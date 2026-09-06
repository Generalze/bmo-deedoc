import { Router } from "express";
import crypto from "node:crypto";
import type { Request, Response } from "express";
import {
  CampaignEventRsvpStatus,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  NotificationType,
  RewardLedgerCategory,
  RewardRedemptionStatus,
  RewardType,
  VoterVerificationDecision,
  VoterVerificationStatus,
} from "@prisma/client";
import { z } from "zod";
import { CAMPAIGN_EVENT_RSVP_STATUSES } from "@pics-nigeria/shared";
import { requireAuth, requireMemberCapability } from "../middleware/auth";
import { createNotification } from "../lib/notifications";
import { prisma } from "../prisma";
import {
  MAX_VOTER_DOCUMENT_BYTES,
  VOTER_DOCUMENT_MIME_TYPES,
  VoterDocumentRejected,
  storeVoterDocument,
  withVoterDocumentCustody,
  voterDocumentSubmissionSchema,
} from "../lib/voter-document-storage";
import { createAuditLog } from "../lib/audit";
import { recordParticipationAndReward } from "../lib/participation";
import { valuePayout } from "../lib/payout-authority";
import {
  serializeCampaignEventItem,
  serializeFeedbackItem,
  serializeIncidentItem,
  serializePollListItem,
  serializePostListItem,
  serializeRewardBalance,
  serializeRewardHistoryItem,
  serializeRewardLedgerItem,
  serializeRewardRedemption,
  serializeVoterEngagementTaskItem,
} from "../lib/serializers";
import { getRewardBalance } from "../lib/rewards";
import { validateTerritoryReferences } from "../lib/territory";

const router = Router();

const feedbackSchema = z.object({
  type: z.string().trim().min(2),
  message: z.string().trim().min(5),
  candidateUserId: z.string().trim().optional(),
  stateId: z.string().trim().min(1),
  senatorialDistrictId: z.string().trim().optional(),
  lgaId: z.string().trim().min(1),
  wardId: z.string().trim().optional(),
  pollingUnitId: z.string().trim().optional(),
});

const pollResponseSchema = z.object({
  optionId: z.string().trim().min(1),
});

const incidentSchema = z.object({
  type: z.nativeEnum(IncidentType),
  title: z.string().trim().min(3),
  description: z.string().trim().min(10),
  severity: z.nativeEnum(IncidentSeverity),
  stateId: z.string().trim().min(1),
  senatorialDistrictId: z.string().trim().optional(),
  lgaId: z.string().trim().min(1),
  wardId: z.string().trim().optional(),
  pollingUnitId: z.string().trim().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

const redemptionSchema = z.object({
  pointsRequested: z.number().int().min(1),
  // amountRequested is deliberately absent: the monetary value is computed
  // server-side from the active payout configuration. Accepting it from the
  // client made the member authoritative for their own payout amount.
  note: z.string().trim().max(500).optional(),
});

const verificationUploadRequestSchema = z.object({
  originalFileName: z.string().trim().min(1).max(255),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "application/pdf"]),
  fileSize: z.number().int().min(1).max(8 * 1024 * 1024),
});

const verificationSubmitSchema = voterDocumentSubmissionSchema.extend({
  documentProcessingConsent: z.boolean(),
});

const campaignEventRsvpSchema = z.object({
  status: z.enum(CAMPAIGN_EVENT_RSVP_STATUSES).default("GOING"),
});

const campaignEventInclude = {
  candidateUser: {
    include: {
      candidateProfile: {
        include: {
          politicalParty: { select: { name: true } },
        },
      },
    },
  },
  geoPoliticalZone: { select: { name: true } },
  state: { select: { name: true } },
  senatorialDistrict: { select: { name: true } },
  federalConstituency: { select: { name: true } },
  lga: { select: { name: true } },
  ward: { select: { name: true } },
  stateConstituency: { select: { name: true } },
  pollingUnit: { select: { name: true } },
  _count: {
    select: { rsvps: true },
  },
} as const;

function readRouteId(response: Response, value: string | string[] | undefined, label: string): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    response.status(400).json({ message: `Invalid ${label}.` });
    return null;
  }

  return value;
}

function buildCandidateAssetUrl(request: Request, assetId: string | null | undefined) {
  if (!assetId) {
    return null;
  }

  const protocol = request.get("x-forwarded-proto") || request.protocol;
  const host = request.get("x-forwarded-host") || request.get("host");

  if (!host) {
    return null;
  }

  return `${protocol}://${host}/candidate/assets/${assetId}`;
}

function matchesTaskScope(
  voterProfile: NonNullable<Request["authUser"]>["voterProfile"],
  task: {
    geoPoliticalZoneId: string | null;
    stateId: string | null;
    senatorialDistrictId: string | null;
    federalConstituencyId: string | null;
    lgaId: string | null;
    wardId: string | null;
    stateConstituencyId: string | null;
    pollingUnitId: string | null;
  },
) {
  if (!voterProfile) {
    return false;
  }

  if (task.geoPoliticalZoneId && task.geoPoliticalZoneId !== voterProfile.geoPoliticalZoneId) {
    return false;
  }
  if (task.stateId && task.stateId !== voterProfile.stateId) {
    return false;
  }
  if (task.senatorialDistrictId && task.senatorialDistrictId !== voterProfile.senatorialDistrictId) {
    return false;
  }
  if (task.federalConstituencyId && task.federalConstituencyId !== voterProfile.federalConstituencyId) {
    return false;
  }
  if (task.lgaId && task.lgaId !== voterProfile.lgaId) {
    return false;
  }
  if (task.wardId && task.wardId !== voterProfile.wardId) {
    return false;
  }
  if (task.stateConstituencyId && task.stateConstituencyId !== voterProfile.stateConstituencyId) {
    return false;
  }
  if (task.pollingUnitId && task.pollingUnitId !== voterProfile.pollingUnitId) {
    return false;
  }

  return true;
}

async function resolveEngagementProgress(voterUserId: string, task: {
  id: string;
  type: string;
  targetCount: number | null;
  createdAt: Date;
  geoPoliticalZoneId: string | null;
  stateId: string | null;
  senatorialDistrictId: string | null;
  federalConstituencyId: string | null;
  lgaId: string | null;
  wardId: string | null;
  stateConstituencyId: string | null;
  pollingUnitId: string | null;
}) {
  if (task.type === "REGISTRATION") {
    return 1;
  }

  if (task.type === "REFERRAL") {
    return prisma.voterProfile.count({
      where: {
        referredByUserId: voterUserId,
        createdAt: { gte: task.createdAt },
        geoPoliticalZoneId: task.geoPoliticalZoneId || undefined,
        stateId: task.stateId || undefined,
        senatorialDistrictId: task.senatorialDistrictId || undefined,
        federalConstituencyId: task.federalConstituencyId || undefined,
        lgaId: task.lgaId || undefined,
        wardId: task.wardId || undefined,
        stateConstituencyId: task.stateConstituencyId || undefined,
        pollingUnitId: task.pollingUnitId || undefined,
      },
    });
  }

  if (task.type === "POLL_RESPONSE") {
    return prisma.participationEvent.count({
      where: {
        voterUserId,
        type: "POLL_RESPONSE",
        createdAt: { gte: task.createdAt },
        relatedPoll: {
          is: {
            geoPoliticalZoneId: task.geoPoliticalZoneId || undefined,
            stateId: task.stateId || undefined,
            senatorialDistrictId: task.senatorialDistrictId || undefined,
            federalConstituencyId: task.federalConstituencyId || undefined,
            lgaId: task.lgaId || undefined,
            wardId: task.wardId || undefined,
            stateConstituencyId: task.stateConstituencyId || undefined,
            pollingUnitId: task.pollingUnitId || undefined,
          },
        },
      },
    });
  }

  return 0;
}

function serializeVerification(verification: {
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
  createdAt: Date;
  updatedAt: Date;
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
  }>;
}) {
  return {
    id: verification.id,
    memberUserId: verification.memberUserId,
    voterIdentifier: verification.voterIdentifier,
    status: verification.status,
    isFlagged: verification.isFlagged,
    fraudReason: verification.fraudReason,
    submittedAt: verification.submittedAt?.toISOString() || null,
    reviewStartedAt: verification.reviewStartedAt?.toISOString() || null,
    reviewedAt: verification.reviewedAt?.toISOString() || null,
    reviewedByUserId: verification.reviewedByUserId,
    reviewNote: verification.reviewNote,
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
      createdAt: entry.createdAt.toISOString(),
    })),
    createdAt: verification.createdAt.toISOString(),
    updatedAt: verification.updatedAt.toISOString(),
  };
}

router.get("/verification", requireAuth, requireMemberCapability, async (request, response) => {
  const verification = await prisma.voterVerification.findUnique({
    where: { memberUserId: request.authUser!.id },
    include: {
      documents: { orderBy: { uploadedAt: "desc" } },
      history: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!verification) {
    return response.json({ verification: null, status: VoterVerificationStatus.NOT_SUBMITTED });
  }

  return response.json({ verification: serializeVerification(verification), status: verification.status });
});

router.post("/verification/upload-request", requireAuth, requireMemberCapability, async (request, response) => {
  const parsed = verificationUploadRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid verification upload request.", errors: parsed.error.flatten() });
  }

  /**
   * What may be uploaded, and nothing about where.
   *
   * This used to hand the caller a storage key and a stub provider, deferring
   * the real upload to a workstream that never arrived — which is how a client
   * came to be authoritative for the location of its own identity document.
   * The document is submitted to /verification/submit, and the server decides
   * where it lives.
   */
  return response.status(200).json({
    maxFileSize: MAX_VOTER_DOCUMENT_BYTES,
    allowedMimeTypes: VOTER_DOCUMENT_MIME_TYPES,
    transport: "SUBMIT_DOCUMENT_BYTES",
    note: "Submit the document to /voter/verification/submit. The server generates the private storage key and computes the hash.",
  });
});

router.post("/verification/submit", requireAuth, requireMemberCapability, async (request, response) => {
  const parsed = verificationSubmitSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid verification submission.", errors: parsed.error.flatten() });
  }

  if (!parsed.data.documentProcessingConsent) {
    return response.status(400).json({ message: "Document processing consent is required before submitting voter evidence." });
  }

  // Custody of the bytes is taken before any record is written, so a record can
  // never name an object that is not there.
  let storedDocument;
  try {
    storedDocument = await storeVoterDocument({
      submission: parsed.data,
      memberUserId: request.authUser!.id,
    });
  } catch (caught) {
    if (caught instanceof VoterDocumentRejected) {
      return response.status(caught.status).json({ message: caught.message, code: caught.code });
    }
    throw caught;
  }

  const voterIdentifier = request.authUser!.voterProfile!.voterCardNumber;
  const result = await withVoterDocumentCustody(
    { stored: storedDocument, actorUserId: request.authUser!.id, committed: (value) => value !== null },
    () =>
      prisma.$transaction(async (transaction) => {
    const existingVerification = await transaction.voterVerification.findUnique({
      where: { memberUserId: request.authUser!.id },
      include: { documents: true },
    });

    if (existingVerification?.status === VoterVerificationStatus.VERIFIED) {
      throw new Error("VERIFICATION_ALREADY_APPROVED");
    }

    const duplicateDocument = await transaction.voterVerificationDocument.findFirst({
      where: {
        sha256: storedDocument.sha256,
        verification: {
          memberUserId: { not: request.authUser!.id },
        },
      },
      select: { id: true },
    });

    const verification = existingVerification
      ? await transaction.voterVerification.update({
          where: { id: existingVerification.id },
          data: {
            status: VoterVerificationStatus.PENDING,
            isFlagged: Boolean(duplicateDocument),
            fraudReason: duplicateDocument ? "DUPLICATE_DOCUMENT_HASH" : null,
            submittedAt: new Date(),
            reviewStartedAt: null,
            reviewedAt: null,
            reviewedByUserId: null,
            reviewNote: null,
          },
        })
      : await transaction.voterVerification.create({
          data: {
            memberUserId: request.authUser!.id,
            voterIdentifier,
            status: VoterVerificationStatus.PENDING,
            isFlagged: Boolean(duplicateDocument),
            fraudReason: duplicateDocument ? "DUPLICATE_DOCUMENT_HASH" : null,
            submittedAt: new Date(),
          },
        });

    await transaction.voterVerificationDocument.create({
      data: {
        id: storedDocument.documentId,
        verificationId: verification.id,
        originalStorageKey: storedDocument.originalStorageKey,
        previewStorageKey: null,
        originalFileName: storedDocument.originalFileName,
        mimeType: storedDocument.mimeType,
        // Derived from the bytes the server stored, never from the submission.
        fileSize: storedDocument.fileSize,
        sha256: storedDocument.sha256,
        storageProvider: storedDocument.storageProvider,
        storageBucket: storedDocument.storageBucket,
        serverReceivedAt: storedDocument.serverReceivedAt,
      },
    });

    await transaction.voterVerificationHistory.create({
      data: {
        verificationId: verification.id,
        actorUserId: request.authUser!.id,
        fromStatus: existingVerification?.status || VoterVerificationStatus.NOT_SUBMITTED,
        toStatus: VoterVerificationStatus.PENDING,
        decision: duplicateDocument ? VoterVerificationDecision.FLAGGED : VoterVerificationDecision.SUBMITTED,
        note: duplicateDocument ? "Potential duplicate voter document hash detected." : "Voter evidence submitted for validation.",
      },
    });

    await transaction.voterProfile.update({
      where: { userId: request.authUser!.id },
      data: {
        documentConsentAt: new Date(),
      },
    });

    return transaction.voterVerification.findUniqueOrThrow({
      where: { id: verification.id },
      include: {
        documents: { orderBy: { uploadedAt: "desc" } },
        history: { orderBy: { createdAt: "desc" } },
      },
    });
      }).catch((error: unknown) => {
    if (error instanceof Error && error.message === "VERIFICATION_ALREADY_APPROVED") {
      return null;
    }
    throw error;
      }),
  );

  if (!result) {
    return response.status(409).json({ message: "Approved voter verification cannot be resubmitted." });
  }

  return response.status(201).json({
    message: result.isFlagged
      ? "Voter evidence submitted and flagged for validator review."
      : "Voter evidence submitted for validator review.",
    verification: serializeVerification(result),
  });
});

router.get("/rewards", requireAuth, requireMemberCapability, async (request, response) => {
  const voterUserId = request.authUser?.id;

  const [recentRewards, groupedRewards, recentRedemptions] = await Promise.all([
    prisma.rewardLedger.findMany({
      where: { voterUserId },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    // Grouped from the authoritative ledger. Grouping the legacy ledger here
    // reported preserved carryover as the member's earned totals — a second
    // leak, independent of the balance, that survives fixing the balance alone.
    prisma.rewardLedgerEntry.groupBy({
      by: ["category"],
      where: { userId: voterUserId },
      _sum: { points: true },
    }),
    prisma.rewardRedemption.findMany({
      where: { voterUserId },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);

  const totals = new Map(groupedRewards.map((entry) => [entry.category, entry._sum.points || 0]));
  const totalPoints = Array.from(totals.values()).reduce((sum, value) => sum + value, 0);

  const balance = await getRewardBalance(prisma, voterUserId!);
  const history = [
    ...recentRewards.map((reward) =>
      serializeRewardHistoryItem({
        ...reward,
        kind: "EARNED",
        status: "POSTED",
        title: reward.type.replace(/_/g, " "),
      }),
    ),
    ...recentRedemptions.map((redemption) =>
      serializeRewardHistoryItem({
        ...redemption,
        kind: "REDEMPTION",
        title: "Reward redemption",
      }),
    ),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return response.json({
    totalPoints,
    totalParticipationPoints: totals.get(RewardLedgerCategory.APPROVED_PARTICIPATION) || 0,
    totalReferralPoints: totals.get(RewardLedgerCategory.VERIFIED_REFERRAL) || 0,
    availablePoints: balance.availablePoints,
    reservedPoints: balance.reservedPoints,
    // Reported separately and never folded into availablePoints, so a member
    // can see value that was preserved for them without it reading as spendable.
    legacyCarryoverPendingPoints: balance.legacyCarryoverPendingPoints,
    legacyCarryoverConfirmedPoints: balance.legacyCarryoverConfirmedPoints,
    recentRewards: recentRewards.map((reward) => ({
      id: reward.id,
      type: reward.type,
      points: reward.points,
      amount: reward.amount,
      description: reward.description,
      createdAt: reward.createdAt.toISOString(),
    })),
    rewardLedger: recentRewards.map(serializeRewardLedgerItem),
    rewardHistory: history,
  });
});

router.get("/reward-ledger", requireAuth, requireMemberCapability, async (request, response) => {
  const voterUserId = request.authUser!.id;
  const [ledgerEntries, redemptions] = await Promise.all([
    prisma.rewardLedger.findMany({
      where: { voterUserId },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.rewardRedemption.findMany({
      where: { voterUserId },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);

  const rewardHistory = [
    ...ledgerEntries.map((entry) =>
      serializeRewardHistoryItem({
        ...entry,
        kind: "EARNED",
        status: "POSTED",
        title: entry.type.replace(/_/g, " "),
      }),
    ),
    ...redemptions.map((redemption) =>
      serializeRewardHistoryItem({
        ...redemption,
        kind: "REDEMPTION",
        title: "Reward redemption",
      }),
    ),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return response.json({
    rewardLedger: ledgerEntries.map(serializeRewardLedgerItem),
    rewardHistory,
  });
});

router.post("/redemptions", requireAuth, requireMemberCapability, async (request, response) => {
  const parsed = redemptionSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid redemption payload.", errors: parsed.error.flatten() });
  }

  const voterUserId = request.authUser!.id;

  // Valued by the single payout authority, exactly as the payout-cycle path is.
  // The member requests a number of points; the server decides whether they are
  // eligible and what they are worth. A client-supplied monetary amount is
  // never accepted, and the configured minimum threshold and conversion rate
  // apply here as they do on every other money-out path.
  const preview = await valuePayout(prisma, {
    userId: voterUserId,
    requestedPoints: parsed.data.pointsRequested,
  });
  if (!preview.meetsThreshold) {
    return response.status(400).json({
      message: preview.reason || "Redemption is not eligible.",
      eligiblePoints: preview.eligiblePoints,
      minimumThreshold: preview.minimumThreshold,
    });
  }

  const redemption = await prisma.$transaction(async (transaction) => {
    // Re-valued inside the transaction so two concurrent requests cannot spend
    // the same points.
    const confirmed = await valuePayout(transaction, {
      userId: voterUserId,
      requestedPoints: parsed.data.pointsRequested,
    });
    if (!confirmed.meetsThreshold) {
      throw new Error(confirmed.reason || "Redemption is not eligible.");
    }

    const created = await transaction.rewardRedemption.create({
      data: {
        voterUserId,
        pointsRequested: confirmed.requestedPoints,
        // Server-computed from the active configuration, never from the client.
        amountRequested: Number(confirmed.payableAmount),
        status: RewardRedemptionStatus.PENDING,
        note: parsed.data.note || null,
      },
    });

    await createAuditLog(transaction, {
      actorUserId: voterUserId,
      action: "REWARD_REDEMPTION_REQUESTED",
      targetType: "RewardRedemption",
      targetId: created.id,
      metadata: {
        requestedPoints: confirmed.requestedPoints,
        eligiblePoints: confirmed.eligiblePoints,
        minimumThreshold: confirmed.minimumThreshold,
        conversionRate: confirmed.conversionRate,
        payableAmount: confirmed.payableAmount.toString(),
        payoutConfigurationId: confirmed.payoutConfigurationId,
      },
    });

    await createNotification(transaction, {
      userId: voterUserId,
      type: NotificationType.REWARD_REDEMPTION,
      title: "Redemption requested",
      message: `${parsed.data.pointsRequested} points redemption submitted for review.`,
    });

    return created;
  }).catch((error: unknown) => {
    throw error;
  });

  return response.status(201).json({
    message: "Redemption request submitted successfully.",
    redemption: serializeRewardRedemption(redemption),
  });
});

router.get("/redemptions", requireAuth, requireMemberCapability, async (request, response) => {
  const [redemptions, balance] = await Promise.all([
    prisma.rewardRedemption.findMany({
      where: { voterUserId: request.authUser!.id },
      orderBy: { createdAt: "desc" },
    }),
    getRewardBalance(prisma, request.authUser!.id),
  ]);

  return response.json({
    balance: serializeRewardBalance(balance),
    redemptions: redemptions.map(serializeRewardRedemption),
  });
});

router.get("/polls", requireAuth, requireMemberCapability, async (request, response) => {
  const voterProfile = request.authUser?.voterProfile;
  const polls = await prisma.poll.findMany({
    where: { isActive: true },
    include: { options: true },
    orderBy: { createdAt: "desc" },
  });

  const visiblePolls = polls.filter((poll) => {
    if (!voterProfile) {
      return false;
    }

    if (poll.stateId && poll.stateId !== voterProfile.stateId) {
      return false;
    }

    if (poll.senatorialDistrictId && poll.senatorialDistrictId !== voterProfile.senatorialDistrictId) {
      return false;
    }

    if (poll.federalConstituencyId && poll.federalConstituencyId !== voterProfile.federalConstituencyId) {
      return false;
    }

    if (poll.lgaId && poll.lgaId !== voterProfile.lgaId) {
      return false;
    }

    if (poll.wardId && poll.wardId !== voterProfile.wardId) {
      return false;
    }

    if (poll.stateConstituencyId && poll.stateConstituencyId !== voterProfile.stateConstituencyId) {
      return false;
    }

    return true;
  });

  return response.json({
    polls: visiblePolls.map(serializePollListItem),
  });
});

router.get("/events", requireAuth, requireMemberCapability, async (request, response) => {
  const voterProfile = request.authUser?.voterProfile;
  if (!voterProfile) {
    return response.json({ events: [] });
  }

  const events = await prisma.campaignEvent.findMany({
    where: {
      isPublished: true,
      startsAt: { gte: new Date(Date.now() - 6 * 60 * 60 * 1000) },
    },
    include: {
      ...campaignEventInclude,
      rsvps: {
        where: { voterUserId: request.authUser!.id },
        select: { status: true, createdAt: true },
      },
    },
    orderBy: { startsAt: "asc" },
    take: 50,
  });

  return response.json({
    events: events
      .filter((event) => matchesTaskScope(voterProfile, event))
      .map((event) =>
        serializeCampaignEventItem({
          ...event,
          coverImageUrl: buildCandidateAssetUrl(request, event.coverImageAssetId) || event.coverImageUrl,
        }),
      ),
  });
});

router.get("/engagement-tasks", requireAuth, requireMemberCapability, async (request, response) => {
  const voterProfile = request.authUser?.voterProfile;

  if (!voterProfile) {
    return response.json({ tasks: [] });
  }

  const tasks = await prisma.voterEngagementTask.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const visibleTasks = tasks.filter((task) => matchesTaskScope(voterProfile, task));
  const claims = await prisma.voterEngagementClaim.findMany({
    where: {
      voterUserId: request.authUser!.id,
      taskId: { in: visibleTasks.map((task) => task.id) },
    },
    select: { taskId: true, progressCount: true },
  });

  const claimsByTaskId = new Map(claims.map((claim) => [claim.taskId, claim]));
  const taskItems = [];

  for (const task of visibleTasks) {
    const progressCount = await resolveEngagementProgress(request.authUser!.id, task);
    const claimed = claimsByTaskId.has(task.id);
    const completed = progressCount >= (task.targetCount || 1);

    taskItems.push(
      serializeVoterEngagementTaskItem({
        ...task,
        progressCount,
        claimed,
        completed,
      }),
    );
  }

  return response.json({ tasks: taskItems });
});

router.post("/engagement-tasks/:taskId/claim", requireAuth, requireMemberCapability, async (request, response) => {
  const taskId = readRouteId(response, request.params.taskId, "task id");
  if (!taskId) {
    return;
  }

  const task = await prisma.voterEngagementTask.findUnique({
    where: { id: taskId },
  });

  if (!task || !task.isActive) {
    return response.status(404).json({ message: "Engagement task was not found." });
  }

  if (!matchesTaskScope(request.authUser?.voterProfile || null, task)) {
    return response.status(403).json({ message: "This engagement task is outside your territory." });
  }

  const existingClaim = await prisma.voterEngagementClaim.findUnique({
    where: {
      taskId_voterUserId: {
        taskId,
        voterUserId: request.authUser!.id,
      },
    },
    select: { id: true },
  });

  if (existingClaim) {
    return response.status(409).json({ message: "This engagement task has already been claimed." });
  }

  const progressCount = await resolveEngagementProgress(request.authUser!.id, task);
  if (progressCount < (task.targetCount || 1)) {
    return response.status(400).json({ message: "This engagement task is not complete yet." });
  }

  await prisma.$transaction(async (transaction) => {
    await transaction.voterEngagementClaim.create({
      data: {
        taskId,
        voterUserId: request.authUser!.id,
        progressCount,
      },
    });

    await recordParticipationAndReward(transaction, {
      voterUserId: request.authUser!.id,
      type: `ENGAGEMENT_TASK:${task.id}`,
      description: `Engagement task completed: ${task.title}`,
      pointsAwarded: task.rewardPoints,
    });
  });

  return response.status(201).json({
    message: "Engagement task claimed successfully.",
  });
});

router.post("/events/:eventId/rsvp", requireAuth, requireMemberCapability, async (request, response) => {
  const parsed = campaignEventRsvpSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid campaign event RSVP payload.", errors: parsed.error.flatten() });
  }

  const eventId = readRouteId(response, request.params.eventId, "event id");
  if (!eventId) {
    return;
  }

  const event = await prisma.campaignEvent.findUnique({
    where: { id: eventId },
    include: {
      ...campaignEventInclude,
      rsvps: {
        where: { voterUserId: request.authUser!.id },
        select: { status: true, createdAt: true },
      },
    },
  });

  if (!event || !event.isPublished) {
    return response.status(404).json({ message: "Campaign event was not found." });
  }

  if (!matchesTaskScope(request.authUser?.voterProfile || null, event)) {
    return response.status(403).json({ message: "This campaign event is outside your territory." });
  }

  const updated = await prisma.$transaction(async (transaction) => {
    const rsvp = await transaction.campaignEventRsvp.upsert({
      where: {
        eventId_voterUserId: {
          eventId,
          voterUserId: request.authUser!.id,
        },
      },
      create: {
        eventId,
        voterUserId: request.authUser!.id,
        status: parsed.data.status as CampaignEventRsvpStatus,
      },
      update: {
        status: parsed.data.status as CampaignEventRsvpStatus,
      },
    });

    await createNotification(transaction, {
      userId: event.candidateUserId,
      type: NotificationType.SYSTEM,
      title: "New campaign event RSVP",
      message: `${request.authUser!.name} responded ${parsed.data.status.toLowerCase()} to ${event.title}.`,
    });

    return transaction.campaignEvent.findUnique({
      where: { id: eventId },
      include: {
        ...campaignEventInclude,
        rsvps: {
          where: { voterUserId: request.authUser!.id },
          select: { status: true, createdAt: true },
        },
      },
    });
  });

  return response.status(201).json({
    message: `Campaign event RSVP saved as ${parsed.data.status.toLowerCase()}.`,
    event: updated
      ? serializeCampaignEventItem({
          ...updated,
          coverImageUrl: buildCandidateAssetUrl(request, updated.coverImageAssetId) || updated.coverImageUrl,
        })
      : null,
  });
});

router.post("/polls/:pollId/respond", requireAuth, requireMemberCapability, async (request, response) => {
  const parsed = pollResponseSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid poll response payload.", errors: parsed.error.flatten() });
  }

  const pollId = readRouteId(response, request.params.pollId, "poll id");
  if (!pollId) {
    return;
  }

  const poll = await prisma.poll.findUnique({
    where: { id: pollId },
    include: { options: true },
  });

  if (!poll || !poll.isActive) {
    return response.status(404).json({ message: "Poll was not found." });
  }

  const selectedOption = poll.options.find((option) => option.id === parsed.data.optionId);
  if (!selectedOption) {
    return response.status(400).json({ message: "Selected option does not belong to this poll." });
  }

  const existingResponse = await prisma.pollResponse.findUnique({
    where: {
      pollId_voterUserId: {
        pollId: poll.id,
        voterUserId: request.authUser!.id,
      },
    },
    select: { id: true },
  });

  if (existingResponse) {
    return response.status(409).json({ message: "You have already responded to this poll." });
  }

  await prisma.$transaction(async (transaction) => {
    await transaction.pollResponse.create({
      data: {
        pollId: poll.id,
        voterUserId: request.authUser!.id,
        optionId: parsed.data.optionId,
      },
    });

    await recordParticipationAndReward(transaction, {
      voterUserId: request.authUser!.id,
      type: "POLL_RESPONSE",
      description: `Poll response recorded for ${poll.title}`,
      pointsAwarded: 5,
      relatedPollId: poll.id,
    });
  });

  return response.status(201).json({ message: "Poll response submitted successfully." });
});

router.get("/posts", requireAuth, requireMemberCapability, async (request, response) => {
  const voterProfile = request.authUser?.voterProfile;
  const posts = await prisma.post.findMany({
    where: { isPublished: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const visiblePosts = posts.filter((post) => {
    if (!voterProfile) {
      return false;
    }

    if (post.stateId && post.stateId !== voterProfile.stateId) {
      return false;
    }

    if (post.senatorialDistrictId && post.senatorialDistrictId !== voterProfile.senatorialDistrictId) {
      return false;
    }

    if (post.federalConstituencyId && post.federalConstituencyId !== voterProfile.federalConstituencyId) {
      return false;
    }

    if (post.lgaId && post.lgaId !== voterProfile.lgaId) {
      return false;
    }

    if (post.wardId && post.wardId !== voterProfile.wardId) {
      return false;
    }

    if (post.stateConstituencyId && post.stateConstituencyId !== voterProfile.stateConstituencyId) {
      return false;
    }

    return true;
  });

  return response.json({
    posts: visiblePosts.map(serializePostListItem),
  });
});

router.post("/feedback", requireAuth, requireMemberCapability, async (request, response) => {
  const parsed = feedbackSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid feedback payload.", errors: parsed.error.flatten() });
  }

  const territoryReferenceError = await validateTerritoryReferences(parsed.data);
  if (territoryReferenceError) {
    return response.status(400).json({ message: territoryReferenceError });
  }

  if (parsed.data.candidateUserId) {
    const candidate = await prisma.user.findUnique({
      where: { id: parsed.data.candidateUserId },
      include: { candidateProfile: true },
    });

    if (!candidate?.candidateProfile) {
      return response.status(400).json({ message: "Candidate user does not exist." });
    }
  }

  const feedback = await prisma.feedback.create({
    data: {
      voterUserId: request.authUser!.id,
      candidateUserId: parsed.data.candidateUserId || null,
      type: parsed.data.type,
      message: parsed.data.message,
      stateId: parsed.data.stateId,
      senatorialDistrictId: parsed.data.senatorialDistrictId || null,
      lgaId: parsed.data.lgaId,
      wardId: parsed.data.wardId || null,
      pollingUnitId: parsed.data.pollingUnitId || null,
    },
  });

  return response.status(201).json({
    message: "Feedback submitted successfully.",
    feedback: serializeFeedbackItem(feedback),
  });
});

router.post("/incidents", requireAuth, requireMemberCapability, async (request, response) => {
  const parsed = incidentSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid incident payload.", errors: parsed.error.flatten() });
  }

  const territoryReferenceError = await validateTerritoryReferences(parsed.data);
  if (territoryReferenceError) {
    return response.status(400).json({ message: territoryReferenceError });
  }

  const incident = await prisma.incident.create({
    data: {
      reportedByUserId: request.authUser!.id,
      type: parsed.data.type,
      title: parsed.data.title,
      description: parsed.data.description,
      severity: parsed.data.severity,
      status: IncidentStatus.OPEN,
      latitude: parsed.data.latitude ?? null,
      longitude: parsed.data.longitude ?? null,
      stateId: parsed.data.stateId,
      senatorialDistrictId: parsed.data.senatorialDistrictId || null,
      lgaId: parsed.data.lgaId,
      wardId: parsed.data.wardId || null,
      pollingUnitId: parsed.data.pollingUnitId || null,
      assignedAdminUserId: null,
    },
  });

  await prisma.feedback.create({
    data: {
      voterUserId: request.authUser!.id,
      type: `INCIDENT:${parsed.data.type}`,
      message: `${parsed.data.title}: ${parsed.data.description}`,
      stateId: parsed.data.stateId,
      senatorialDistrictId: parsed.data.senatorialDistrictId || null,
      lgaId: parsed.data.lgaId,
      wardId: parsed.data.wardId || null,
      pollingUnitId: parsed.data.pollingUnitId || null,
    },
  });

  return response.status(201).json({
    message: "Incident submitted successfully.",
    incident: serializeIncidentItem(incident),
  });
});

export default router;
