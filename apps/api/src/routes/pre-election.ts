import { Router } from "express";
import type { Request } from "express";
import crypto from "node:crypto";
import {
  PayoutStatus,
  Prisma,
  ReferralStatus,
  RewardEventStatus,
  RewardLedgerCategory,
  RewardQualifyingEvent,
  UserRole,
  VoterVerificationDecision,
  VoterVerificationStatus,
  type CoordinatorLevel,
} from "@prisma/client";
import { OGUN_STATE_ID, type OperationalTerritory } from "@pics-nigeria/shared";
import { z } from "zod";
import { generateUniqueReferralCode } from "../auth/referral";
import { authorizeAction, resolveOperationalTerritory } from "../authorization";
import {
  buildOperationalPollingUnitTerritoryWhere,
  buildOperationalVoterProfileTerritoryWhere,
  isCurrentMemberTerritoryMetricSnapshot,
  MEMBER_TERRITORY_SCOPE_VERSION,
  selectCurrentMemberTerritorySnapshots,
  SNAPSHOT_COMPATIBILITY_SCAN_LIMIT,
  type MemberTerritoryLevel,
} from "../lib/member-territory-scope";
import { getPrivateObjectStorage } from "@pics-nigeria/object-storage";
import { createAuditLog } from "../lib/audit";
import {
  VoterDocumentRejected,
  storeVoterDocument,
  voterDocumentSubmissionSchema,
} from "../lib/voter-document-storage";
import { processVerifiedReferralReward } from "../lib/pre-election-rewards";
import { requireAuth, requireMemberCapability, requireRole } from "../middleware/auth";
import { prisma } from "../prisma";
import {
  PayoutExecutionDisabledError,
  getAuthoritativeBalance,
  isPayoutExecutionEnabled,
  resolveActivePayoutTerms,
  valueEligibleBeneficiaries,
  valueLegacyCarryover,
  type PayoutTerms,
} from "../lib/payout-authority";
import { PayoutExecutionError, executePayout, payoutExecutionStatusCode } from "../lib/payout-execution";

const router = Router();

const commandTerritoryTypeSchema = z.enum([
  "STATE",
  "SENATORIAL_DISTRICT",
  "FEDERAL_CONSTITUENCY",
  "STATE_CONSTITUENCY",
  "WARD",
  "POLLING_UNIT",
]);

const verificationQueueQuerySchema = z.object({
  status: z.nativeEnum(VoterVerificationStatus).optional(),
  flagged: z.coerce.boolean().optional(),
  search: z.string().trim().max(120).optional(),
  territoryType: commandTerritoryTypeSchema.optional(),
  territoryId: z.string().trim().min(1).optional(),
  export: z.enum(["csv"]).optional(),
});

const verificationDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT", "REQUEST_RESUBMISSION"]),
  note: z.string().trim().max(1000).optional(),
});

const verificationDocumentSchema = z.object({
  documentProcessingConsent: z.literal(true),
  voterDocument: voterDocumentSubmissionSchema,
});

const rewardRuleSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    directPoints: z.number().int().min(0).max(100000),
    qualifyingEvent: z.nativeEnum(RewardQualifyingEvent).default(RewardQualifyingEvent.VOTER_VERIFICATION_APPROVED),
    /** Qualified-referral count that triggers a bonus award. Milestone rules only. */
    milestoneThreshold: z.number().int().min(1).max(100000).optional(),
    eligibleRole: z.nativeEnum(UserRole).default(UserRole.COORDINATOR),
    eligibleCoordinatorLevel: z
      .enum(["SENATORIAL_DISTRICT", "FEDERAL_CONSTITUENCY", "STATE_CONSTITUENCY", "WARD", "POLLING_UNIT"])
      .optional(),
    effectiveFrom: z.string().datetime().optional(),
    effectiveUntil: z.string().datetime().optional(),
  })
  .superRefine((value, context) => {
    // A bonus rule without a threshold would have no system trigger, and a
    // system trigger is the only way bonus points may come into existence.
    if (value.qualifyingEvent === RewardQualifyingEvent.REFERRAL_MILESTONE_REACHED && !value.milestoneThreshold) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["milestoneThreshold"],
        message: "milestoneThreshold is required for REFERRAL_MILESTONE_REACHED bonus rules.",
      });
    }
    if (value.qualifyingEvent !== RewardQualifyingEvent.REFERRAL_MILESTONE_REACHED && value.milestoneThreshold) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["milestoneThreshold"],
        message: "milestoneThreshold only applies to REFERRAL_MILESTONE_REACHED bonus rules.",
      });
    }
  });

const payoutConfigurationSchema = z.object({
  minimumPoints: z.number().int().min(1).max(10_000_000),
  pointConversionRate: z.number().positive().max(1_000_000),
  frequency: z.string().trim().min(3).max(40),
  nextPayoutDate: z.string().datetime().optional(),
});

const payoutCycleSchema = z.object({
  name: z.string().trim().min(3).max(120),
  opensAt: z.string().datetime(),
  closesAt: z.string().datetime(),
  payoutDate: z.string().datetime(),
  // No minimumThreshold and no conversionRate. A cycle's monetary terms are
  // snapshotted from the active PayoutConfiguration by the payout authority, so
  // a caller cannot choose the rate its beneficiaries are paid at.
});

const payoutBatchSchema = z.object({
  payoutOfficerUserId: z.string().trim().min(1),
  beneficiaryUserIds: z.array(z.string().trim().min(1)).max(500).optional(),
});

const payoutAssignmentStatusSchema = z.object({
  status: z.enum(["PROCESSING", "PAID", "HELD", "REJECTED"]),
  paymentReference: z.string().trim().min(3).max(120).optional(),
  proofStorageKey: z
    .string()
    .trim()
    .max(500)
    .refine((value) => !/^https?:\/\//i.test(value), "Proof storage key must not be a public URL.")
    .optional(),
  note: z.string().trim().max(1000).optional(),
});

const payoutAssignmentQuerySchema = z.object({
  status: z.nativeEnum(PayoutStatus).optional(),
});

const rewardBalanceQuerySchema = z.object({
  userId: z.string().trim().min(1).optional(),
});

const rewardLedgerQuerySchema = z.object({
  userId: z.string().trim().min(1).optional(),
  category: z.nativeEnum(RewardLedgerCategory).optional(),
});

const scopedQuerySchema = z.object({
  territoryType: commandTerritoryTypeSchema,
  territoryId: z.string().trim().min(1),
});

const referralManagementQuerySchema = z.object({
  territoryType: commandTerritoryTypeSchema.optional(),
  territoryId: z.string().trim().min(1).optional(),
  status: z.nativeEnum(ReferralStatus).optional(),
  search: z.string().trim().max(120).optional(),
  export: z.enum(["csv"]).optional(),
});

const payoutBatchQuerySchema = z.object({
  status: z.nativeEnum(PayoutStatus).optional(),
});

const payoutEligibilityQuerySchema = z.object({
  cycleId: z.string().trim().min(1).optional(),
  search: z.string().trim().max(120).optional(),
});

const strengthMetricSchema = z.object({
  metric: z.string().trim().min(2).max(80).transform((value) => value.toUpperCase()),
  description: z.string().trim().max(500).optional(),
});

const strengthWeightSchema = z.object({
  metric: z.string().trim().min(2).max(80).transform((value) => value.toUpperCase()),
  weight: z.number().min(0).max(100),
  effectiveFrom: z.string().datetime().optional(),
  effectiveUntil: z.string().datetime().optional(),
});

const territoryTargetSchema = z.object({
  candidateId: z.string().trim().min(1).optional(),
  territoryType: commandTerritoryTypeSchema,
  territoryId: z.string().trim().min(1),
  metric: z.string().trim().min(2).max(80).transform((value) => value.toUpperCase()),
  targetValue: z.number().int().min(0).max(100_000_000),
  startDate: z.string().datetime(),
  endDate: z.string().datetime().optional(),
});

const strengthSnapshotSchema = z.object({
  territoryType: commandTerritoryTypeSchema,
  territoryId: z.string().trim().min(1),
  candidateId: z.string().trim().min(1).optional(),
});

function serializeVerificationCase(verification: {
  id: string;
  memberUserId: string;
  voterIdentifier: string;
  status: VoterVerificationStatus;
  isFlagged: boolean;
  fraudReason: string | null;
  submittedAt: Date | null;
  reviewStartedAt: Date | null;
  reviewedAt: Date | null;
  reviewedByUserId: string | null;
  reviewNote: string | null;
  memberUser: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    voterProfile: {
      stateId: string;
      senatorialDistrictId: string | null;
      federalConstituencyId: string | null;
      stateConstituencyId: string | null;
      lgaId: string;
      wardId: string;
      pollingUnitId: string | null;
    } | null;
  };
  documents: Array<{
    id: string;
    originalFileName: string;
    mimeType: string;
    fileSize: number;
    sha256: string;
    storageProvider: string;
    uploadedAt: Date;
  }>;
  history: Array<{
    id: string;
    fromStatus: VoterVerificationStatus | null;
    toStatus: VoterVerificationStatus;
    decision: VoterVerificationDecision;
    note: string | null;
    createdAt: Date;
    actorUser: { name: string } | null;
  }>;
}) {
  return {
    id: verification.id,
    memberUserId: verification.memberUserId,
    memberName: verification.memberUser.name,
    memberEmail: verification.memberUser.email,
    memberPhone: verification.memberUser.phone,
    voterIdentifier: verification.voterIdentifier,
    status: verification.status,
    isFlagged: verification.isFlagged,
    fraudReason: verification.fraudReason,
    submittedAt: verification.submittedAt?.toISOString() || null,
    reviewStartedAt: verification.reviewStartedAt?.toISOString() || null,
    reviewedAt: verification.reviewedAt?.toISOString() || null,
    reviewedByUserId: verification.reviewedByUserId,
    reviewNote: verification.reviewNote,
    territory: verification.memberUser.voterProfile
      ? {
          stateId: verification.memberUser.voterProfile.stateId,
          senatorialDistrictId: verification.memberUser.voterProfile.senatorialDistrictId,
          federalConstituencyId: verification.memberUser.voterProfile.federalConstituencyId,
          stateConstituencyId: verification.memberUser.voterProfile.stateConstituencyId,
          lgaId: verification.memberUser.voterProfile.lgaId,
          wardId: verification.memberUser.voterProfile.wardId,
          pollingUnitId: verification.memberUser.voterProfile.pollingUnitId,
        }
      : null,
    documents: verification.documents.map((document) => ({
      id: document.id,
      originalFileName: document.originalFileName,
      mimeType: document.mimeType,
      fileSize: document.fileSize,
      sha256: document.sha256,
      storageProvider: document.storageProvider,
      uploadedAt: document.uploadedAt.toISOString(),
    })),
    history: verification.history.map((entry) => ({
      id: entry.id,
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      decision: entry.decision,
      note: entry.note,
      actorName: entry.actorUser?.name || null,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}

function csvEscape(value: unknown) {
  const normalized = value === null || value === undefined ? "" : String(value);
  return `"${normalized.replace(/"/g, '""')}"`;
}

function sendCsv(response: { setHeader(name: string, value: string): void; send(body: string): void }, fileName: string, rows: unknown[][]) {
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  response.send(rows.map((row) => row.map(csvEscape).join(",")).join("\n"));
}

function canUseReferralCode(user: NonNullable<Request["authUser"]>) {
  return user.role === "COORDINATOR" && Boolean(user.coordinatorProfile);
}

function readParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function commandTerritoryInput(territoryType: string, territoryId: string): OperationalTerritory {
  if (territoryType === "STATE") {
    return { stateId: territoryId };
  }
  if (territoryType === "SENATORIAL_DISTRICT") {
    return { stateId: OGUN_STATE_ID, senatorialDistrictId: territoryId };
  }
  if (territoryType === "FEDERAL_CONSTITUENCY") {
    return { stateId: OGUN_STATE_ID, federalConstituencyId: territoryId };
  }
  if (territoryType === "STATE_CONSTITUENCY") {
    return { stateId: OGUN_STATE_ID, stateConstituencyId: territoryId };
  }
  if (territoryType === "WARD") {
    return { stateId: OGUN_STATE_ID, wardId: territoryId };
  }
  return { stateId: OGUN_STATE_ID, pollingUnitId: territoryId };
}

async function canViewCommandTerritory(
  actor: NonNullable<Request["authUser"]>,
  territoryType: string,
  territoryId: string,
) {
  try {
    const resolved = await resolveOperationalTerritory(prisma, commandTerritoryInput(territoryType, territoryId));
    return authorizeAction(actor, "VIEW_TERRITORY", resolved);
  } catch {
    return false;
  }
}

function decimalToString(value: Prisma.Decimal | number | string) {
  return new Prisma.Decimal(value).toFixed(2);
}

/**
 * Member scope is not defined here.
 *
 * This used to filter on VoterProfile's nullable ancestry columns while the
 * command dashboard filtered on the ward graph, so a strength score of zero
 * could be written for a territory whose dashboard tile read four hundred — and
 * because the dashboard prefers a snapshot over its live count, that zero then
 * became what everyone saw. One authority now answers for both.
 */
function buildScopedVoterProfileWhere(territoryType: string, territoryId: string): Prisma.VoterProfileWhereInput {
  return buildOperationalVoterProfileTerritoryWhere(territoryType as MemberTerritoryLevel, territoryId);
}

function buildScopedVerificationWhere(territoryType?: string, territoryId?: string): Prisma.VoterVerificationWhereInput {
  if (!territoryType || !territoryId) {
    return {};
  }
  return { memberUser: { voterProfile: { is: buildScopedVoterProfileWhere(territoryType, territoryId) } } };
}

function buildSearchWhere(search?: string): Prisma.VoterVerificationWhereInput {
  const normalized = search?.trim();
  if (!normalized) {
    return {};
  }
  return {
    OR: [
      { voterIdentifier: { contains: normalized, mode: "insensitive" } },
      { memberUser: { name: { contains: normalized, mode: "insensitive" } } },
      { memberUser: { email: { contains: normalized, mode: "insensitive" } } },
      { memberUser: { phone: { contains: normalized, mode: "insensitive" } } },
    ],
  };
}

function buildScopedCoordinatorWhere(territoryType: string, territoryId: string): Prisma.CoordinatorProfileWhereInput {
  if (territoryType === "STATE") {
    return { stateId: territoryId };
  }
  if (territoryType === "SENATORIAL_DISTRICT") {
    return { senatorialDistrictId: territoryId };
  }
  if (territoryType === "FEDERAL_CONSTITUENCY") {
    return { federalConstituencyId: territoryId };
  }
  if (territoryType === "STATE_CONSTITUENCY") {
    return { stateConstituencyId: territoryId };
  }
  if (territoryType === "WARD") {
    return { wardId: territoryId };
  }
  return { pollingUnitId: territoryId };
}

function serializePayoutAssignment(assignment: {
  id: string;
  payoutCycleId: string;
  payoutBatchId: string;
  payoutOfficerUserId: string;
  beneficiaryUserId: string;
  points: number;
  amount: Prisma.Decimal;
  status: PayoutStatus;
  assignedAt: Date;
  processedAt: Date | null;
  note: string | null;
  beneficiaryUser?: { name: string; email: string } | null;
  payoutOfficerUser?: { name: string; email: string } | null;
  transactions?: Array<{
    id: string;
    paymentReference: string;
    pointsRedeemed: number;
    amountPaid: Prisma.Decimal;
    status: PayoutStatus;
    proofStorageKey: string | null;
    note: string | null;
    createdAt: Date;
  }>;
}) {
  return {
    id: assignment.id,
    payoutCycleId: assignment.payoutCycleId,
    payoutBatchId: assignment.payoutBatchId,
    payoutOfficerUserId: assignment.payoutOfficerUserId,
    payoutOfficerName: assignment.payoutOfficerUser?.name || null,
    beneficiaryUserId: assignment.beneficiaryUserId,
    beneficiaryName: assignment.beneficiaryUser?.name || null,
    beneficiaryEmail: assignment.beneficiaryUser?.email || null,
    points: assignment.points,
    amount: decimalToString(assignment.amount),
    status: assignment.status,
    assignedAt: assignment.assignedAt.toISOString(),
    processedAt: assignment.processedAt?.toISOString() || null,
    note: assignment.note,
    transactions:
      assignment.transactions?.map((transaction) => ({
        id: transaction.id,
        paymentReference: transaction.paymentReference,
        pointsRedeemed: transaction.pointsRedeemed,
        amountPaid: decimalToString(transaction.amountPaid),
        status: transaction.status,
        proofStorageKey: transaction.proofStorageKey,
        note: transaction.note,
        createdAt: transaction.createdAt.toISOString(),
      })) || [],
  };
}

function serializeRewardLedgerEntry(entry: {
  id: string;
  userId: string;
  points: number;
  category: string;
  sourceEventType: string;
  sourceEventId: string;
  rewardRuleVersionId: string | null;
  relatedUserId: string | null;
  description: string | null;
  createdAt: Date;
  relatedUser?: { name: string; email: string } | null;
  rewardRuleVersion?: { version: number; rewardRule: { name: string } } | null;
}) {
  return {
    id: entry.id,
    userId: entry.userId,
    points: entry.points,
    category: entry.category,
    sourceEventType: entry.sourceEventType,
    sourceEventId: entry.sourceEventId,
    rewardRuleVersionId: entry.rewardRuleVersionId,
    rewardRuleName: entry.rewardRuleVersion?.rewardRule.name || null,
    rewardRuleVersion: entry.rewardRuleVersion?.version || null,
    relatedUserId: entry.relatedUserId,
    relatedUserName: entry.relatedUser?.name || null,
    relatedUserEmail: entry.relatedUser?.email || null,
    description: entry.description,
    createdAt: entry.createdAt.toISOString(),
  };
}

function serializeReferral(referral: {
  id: string;
  referredUserId: string;
  referrerUserId: string;
  referralCode: string;
  status: ReferralStatus;
  registeredAt: Date;
  qualifiedAt: Date | null;
  rewardProcessedAt: Date | null;
  flaggedAt: Date | null;
  fraudReason: string | null;
  referredUser: { name: string; email: string; voterProfile: { wardId: string; pollingUnitId: string | null } | null };
  referrerUser: { name: string; email: string };
}) {
  return {
    id: referral.id,
    referredUserId: referral.referredUserId,
    referredName: referral.referredUser.name,
    referredEmail: referral.referredUser.email,
    referrerUserId: referral.referrerUserId,
    referrerName: referral.referrerUser.name,
    referrerEmail: referral.referrerUser.email,
    referralCode: referral.referralCode,
    status: referral.status,
    wardId: referral.referredUser.voterProfile?.wardId || null,
    pollingUnitId: referral.referredUser.voterProfile?.pollingUnitId || null,
    registeredAt: referral.registeredAt.toISOString(),
    qualifiedAt: referral.qualifiedAt?.toISOString() || null,
    rewardProcessedAt: referral.rewardProcessedAt?.toISOString() || null,
    flaggedAt: referral.flaggedAt?.toISOString() || null,
    fraudReason: referral.fraudReason,
  };
}

function serializePayoutBatchWithAssignments(batch: {
  id: string;
  payoutCycleId: string;
  status: PayoutStatus;
  createdAt: Date;
  approvedAt: Date | null;
  payoutCycle?: { name: string; payoutDate: Date } | null;
  assignments: Parameters<typeof serializePayoutAssignment>[0][];
}) {
  return {
    id: batch.id,
    payoutCycleId: batch.payoutCycleId,
    payoutCycleName: batch.payoutCycle?.name || null,
    payoutDate: batch.payoutCycle?.payoutDate.toISOString() || null,
    status: batch.status,
    createdAt: batch.createdAt.toISOString(),
    approvedAt: batch.approvedAt?.toISOString() || null,
    assignmentCount: batch.assignments.length,
    totalPoints: batch.assignments.reduce((sum, assignment) => sum + assignment.points, 0),
    totalAmount: decimalToString(
      batch.assignments.reduce((sum, assignment) => sum.add(assignment.amount), new Prisma.Decimal(0)),
    ),
    assignments: batch.assignments.map(serializePayoutAssignment),
  };
}

async function getConfirmedPoints(userId: string) {
  const aggregate = await prisma.rewardLedgerEntry.aggregate({
    where: { userId },
    _sum: { points: true },
  });
  return aggregate._sum.points || 0;
}


async function getPotentialReferralPoints(userId: string) {
  const pendingCount = await prisma.referral.count({
    where: { referrerUserId: userId, status: ReferralStatus.PENDING_VERIFICATION },
  });
  if (pendingCount === 0) {
    return 0;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { coordinatorProfile: true },
  });
  if (!user) {
    return 0;
  }

  const now = new Date();
  const ruleVersion = await prisma.rewardRuleVersion.findFirst({
    where: {
      effectiveFrom: { lte: now },
      rewardRule: {
        qualifyingEvent: RewardQualifyingEvent.VOTER_VERIFICATION_APPROVED,
        active: true,
        effectiveFrom: { lte: now },
        eligibleRole: user.role,
        AND: [
          { OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }] },
          user.coordinatorProfile
            ? {
                OR: [
                  { eligibleCoordinatorLevel: null },
                  { eligibleCoordinatorLevel: user.coordinatorProfile.level },
                ],
              }
            : { eligibleCoordinatorLevel: null },
        ],
      },
    },
    orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
  });

  return pendingCount * (ruleVersion?.directPoints || 0);
}

/**
 * Eligible beneficiaries for a payout cycle.
 *
 * This used to be a second money authority: it aggregated the ledger itself,
 * subtracted only payout-assignment reservations, applied its own threshold and
 * multiplied by the cycle's own conversion rate. Because it ignored redemption
 * reservations, a member could be paid for points they had already redeemed.
 * It now computes nothing — every figure comes from the payout authority, on
 * terms the server derived when the cycle was created.
 */
async function calculateEligibleBeneficiaries(
  transaction: Prisma.TransactionClient,
  cycle: { id: string; minimumThreshold: number; conversionRate: Prisma.Decimal },
  beneficiaryUserIds?: string[],
) {
  return valueEligibleBeneficiaries(
    transaction,
    { minimumThreshold: cycle.minimumThreshold, conversionRate: cycle.conversionRate },
    beneficiaryUserIds,
  );
}

async function calculateMetricActual(territoryType: string, territoryId: string, metric: string) {
  const voterScope = buildScopedVoterProfileWhere(territoryType, territoryId);
  if (metric === "VERIFIED_MEMBERS") {
    return prisma.voterVerification.count({
      where: { status: VoterVerificationStatus.VERIFIED, memberUser: { voterProfile: { is: voterScope } } },
    });
  }
  if (metric === "REGISTERED_MEMBERS") {
    return prisma.voterProfile.count({ where: voterScope });
  }
  if (metric === "PENDING_VERIFICATIONS") {
    return prisma.voterVerification.count({
      where: { status: VoterVerificationStatus.PENDING, memberUser: { voterProfile: { is: voterScope } } },
    });
  }
  if (metric === "QUALIFIED_REFERRALS") {
    return prisma.referral.count({
      where: {
        status: { in: [ReferralStatus.QUALIFIED, ReferralStatus.REWARD_PROCESSED] },
        referredUser: { voterProfile: { is: voterScope } },
      },
    });
  }
  if (metric === "COORDINATOR_COVERAGE") {
    return prisma.coordinatorProfile.count({ where: buildScopedCoordinatorWhere(territoryType, territoryId) });
  }
  if (metric === "POLLING_UNIT_COVERAGE") {
    const pollingUnits = await countPollingUnitsInScope(territoryType, territoryId);
    if (pollingUnits === 0) {
      return 0;
    }
    const covered = await prisma.coordinatorProfile.count({
      where: { ...buildScopedCoordinatorWhere(territoryType, territoryId), level: "POLLING_UNIT", pollingUnitId: { not: null } },
    });
    return Math.round((covered / pollingUnits) * 100);
  }
  return prisma.territoryMetricSnapshot
    .findFirst({
      where: { territoryType, territoryId, metric },
      orderBy: { calculatedAt: "desc" },
      select: { actualValue: true },
    })
    .then((snapshot) => snapshot?.actualValue || 0);
}

/**
 * Polling units in scope, through the one operational authority.
 *
 * This used to walk `ward.stateConstituency` itself, without the reviewed-edge
 * predicate the dashboard applies. That made the coverage denominator count
 * polling units behind unreviewed inferred edges while the member metrics in the
 * same snapshot excluded every member on those wards — and the snapshot was
 * still stamped with the current scope version, certifying semantics it had not
 * used. There is one definition now, and it lives in member-territory-scope.
 */
async function countPollingUnitsInScope(territoryType: string, territoryId: string) {
  return prisma.pollingUnit.count({
    where: buildOperationalPollingUnitTerritoryWhere(territoryType, territoryId),
  });
}

async function getTargetForMetric(territoryType: string, territoryId: string, metric: string, now = new Date()) {
  return prisma.territoryTarget.findFirst({
    where: {
      territoryType,
      territoryId,
      metric,
      startDate: { lte: now },
      OR: [{ endDate: null }, { endDate: { gte: now } }],
    },
    orderBy: { startDate: "desc" },
  });
}

function trendFromScores(latest: Prisma.Decimal, previous?: Prisma.Decimal | null) {
  if (!previous) {
    return "STABLE";
  }
  const difference = latest.minus(previous);
  if (difference.greaterThan(1)) {
    return "IMPROVING";
  }
  if (difference.lessThan(-1)) {
    return "DECLINING";
  }
  return "STABLE";
}

router.get("/referral-code", requireAuth, async (request, response) => {
  if (!request.authUser || !canUseReferralCode(request.authUser)) {
    return response.status(403).json({ message: "Coordinator referral capability is required." });
  }

  const referralCode = await prisma.$transaction(async (transaction) => {
    const existing = await transaction.referralCode.findFirst({
      where: { ownerUserId: request.authUser!.id, isActive: true },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      return existing;
    }

    return transaction.referralCode.create({
      data: {
        ownerUserId: request.authUser!.id,
        code: await generateUniqueReferralCode(transaction),
      },
    });
  });

  return response.json({
    referralCode: referralCode.code,
    referralLink: `/register?ref=${referralCode.code}`,
  });
});

router.get("/verifications/me", requireAuth, requireMemberCapability, async (request, response) => {
  const verification = await prisma.voterVerification.findUnique({
    where: { memberUserId: request.authUser!.id },
    include: {
      memberUser: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          voterProfile: {
            select: {
              stateId: true,
              senatorialDistrictId: true,
              federalConstituencyId: true,
              stateConstituencyId: true,
              lgaId: true,
              wardId: true,
              pollingUnitId: true,
            },
          },
        },
      },
      documents: { orderBy: { uploadedAt: "desc" } },
      history: {
        include: { actorUser: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  return response.json({ verification: verification ? serializeVerificationCase(verification) : null });
});

router.post("/verifications/me/documents", requireAuth, requireMemberCapability, async (request, response) => {
  const parsed = verificationDocumentSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid verification document payload.", errors: parsed.error.flatten() });
  }

  let storedDocument;
  try {
    storedDocument = await storeVoterDocument({
      submission: parsed.data.voterDocument,
      memberUserId: request.authUser!.id,
    });
  } catch (caught) {
    if (caught instanceof VoterDocumentRejected) {
      return response.status(caught.status).json({ message: caught.message, code: caught.code });
    }
    throw caught;
  }

  const result = await prisma.$transaction(async (transaction) => {
    const verification = await transaction.voterVerification.findUnique({
      where: { memberUserId: request.authUser!.id },
    });
    if (!verification) {
      throw new Error("NOT_FOUND");
    }
    if (verification.status === VoterVerificationStatus.VERIFIED || verification.status === VoterVerificationStatus.REJECTED) {
      throw new Error("FINALIZED");
    }
    if (verification.status === VoterVerificationStatus.UNDER_REVIEW && verification.reviewedByUserId) {
      throw new Error("UNDER_REVIEW");
    }

    const duplicateDocument = await transaction.voterVerificationDocument.findFirst({
      where: {
        sha256: storedDocument.sha256,
        verification: { memberUserId: { not: request.authUser!.id } },
      },
      select: { id: true },
    });

    await transaction.voterVerificationDocument.create({
      data: {
        id: storedDocument.documentId,
        verificationId: verification.id,
        originalStorageKey: storedDocument.originalStorageKey,
        previewStorageKey: null,
        originalFileName: parsed.data.voterDocument.originalFileName,
        mimeType: parsed.data.voterDocument.mimeType,
        // Every authoritative field below is derived from the bytes the server
        // received, not from anything the client said about them.
        fileSize: storedDocument.fileSize,
        sha256: storedDocument.sha256,
        storageProvider: storedDocument.storageProvider,
        storageBucket: storedDocument.storageBucket,
        serverReceivedAt: storedDocument.serverReceivedAt,
      },
    });

    const updated = await transaction.voterVerification.update({
      where: { id: verification.id },
      data: {
        status: VoterVerificationStatus.PENDING,
        submittedAt: new Date(),
        reviewStartedAt: null,
        reviewedAt: null,
        reviewedByUserId: null,
        reviewNote: null,
        isFlagged: Boolean(duplicateDocument),
        fraudReason: duplicateDocument ? "DUPLICATE_DOCUMENT_HASH" : null,
      },
    });

    await transaction.voterVerificationHistory.create({
      data: {
        verificationId: verification.id,
        actorUserId: request.authUser!.id,
        fromStatus: verification.status,
        toStatus: VoterVerificationStatus.PENDING,
        decision: duplicateDocument ? VoterVerificationDecision.FLAGGED : VoterVerificationDecision.SUBMITTED,
        note: duplicateDocument
          ? "Resubmitted voter evidence and flagged for duplicate document hash."
          : "Voter evidence submitted for validation.",
      },
    });

    await transaction.voterProfile.updateMany({
      where: { userId: request.authUser!.id },
      data: { documentConsentAt: new Date() },
    });

    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: duplicateDocument ? "VERIFICATION_DOCUMENT_RESUBMITTED_FLAGGED" : "VERIFICATION_DOCUMENT_RESUBMITTED",
      targetType: "VoterVerification",
      targetId: verification.id,
      metadata: { duplicateDocument: Boolean(duplicateDocument) },
    });

    return updated;
  }).catch((error: unknown) => (error instanceof Error ? error : Promise.reject(error)));

  if (result instanceof Error) {
    if (result.message === "NOT_FOUND") {
      return response.status(404).json({ message: "Verification profile was not found." });
    }
    if (result.message === "FINALIZED") {
      return response.status(409).json({ message: "Finalized verification cases cannot be resubmitted." });
    }
    if (result.message === "UNDER_REVIEW") {
      return response.status(409).json({ message: "A validator is already reviewing this submission." });
    }
    throw result;
  }

  return response.status(201).json({ message: "Verification document submitted.", verificationId: result.id, status: result.status });
});

router.get("/verifications", requireAuth, requireRole("VALIDATOR", "SUPER_ADMIN"), async (request, response) => {
  const parsed = verificationQueueQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid verification queue query.", errors: parsed.error.flatten() });
  }
  if (Boolean(parsed.data.territoryType) !== Boolean(parsed.data.territoryId)) {
    return response.status(400).json({ message: "territoryType and territoryId must be supplied together." });
  }
  if (
    parsed.data.territoryType &&
    parsed.data.territoryId &&
    !(await canViewCommandTerritory(request.authUser!, parsed.data.territoryType, parsed.data.territoryId))
  ) {
    return response.status(403).json({ message: "You do not have permission to view this territory." });
  }

  const statuses = parsed.data.status
    ? [parsed.data.status]
    : [
        VoterVerificationStatus.PENDING,
        VoterVerificationStatus.UNDER_REVIEW,
        VoterVerificationStatus.RESUBMISSION_REQUIRED,
        VoterVerificationStatus.VERIFIED,
        VoterVerificationStatus.REJECTED,
      ];

  const verifications = await prisma.voterVerification.findMany({
    where: {
      AND: [
        buildScopedVerificationWhere(parsed.data.territoryType, parsed.data.territoryId),
        buildSearchWhere(parsed.data.search),
      ],
      status: { in: statuses },
      isFlagged: parsed.data.flagged === undefined ? undefined : parsed.data.flagged,
    },
    include: {
      memberUser: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          voterProfile: {
            select: {
              stateId: true,
              senatorialDistrictId: true,
              federalConstituencyId: true,
              stateConstituencyId: true,
              lgaId: true,
              wardId: true,
              pollingUnitId: true,
            },
          },
        },
      },
      documents: { orderBy: { uploadedAt: "desc" } },
      history: {
        include: { actorUser: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: [{ isFlagged: "desc" }, { submittedAt: "asc" }],
    take: 100,
  });

  if (parsed.data.export === "csv") {
    return sendCsv(response, "pre-election-verifications.csv", [
      ["id", "memberName", "memberEmail", "status", "flagged", "voterIdentifier", "submittedAt", "reviewedAt"],
      ...verifications.map((verification) => [
        verification.id,
        verification.memberUser.name,
        verification.memberUser.email,
        verification.status,
        verification.isFlagged,
        verification.voterIdentifier,
        verification.submittedAt?.toISOString() || "",
        verification.reviewedAt?.toISOString() || "",
      ]),
    ]);
  }

  return response.json({ verifications: verifications.map(serializeVerificationCase) });
});

router.post("/verifications/:verificationId/claim", requireAuth, requireRole("VALIDATOR"), async (request, response) => {
  const verificationId = readParam(request.params.verificationId);
  if (!verificationId) {
    return response.status(400).json({ message: "Invalid verification id." });
  }

  const updated = await prisma.$transaction(async (transaction) => {
    const verification = await transaction.voterVerification.findUnique({ where: { id: verificationId } });
    if (!verification) {
      throw new Error("NOT_FOUND");
    }
    if (verification.status === VoterVerificationStatus.UNDER_REVIEW && verification.reviewedByUserId !== request.authUser!.id) {
      throw new Error("ALREADY_CLAIMED");
    }
    if (verification.status !== VoterVerificationStatus.PENDING && verification.status !== VoterVerificationStatus.UNDER_REVIEW) {
      throw new Error("NOT_CLAIMABLE");
    }

    const claimed = await transaction.voterVerification.update({
      where: { id: verification.id },
      data: {
        status: VoterVerificationStatus.UNDER_REVIEW,
        reviewStartedAt: verification.reviewStartedAt || new Date(),
        reviewedByUserId: request.authUser!.id,
      },
    });

    await transaction.voterVerificationHistory.create({
      data: {
        verificationId: verification.id,
        actorUserId: request.authUser!.id,
        fromStatus: verification.status,
        toStatus: VoterVerificationStatus.UNDER_REVIEW,
        decision: VoterVerificationDecision.CLAIMED,
        note: "Verification case claimed by validator.",
      },
    });

    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: "VERIFICATION_CLAIMED",
      targetType: "VoterVerification",
      targetId: verification.id,
    });

    return claimed;
  }).catch((error: unknown) => {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  });

  if (updated instanceof Error) {
    if (updated.message === "NOT_FOUND") {
      return response.status(404).json({ message: "Verification case was not found." });
    }
    if (updated.message === "ALREADY_CLAIMED") {
      return response.status(409).json({ message: "Verification case is already claimed by another validator." });
    }
    if (updated.message === "NOT_CLAIMABLE") {
      return response.status(400).json({ message: "Only pending cases can be claimed." });
    }
    throw updated;
  }

  return response.json({ message: "Verification case claimed.", verificationId });
});

router.get(
  "/verifications/:verificationId/documents/:documentId/access",
  requireAuth,
  requireRole("VALIDATOR", "SUPER_ADMIN"),
  async (request, response) => {
    const verificationId = readParam(request.params.verificationId);
    const documentId = readParam(request.params.documentId);
    if (!verificationId || !documentId) {
      return response.status(400).json({ message: "Invalid verification document id." });
    }

    const document = await prisma.voterVerificationDocument.findFirst({
      where: {
        id: documentId,
        verificationId,
      },
      include: {
        verification: {
          select: { id: true, memberUserId: true },
        },
      },
    });

    if (!document) {
      return response.status(404).json({ message: "Verification document was not found." });
    }

    /**
     * A row that predates private storage describes a document that was never
     * uploaded. Issuing a URL for it would produce a link to nothing while
     * reading as a successful, audited access.
     */
    if (document.storageProvider === "UNSTORED_LEGACY_STUB" || !document.storageBucket) {
      await createAuditLog(prisma, {
        actorUserId: request.authUser!.id,
        action: "VERIFICATION_DOCUMENT_ACCESS_REFUSED",
        targetType: "VoterVerificationDocument",
        targetId: document.id,
        metadata: {
          verificationId: document.verification.id,
          reason: "DOCUMENT_WAS_NEVER_STORED",
        },
      });
      return response.status(409).json({
        message:
          "This document was recorded before private storage existed and its bytes were never stored. Ask the member to resubmit.",
        code: "DOCUMENT_WAS_NEVER_STORED",
      });
    }

    const storage = getPrivateObjectStorage();
    const stored = await storage.getObject(document.originalStorageKey);

    /**
     * The stored bytes must still hash to what was recorded at upload. A
     * mismatch means the object was replaced or corrupted, and a validator
     * deciding someone's identity must not be shown it as though it were the
     * document that was submitted.
     */
    if (!stored || stored.sha256 !== document.sha256) {
      await createAuditLog(prisma, {
        actorUserId: request.authUser!.id,
        action: "VERIFICATION_DOCUMENT_ACCESS_REFUSED",
        targetType: "VoterVerificationDocument",
        targetId: document.id,
        metadata: {
          verificationId: document.verification.id,
          reason: stored ? "STORED_HASH_MISMATCH" : "OBJECT_MISSING",
          recordedSha256: document.sha256,
          storedSha256: stored?.sha256 ?? null,
        },
      });
      return response.status(409).json({
        message: stored
          ? "The stored document no longer matches the hash recorded at upload."
          : "The stored document could not be found.",
        code: stored ? "STORED_HASH_MISMATCH" : "OBJECT_MISSING",
      });
    }

    // Short-lived by construction, and never a permanent public URL.
    const expiresInSeconds = 300;
    const signed = await storage.createSignedGetUrl(document.originalStorageKey, expiresInSeconds);

    await createAuditLog(prisma, {
      actorUserId: request.authUser!.id,
      action: "VERIFICATION_DOCUMENT_ACCESS_GRANTED",
      targetType: "VoterVerificationDocument",
      targetId: document.id,
      metadata: {
        verificationId: document.verification.id,
        memberUserId: document.verification.memberUserId,
        expiresInSeconds,
        verifiedSha256: stored.sha256,
        storageBucket: document.storageBucket,
      },
    });

    return response.json({
      storageProvider: document.storageProvider,
      storageKey: document.originalStorageKey,
      url: signed.url,
      expiresAt: signed.expiresAt,
      verifiedSha256: stored.sha256,
    });
  },
);

router.patch("/verifications/:verificationId/decision", requireAuth, requireRole("VALIDATOR"), async (request, response) => {
  const parsed = verificationDecisionSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid verification decision.", errors: parsed.error.flatten() });
  }

  const verificationId = readParam(request.params.verificationId);
  if (!verificationId) {
    return response.status(400).json({ message: "Invalid verification id." });
  }

  const result = await prisma.$transaction(async (transaction) => {
    const verification = await transaction.voterVerification.findUnique({ where: { id: verificationId } });
    if (!verification) {
      throw new Error("NOT_FOUND");
    }
    if (verification.status === VoterVerificationStatus.VERIFIED || verification.status === VoterVerificationStatus.REJECTED) {
      throw new Error("FINALIZED");
    }
    if (verification.reviewedByUserId && verification.reviewedByUserId !== request.authUser!.id) {
      throw new Error("CLAIMED_BY_OTHER");
    }

    const toStatus =
      parsed.data.decision === "APPROVE"
        ? VoterVerificationStatus.VERIFIED
        : parsed.data.decision === "REJECT"
          ? VoterVerificationStatus.REJECTED
          : VoterVerificationStatus.RESUBMISSION_REQUIRED;
    const historyDecision =
      parsed.data.decision === "APPROVE"
        ? VoterVerificationDecision.APPROVED
        : parsed.data.decision === "REJECT"
          ? VoterVerificationDecision.REJECTED
          : VoterVerificationDecision.RESUBMISSION_REQUIRED;

    const updated = await transaction.voterVerification.update({
      where: { id: verification.id },
      data: {
        status: toStatus,
        reviewedByUserId: request.authUser!.id,
        reviewedAt: new Date(),
        reviewNote: parsed.data.note || null,
      },
    });

    await transaction.voterVerificationHistory.create({
      data: {
        verificationId: verification.id,
        actorUserId: request.authUser!.id,
        fromStatus: verification.status,
        toStatus,
        decision: historyDecision,
        note: parsed.data.note || null,
      },
    });

    if (toStatus === VoterVerificationStatus.VERIFIED) {
      await processVerifiedReferralReward(transaction, { referredUserId: verification.memberUserId });
    } else if (toStatus === VoterVerificationStatus.REJECTED) {
      await transaction.referral.updateMany({
        where: {
          referredUserId: verification.memberUserId,
          status: { in: [ReferralStatus.REGISTERED, ReferralStatus.PENDING_VERIFICATION, ReferralStatus.FLAGGED] },
        },
        data: { status: ReferralStatus.REJECTED },
      });
    }

    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: `VERIFICATION_${historyDecision}`,
      targetType: "VoterVerification",
      targetId: verification.id,
      metadata: { fromStatus: verification.status, toStatus },
    });

    return updated;
  }).catch((error: unknown) => {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  });

  if (result instanceof Error) {
    if (result.message === "NOT_FOUND") {
      return response.status(404).json({ message: "Verification case was not found." });
    }
    if (result.message === "FINALIZED") {
      return response.status(409).json({ message: "Finalized verification cases cannot be changed." });
    }
    if (result.message === "CLAIMED_BY_OTHER") {
      return response.status(409).json({ message: "Verification case is claimed by another validator." });
    }
    throw result;
  }

  return response.json({
    message: "Verification decision recorded.",
    verificationId,
    status: result.status,
  });
});

router.post("/reward-rules", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const parsed = rewardRuleSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid reward rule payload.", errors: parsed.error.flatten() });
  }

  if (parsed.data.eligibleRole !== UserRole.COORDINATOR && parsed.data.eligibleCoordinatorLevel) {
    return response.status(400).json({ message: "Coordinator level can only be set for coordinator reward rules." });
  }

  const effectiveFrom = parsed.data.effectiveFrom ? new Date(parsed.data.effectiveFrom) : new Date();
  const effectiveUntil = parsed.data.effectiveUntil ? new Date(parsed.data.effectiveUntil) : null;
  if (effectiveUntil && effectiveUntil <= effectiveFrom) {
    return response.status(400).json({ message: "effectiveUntil must be after effectiveFrom." });
  }

  const rule = await prisma.$transaction(async (transaction) => {
    const created = await transaction.rewardRule.create({
      data: {
        name: parsed.data.name,
        qualifyingEvent: parsed.data.qualifyingEvent,
        eligibleRole: parsed.data.eligibleRole,
        eligibleCoordinatorLevel: (parsed.data.eligibleCoordinatorLevel as CoordinatorLevel | undefined) || null,
        effectiveFrom,
        effectiveUntil,
        createdByUserId: request.authUser!.id,
        versions: {
          create: {
            version: 1,
            directPoints: parsed.data.directPoints,
            milestoneThreshold: parsed.data.milestoneThreshold ?? null,
            effectiveFrom,
          },
        },
      },
      include: { versions: true },
    });

    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: "REWARD_RULE_CREATED",
      targetType: "RewardRule",
      targetId: created.id,
      metadata: {
        qualifyingEvent: parsed.data.qualifyingEvent,
        directPoints: parsed.data.directPoints,
        milestoneThreshold: parsed.data.milestoneThreshold ?? null,
      },
    });

    return created;
  });

  return response.status(201).json({
    message: "Reward rule created.",
    rewardRule: rule,
  });
});

router.get("/reward-rules", requireAuth, requireRole("SUPER_ADMIN"), async (_request, response) => {
  const rules = await prisma.rewardRule.findMany({
    include: { versions: { orderBy: { version: "desc" } } },
    orderBy: { createdAt: "desc" },
  });
  return response.json({ rewardRules: rules });
});

router.get("/rewards/balance", requireAuth, async (request, response) => {
  const parsed = rewardBalanceQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid reward balance query.", errors: parsed.error.flatten() });
  }

  const targetUserId = parsed.data.userId || request.authUser!.id;
  if (targetUserId !== request.authUser!.id && request.authUser!.role !== "SUPER_ADMIN") {
    return response.status(403).json({ message: "Only Super Admin can inspect another user's reward balance." });
  }

  const [pendingPotentialPoints, balance] = await Promise.all([
    getPotentialReferralPoints(targetUserId),
    getAuthoritativeBalance(prisma, targetUserId),
  ]);

  return response.json({
    userId: targetUserId,
    confirmedPoints: balance.confirmedPoints,
    pendingPotentialPoints,
    reservedPayoutPoints: balance.reservedPoints,
    availablePoints: balance.eligiblePoints,
    // Reported separately and deliberately excluded from availablePoints: a
    // migrated legacy balance is preserved and visible, but is not payable
    // until an approved equivalence ratio credits it. Folding it into the
    // spendable figure would create value from an unverified assumption.
    legacyCarryoverPendingPoints: balance.legacyCarryoverPendingPoints,
    legacyCarryoverConfirmedPoints: balance.legacyCarryoverConfirmedPoints,
    // Legacy-era claims against this balance, reported so they are visible.
    // Fully counted in reservedPayoutPoints and never netted off.
    preCutoverReservedPoints: balance.preCutoverReservedPoints,
    payablePoints: balance.eligiblePoints,
  });
});

/** Decimal is serialised as a string so a ratio never crosses the wire as a float. */
function serializeLegacyReconciliationPolicy(policy: {
  id: string;
  version: string;
  conversionRatio: Prisma.Decimal;
  status: string;
  rationale: string | null;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  createdAt: Date;
}) {
  return {
    id: policy.id,
    version: policy.version,
    conversionRatio: policy.conversionRatio.toString(),
    status: policy.status,
    rationale: policy.rationale,
    approvedAt: policy.approvedAt ? policy.approvedAt.toISOString() : null,
    approvedByUserId: policy.approvedByUserId,
    createdAt: policy.createdAt.toISOString(),
  };
}

const legacyReconciliationPolicySchema = z
  .object({
    version: z.string().trim().min(3).max(60),
    conversionRatio: z.number().positive().max(1000),
    rationale: z.string().trim().max(1000).optional(),
  })
  .strict();

/**
 * Proposes an equivalence ratio. Created DRAFT and inert: nothing reads a policy
 * until it is approved, so proposing a ratio cannot value anything.
 */
router.post("/rewards/legacy-reconciliation-policy", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const parsed = legacyReconciliationPolicySchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid reconciliation policy payload.", errors: parsed.error.flatten() });
  }

  const existing = await prisma.legacyReconciliationPolicy.findUnique({ where: { version: parsed.data.version } });
  if (existing) {
    return response.status(409).json({ message: "A reconciliation policy with that version already exists." });
  }

  const policy = await prisma.$transaction(async (transaction) => {
    const created = await transaction.legacyReconciliationPolicy.create({
      data: {
        version: parsed.data.version,
        conversionRatio: new Prisma.Decimal(parsed.data.conversionRatio),
        rationale: parsed.data.rationale || null,
        status: "DRAFT",
        createdByUserId: request.authUser!.id,
      },
    });
    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: "LEGACY_RECONCILIATION_POLICY_DRAFTED",
      targetType: "LegacyReconciliationPolicy",
      targetId: created.id,
      metadata: {
        version: created.version,
        conversionRatio: created.conversionRatio.toString(),
        rationale: created.rationale,
      },
    });
    return created;
  });

  return response.status(201).json({
    message: "Reconciliation policy drafted. It has no effect until approved.",
    policy: serializeLegacyReconciliationPolicy(policy),
  });
});

/**
 * Approves a drafted ratio, making it the one reconciliation reads.
 *
 * Deliberately a second act by a second call: drafting proposes a valuation and
 * approving authorises it, so no single request can both invent a ratio and
 * apply it to a member's balance. Any previously approved policy is retired in
 * the same transaction, and a partial unique index refuses the write if that
 * ever fails to happen.
 */
router.post(
  "/rewards/legacy-reconciliation-policy/:policyId/approve",
  requireAuth,
  requireRole("SUPER_ADMIN"),
  async (request, response) => {
    const policyId = readParam(request.params.policyId);
    if (!policyId) {
      return response.status(400).json({ message: "Invalid reconciliation policy id." });
    }

    const policy = await prisma.legacyReconciliationPolicy.findUnique({ where: { id: policyId } });
    if (!policy) {
      return response.status(404).json({ message: "Reconciliation policy was not found." });
    }
    if (policy.status !== "DRAFT") {
      return response.status(409).json({ message: `Policy is ${policy.status} and cannot be approved.` });
    }

    const approved = await prisma.$transaction(async (transaction) => {
      await transaction.legacyReconciliationPolicy.updateMany({
        where: { status: "APPROVED" },
        data: { status: "RETIRED" },
      });
      const claimed = await transaction.legacyReconciliationPolicy.updateMany({
        where: { id: policy.id, status: "DRAFT" },
        data: { status: "APPROVED", approvedAt: new Date(), approvedByUserId: request.authUser!.id },
      });
      if (claimed.count === 0) {
        throw new Error("POLICY_ALREADY_DECIDED");
      }
      const next = await transaction.legacyReconciliationPolicy.findUniqueOrThrow({ where: { id: policy.id } });
      await createAuditLog(transaction, {
        actorUserId: request.authUser!.id,
        action: "LEGACY_RECONCILIATION_POLICY_APPROVED",
        targetType: "LegacyReconciliationPolicy",
        targetId: next.id,
        metadata: { version: next.version, conversionRatio: next.conversionRatio.toString() },
      });
      return next;
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message === "POLICY_ALREADY_DECIDED") {
        return null;
      }
      throw error;
    });

    if (!approved) {
      return response.status(409).json({ message: "Policy was decided by a concurrent request." });
    }

    return response.json({
      message: "Reconciliation policy approved.",
      policy: serializeLegacyReconciliationPolicy(approved),
    });
  },
);

/** Read-only view of every proposed and approved equivalence ratio. */
router.get("/rewards/legacy-reconciliation-policy", requireAuth, requireRole("SUPER_ADMIN"), async (_request, response) => {
  const policies = await prisma.legacyReconciliationPolicy.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  return response.json({
    policies: policies.map(serializeLegacyReconciliationPolicy),
    approvedPolicyCount: policies.filter((policy) => policy.status === "APPROVED").length,
  });
});

/**
 * Strict: a request carrying `conversionRatio` or `reconciliationRuleVersion` is
 * rejected rather than silently stripped, so an old client is told its valuation
 * was refused instead of quietly having it ignored.
 */
const legacyReconciliationSchema = z
  .object({
    carryoverId: z.string().trim().min(1),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

/**
 * Applies an approved equivalence ratio to a preserved legacy balance.
 *
 * This is the only path that turns a carryover into spendable points, and it is
 * Super Admin only. History is never rewritten: the legacy rows stay untouched,
 * the carryover keeps its original `legacyPointBalance`, and the credit is
 * posted as a new immutable ledger entry recording the ratio and rule version
 * that produced it. A different ratio later is another explicit event, not an
 * edit of this one.
 */
router.post("/rewards/legacy-carryover/reconcile", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const parsed = legacyReconciliationSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid reconciliation payload.", errors: parsed.error.flatten() });
  }

  const carryover = await prisma.legacyBalanceCarryover.findUnique({ where: { id: parsed.data.carryoverId } });
  if (!carryover) {
    return response.status(404).json({ message: "Legacy carryover was not found." });
  }
  if (carryover.status !== "LEGACY_CARRYOVER_PENDING") {
    return response.status(409).json({
      message: `Carryover is ${carryover.status} and cannot be reconciled again.`,
    });
  }

  // The valuation comes from an approved, versioned policy and from nowhere
  // else. Fail-closed: with no approved policy there is no equivalence between
  // a legacy point and an authoritative one, so there is nothing to convert.
  const policy = await prisma.legacyReconciliationPolicy.findFirst({
    where: { status: "APPROVED" },
    orderBy: { approvedAt: "desc" },
  });
  if (!policy) {
    return response.status(409).json({
      message:
        "No approved legacy reconciliation policy exists. Governance must approve an equivalence ratio before any carryover can be converted.",
      code: "RECONCILIATION_POLICY_NOT_APPROVED",
    });
  }

  // Exact decimal arithmetic on the unspent balance. In binary floating point
  // 100 x 0.29 is 28.999999999999996, which floors to 28 and under-credits; and
  // converting the gross balance would pay again for legacy points a redemption
  // had already committed before the cutover.
  const valuation = await valueLegacyCarryover(prisma, {
    userId: carryover.userId,
    legacyPointBalance: carryover.legacyPointBalance,
    conversionRatio: policy.conversionRatio,
  });
  const creditedPoints = valuation.creditedPoints;

  const result = await prisma.$transaction(async (transaction) => {
    // The PENDING check above ran outside this transaction, so two simultaneous
    // requests can both reach here. This claim is the real guard: it transitions
    // the row only if it is still PENDING, and a count of 0 means another
    // request won the race. Without it both would commit, and — because the
    // batch totals below are unconditional increments — the batch would be
    // decremented twice for one reconciliation.
    const claimed = await transaction.legacyBalanceCarryover.updateMany({
      where: { id: carryover.id, status: "LEGACY_CARRYOVER_PENDING" },
      data: { status: "LEGACY_CARRYOVER_CONFIRMED" },
    });
    if (claimed.count === 0) {
      throw new Error("CARRYOVER_ALREADY_RECONCILED");
    }

    const rewardEvent = await transaction.rewardEvent.upsert({
      where: {
        eventType_sourceType_sourceId: {
          eventType: RewardQualifyingEvent.LEGACY_BALANCE_RECONCILED,
          sourceType: "LegacyBalanceCarryover",
          sourceId: carryover.id,
        },
      },
      create: {
        eventType: RewardQualifyingEvent.LEGACY_BALANCE_RECONCILED,
        sourceType: "LegacyBalanceCarryover",
        sourceId: carryover.id,
        status: RewardEventStatus.PENDING,
        idempotencyKey: `legacy-carryover:${carryover.id}`,
      },
      update: {},
    });

    const entry = await transaction.rewardLedgerEntry.upsert({
      where: {
        userId_sourceEventId_category: {
          userId: carryover.userId,
          sourceEventId: rewardEvent.id,
          category: RewardLedgerCategory.LEGACY_CARRYOVER,
        },
      },
      create: {
        userId: carryover.userId,
        points: creditedPoints,
        category: RewardLedgerCategory.LEGACY_CARRYOVER,
        sourceEventType: RewardQualifyingEvent.LEGACY_BALANCE_RECONCILED,
        sourceEventId: rewardEvent.id,
        description:
          `Legacy balance reconciled: ${carryover.legacyPointBalance} legacy points ` +
          `x ${policy.conversionRatio.toString()} = ${creditedPoints} points ` +
          `(policy ${policy.version})`,
      },
      update: {},
    });

    await transaction.rewardEvent.update({
      where: { id: rewardEvent.id },
      data: { status: RewardEventStatus.PROCESSED, processedAt: new Date() },
    });

    const updated = await transaction.legacyBalanceCarryover.update({
      where: { id: carryover.id },
      data: {
        conversionRatio: policy.conversionRatio,
        reconciliationRuleVersion: policy.version,
        reconciliationPolicyId: policy.id,
        creditedPoints,
        reconciledLedgerEntryId: entry.id,
        reconciledAt: new Date(),
        reconciledByUserId: request.authUser!.id,
      },
    });

    await transaction.legacyMigrationBatch.update({
      where: { id: carryover.migrationBatchId },
      data: {
        // Both sides move on the same basis: the gross balance leaves the
        // pending pool, and the gross is what the batch recorded as pending, so
        // the two cannot drift. creditedPoints is the converted net and is
        // tracked separately.
        pendingTotalPoints: { decrement: carryover.legacyPointBalance },
        reconciledTotalPoints: { increment: creditedPoints },
      },
    });

    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: "LEGACY_BALANCE_RECONCILED",
      targetType: "LegacyBalanceCarryover",
      targetId: carryover.id,
      metadata: {
        sourceBalance: carryover.legacyPointBalance,
        reconciliationPolicyId: policy.id,
        reconciliationPolicyVersion: policy.version,
        conversionRatio: policy.conversionRatio.toString(),
        // Recorded so an auditor can see that this member held a legacy-era
        // claim which the credit did not settle; what to do about it is an
        // open reconciliation policy question.
        preCutoverReservedPoints: valuation.preCutoverReservedPoints,
        creditedPoints,
        ruleVersion: policy.version,
        ledgerEntryId: entry.id,
        note: parsed.data.note || null,
      },
    });

    return updated;
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === "CARRYOVER_ALREADY_RECONCILED") {
      return null;
    }
    throw error;
  });

  // A concurrent request won the claim. Reported as the same 409 the
  // pre-transaction check returns, so a duplicate never reads as a success.
  if (!result) {
    return response.status(409).json({ message: "Carryover has already been reconciled." });
  }

  return response.json({
    message: "Legacy balance reconciled and credited to the authoritative ledger.",
    carryover: {
      id: result.id,
      userId: result.userId,
      status: result.status,
      sourceBalance: carryover.legacyPointBalance,
      conversionRatio: policy.conversionRatio.toString(),
      creditedPoints: result.creditedPoints,
      ruleVersion: result.reconciliationRuleVersion,
      reconciliationPolicyId: policy.id,
    },
  });
});

/** Read-only view of preserved legacy balances and cutover totals. */
router.get("/rewards/legacy-carryover", requireAuth, requireRole("SUPER_ADMIN"), async (_request, response) => {
  const [carryovers, batches] = await Promise.all([
    prisma.legacyBalanceCarryover.findMany({
      include: { user: { select: { name: true, email: true } } },
      orderBy: { legacyPointBalance: "desc" },
      take: 200,
    }),
    prisma.legacyMigrationBatch.findMany({ orderBy: { executedAt: "desc" } }),
  ]);

  return response.json({
    batches: batches.map((batch) => ({
      id: batch.id,
      executedAt: batch.executedAt.toISOString(),
      sourceLedger: batch.sourceLedger,
      memberCount: batch.memberCount,
      beforeTotalPoints: batch.beforeTotalPoints,
      migratedTotalPoints: batch.migratedTotalPoints,
      pendingTotalPoints: batch.pendingTotalPoints,
      reconciledTotalPoints: batch.reconciledTotalPoints,
      snapshotChecksum: batch.snapshotChecksum,
    })),
    carryovers: carryovers.map((entry) => ({
      id: entry.id,
      userId: entry.userId,
      memberName: entry.user.name,
      legacyPointBalance: entry.legacyPointBalance,
      status: entry.status,
      conversionRatio: entry.conversionRatio ? entry.conversionRatio.toString() : null,
      creditedPoints: entry.creditedPoints,
      reconciliationRuleVersion: entry.reconciliationRuleVersion,
      rowChecksum: entry.rowChecksum,
    })),
  });
});

router.get("/rewards/ledger", requireAuth, async (request, response) => {
  const parsed = rewardLedgerQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid reward ledger query.", errors: parsed.error.flatten() });
  }

  const targetUserId = parsed.data.userId || request.authUser!.id;
  if (targetUserId !== request.authUser!.id && request.authUser!.role !== "SUPER_ADMIN") {
    return response.status(403).json({ message: "Only Super Admin can inspect another user's reward ledger." });
  }

  const entries = await prisma.rewardLedgerEntry.findMany({
    where: {
      userId: targetUserId,
      category: parsed.data.category,
    },
    include: {
      relatedUser: { select: { name: true, email: true } },
      rewardRuleVersion: { select: { version: true, rewardRule: { select: { name: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return response.json({ rewardLedgerEntries: entries.map(serializeRewardLedgerEntry) });
});

router.get("/referrals/stats", requireAuth, async (request, response) => {
  const parsed = scopedQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid referral stats query.", errors: parsed.error.flatten() });
  }
  if (!(await canViewCommandTerritory(request.authUser!, parsed.data.territoryType, parsed.data.territoryId))) {
    return response.status(403).json({ message: "You do not have permission to view this territory." });
  }

  const voterScope = buildScopedVoterProfileWhere(parsed.data.territoryType, parsed.data.territoryId);
  const [directRegistrations, directVerifiedRegistrations, networkRegistrations, networkVerifiedRegistrations] =
    await Promise.all([
      prisma.referral.count({ where: { referrerUserId: request.authUser!.id } }),
      prisma.referral.count({
        where: {
          referrerUserId: request.authUser!.id,
          status: { in: [ReferralStatus.QUALIFIED, ReferralStatus.REWARD_PROCESSED] },
        },
      }),
      prisma.referral.count({ where: { referredUser: { voterProfile: { is: voterScope } } } }),
      prisma.referral.count({
        where: {
          status: { in: [ReferralStatus.QUALIFIED, ReferralStatus.REWARD_PROCESSED] },
          referredUser: { voterProfile: { is: voterScope } },
        },
      }),
    ]);

  return response.json({
    territoryType: parsed.data.territoryType,
    territoryId: parsed.data.territoryId,
    directRegistrations,
    directVerifiedRegistrations,
    networkRegistrations,
    networkVerifiedRegistrations,
  });
});

router.get("/referrals", requireAuth, async (request, response) => {
  const parsed = referralManagementQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid referral query.", errors: parsed.error.flatten() });
  }
  if (Boolean(parsed.data.territoryType) !== Boolean(parsed.data.territoryId)) {
    return response.status(400).json({ message: "territoryType and territoryId must be supplied together." });
  }
  if (
    parsed.data.territoryType &&
    parsed.data.territoryId &&
    !(await canViewCommandTerritory(request.authUser!, parsed.data.territoryType, parsed.data.territoryId))
  ) {
    return response.status(403).json({ message: "You do not have permission to view this territory." });
  }

  const search = parsed.data.search?.trim();
  const voterScope =
    parsed.data.territoryType && parsed.data.territoryId
      ? buildScopedVoterProfileWhere(parsed.data.territoryType, parsed.data.territoryId)
      : undefined;
  const ownDirectOnly =
    !voterScope && request.authUser!.role !== "SUPER_ADMIN" && request.authUser!.role !== "STATE_OFFICER";

  const referrals = await prisma.referral.findMany({
    where: {
      status: parsed.data.status,
      referrerUserId: ownDirectOnly ? request.authUser!.id : undefined,
      referredUser: voterScope || search
        ? {
            voterProfile: voterScope ? { is: voterScope } : undefined,
            OR: search
              ? [
                  { name: { contains: search, mode: "insensitive" } },
                  { email: { contains: search, mode: "insensitive" } },
                ]
              : undefined,
          }
        : undefined,
    },
    include: {
      referredUser: { select: { name: true, email: true, voterProfile: { select: { wardId: true, pollingUnitId: true } } } },
      referrerUser: { select: { name: true, email: true } },
    },
    orderBy: { registeredAt: "desc" },
    take: 200,
  });
  const items = referrals.map(serializeReferral);

  if (parsed.data.export === "csv") {
    return sendCsv(response, "pre-election-referrals.csv", [
      ["id", "referredName", "referredEmail", "referrerName", "status", "referralCode", "registeredAt", "qualifiedAt"],
      ...items.map((item) => [
        item.id,
        item.referredName,
        item.referredEmail,
        item.referrerName,
        item.status,
        item.referralCode,
        item.registeredAt,
        item.qualifiedAt || "",
      ]),
    ]);
  }

  const statusCounts = items.reduce<Record<string, number>>((accumulator, item) => {
    accumulator[item.status] = (accumulator[item.status] || 0) + 1;
    return accumulator;
  }, {});

  return response.json({
    referrals: items,
    summary: {
      total: items.length,
      qualified: statusCounts.QUALIFIED || 0,
      rewardProcessed: statusCounts.REWARD_PROCESSED || 0,
      pendingVerification: statusCounts.PENDING_VERIFICATION || 0,
      rejected: statusCounts.REJECTED || 0,
      flagged: statusCounts.FLAGGED || 0,
    },
  });
});

router.post("/payout/configurations", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const parsed = payoutConfigurationSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid payout configuration payload.", errors: parsed.error.flatten() });
  }

  const configuration = await prisma.$transaction(async (transaction) => {
    await transaction.payoutConfiguration.updateMany({ where: { active: true }, data: { active: false } });
    const created = await transaction.payoutConfiguration.create({
      data: {
        minimumPoints: parsed.data.minimumPoints,
        pointConversionRate: new Prisma.Decimal(parsed.data.pointConversionRate),
        frequency: parsed.data.frequency,
        nextPayoutDate: parsed.data.nextPayoutDate ? new Date(parsed.data.nextPayoutDate) : null,
        createdByUserId: request.authUser!.id,
      },
    });
    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: "PAYOUT_CONFIGURATION_CREATED",
      targetType: "PayoutConfiguration",
      targetId: created.id,
      metadata: { minimumPoints: created.minimumPoints, frequency: created.frequency },
    });
    return created;
  });

  return response.status(201).json({
    message: "Payout configuration created.",
    payoutConfiguration: {
      ...configuration,
      pointConversionRate: configuration.pointConversionRate.toString(),
      nextPayoutDate: configuration.nextPayoutDate?.toISOString() || null,
    },
  });
});

router.get("/payout/configurations/active", requireAuth, requireRole("SUPER_ADMIN", "PAYOUT_OFFICER"), async (_request, response) => {
  const configuration = await prisma.payoutConfiguration.findFirst({
    where: { active: true },
    orderBy: { createdAt: "desc" },
  });
  return response.json({
    payoutConfiguration: configuration
      ? {
          ...configuration,
          pointConversionRate: configuration.pointConversionRate.toString(),
          nextPayoutDate: configuration.nextPayoutDate?.toISOString() || null,
        }
      : null,
  });
});

router.get("/payout/officers", requireAuth, requireRole("SUPER_ADMIN"), async (_request, response) => {
  const officers = await prisma.user.findMany({
    where: { role: UserRole.PAYOUT_OFFICER, isActive: true, accountStatus: "ACTIVE" },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true },
  });

  return response.json({ payoutOfficers: officers });
});

router.post("/payout/cycles", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const parsed = payoutCycleSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid payout cycle payload.", errors: parsed.error.flatten() });
  }

  const opensAt = new Date(parsed.data.opensAt);
  const closesAt = new Date(parsed.data.closesAt);
  const payoutDate = new Date(parsed.data.payoutDate);
  if (closesAt <= opensAt || payoutDate < opensAt) {
    return response.status(400).json({ message: "Payout cycle dates are inconsistent." });
  }

  // The cycle's terms are snapshotted from versioned configuration, so they are
  // immutable for the cycle's lifetime and were never chosen by a caller.
  let terms: PayoutTerms;
  try {
    terms = await resolveActivePayoutTerms(prisma);
  } catch {
    return response.status(400).json({ message: "Create an active payout configuration before opening a payout cycle." });
  }

  const cycle = await prisma.$transaction(async (transaction) => {
    const created = await transaction.payoutCycle.create({
      data: {
        name: parsed.data.name,
        opensAt,
        closesAt,
        payoutDate,
        minimumThreshold: terms.minimumThreshold,
        conversionRate: terms.conversionRate,
        // Provenance for the amounts this cycle will pay: the configuration row
        // the terms came from. Its absence is what marks a pre-authority cycle.
        payoutConfigurationId: terms.payoutConfigurationId,
        status: PayoutStatus.PENDING,
      },
    });
    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: "PAYOUT_CYCLE_CREATED",
      targetType: "PayoutCycle",
      targetId: created.id,
      metadata: { minimumThreshold: created.minimumThreshold },
    });
    return created;
  });

  return response.status(201).json({
    message: "Payout cycle created.",
    payoutCycle: { ...cycle, conversionRate: cycle.conversionRate.toString() },
  });
});

router.get("/payout/cycles", requireAuth, requireRole("SUPER_ADMIN", "PAYOUT_OFFICER"), async (_request, response) => {
  const cycles = await prisma.payoutCycle.findMany({ orderBy: { payoutDate: "desc" }, take: 50 });
  return response.json({
    payoutCycles: cycles.map((cycle) => ({ ...cycle, conversionRate: cycle.conversionRate.toString() })),
  });
});

router.get("/payout/eligibility", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const parsed = payoutEligibilityQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid payout eligibility query.", errors: parsed.error.flatten() });
  }

  const search = parsed.data.search?.trim();
  const beneficiaryUserIds = search
    ? (
        await prisma.user.findMany({
          where: {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
            ],
          },
          select: { id: true },
          take: 100,
        })
      ).map((user) => user.id)
    : undefined;

  const cycle = parsed.data.cycleId
    ? await prisma.payoutCycle.findUnique({ where: { id: parsed.data.cycleId } })
    : null;
  const activeConfiguration = !cycle
    ? await prisma.payoutConfiguration.findFirst({ where: { active: true }, orderBy: { createdAt: "desc" } })
    : null;
  if (!cycle && !activeConfiguration) {
    return response.status(400).json({ message: "Create a payout cycle or active payout configuration first." });
  }

  const eligibilityCycle = cycle || {
    id: "active-configuration",
    minimumThreshold: activeConfiguration!.minimumPoints,
    conversionRate: activeConfiguration!.pointConversionRate,
  };
  const eligible = await prisma.$transaction((transaction) =>
    calculateEligibleBeneficiaries(transaction, eligibilityCycle, beneficiaryUserIds),
  );
  const users = await prisma.user.findMany({
    where: { id: { in: eligible.map((item) => item.userId) } },
    select: { id: true, name: true, email: true },
  });
  const userById = new Map(users.map((user) => [user.id, user]));

  return response.json({
    payoutEligibility: eligible.map((item) => ({
      userId: item.userId,
      name: userById.get(item.userId)?.name || null,
      email: userById.get(item.userId)?.email || null,
      availablePoints: item.availablePoints,
      amount: decimalToString(item.amount),
    })),
    minimumThreshold: eligibilityCycle.minimumThreshold,
    conversionRate: eligibilityCycle.conversionRate.toString(),
  });
});

router.post("/payout/cycles/:cycleId/batches", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const parsed = payoutBatchSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid payout batch payload.", errors: parsed.error.flatten() });
  }

  const cycleId = readParam(request.params.cycleId);
  if (!cycleId) {
    return response.status(400).json({ message: "Invalid payout cycle id." });
  }

  const result = await prisma.$transaction(async (transaction) => {
    const [cycle, payoutOfficer] = await Promise.all([
      transaction.payoutCycle.findUnique({ where: { id: cycleId } }),
      transaction.user.findUnique({ where: { id: parsed.data.payoutOfficerUserId }, select: { id: true, role: true, accountStatus: true, isActive: true } }),
    ]);
    if (!cycle) {
      throw new Error("CYCLE_NOT_FOUND");
    }
    if (!payoutOfficer || payoutOfficer.role !== UserRole.PAYOUT_OFFICER || !payoutOfficer.isActive || payoutOfficer.accountStatus !== "ACTIVE") {
      throw new Error("INVALID_PAYOUT_OFFICER");
    }

    const eligible = await calculateEligibleBeneficiaries(transaction, cycle, parsed.data.beneficiaryUserIds);
    if (eligible.length === 0) {
      throw new Error("NO_ELIGIBLE_BENEFICIARIES");
    }

    const batch = await transaction.payoutBatch.create({
      data: { payoutCycleId: cycle.id, status: PayoutStatus.ELIGIBLE },
    });

    await transaction.payoutAssignment.createMany({
      data: eligible.map((beneficiary) => ({
        payoutCycleId: cycle.id,
        payoutBatchId: batch.id,
        payoutOfficerUserId: parsed.data.payoutOfficerUserId,
        beneficiaryUserId: beneficiary.userId,
        points: beneficiary.availablePoints,
        amount: beneficiary.amount,
        status: PayoutStatus.ELIGIBLE,
      })),
      skipDuplicates: true,
    });

    await transaction.payoutCycle.update({ where: { id: cycle.id }, data: { status: PayoutStatus.ELIGIBLE } });
    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: "PAYOUT_BATCH_CREATED",
      targetType: "PayoutBatch",
      targetId: batch.id,
      metadata: { payoutCycleId: cycle.id, eligibleCount: eligible.length },
    });

    return transaction.payoutBatch.findUniqueOrThrow({
      where: { id: batch.id },
      include: {
        assignments: {
          include: { beneficiaryUser: { select: { name: true, email: true } }, payoutOfficerUser: { select: { name: true, email: true } } },
          orderBy: { assignedAt: "asc" },
        },
      },
    });
  }).catch((error: unknown) => {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  });

  if (result instanceof Error) {
    if (result.message === "CYCLE_NOT_FOUND") {
      return response.status(404).json({ message: "Payout cycle was not found." });
    }
    if (result.message === "INVALID_PAYOUT_OFFICER") {
      return response.status(400).json({ message: "A valid active Payout Officer is required." });
    }
    if (result.message === "NO_ELIGIBLE_BENEFICIARIES") {
      return response.status(400).json({ message: "No beneficiaries meet the payout threshold." });
    }
    throw result;
  }

  return response.status(201).json({
    message: "Payout batch created.",
    payoutBatch: {
      id: result.id,
      payoutCycleId: result.payoutCycleId,
      status: result.status,
      assignments: result.assignments.map(serializePayoutAssignment),
    },
  });
});

router.get("/payout/batches", requireAuth, requireRole("SUPER_ADMIN", "PAYOUT_OFFICER"), async (request, response) => {
  const parsed = payoutBatchQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid payout batch query.", errors: parsed.error.flatten() });
  }
  const officerOnly = request.authUser!.role === "PAYOUT_OFFICER";
  const batches = await prisma.payoutBatch.findMany({
    where: {
      status: parsed.data.status,
      assignments: officerOnly ? { some: { payoutOfficerUserId: request.authUser!.id } } : undefined,
    },
    include: {
      payoutCycle: { select: { name: true, payoutDate: true } },
      assignments: {
        where: officerOnly ? { payoutOfficerUserId: request.authUser!.id } : undefined,
        include: {
          beneficiaryUser: { select: { name: true, email: true } },
          payoutOfficerUser: { select: { name: true, email: true } },
          transactions: { orderBy: { createdAt: "desc" } },
        },
        orderBy: { assignedAt: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return response.json({ payoutBatches: batches.map(serializePayoutBatchWithAssignments) });
});

router.patch("/payout/batches/:batchId/approve", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const batchId = readParam(request.params.batchId);
  if (!batchId) {
    return response.status(400).json({ message: "Invalid payout batch id." });
  }

  const batch = await prisma.$transaction(async (transaction) => {
    const existing = await transaction.payoutBatch.findUnique({ where: { id: batchId } });
    if (!existing) {
      throw new Error("NOT_FOUND");
    }
    if (existing.status !== PayoutStatus.ELIGIBLE && existing.status !== PayoutStatus.PENDING) {
      throw new Error("NOT_APPROVABLE");
    }
    await transaction.payoutAssignment.updateMany({
      where: { payoutBatchId: existing.id, status: { in: [PayoutStatus.PENDING, PayoutStatus.ELIGIBLE] } },
      data: { status: PayoutStatus.APPROVED },
    });
    const updated = await transaction.payoutBatch.update({
      where: { id: existing.id },
      data: { status: PayoutStatus.APPROVED, approvedAt: new Date() },
    });
    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: "PAYOUT_BATCH_APPROVED",
      targetType: "PayoutBatch",
      targetId: existing.id,
    });
    return updated;
  }).catch((error: unknown) => (error instanceof Error ? error : Promise.reject(error)));

  if (batch instanceof Error) {
    if (batch.message === "NOT_FOUND") {
      return response.status(404).json({ message: "Payout batch was not found." });
    }
    if (batch.message === "NOT_APPROVABLE") {
      return response.status(409).json({ message: "Payout batch cannot be approved from its current status." });
    }
    throw batch;
  }

  return response.json({ message: "Payout batch approved.", payoutBatch: batch });
});

router.get("/payout/assignments", requireAuth, requireRole("SUPER_ADMIN", "PAYOUT_OFFICER"), async (request, response) => {
  const parsed = payoutAssignmentQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid payout assignment query.", errors: parsed.error.flatten() });
  }

  const assignments = await prisma.payoutAssignment.findMany({
    where: {
      status: parsed.data.status,
      payoutOfficerUserId: request.authUser!.role === "PAYOUT_OFFICER" ? request.authUser!.id : undefined,
    },
    include: {
      beneficiaryUser: { select: { name: true, email: true } },
      payoutOfficerUser: { select: { name: true, email: true } },
      transactions: { orderBy: { createdAt: "desc" } },
    },
    orderBy: { assignedAt: "desc" },
    take: 100,
  });

  return response.json({ payoutAssignments: assignments.map(serializePayoutAssignment) });
});

router.patch("/payout/assignments/:assignmentId/status", requireAuth, requireRole("SUPER_ADMIN", "PAYOUT_OFFICER"), async (request, response) => {
  const parsed = payoutAssignmentStatusSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid payout status payload.", errors: parsed.error.flatten() });
  }

  const assignmentId = readParam(request.params.assignmentId);
  if (!assignmentId) {
    return response.status(400).json({ message: "Invalid payout assignment id." });
  }
  if (parsed.data.status === "PAID" && !parsed.data.paymentReference) {
    return response.status(400).json({ message: "paymentReference is required when marking a payout paid." });
  }

  // Narrowed to a const before the branch below. After the PAID case returns,
  // `nextStatus` is typed as the non-PAID members of the union, so the generic
  // status writer further down cannot emit PAID even if this branch were later
  // removed — the compiler rejects it. The repository scanner cannot see a
  // variable status, so this is the guard that actually holds that line.
  const nextStatus = parsed.data.status;

  // Paying is not this route's to do. It owns the non-money transitions below;
  // the PAID transition, its kill switch, its valuation, its atomic claim and
  // its execution record all belong to the one execution authority.
  if (nextStatus === "PAID") {
    const assignment = await prisma.payoutAssignment.findUnique({
      where: { id: assignmentId },
      select: { payoutOfficerUserId: true },
    });
    if (!assignment) {
      return response.status(404).json({ message: "Payout assignment was not found." });
    }
    if (request.authUser!.role === "PAYOUT_OFFICER" && assignment.payoutOfficerUserId !== request.authUser!.id) {
      return response.status(403).json({ message: "Payout Officer can only process assigned payouts." });
    }

    try {
      await executePayout(prisma, {
        kind: "ASSIGNMENT",
        assignmentId,
        actorUserId: request.authUser!.id,
        paymentReference: parsed.data.paymentReference!,
        proofStorageKey: parsed.data.proofStorageKey || null,
        note: parsed.data.note || null,
      });
    } catch (error) {
      if (error instanceof PayoutExecutionDisabledError) {
        return response.status(409).json({ message: error.message, payoutExecutionEnabled: false });
      }
      if (error instanceof PayoutExecutionError) {
        return response.status(payoutExecutionStatusCode(error.code)).json({ message: error.message, code: error.code });
      }
      throw error;
    }

    const paid = await prisma.payoutAssignment.findUniqueOrThrow({
      where: { id: assignmentId },
      include: {
        beneficiaryUser: { select: { name: true, email: true } },
        payoutOfficerUser: { select: { name: true, email: true } },
        transactions: { orderBy: { createdAt: "desc" } },
      },
    });
    return response.json({ message: "Payout assignment updated.", payoutAssignment: serializePayoutAssignment(paid) });
  }

  // Compiler-enforced, not merely narrowed: if the PAID branch above were
  // deleted or reordered, `nextStatus` would still include "PAID" and this
  // annotation would fail to typecheck. The repository scanner matches only a
  // literal PAID and cannot see a variable status, so this is what actually
  // holds the line on the generic writer below.
  const nonPayingStatus: "PROCESSING" | "HELD" | "REJECTED" = nextStatus;

  const result = await prisma.$transaction(async (transaction) => {
    const assignment = await transaction.payoutAssignment.findUnique({
      where: { id: assignmentId },
      include: { transactions: true },
    });
    if (!assignment) {
      throw new Error("NOT_FOUND");
    }
    if (request.authUser!.role === "PAYOUT_OFFICER" && assignment.payoutOfficerUserId !== request.authUser!.id) {
      throw new Error("NOT_ASSIGNED");
    }
    if (assignment.status === PayoutStatus.PAID || assignment.status === PayoutStatus.REJECTED) {
      throw new Error("FINALIZED");
    }
    if (nonPayingStatus === "PROCESSING" && assignment.status !== PayoutStatus.APPROVED) {
      throw new Error("INVALID_TRANSITION");
    }
    const updated = await transaction.payoutAssignment.update({
      where: { id: assignment.id },
      data: {
        status: nonPayingStatus,
        processedAt: ["HELD", "REJECTED"].includes(nonPayingStatus) ? new Date() : assignment.processedAt,
        note: parsed.data.note || assignment.note,
      },
      include: {
        beneficiaryUser: { select: { name: true, email: true } },
        payoutOfficerUser: { select: { name: true, email: true } },
        transactions: { orderBy: { createdAt: "desc" } },
      },
    });

    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: `PAYOUT_ASSIGNMENT_${nonPayingStatus}`,
      targetType: "PayoutAssignment",
      targetId: assignment.id,
      metadata: { fromStatus: assignment.status, toStatus: nonPayingStatus },
    });

    return updated;
  }).catch((error: unknown) => (error instanceof Error ? error : Promise.reject(error)));

  if (result instanceof Error) {
    if (result.message === "NOT_FOUND") {
      return response.status(404).json({ message: "Payout assignment was not found." });
    }
    if (result.message === "NOT_ASSIGNED") {
      return response.status(403).json({ message: "Payout Officer can only process assigned payouts." });
    }
    if (result.message === "FINALIZED") {
      return response.status(409).json({ message: "Finalized payout assignments cannot be changed." });
    }
    if (result.message === "INVALID_TRANSITION") {
      return response.status(409).json({ message: "Invalid payout status transition." });
    }
    throw result;
  }

  return response.json({ message: "Payout assignment updated.", payoutAssignment: serializePayoutAssignment(result) });
});

router.post("/strength/metrics", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const parsed = strengthMetricSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid strength metric payload.", errors: parsed.error.flatten() });
  }

  const metric = await prisma.strengthMetricDefinition.upsert({
    where: { metric: parsed.data.metric },
    create: { ...parsed.data, createdByUserId: request.authUser!.id },
    update: { description: parsed.data.description, active: true },
  });

  return response.status(201).json({ message: "Strength metric configured.", strengthMetric: metric });
});

router.post("/strength/weights", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const parsed = strengthWeightSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid strength weight payload.", errors: parsed.error.flatten() });
  }

  const effectiveFrom = parsed.data.effectiveFrom ? new Date(parsed.data.effectiveFrom) : new Date();
  const effectiveUntil = parsed.data.effectiveUntil ? new Date(parsed.data.effectiveUntil) : null;
  if (effectiveUntil && effectiveUntil <= effectiveFrom) {
    return response.status(400).json({ message: "effectiveUntil must be after effectiveFrom." });
  }

  const weight = await prisma.strengthWeightConfiguration.create({
    data: {
      metric: parsed.data.metric,
      weight: new Prisma.Decimal(parsed.data.weight),
      effectiveFrom,
      effectiveUntil,
      createdByUserId: request.authUser!.id,
    },
  });

  return response.status(201).json({ message: "Strength weight configured.", strengthWeight: { ...weight, weight: weight.weight.toString() } });
});

router.post("/strength/targets", requireAuth, requireRole("SUPER_ADMIN", "STATE_OFFICER"), async (request, response) => {
  const parsed = territoryTargetSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid territory target payload.", errors: parsed.error.flatten() });
  }
  if (!(await canViewCommandTerritory(request.authUser!, parsed.data.territoryType, parsed.data.territoryId))) {
    return response.status(403).json({ message: "You do not have permission to configure this territory." });
  }

  const startDate = new Date(parsed.data.startDate);
  const endDate = parsed.data.endDate ? new Date(parsed.data.endDate) : null;
  if (endDate && endDate <= startDate) {
    return response.status(400).json({ message: "endDate must be after startDate." });
  }

  const target = await prisma.territoryTarget.create({
    data: {
      candidateId: parsed.data.candidateId || null,
      territoryType: parsed.data.territoryType,
      territoryId: parsed.data.territoryId,
      metric: parsed.data.metric,
      targetValue: parsed.data.targetValue,
      startDate,
      endDate,
      createdByUserId: request.authUser!.id,
    },
  });

  return response.status(201).json({ message: "Territory target created.", territoryTarget: target });
});

router.post("/strength/snapshots/calculate", requireAuth, requireRole("SUPER_ADMIN", "STATE_OFFICER"), async (request, response) => {
  const parsed = strengthSnapshotSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid strength snapshot payload.", errors: parsed.error.flatten() });
  }
  if (!(await canViewCommandTerritory(request.authUser!, parsed.data.territoryType, parsed.data.territoryId))) {
    return response.status(403).json({ message: "You do not have permission to calculate this territory." });
  }

  const now = new Date();
  const metrics = await prisma.strengthMetricDefinition.findMany({ where: { active: true }, orderBy: { metric: "asc" } });
  if (metrics.length === 0) {
    return response.status(400).json({ message: "At least one active strength metric is required." });
  }

  const breakdown = [];
  let weightedScore = new Prisma.Decimal(0);
  let totalWeight = new Prisma.Decimal(0);

  for (const metricDefinition of metrics) {
    const [actualValue, target, weightConfiguration] = await Promise.all([
      calculateMetricActual(parsed.data.territoryType, parsed.data.territoryId, metricDefinition.metric),
      getTargetForMetric(parsed.data.territoryType, parsed.data.territoryId, metricDefinition.metric, now),
      prisma.strengthWeightConfiguration.findFirst({
        where: {
          metric: metricDefinition.metric,
          effectiveFrom: { lte: now },
          OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }],
        },
        orderBy: { effectiveFrom: "desc" },
      }),
    ]);

    await prisma.territoryMetricSnapshot.create({
      data: {
        territoryType: parsed.data.territoryType,
        territoryId: parsed.data.territoryId,
        metric: metricDefinition.metric,
        actualValue,
        calculatedAt: now,
        /**
         * Stamped with the member-scope semantics this value was calculated
         * under, so a consumer can tell a current actual from one produced
         * before member scope moved onto the ward graph.
         */
        metadataJson: {
          source: "PRE_ELECTION_API",
          memberTerritoryScopeVersion: MEMBER_TERRITORY_SCOPE_VERSION,
        },
      },
    });

    const weight = weightConfiguration?.weight || new Prisma.Decimal(1);
    const targetValue = target?.targetValue ?? null;
    const percentageAchieved =
      targetValue && targetValue > 0 ? Math.min((actualValue / targetValue) * 100, 100) : actualValue > 0 ? 100 : 0;
    const contribution = new Prisma.Decimal(percentageAchieved).mul(weight);
    weightedScore = weightedScore.add(contribution);
    totalWeight = totalWeight.add(weight);
    breakdown.push({
      metric: metricDefinition.metric,
      actualValue,
      targetValue,
      percentageAchieved: Number(percentageAchieved.toFixed(2)),
      shortfall: targetValue === null ? null : Math.max(targetValue - actualValue, 0),
      weight: weight.toString(),
      contribution: contribution.toFixed(4),
    });
  }

  const score = totalWeight.greaterThan(0) ? weightedScore.div(totalWeight).toDecimalPlaces(4) : new Prisma.Decimal(0);
  /**
   * Trend compares like with like. The most recent snapshot may have been
   * calculated under the old member scope, and reporting the difference between
   * two calculation generations as a trend would announce an improvement that
   * only reflects a change in how the number is derived.
   */
  const previousCandidates = await prisma.territoryStrengthSnapshot.findMany({
    where: { territoryType: parsed.data.territoryType, territoryId: parsed.data.territoryId, candidateId: parsed.data.candidateId || null },
    orderBy: { calculatedAt: "desc" },
    take: SNAPSHOT_COMPATIBILITY_SCAN_LIMIT,
  });
  const previousSnapshot = selectCurrentMemberTerritorySnapshots(previousCandidates, 1)[0] || null;
  const snapshot = await prisma.territoryStrengthSnapshot.create({
    data: {
      territoryType: parsed.data.territoryType,
      territoryId: parsed.data.territoryId,
      candidateId: parsed.data.candidateId || null,
      score,
      /**
       * Stamped with the member-scope semantics this score was calculated
       * under. The dashboard prefers a snapshot over its own live count, so an
       * unversioned snapshot from before member scope moved onto the ward graph
       * must be ignorable rather than authoritative forever.
       */
      breakdownJson: { memberTerritoryScopeVersion: MEMBER_TERRITORY_SCOPE_VERSION, metrics: breakdown },
      calculatedAt: now,
    },
  });

  return response.status(201).json({
    message: "Strength snapshot calculated.",
    strengthSnapshot: {
      ...snapshot,
      score: snapshot.score.toString(),
      trend: trendFromScores(snapshot.score, previousSnapshot?.score),
      breakdown,
    },
  });
});

router.get("/strength/snapshots/latest", requireAuth, async (request, response) => {
  const parsed = scopedQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid strength snapshot query.", errors: parsed.error.flatten() });
  }
  if (!(await canViewCommandTerritory(request.authUser!, parsed.data.territoryType, parsed.data.territoryId))) {
    return response.status(403).json({ message: "You do not have permission to view this territory." });
  }

  /**
   * Only snapshots calculated under current member-scope semantics. An obsolete
   * one is a historical record, not the territory's current strength, and
   * presenting it here is what let this surface print 0 beside a command
   * dashboard showing the correct score for the same territory.
   */
  const snapshotCandidates = await prisma.territoryStrengthSnapshot.findMany({
    where: { territoryType: parsed.data.territoryType, territoryId: parsed.data.territoryId },
    orderBy: { calculatedAt: "desc" },
    take: SNAPSHOT_COMPATIBILITY_SCAN_LIMIT,
  });
  const snapshots = selectCurrentMemberTerritorySnapshots(snapshotCandidates, 2);
  const latest = snapshots[0] || null;

  return response.json({
    strengthSnapshot: latest
      ? {
          ...latest,
          score: latest.score.toString(),
          trend: trendFromScores(latest.score, snapshots[1]?.score),
        }
      : null,
  });
});

router.get("/strength/targets/progress", requireAuth, async (request, response) => {
  const parsed = scopedQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid target progress query.", errors: parsed.error.flatten() });
  }
  if (!(await canViewCommandTerritory(request.authUser!, parsed.data.territoryType, parsed.data.territoryId))) {
    return response.status(403).json({ message: "You do not have permission to view this territory." });
  }

  const targets = await prisma.territoryTarget.findMany({
    where: { territoryType: parsed.data.territoryType, territoryId: parsed.data.territoryId },
    orderBy: { startDate: "desc" },
  });

  const progress = await Promise.all(
    targets.map(async (target) => {
      /**
       * A stored actual is current only if it was calculated under the current
       * member scope. An older one is a historical record, not this target's
       * progress; where none exists the value is recomputed through the same
       * `calculateMetricActual` path `/strength/dashboard` uses, so the two
       * endpoints cannot disagree about the same target.
       */
      const metricSnapshots = await prisma.territoryMetricSnapshot.findMany({
        where: { territoryType: target.territoryType, territoryId: target.territoryId, metric: target.metric },
        orderBy: { calculatedAt: "desc" },
        take: SNAPSHOT_COMPATIBILITY_SCAN_LIMIT,
      });
      const compatibleSnapshot = metricSnapshots.find((snapshot) =>
        isCurrentMemberTerritoryMetricSnapshot(snapshot),
      );
      const actualValue =
        compatibleSnapshot?.actualValue ??
        (await calculateMetricActual(target.territoryType, target.territoryId, target.metric));
      return {
        targetId: target.id,
        metric: target.metric,
        territoryType: target.territoryType,
        territoryId: target.territoryId,
        targetValue: target.targetValue,
        actualValue,
        percentageAchieved: target.targetValue > 0 ? Number(Math.min((actualValue / target.targetValue) * 100, 100).toFixed(2)) : 0,
        shortfall: Math.max(target.targetValue - actualValue, 0),
      };
    }),
  );

  return response.json({ progress });
});

router.get("/strength/dashboard", requireAuth, async (request, response) => {
  const parsed = scopedQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid strength dashboard query.", errors: parsed.error.flatten() });
  }
  if (!(await canViewCommandTerritory(request.authUser!, parsed.data.territoryType, parsed.data.territoryId))) {
    return response.status(403).json({ message: "You do not have permission to view this territory." });
  }

  const [latestSnapshots, targets, coordinatorProfiles] = await Promise.all([
    prisma.territoryStrengthSnapshot.findMany({
      where: { territoryType: parsed.data.territoryType, territoryId: parsed.data.territoryId },
      orderBy: { calculatedAt: "desc" },
      take: SNAPSHOT_COMPATIBILITY_SCAN_LIMIT,
    }),
    prisma.territoryTarget.findMany({
      where: { territoryType: parsed.data.territoryType, territoryId: parsed.data.territoryId },
      orderBy: { startDate: "desc" },
    }),
    prisma.coordinatorProfile.findMany({
      where: buildScopedCoordinatorWhere(parsed.data.territoryType, parsed.data.territoryId),
      include: { user: { select: { id: true, name: true, email: true } } },
      take: 50,
    }),
  ]);

  const targetProgress = await Promise.all(
    targets.map(async (target) => {
      const actualValue = await calculateMetricActual(target.territoryType, target.territoryId, target.metric);
      return {
        targetId: target.id,
        metric: target.metric,
        territoryType: target.territoryType,
        territoryId: target.territoryId,
        targetValue: target.targetValue,
        actualValue,
        percentageAchieved: target.targetValue > 0 ? Number(Math.min((actualValue / target.targetValue) * 100, 100).toFixed(2)) : 0,
        shortfall: Math.max(target.targetValue - actualValue, 0),
      };
    }),
  );

  const coordinatorPerformance = await Promise.all(
    coordinatorProfiles.map(async (profile) => {
      const [directRegistrations, directVerifiedRegistrations, points] = await Promise.all([
        prisma.referral.count({ where: { referrerUserId: profile.userId } }),
        prisma.referral.count({
          where: {
            referrerUserId: profile.userId,
            status: { in: [ReferralStatus.QUALIFIED, ReferralStatus.REWARD_PROCESSED] },
          },
        }),
        getConfirmedPoints(profile.userId),
      ]);
      return {
        userId: profile.userId,
        name: profile.user.name,
        email: profile.user.email,
        level: profile.level,
        directRegistrations,
        directVerifiedRegistrations,
        confirmedPoints: points,
      };
    }),
  );

  const children =
    parsed.data.territoryType === "STATE"
      ? await prisma.senatorialDistrict.findMany({
          where: { stateId: parsed.data.territoryId },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        }).then((items) => items.map((item) => ({ ...item, territoryType: "SENATORIAL_DISTRICT" })))
      : parsed.data.territoryType === "SENATORIAL_DISTRICT"
        ? await prisma.federalConstituency.findMany({
            where: { senatorialDistrictId: parsed.data.territoryId },
            select: { id: true, name: true },
            orderBy: { name: "asc" },
          }).then((items) => items.map((item) => ({ ...item, territoryType: "FEDERAL_CONSTITUENCY" })))
        : parsed.data.territoryType === "FEDERAL_CONSTITUENCY"
          ? await prisma.stateConstituency.findMany({
              where: { federalConstituencyId: parsed.data.territoryId },
              select: { id: true, name: true },
              orderBy: { name: "asc" },
            }).then((items) => items.map((item) => ({ ...item, territoryType: "STATE_CONSTITUENCY" })))
          : parsed.data.territoryType === "STATE_CONSTITUENCY"
            ? await prisma.ward.findMany({
                where: { stateConstituencyId: parsed.data.territoryId },
                select: { id: true, name: true },
                orderBy: { name: "asc" },
              }).then((items) => items.map((item) => ({ ...item, territoryType: "WARD" })))
            : parsed.data.territoryType === "WARD"
              ? await prisma.pollingUnit.findMany({
                  where: { wardId: parsed.data.territoryId },
                  select: { id: true, name: true },
                  orderBy: { name: "asc" },
                }).then((items) => items.map((item) => ({ ...item, territoryType: "POLLING_UNIT" })))
              : [];

  const childSummaries = await Promise.all(
    children.map(async (child) => {
      const [snapshot, verifiedMembers, registeredMembers] = await Promise.all([
        prisma.territoryStrengthSnapshot
          .findMany({
            where: { territoryType: child.territoryType, territoryId: child.id },
            orderBy: { calculatedAt: "desc" },
            take: SNAPSHOT_COMPATIBILITY_SCAN_LIMIT,
          })
          .then((rows) => selectCurrentMemberTerritorySnapshots(rows, 1)[0] || null),
        calculateMetricActual(child.territoryType, child.id, "VERIFIED_MEMBERS"),
        calculateMetricActual(child.territoryType, child.id, "REGISTERED_MEMBERS"),
      ]);
      return {
        territoryType: child.territoryType,
        territoryId: child.id,
        name: child.name,
        latestScore: snapshot?.score.toString() || null,
        latestScoreAt: snapshot?.calculatedAt.toISOString() || null,
        verifiedMembers,
        registeredMembers,
      };
    }),
  );

  /**
   * Score and trend both come from this list. Taking `latest` from the filtered
   * snapshots and the comparand from the raw ones is how an obsolete zero
   * became the "previous" score, reporting a change of calculation generation
   * as campaign progress — and, with a genuine decline in between, inverting
   * its sign.
   */
  const compatibleSnapshots = selectCurrentMemberTerritorySnapshots(latestSnapshots, 2);
  const latest = compatibleSnapshots[0] || null;
  return response.json({
    dashboard: {
      territoryType: parsed.data.territoryType,
      territoryId: parsed.data.territoryId,
      latestStrengthSnapshot: latest
        ? {
            ...latest,
            score: latest.score.toString(),
            calculatedAt: latest.calculatedAt.toISOString(),
            trend: trendFromScores(latest.score, compatibleSnapshots[1]?.score),
          }
        : null,
      targetProgress,
      childSummaries,
      coordinatorPerformance: coordinatorPerformance.sort(
        (left, right) =>
          right.directVerifiedRegistrations - left.directVerifiedRegistrations ||
          right.confirmedPoints - left.confirmedPoints,
      ),
    },
  });
});

export default router;
