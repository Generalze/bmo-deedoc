import { Router } from "express";
import type { Response } from "express";
import {
  AdminLevel,
  AgentActivityType,
  AssignmentPermissionType,
  BroadcastAudience,
  CandidateOfficeType,
  ElectionDayReportStatus,
  FieldTaskPriority,
  FieldTaskStatus,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  NotificationType,
  Prisma,
  RewardRedemptionStatus,
  RewardType,
  UserRole,
} from "@prisma/client";
import { z } from "zod";
import {
  NIGERIA_EXPECTED_LGA_TOTAL,
  NIGERIA_EXPECTED_STATE_TOTAL,
  NIGERIA_STATE_EXPECTED_LGA_COUNTS,
  normalizeEmail,
} from "@pics-nigeria/shared";
import { getAuthUserProfile } from "../auth/profile";
import { hashPassword } from "../auth/password";
import { createAuditLog } from "../lib/audit";
import { buildIncidentGovernance, summarizeIncidentGovernance } from "../lib/incident-governance";
import { createNotification } from "../lib/notifications";
import { requireAuth, requireRole } from "../middleware/auth";
import { prisma } from "../prisma";
import { recordParticipationAndReward } from "../lib/participation";
import {
  PayoutExecutionDisabledError,
  getAuthoritativeBalance,
  isPayoutExecutionEnabled,
  valuePayout,
} from "../lib/payout-authority";
import { PayoutExecutionError, executePayout, payoutExecutionStatusCode } from "../lib/payout-execution";
import { ensureNationalReferenceStates, syncLgasForState, syncPollingUnitsForWard, syncWardsForLga } from "../lib/inec-reference";
import { createElectionDayRealtimeEvent } from "../realtime/events";
import { publishRealtimeEvent } from "../realtime/gateway";
import {
  serializeAdminMapSummary,
  serializeAdminSummary,
  serializeAgentActivitySummary,
  serializeBroadcastMessageItem,
  serializeCandidateListItem,
  serializeFeedbackItem,
  serializeIncidentItem,
  serializePollingUnitCoverageSummary,
  serializeCoverageInsights,
  serializeAuditLogItem,
  serializeElectionDayReportItem,
  serializeFieldTaskItem,
  serializeNotificationItem,
  serializeRewardHistoryItem,
  serializeRewardLedgerItem,
  serializeRewardRedemption,
  serializeTerritory,
  serializeVoterEngagementTaskItem,
} from "../lib/serializers";
import { toScopeFilter, validateCandidateOfficeTerritory, validateTerritoryReferences } from "../lib/territory";
import {
  canCreateAgentInScope,
  canManageCandidateOffice,
  canManageUser,
  canManageAdmin,
  canViewCandidate,
  isAdminUser,
  isSuperAdmin,
  isWithinActorParty,
  isWithinAdminScope,
} from "../scope";
import { getRewardBalance } from "../lib/rewards";

const router = Router();

/**
 * Admin levels the Ogun command structure can actually place.
 *
 * Features 001 and 003: NATIONAL and GEO_POLITICAL_ZONE describe a hierarchy
 * above the state that this platform does not have, and LGA is reference data
 * for reporting and INEC alignment rather than a rung of command authority.
 * Enforced on the server because the create-user form filtering these out is a
 * convenience — the endpoint is what decides who can exist.
 */
const ASSIGNABLE_ADMIN_LEVELS = [
  AdminLevel.STATE,
  AdminLevel.SENATORIAL,
  AdminLevel.FEDERAL_CONSTITUENCY,
  AdminLevel.STATE_CONSTITUENCY,
  AdminLevel.WARD,
] as const;

const assignableAdminLevel = z.enum(ASSIGNABLE_ADMIN_LEVELS.map(String) as [string, ...string[]]).transform(
  (value) => value as AdminLevel,
);

const adminCreationSchema = z.object({
  name: z.string().trim().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  adminLevel: assignableAdminLevel,
  politicalPartyId: z.string().trim().optional(),
  geoPoliticalZoneId: z.string().trim().optional(),
  stateId: z.string().trim().optional(),
  senatorialDistrictId: z.string().trim().optional(),
  federalConstituencyId: z.string().trim().optional(),
  lgaId: z.string().trim().optional(),
  wardId: z.string().trim().optional(),
  stateConstituencyId: z.string().trim().optional(),
  pollingUnitId: z.string().trim().optional(),
});

const candidateCreationSchema = z.object({
  name: z.string().trim().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  officeType: z.nativeEnum(CandidateOfficeType),
  politicalPartyId: z.string().trim().optional(),
  geoPoliticalZoneId: z.string().trim().optional(),
  stateId: z.string().trim().optional(),
  senatorialDistrictId: z.string().trim().optional(),
  federalConstituencyId: z.string().trim().optional(),
  lgaId: z.string().trim().optional(),
  wardId: z.string().trim().optional(),
  stateConstituencyId: z.string().trim().optional(),
  pollingUnitId: z.string().trim().optional(),
});

const assignmentSchema = z.object({
  adminUserId: z.string().trim().min(1),
  candidateUserId: z.string().trim().min(1),
  permissionType: z.nativeEnum(AssignmentPermissionType),
});

const geoPoliticalZoneSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(2),
});

const geoPoliticalZoneUpdateSchema = z.object({
  name: z.string().trim().min(2),
});

const politicalPartySchema = z.object({
  id: z.string().trim().min(1),
  code: z.string().trim().min(2).max(10),
  name: z.string().trim().min(2),
  logoUrl: z.string().url().optional().or(z.literal("")),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  officialWebsite: z.string().url().optional().or(z.literal("")),
  isApprovedByInec: z.boolean().optional(),
  inecSourceUrl: z.string().url().optional().or(z.literal("")),
});

const politicalPartyUpdateSchema = z.object({
  code: z.string().trim().min(2).max(10),
  name: z.string().trim().min(2),
  logoUrl: z.string().url().optional().or(z.literal("")),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  officialWebsite: z.string().url().optional().or(z.literal("")),
  isApprovedByInec: z.boolean().optional(),
  inecSourceUrl: z.string().url().optional().or(z.literal("")),
});

const agentCreationSchema = z.object({
  name: z.string().trim().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  phone: z.string().trim().min(7).optional(),
  politicalPartyId: z.string().trim().optional(),
  stateId: z.string().trim().min(1),
  senatorialDistrictId: z.string().trim().optional(),
  federalConstituencyId: z.string().trim().optional(),
  lgaId: z.string().trim().min(1),
  wardId: z.string().trim().min(1),
  stateConstituencyId: z.string().trim().optional(),
  pollingUnitId: z.string().trim().optional(),
  assignedAdminUserId: z.string().trim().optional(),
});

const adminUpdateSchema = z.object({
  name: z.string().trim().min(2),
  adminLevel: assignableAdminLevel,
  politicalPartyId: z.string().trim().optional(),
  geoPoliticalZoneId: z.string().trim().optional(),
  stateId: z.string().trim().optional(),
  senatorialDistrictId: z.string().trim().optional(),
  federalConstituencyId: z.string().trim().optional(),
  lgaId: z.string().trim().optional(),
  wardId: z.string().trim().optional(),
  stateConstituencyId: z.string().trim().optional(),
  pollingUnitId: z.string().trim().optional(),
});

const candidateUpdateSchema = z.object({
  name: z.string().trim().min(2),
  officeType: z.nativeEnum(CandidateOfficeType),
  politicalPartyId: z.string().trim().optional(),
  geoPoliticalZoneId: z.string().trim().optional(),
  stateId: z.string().trim().optional(),
  senatorialDistrictId: z.string().trim().optional(),
  federalConstituencyId: z.string().trim().optional(),
  lgaId: z.string().trim().optional(),
  wardId: z.string().trim().optional(),
  stateConstituencyId: z.string().trim().optional(),
  pollingUnitId: z.string().trim().optional(),
});

const agentUpdateSchema = z.object({
  name: z.string().trim().min(2),
  phone: z.string().trim().min(7).optional(),
  politicalPartyId: z.string().trim().optional(),
  stateId: z.string().trim().min(1),
  senatorialDistrictId: z.string().trim().optional(),
  federalConstituencyId: z.string().trim().optional(),
  lgaId: z.string().trim().min(1),
  wardId: z.string().trim().min(1),
  stateConstituencyId: z.string().trim().optional(),
  pollingUnitId: z.string().trim().optional(),
  assignedAdminUserId: z.string().trim().optional(),
});

const userDeactivationSchema = z.object({
  isActive: z.boolean(),
});

type ManagedUserDependencyCounts = {
  assignedAdmins: number;
  assignedAgents: number;
  managedCandidateLinks: number;
  assignedCandidateLinks: number;
  createdTasks: number;
  assignedTasks: number;
  createdBroadcasts: number;
  createdPolls: number;
  authoredPosts: number;
  candidatePosts: number;
  createdCampaignEvents: number;
  candidateCampaignEvents: number;
  notifications: number;
  rewardEntries: number;
  /**
   * Entries in the authoritative ledger. Counted separately from the legacy
   * `rewardEntries` because earnings now post here: without this the guard
   * below would report no dependencies for a member who has earned points, and
   * the delete would fail on the database foreign key as a 500 instead of the
   * explained 409.
   */
  authoritativeLedgerEntries: number;
  /** Preserved legacy value. A member holding a carryover must never be deleted. */
  legacyBalanceCarryovers: number;
  /**
   * Payout rows, counted for both the beneficiary and the payout officer. Both
   * foreign keys are Restrict, so any of them left uncounted turns a delete into
   * a raw database error instead of the explained 409. A beneficiary is usually
   * covered incidentally by their ledger entries, and a payout officer is
   * currently unreachable here because canManageUser refuses that role first —
   * counted anyway, so the guard does not depend on an authorization rule
   * elsewhere continuing to say no.
   */
  payoutAssignments: number;
  payoutTransactions: number;
  /** Records that money left the platform. Immutable, and never deleted with a user. */
  payoutExecutions: number;
  rewardRedemptions: number;
  agentActivities: number;
  reportedIncidents: number;
  feedbackItems: number;
  voterProfileDependents: number;
  engagementTaskClaims: number;
};

/** Evidence that a redemption payment actually happened, required to execute one. */
const redemptionPaymentSchema = z.object({
  paymentReference: z.string().trim().min(3).max(120),
  proofStorageKey: z.string().trim().min(1).max(500).optional(),
  note: z.string().trim().max(500).optional(),
});

const participationSchema = z.object({
  voterUserId: z.string().trim().min(1),
  type: z.string().trim().min(2),
  description: z.string().trim().min(2),
  pointsAwarded: z.number().int().min(1).max(100),
  relatedPollId: z.string().trim().optional(),
  relatedPostId: z.string().trim().optional(),
});

const pollCreationSchema = z.object({
  title: z.string().trim().min(3),
  description: z.string().trim().optional(),
  candidateUserId: z.string().trim().optional(),
  officeType: z.nativeEnum(CandidateOfficeType).optional(),
  stateId: z.string().trim().optional(),
  senatorialDistrictId: z.string().trim().optional(),
  federalConstituencyId: z.string().trim().optional(),
  lgaId: z.string().trim().optional(),
  wardId: z.string().trim().optional(),
  stateConstituencyId: z.string().trim().optional(),
  pollingUnitId: z.string().trim().optional(),
  options: z.array(z.string().trim().min(1)).min(2),
});

const agentActivityQuerySchema = z.object({
  agentUserId: z.string().trim().optional(),
  type: z.nativeEnum(AgentActivityType).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
});

const incidentQuerySchema = z.object({
  status: z.nativeEnum(IncidentStatus).optional(),
  type: z.nativeEnum(IncidentType).optional(),
  reviewPriority: z.enum(["ROUTINE", "PRIORITY", "CRITICAL"]).optional(),
  flaggedOnly: z.enum(["true", "false"]).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
});

const incidentStatusUpdateSchema = z.object({
  status: z.nativeEnum(IncidentStatus),
});

const incidentAssignSchema = z.object({
  assignedAdminUserId: z.string().trim().min(1),
});

const electionDayReportQuerySchema = z.object({
  status: z.nativeEnum(ElectionDayReportStatus).optional(),
  reportDate: z.string().date().optional(),
});

const electionDayReportStatusSchema = z.object({
  status: z.nativeEnum(ElectionDayReportStatus),
  reviewNote: z.string().trim().max(1000).optional(),
});

const stateAgentTargetSchema = z.object({
  agentsPerPollingUnitTarget: z.number().int().min(1).max(20),
});

const redemptionReviewSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

const auditLogQuerySchema = z.object({
  actorUserId: z.string().trim().optional(),
  action: z.string().trim().optional(),
  targetType: z.string().trim().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

const recentChangesQuerySchema = z.object({
  since: z.string().datetime(),
});

const analyticsQuerySchema = z.object({
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

const stateLookupQuerySchema = z.object({
  geoPoliticalZoneId: z.string().trim().optional(),
});

const stateScopedLookupQuerySchema = z.object({
  stateId: z.string().trim().min(1),
});

const federalConstituencyLookupQuerySchema = z.object({
  stateId: z.string().trim().min(1),
  senatorialDistrictId: z.string().trim().optional(),
});

const lgaScopedLookupQuerySchema = z.object({
  stateId: z.string().trim().optional(),
  lgaId: z.string().trim().optional(),
});

const managedUsersQuerySchema = z.object({
  role: z.nativeEnum(UserRole).optional(),
  isActive: z.enum(["true", "false"]).optional(),
  search: z.string().trim().optional(),
  stateId: z.string().trim().optional(),
  lgaId: z.string().trim().optional(),
  wardId: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const wardScopedLookupQuerySchema = z.object({
  stateId: z.string().trim().min(1),
  lgaId: z.string().trim().min(1),
  wardId: z.string().trim().optional(),
});

const escalationSchema = z.object({
  escalationNote: z.string().trim().min(3).max(500),
});

const fieldTaskCreationSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(5).max(1000),
  assignedToUserId: z.string().trim().min(1),
  incidentId: z.string().trim().optional(),
  priority: z.nativeEnum(FieldTaskPriority).default(FieldTaskPriority.MEDIUM),
  dueAt: z.string().datetime().optional(),
});

const fieldTaskBulkCreationSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(5).max(1000),
  priority: z.nativeEnum(FieldTaskPriority).default(FieldTaskPriority.MEDIUM),
  dueAt: z.string().datetime().optional(),
  agentUserIds: z.array(z.string().trim().min(1)).max(200).optional(),
  geoPoliticalZoneId: z.string().trim().optional(),
  stateId: z.string().trim().optional(),
  senatorialDistrictId: z.string().trim().optional(),
  federalConstituencyId: z.string().trim().optional(),
  lgaId: z.string().trim().optional(),
  wardId: z.string().trim().optional(),
  stateConstituencyId: z.string().trim().optional(),
  pollingUnitId: z.string().trim().optional(),
});

const fieldTaskUpdateSchema = z.object({
  status: z.nativeEnum(FieldTaskStatus).optional(),
  priority: z.nativeEnum(FieldTaskPriority).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  resolutionNote: z.string().trim().max(1000).nullable().optional(),
});

const broadcastCreationSchema = z.object({
  title: z.string().trim().min(3).max(120),
  message: z.string().trim().min(5).max(1500),
  audience: z.nativeEnum(BroadcastAudience),
  taskStatus: z.nativeEnum(FieldTaskStatus).optional(),
  politicalPartyId: z.string().trim().optional(),
  adminLevel: z.nativeEnum(AdminLevel).optional(),
  officeType: z.nativeEnum(CandidateOfficeType).optional(),
  geoPoliticalZoneId: z.string().trim().optional(),
  stateId: z.string().trim().optional(),
  senatorialDistrictId: z.string().trim().optional(),
  federalConstituencyId: z.string().trim().optional(),
  lgaId: z.string().trim().optional(),
  wardId: z.string().trim().optional(),
  stateConstituencyId: z.string().trim().optional(),
  pollingUnitId: z.string().trim().optional(),
});

const engagementTaskCreationSchema = z.object({
  title: z.string().trim().min(3),
  description: z.string().trim().min(10),
  type: z.enum(["REGISTRATION", "REFERRAL", "POLL_RESPONSE"]),
  rewardPoints: z.number().int().min(1).max(1000),
  targetCount: z.number().int().min(1).max(100).optional(),
  geoPoliticalZoneId: z.string().trim().optional(),
  stateId: z.string().trim().optional(),
  senatorialDistrictId: z.string().trim().optional(),
  federalConstituencyId: z.string().trim().optional(),
  lgaId: z.string().trim().optional(),
  wardId: z.string().trim().optional(),
  stateConstituencyId: z.string().trim().optional(),
  pollingUnitId: z.string().trim().optional(),
});

function readRouteId(response: Response, value: string | string[] | undefined, label: string): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    response.status(400).json({ message: `Invalid ${label}.` });
    return null;
  }

  return value;
}

function enforceStateScope(
  actor: Express.Request["authUser"],
  requestedStateId?: string,
): string | null {
  if (!actor || actor.role === UserRole.SUPER_ADMIN || !actor.adminProfile?.stateId || !requestedStateId) {
    return null;
  }

  return actor.adminProfile.stateId === requestedStateId ? null : "You cannot view territory outside your state.";
}

function enforceLgaScope(
  actor: Express.Request["authUser"],
  requestedLgaId?: string,
): string | null {
  if (!actor || actor.role === UserRole.SUPER_ADMIN || !actor.adminProfile?.lgaId || !requestedLgaId) {
    return null;
  }

  return actor.adminProfile.lgaId === requestedLgaId ? null : "You cannot view territory outside your LGA.";
}

function validateAdminTerritoryPayload(data: {
  adminLevel: AdminLevel;
  geoPoliticalZoneId?: string;
  stateId?: string;
  senatorialDistrictId?: string;
  federalConstituencyId?: string;
  lgaId?: string;
  wardId?: string;
  stateConstituencyId?: string;
  pollingUnitId?: string;
}): string | null {
  if (data.adminLevel === "NATIONAL") {
    return data.geoPoliticalZoneId ||
      data.stateId ||
      data.senatorialDistrictId ||
      data.federalConstituencyId ||
      data.lgaId ||
      data.wardId ||
      data.stateConstituencyId ||
      data.pollingUnitId
      ? "NATIONAL admin must not include lower territory ids."
      : null;
  }

  if (data.adminLevel === "GEO_POLITICAL_ZONE" && !data.geoPoliticalZoneId) {
    return "GEO_POLITICAL_ZONE admin requires geoPoliticalZoneId.";
  }

  if (data.adminLevel === "STATE" && !data.stateId) {
    return "STATE admin requires stateId.";
  }

  if (data.adminLevel === "SENATORIAL" && (!data.stateId || !data.senatorialDistrictId)) {
    return "SENATORIAL admin requires stateId and senatorialDistrictId.";
  }

  if (data.adminLevel === "FEDERAL_CONSTITUENCY" && (!data.stateId || !data.federalConstituencyId)) {
    return "FEDERAL_CONSTITUENCY admin requires stateId and federalConstituencyId.";
  }

  if (data.adminLevel === "STATE_CONSTITUENCY" && (!data.stateId || !data.stateConstituencyId)) {
    return "STATE_CONSTITUENCY admin requires stateId and stateConstituencyId.";
  }

  if (data.adminLevel === "LGA" && (!data.stateId || !data.lgaId)) {
    return "LGA admin requires stateId and lgaId.";
  }

  if (data.adminLevel === "WARD" && (!data.stateId || !data.lgaId || !data.wardId)) {
    return "WARD admin requires stateId, lgaId, and wardId.";
  }

  return null;
}

async function enrichCandidateScope(data: {
  geoPoliticalZoneId?: string;
  stateId?: string;
  senatorialDistrictId?: string;
  federalConstituencyId?: string;
  lgaId?: string;
  wardId?: string;
  stateConstituencyId?: string;
  pollingUnitId?: string;
}) {
  const result = {
    geoPoliticalZoneId: data.geoPoliticalZoneId || null,
    stateId: data.stateId || null,
    senatorialDistrictId: data.senatorialDistrictId || null,
    federalConstituencyId: data.federalConstituencyId || null,
    lgaId: data.lgaId || null,
    wardId: data.wardId || null,
    stateConstituencyId: data.stateConstituencyId || null,
    pollingUnitId: data.pollingUnitId || null,
  };

  if (data.federalConstituencyId) {
    const constituency = await prisma.federalConstituency.findUnique({
      where: { id: data.federalConstituencyId },
      select: { senatorialDistrictId: true },
    });

    result.senatorialDistrictId = constituency?.senatorialDistrictId || result.senatorialDistrictId;
  }

  if (data.stateConstituencyId) {
    const constituency = await prisma.stateConstituency.findUnique({
      where: { id: data.stateConstituencyId },
      select: { lgaId: true },
    });

    result.lgaId = constituency?.lgaId || result.lgaId;
  }

  return result;
}

function getAgentScopeFilter(actor: Express.Request["authUser"]) {
  if (!actor || isSuperAdmin(actor)) {
    return {};
  }

  if (!actor.adminProfile) {
    return {};
  }

  return {
    geoPoliticalZoneId: actor.adminProfile.geoPoliticalZoneId || undefined,
    stateId: actor.adminProfile.stateId || undefined,
    senatorialDistrictId: actor.adminProfile.senatorialDistrictId || undefined,
    federalConstituencyId: actor.adminProfile.federalConstituencyId || undefined,
    lgaId: actor.adminProfile.lgaId || undefined,
    wardId: actor.adminProfile.wardId || undefined,
    stateConstituencyId: actor.adminProfile.stateConstituencyId || undefined,
    pollingUnitId: actor.adminProfile.pollingUnitId || undefined,
  };
}

function getAgentActivityScopeFilter(actor: Express.Request["authUser"]) {
  if (!actor || isSuperAdmin(actor)) {
    return {};
  }

  if (!actor.adminProfile) {
    return {};
  }

  return {
    geoPoliticalZoneId: actor.adminProfile.geoPoliticalZoneId || undefined,
    stateId: actor.adminProfile.stateId || undefined,
    senatorialDistrictId: actor.adminProfile.senatorialDistrictId || undefined,
    federalConstituencyId: actor.adminProfile.federalConstituencyId || undefined,
    lgaId: actor.adminProfile.lgaId || undefined,
    wardId: actor.adminProfile.wardId || undefined,
    stateConstituencyId: actor.adminProfile.stateConstituencyId || undefined,
    pollingUnitId: actor.adminProfile.pollingUnitId || undefined,
  };
}

function getFeedbackScopeFilter(actor: Express.Request["authUser"]) {
  if (!actor || isSuperAdmin(actor)) {
    return {};
  }

  if (!actor.adminProfile) {
    return {};
  }

  return {
    geoPoliticalZoneId: actor.adminProfile.geoPoliticalZoneId || undefined,
    stateId: actor.adminProfile.stateId || undefined,
    senatorialDistrictId: actor.adminProfile.senatorialDistrictId || undefined,
    lgaId: actor.adminProfile.lgaId || undefined,
    wardId: actor.adminProfile.wardId || undefined,
    pollingUnitId: actor.adminProfile.pollingUnitId || undefined,
  };
}

function getIncidentScopeFilter(actor: Express.Request["authUser"]) {
  if (!actor || isSuperAdmin(actor)) {
    return {};
  }

  if (!actor.adminProfile) {
    return {};
  }

  return {
    geoPoliticalZoneId: actor.adminProfile.geoPoliticalZoneId || undefined,
    stateId: actor.adminProfile.stateId || undefined,
    senatorialDistrictId: actor.adminProfile.senatorialDistrictId || undefined,
    federalConstituencyId: actor.adminProfile.federalConstituencyId || undefined,
    lgaId: actor.adminProfile.lgaId || undefined,
    wardId: actor.adminProfile.wardId || undefined,
    stateConstituencyId: actor.adminProfile.stateConstituencyId || undefined,
    pollingUnitId: actor.adminProfile.pollingUnitId || undefined,
  };
}

function getPollScopeFilter(actor: Express.Request["authUser"]) {
  if (!actor || isSuperAdmin(actor)) {
    return {};
  }

  if (!actor.adminProfile) {
    return {};
  }

  return {
    geoPoliticalZoneId: actor.adminProfile.geoPoliticalZoneId || undefined,
    stateId: actor.adminProfile.stateId || undefined,
    senatorialDistrictId: actor.adminProfile.senatorialDistrictId || undefined,
    federalConstituencyId: actor.adminProfile.federalConstituencyId || undefined,
    lgaId: actor.adminProfile.lgaId || undefined,
    wardId: actor.adminProfile.wardId || undefined,
    stateConstituencyId: actor.adminProfile.stateConstituencyId || undefined,
    pollingUnitId: actor.adminProfile.pollingUnitId || undefined,
  };
}

function getVoterScopeFilter(actor: Express.Request["authUser"]) {
  if (!actor || isSuperAdmin(actor)) {
    return {};
  }

  if (!actor.adminProfile) {
    return {};
  }

  return {
    geoPoliticalZoneId: actor.adminProfile.geoPoliticalZoneId || undefined,
    stateId: actor.adminProfile.stateId || undefined,
    lgaId: actor.adminProfile.lgaId || undefined,
    wardId: actor.adminProfile.wardId || undefined,
  };
}

async function buildGovernedIncidentItems(
  incidents: Array<{
    id: string;
    reportedByUserId: string;
    type: IncidentType;
    title: string;
    description: string;
    severity: IncidentSeverity;
    status: IncidentStatus;
    latitude: number | null;
    longitude: number | null;
    stateId: string;
    senatorialDistrictId: string | null;
    lgaId: string;
    wardId: string | null;
    pollingUnitId: string | null;
    assignedAdminUserId: string | null;
    escalatedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    reportedByUser: {
      role: UserRole;
      agentProfile: {
        stateId: string;
        lgaId: string;
        wardId: string;
        pollingUnitId: string | null;
      } | null;
      voterProfile: {
        stateId: string;
        lgaId: string;
        wardId: string;
        pollingUnitId: string | null;
      } | null;
      adminProfile: {
        stateId: string | null;
        lgaId: string | null;
        wardId: string | null;
        pollingUnitId: string | null;
      } | null;
      candidateProfile: {
        stateId: string | null;
        lgaId: string | null;
        wardId: string | null;
        pollingUnitId: string | null;
      } | null;
    };
  }>,
) {
  if (incidents.length === 0) {
    return [];
  }

  const duplicateKeys = new Set(
    incidents.map((incident) =>
      [
        incident.type,
        incident.pollingUnitId || "no-pu",
        incident.wardId || "no-ward",
        new Date(incident.createdAt).toISOString().slice(0, 13),
      ].join(":"),
    ),
  );

  const duplicateCounts = await prisma.incident.groupBy({
    by: ["type", "pollingUnitId", "wardId"],
    where: {
      OR: Array.from(duplicateKeys).map((key) => {
        const [type, pollingUnitId, wardId, hour] = key.split(":");
        return {
          type: type as IncidentType,
          pollingUnitId: pollingUnitId === "no-pu" ? null : pollingUnitId,
          wardId: wardId === "no-ward" ? null : wardId,
          createdAt: {
            gte: new Date(`${hour}:00:00.000Z`),
            lt: new Date(`${hour}:59:59.999Z`),
          },
        };
      }),
    },
    _count: { _all: true },
  });

  const duplicateCountMap = new Map(
    duplicateCounts.map((entry) => [
      [entry.type, entry.pollingUnitId || "no-pu", entry.wardId || "no-ward"].join(":"),
      entry._count._all,
    ]),
  );

  const reporterIds = Array.from(new Set(incidents.map((incident) => incident.reportedByUserId)));
  const reporterCounts = await prisma.incident.groupBy({
    by: ["reportedByUserId"],
    where: {
      reportedByUserId: { in: reporterIds },
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    _count: { _all: true },
  });

  const reporterCountMap = new Map(reporterCounts.map((entry) => [entry.reportedByUserId, entry._count._all]));

  return incidents.map((incident) => {
    const reporterScope = incident.reportedByUser.agentProfile ||
      incident.reportedByUser.voterProfile ||
      incident.reportedByUser.adminProfile ||
      incident.reportedByUser.candidateProfile || {
        stateId: null,
        lgaId: null,
        wardId: null,
        pollingUnitId: null,
      };

    const governance = buildIncidentGovernance(
      {
        ...incident,
        reportedByUser: {
          role: incident.reportedByUser.role,
          stateId: reporterScope.stateId,
          lgaId: reporterScope.lgaId,
          wardId: reporterScope.wardId,
          pollingUnitId: reporterScope.pollingUnitId,
        },
      },
      {
        duplicateCount:
          duplicateCountMap.get([incident.type, incident.pollingUnitId || "no-pu", incident.wardId || "no-ward"].join(":")) || 1,
        reporterIncidentCountInWindow: reporterCountMap.get(incident.reportedByUserId) || 1,
      },
    );

    return serializeIncidentItem({
      ...incident,
      governance,
    });
  });
}

function getFieldTaskScopeFilter(actor: Express.Request["authUser"]) {
  if (!actor || isSuperAdmin(actor)) {
    return {};
  }

  if (!actor.adminProfile) {
    return {};
  }

  return {
    geoPoliticalZoneId: actor.adminProfile.geoPoliticalZoneId || undefined,
    stateId: actor.adminProfile.stateId || undefined,
    senatorialDistrictId: actor.adminProfile.senatorialDistrictId || undefined,
    federalConstituencyId: actor.adminProfile.federalConstituencyId || undefined,
    lgaId: actor.adminProfile.lgaId || undefined,
    wardId: actor.adminProfile.wardId || undefined,
    stateConstituencyId: actor.adminProfile.stateConstituencyId || undefined,
    pollingUnitId: actor.adminProfile.pollingUnitId || undefined,
  };
}

function buildAgentTerritory(agentProfile: {
  geoPoliticalZoneId?: string | null;
  stateId: string;
  senatorialDistrictId?: string | null;
  federalConstituencyId?: string | null;
  lgaId: string;
  wardId: string;
  stateConstituencyId?: string | null;
  pollingUnitId?: string | null;
}) {
  return {
    geoPoliticalZoneId: agentProfile.geoPoliticalZoneId || undefined,
    stateId: agentProfile.stateId,
    senatorialDistrictId: agentProfile.senatorialDistrictId || undefined,
    federalConstituencyId: agentProfile.federalConstituencyId || undefined,
    lgaId: agentProfile.lgaId,
    wardId: agentProfile.wardId,
    stateConstituencyId: agentProfile.stateConstituencyId || undefined,
    pollingUnitId: agentProfile.pollingUnitId || undefined,
  };
}

async function createScopedFieldTask(
  actor: NonNullable<Express.Request["authUser"]>,
  assignedAgent: {
    id: string;
    agentProfile: {
      politicalPartyId: string | null;
      geoPoliticalZoneId: string | null;
      stateId: string;
      senatorialDistrictId: string | null;
      federalConstituencyId: string | null;
      lgaId: string;
      wardId: string;
      stateConstituencyId: string | null;
      pollingUnitId: string | null;
    };
  },
  payload: {
    title: string;
    description: string;
    priority: FieldTaskPriority;
    dueAt?: string;
    incidentId?: string;
  },
  linkedIncident?: Awaited<ReturnType<typeof prisma.incident.findUnique>> | null,
) {
  if (!isWithinActorParty(actor, assignedAgent.agentProfile.politicalPartyId)) {
    throw new Error("You cannot assign tasks outside your political party scope.");
  }

  const territory = linkedIncident
    ? {
        geoPoliticalZoneId: linkedIncident.geoPoliticalZoneId ?? assignedAgent.agentProfile.geoPoliticalZoneId,
        stateId: linkedIncident.stateId,
        senatorialDistrictId: linkedIncident.senatorialDistrictId ?? assignedAgent.agentProfile.senatorialDistrictId,
        federalConstituencyId: assignedAgent.agentProfile.federalConstituencyId,
        lgaId: linkedIncident.lgaId,
        wardId: linkedIncident.wardId ?? assignedAgent.agentProfile.wardId,
        stateConstituencyId: assignedAgent.agentProfile.stateConstituencyId,
        pollingUnitId: linkedIncident.pollingUnitId ?? assignedAgent.agentProfile.pollingUnitId,
      }
    : buildAgentTerritory(assignedAgent.agentProfile);

  const task = await prisma.$transaction(async (transaction) => {
    const createdTask = await transaction.fieldTask.create({
      data: {
        title: payload.title,
        description: payload.description,
        status: FieldTaskStatus.TODO,
        priority: payload.priority,
        createdByUserId: actor.id,
        assignedToUserId: assignedAgent.id,
        incidentId: payload.incidentId || null,
        dueAt: payload.dueAt ? new Date(payload.dueAt) : null,
        geoPoliticalZoneId: territory.geoPoliticalZoneId || null,
        stateId: territory.stateId,
        senatorialDistrictId: territory.senatorialDistrictId || null,
        federalConstituencyId: territory.federalConstituencyId || null,
        lgaId: territory.lgaId,
        wardId: territory.wardId,
        stateConstituencyId: territory.stateConstituencyId || null,
        pollingUnitId: territory.pollingUnitId || null,
      },
      include: {
        createdByUser: { select: { name: true } },
        assignedToUser: { select: { name: true } },
      },
    });

    await createNotification(transaction, {
      userId: assignedAgent.id,
      type: NotificationType.SYSTEM,
      title: "New field task assigned",
      message: `${payload.title} has been assigned to you.`,
    });

    await createAuditLog(transaction, {
      actorUserId: actor.id,
      action: "FIELD_TASK_CREATED",
      targetType: "FieldTask",
      targetId: createdTask.id,
      territory,
      metadata: { assignedToUserId: assignedAgent.id, incidentId: payload.incidentId || null },
    });

    return createdTask;
  });

  return task;
}

function buildBroadcastScope(data: z.infer<typeof broadcastCreationSchema>) {
  return {
    geoPoliticalZoneId: data.geoPoliticalZoneId || undefined,
    stateId: data.stateId || undefined,
    senatorialDistrictId: data.senatorialDistrictId || undefined,
    federalConstituencyId: data.federalConstituencyId || undefined,
    lgaId: data.lgaId || undefined,
    wardId: data.wardId || undefined,
    stateConstituencyId: data.stateConstituencyId || undefined,
    pollingUnitId: data.pollingUnitId || undefined,
  };
}

function buildEngagementTaskScope(data: z.infer<typeof engagementTaskCreationSchema>) {
  return {
    geoPoliticalZoneId: data.geoPoliticalZoneId || undefined,
    stateId: data.stateId || undefined,
    senatorialDistrictId: data.senatorialDistrictId || undefined,
    federalConstituencyId: data.federalConstituencyId || undefined,
    lgaId: data.lgaId || undefined,
    wardId: data.wardId || undefined,
    stateConstituencyId: data.stateConstituencyId || undefined,
    pollingUnitId: data.pollingUnitId || undefined,
  };
}

function buildBroadcastRecipientWhere(
  data: z.infer<typeof broadcastCreationSchema>,
  scope: ReturnType<typeof buildBroadcastScope>,
  actor?: Express.Request["authUser"],
) {
  const actorPartyId = actor?.role === UserRole.ADMIN ? actor.adminProfile?.politicalPartyId || undefined : undefined;
  const partyFilter = data.politicalPartyId || actorPartyId || undefined;
  const adminClause = {
    role: UserRole.ADMIN,
    adminProfile: {
      is: {
        ...scope,
        politicalPartyId: partyFilter,
        adminLevel: data.adminLevel || undefined,
      },
    },
  };
  const agentClause = {
    role: UserRole.AGENT,
    agentProfile: {
      is: {
        ...scope,
        politicalPartyId: partyFilter,
      },
    },
    ...(data.taskStatus ? { assignedTasks: { some: { status: data.taskStatus } } } : {}),
  };
  const voterClause = {
    role: UserRole.VOTER,
    voterProfile: {
      is: {
        ...scope,
        contactConsent: true,
      },
    },
  };
  const candidateClause = {
    role: UserRole.CANDIDATE,
    candidateProfile: {
      is: {
        ...scope,
        politicalPartyId: partyFilter,
        officeType: data.officeType || undefined,
      },
    },
  };

  if (data.audience === BroadcastAudience.ADMINS) {
    return adminClause;
  }
  if (data.audience === BroadcastAudience.AGENTS) {
    return agentClause;
  }
  if (data.audience === BroadcastAudience.VOTERS) {
    return voterClause;
  }
  if (data.audience === BroadcastAudience.CANDIDATES) {
    return candidateClause;
  }

  return {
    OR: partyFilter ? [adminClause, agentClause, candidateClause] : [adminClause, agentClause, voterClause, candidateClause],
  };
}

function getTodayStart() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function parseElectionDayVoteEntries(
  value: Prisma.JsonValue,
): Array<{ politicalPartyId: string; politicalPartyName: string | null; votes: number }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const record = entry as Record<string, Prisma.JsonValue>;
      const politicalPartyId = typeof record.politicalPartyId === "string" ? record.politicalPartyId : null;
      const politicalPartyName = typeof record.politicalPartyName === "string" ? record.politicalPartyName : null;
      const votes = typeof record.votes === "number" ? record.votes : null;
      if (!politicalPartyId || votes === null) {
        return null;
      }

      return {
        politicalPartyId,
        politicalPartyName,
        votes,
      };
    })
    .filter((entry): entry is { politicalPartyId: string; politicalPartyName: string | null; votes: number } => Boolean(entry));
}

function validateBroadcastTargeting(data: z.infer<typeof broadcastCreationSchema>) {
  if (data.taskStatus && !["AGENTS", "ALL"].includes(data.audience)) {
    return "Task-status targeting is only available for agent-inclusive broadcasts.";
  }

  if (data.adminLevel && !["ADMINS", "ALL"].includes(data.audience)) {
    return "Admin-level targeting is only available for admin-inclusive broadcasts.";
  }

  if (data.officeType && !["CANDIDATES", "ALL"].includes(data.audience)) {
    return "Office targeting is only available for candidate-inclusive broadcasts.";
  }

  if (data.politicalPartyId && data.audience === "VOTERS") {
    return "Political-party targeting is not available for voter-only broadcasts.";
  }

  return null;
}

function validateBroadcastPartyScope(
  actor: Express.Request["authUser"],
  politicalPartyId?: string,
) {
  const actorPartyId = actor?.role === UserRole.ADMIN ? actor.adminProfile?.politicalPartyId || null : null;

  if (!actorPartyId || !politicalPartyId) {
    return null;
  }

  return actorPartyId === politicalPartyId
    ? null
    : "You cannot target a political party outside your assigned party scope.";
}

function escapeCsvValue(value: string | null | undefined): string {
  const normalized = value ?? "";
  return `"${normalized.replace(/"/g, "\"\"")}"`;
}

function getDateRange(input: { dateFrom?: string; dateTo?: string }) {
  if (!input.dateFrom && !input.dateTo) {
    return undefined;
  }

  return {
    gte: input.dateFrom ? new Date(input.dateFrom) : undefined,
    lte: input.dateTo ? new Date(input.dateTo) : undefined,
  };
}

function getPollingUnitScopeFilter(actor: Express.Request["authUser"]) {
  if (!actor || isSuperAdmin(actor) || !actor.adminProfile) {
    return {};
  }

  return {
    state: actor.adminProfile.geoPoliticalZoneId
      ? { geoPoliticalZoneId: actor.adminProfile.geoPoliticalZoneId }
      : undefined,
    stateId: actor.adminProfile.stateId || undefined,
    lgaId: actor.adminProfile.lgaId || undefined,
    wardId: actor.adminProfile.wardId || undefined,
    id: actor.adminProfile.pollingUnitId || undefined,
  };
}

const BOOTSTRAP_LGA_ID_PREFIX = "bootstrap-lga-";

function getExpectedLgaTotalForStates(stateIds: string[]) {
  return stateIds.reduce((sum, stateId) => sum + (NIGERIA_STATE_EXPECTED_LGA_COUNTS[stateId] ?? 0), 0);
}

async function getScopedLgaIdsForReference(actor: Express.Request["authUser"]) {
  if (!actor || isSuperAdmin(actor) || !actor.adminProfile) {
    return { lgaIds: null as string[] | null, scopeWarning: null as string | null };
  }

  const scope = actor.adminProfile;

  if (scope.pollingUnitId) {
    const pollingUnit = await prisma.pollingUnit.findUnique({
      where: { id: scope.pollingUnitId },
      select: { lgaId: true },
    });
    return { lgaIds: pollingUnit?.lgaId ? [pollingUnit.lgaId] : [], scopeWarning: null };
  }

  if (scope.wardId) {
    const ward = await prisma.ward.findUnique({
      where: { id: scope.wardId },
      select: { lgaId: true },
    });
    return { lgaIds: ward?.lgaId ? [ward.lgaId] : [], scopeWarning: null };
  }

  if (scope.lgaId) {
    return { lgaIds: [scope.lgaId], scopeWarning: null };
  }

  if (scope.stateConstituencyId) {
    const memberships = await prisma.stateConstituencyLga.findMany({
      where: { stateConstituencyId: scope.stateConstituencyId },
      select: { lgaId: true },
    });
    if (memberships.length > 0) {
      return { lgaIds: memberships.map((item) => item.lgaId), scopeWarning: null };
    }

    const constituency = await prisma.stateConstituency.findUnique({
      where: { id: scope.stateConstituencyId },
      select: { lgaId: true },
    });
    return {
      lgaIds: constituency?.lgaId ? [constituency.lgaId] : [],
      scopeWarning: constituency?.lgaId ? null : "State constituency reference membership is missing. Run the reference bootstrap to restore exact coverage counts.",
    };
  }

  if (scope.federalConstituencyId) {
    const memberships = await prisma.federalConstituencyLga.findMany({
      where: { federalConstituencyId: scope.federalConstituencyId },
      select: { lgaId: true },
    });
    return memberships.length > 0
      ? { lgaIds: memberships.map((item) => item.lgaId), scopeWarning: null }
      : {
          lgaIds: [],
          scopeWarning: "Federal constituency reference membership is missing. Run the reference bootstrap to restore exact coverage counts.",
        };
  }

  if (scope.senatorialDistrictId) {
    const memberships = await prisma.senatorialDistrictLga.findMany({
      where: { senatorialDistrictId: scope.senatorialDistrictId },
      select: { lgaId: true },
    });
    return memberships.length > 0
      ? { lgaIds: memberships.map((item) => item.lgaId), scopeWarning: null }
      : {
          lgaIds: [],
          scopeWarning: "Senatorial district reference membership is missing. Run the reference bootstrap to restore exact coverage counts.",
        };
  }

  return { lgaIds: null, scopeWarning: null };
}

async function getAuthoritativeReferenceScope(actor: Express.Request["authUser"]) {
  if (!actor || isSuperAdmin(actor) || !actor.adminProfile) {
    return {
      stateWhere: {} as Prisma.StateWhereInput,
      lgaWhere: {} as Prisma.LGAWhereInput,
      wardWhere: {} as Prisma.WardWhereInput,
      pollingUnitWhere: {} as Prisma.PollingUnitWhereInput,
      scopeWarning: null as string | null,
    };
  }

  const scope = actor.adminProfile;
  const { lgaIds, scopeWarning } = await getScopedLgaIdsForReference(actor);

  if (scope.pollingUnitId) {
    return {
      stateWhere: { id: scope.stateId || undefined },
      lgaWhere: lgaIds?.length ? { id: { in: lgaIds } } : { id: "__no_scope__" },
      wardWhere: { id: scope.wardId || "__no_scope__" },
      pollingUnitWhere: { id: scope.pollingUnitId },
      scopeWarning,
    };
  }

  if (scope.wardId) {
    return {
      stateWhere: { id: scope.stateId || undefined },
      lgaWhere: lgaIds?.length ? { id: { in: lgaIds } } : { id: "__no_scope__" },
      wardWhere: { id: scope.wardId },
      pollingUnitWhere: { wardId: scope.wardId },
      scopeWarning,
    };
  }

  if (lgaIds) {
    return {
      stateWhere: { id: scope.stateId || undefined },
      lgaWhere: lgaIds.length ? { id: { in: lgaIds } } : { id: "__no_scope__" },
      wardWhere: lgaIds.length ? { lgaId: { in: lgaIds } } : { id: "__no_scope__" },
      pollingUnitWhere: lgaIds.length ? { lgaId: { in: lgaIds } } : { id: "__no_scope__" },
      scopeWarning,
    };
  }

  if (scope.stateId) {
    return {
      stateWhere: { id: scope.stateId },
      lgaWhere: { stateId: scope.stateId },
      wardWhere: { stateId: scope.stateId },
      pollingUnitWhere: { stateId: scope.stateId },
      scopeWarning,
    };
  }

  if (scope.geoPoliticalZoneId) {
    return {
      stateWhere: { geoPoliticalZoneId: scope.geoPoliticalZoneId },
      lgaWhere: { state: { geoPoliticalZoneId: scope.geoPoliticalZoneId } },
      wardWhere: { state: { geoPoliticalZoneId: scope.geoPoliticalZoneId } },
      pollingUnitWhere: { state: { geoPoliticalZoneId: scope.geoPoliticalZoneId } },
      scopeWarning,
    };
  }

  return {
    stateWhere: {} as Prisma.StateWhereInput,
    lgaWhere: {} as Prisma.LGAWhereInput,
    wardWhere: {} as Prisma.WardWhereInput,
    pollingUnitWhere: {} as Prisma.PollingUnitWhereInput,
    scopeWarning,
  };
}

function shouldUseExpectedStateLgaTotals(actor: Express.Request["authUser"]) {
  if (!actor || isSuperAdmin(actor) || !actor.adminProfile) {
    return true;
  }

  return !(
    actor.adminProfile.senatorialDistrictId ||
    actor.adminProfile.federalConstituencyId ||
    actor.adminProfile.stateConstituencyId ||
    actor.adminProfile.lgaId ||
    actor.adminProfile.wardId ||
    actor.adminProfile.pollingUnitId
  );
}

async function getCoveragePollingUnitScope(actor: Express.Request["authUser"]): Promise<{
  where: Prisma.PollingUnitWhereInput;
  scopeWarning: string | null;
}> {
  const scope = await getAuthoritativeReferenceScope(actor);
  return { where: scope.pollingUnitWhere, scopeWarning: scope.scopeWarning };
}

function getAdminPartyScopedAgentProfileFilter(actor: Express.Request["authUser"]): Prisma.AgentProfileWhereInput {
  if (!actor || isSuperAdmin(actor) || actor.role !== UserRole.ADMIN) {
    return {};
  }

  return actor.adminProfile?.politicalPartyId
    ? { politicalPartyId: actor.adminProfile.politicalPartyId }
    : { politicalPartyId: "__no_visible_party_scope__" };
}

function getAdminPartyScopedAgentUserFilter(actor: Express.Request["authUser"]): Prisma.UserWhereInput {
  if (!actor || isSuperAdmin(actor) || actor.role !== UserRole.ADMIN) {
    return {};
  }

  return actor.adminProfile?.politicalPartyId
    ? { agentProfile: { is: { politicalPartyId: actor.adminProfile.politicalPartyId } } }
    : { id: "__no_visible_party_scope__" };
}

function getAdminPartyScopedAgentRelationFilter(actor: Express.Request["authUser"]): Prisma.UserScalarRelationFilter | undefined {
  if (!actor || isSuperAdmin(actor) || actor.role !== UserRole.ADMIN) {
    return undefined;
  }

  return actor.adminProfile?.politicalPartyId
    ? { is: { agentProfile: { is: { politicalPartyId: actor.adminProfile.politicalPartyId } } } }
    : { is: { id: "__no_visible_party_scope__" } };
}

function getAdminPartyScopedIncidentWhere(actor: Express.Request["authUser"]): Prisma.IncidentWhereInput {
  if (!actor || isSuperAdmin(actor) || actor.role !== UserRole.ADMIN) {
    return {};
  }

  const actorPartyId = actor.adminProfile?.politicalPartyId || null;
  const voterIncidentScope: Prisma.IncidentWhereInput = {
    reportedByUser: {
      is: {
        role: UserRole.VOTER,
      },
    },
  };

  if (!actorPartyId) {
    return voterIncidentScope;
  }

  return {
    OR: [
      voterIncidentScope,
      {
        reportedByUser: {
          is: {
            role: UserRole.ADMIN,
            adminProfile: { is: { politicalPartyId: actorPartyId } },
          },
        },
      },
      {
        reportedByUser: {
          is: {
            role: UserRole.AGENT,
            agentProfile: { is: { politicalPartyId: actorPartyId } },
          },
        },
      },
      {
        reportedByUser: {
          is: {
            role: UserRole.CANDIDATE,
            candidateProfile: { is: { politicalPartyId: actorPartyId } },
          },
        },
      },
    ],
  };
}

function getAdminPartyScopedFeedbackWhere(actor: Express.Request["authUser"]): Prisma.FeedbackWhereInput {
  if (!actor || isSuperAdmin(actor) || actor.role !== UserRole.ADMIN) {
    return {};
  }

  const actorPartyId = actor.adminProfile?.politicalPartyId || null;
  const voterFeedbackScope: Prisma.FeedbackWhereInput = {
    voterUserId: { not: null },
  };

  if (!actorPartyId) {
    return voterFeedbackScope;
  }

  return {
    OR: [
      voterFeedbackScope,
      {
        agentUser: {
          is: {
            agentProfile: { is: { politicalPartyId: actorPartyId } },
          },
        },
      },
      {
        candidateUser: {
          is: {
            candidateProfile: { is: { politicalPartyId: actorPartyId } },
          },
        },
      },
    ],
  };
}

function canSetStateAgentTarget(actor: Express.Request["authUser"], stateId: string) {
  if (!actor) {
    return false;
  }

  if (isSuperAdmin(actor)) {
    return true;
  }

  if (!isAdminUser(actor) || !actor.adminProfile) {
    return false;
  }

  if (actor.adminProfile.adminLevel !== AdminLevel.NATIONAL && actor.adminProfile.adminLevel !== AdminLevel.STATE) {
    return false;
  }

  return isWithinAdminScope(actor, { stateId });
}

const adminLevelSpecificity: Record<AdminLevel, number> = {
  WARD: 0,
  LGA: 1,
  STATE_CONSTITUENCY: 2,
  FEDERAL_CONSTITUENCY: 3,
  SENATORIAL: 4,
  STATE: 5,
  GEO_POLITICAL_ZONE: 6,
  NATIONAL: 7,
};

async function resolveTerritoryAdminUserId(input: {
  politicalPartyId: string;
  geoPoliticalZoneId?: string;
  stateId: string;
  senatorialDistrictId?: string;
  federalConstituencyId?: string;
  lgaId: string;
  wardId: string;
  stateConstituencyId?: string;
  pollingUnitId: string;
}) {
  const admins = await prisma.user.findMany({
    where: {
      role: UserRole.ADMIN,
      isActive: true,
      adminProfile: {
        is: {
          politicalPartyId: input.politicalPartyId,
        },
      },
    },
    include: { adminProfile: true },
  });

  const matchingAdmins = admins.filter((admin) => {
    const profile = admin.adminProfile;
    if (!profile) {
      return false;
    }

    if (profile.geoPoliticalZoneId && profile.geoPoliticalZoneId !== input.geoPoliticalZoneId) {
      return false;
    }
    if (profile.stateId && profile.stateId !== input.stateId) {
      return false;
    }
    if (profile.senatorialDistrictId && profile.senatorialDistrictId !== input.senatorialDistrictId) {
      return false;
    }
    if (profile.federalConstituencyId && profile.federalConstituencyId !== input.federalConstituencyId) {
      return false;
    }
    if (profile.stateConstituencyId && profile.stateConstituencyId !== input.stateConstituencyId) {
      return false;
    }
    if (profile.lgaId && profile.lgaId !== input.lgaId) {
      return false;
    }
    if (profile.wardId && profile.wardId !== input.wardId) {
      return false;
    }
    if (profile.pollingUnitId && profile.pollingUnitId !== input.pollingUnitId) {
      return false;
    }

    return true;
  });

  if (matchingAdmins.length === 0) {
    return null;
  }

  const topSpecificity = Math.min(...matchingAdmins.map((admin) => adminLevelSpecificity[admin.adminProfile!.adminLevel]));
  const topMatches = matchingAdmins.filter((admin) => adminLevelSpecificity[admin.adminProfile!.adminLevel] === topSpecificity);

  return topMatches.length === 1 ? topMatches[0]!.id : null;
}

function getStateReferenceScopeFilter(actor: Express.Request["authUser"]): Prisma.StateWhereInput {
  if (!actor || isSuperAdmin(actor) || !actor.adminProfile) {
    return {};
  }

  return {
    geoPoliticalZoneId: actor.adminProfile.geoPoliticalZoneId || undefined,
    id: actor.adminProfile.stateId || undefined,
  };
}

function getLgaReferenceScopeFilter(actor: Express.Request["authUser"]): Prisma.LGAWhereInput {
  if (!actor || isSuperAdmin(actor) || !actor.adminProfile) {
    return {};
  }

  return {
    state: actor.adminProfile.geoPoliticalZoneId
      ? { geoPoliticalZoneId: actor.adminProfile.geoPoliticalZoneId }
      : undefined,
    stateId: actor.adminProfile.stateId || undefined,
    id: actor.adminProfile.lgaId || undefined,
  };
}

function getWardReferenceScopeFilter(actor: Express.Request["authUser"]): Prisma.WardWhereInput {
  if (!actor || isSuperAdmin(actor) || !actor.adminProfile) {
    return {};
  }

  return {
    state: actor.adminProfile.geoPoliticalZoneId
      ? { geoPoliticalZoneId: actor.adminProfile.geoPoliticalZoneId }
      : undefined,
    stateId: actor.adminProfile.stateId || undefined,
    lgaId: actor.adminProfile.lgaId || undefined,
    id: actor.adminProfile.wardId || undefined,
  };
}

async function buildReferenceCompletenessReport(actor: Express.Request["authUser"]) {
  const { stateWhere, lgaWhere, wardWhere, pollingUnitWhere } = await getAuthoritativeReferenceScope(actor);
  const states = await prisma.state.findMany({
    where: stateWhere,
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  const [lgas, wards, pollingUnits] = await Promise.all([
    prisma.lGA.findMany({
      where: lgaWhere,
      select: { id: true, stateId: true },
    }),
    prisma.ward.findMany({
      where: wardWhere,
      select: { id: true, stateId: true, lgaId: true },
    }),
    prisma.pollingUnit.findMany({
      where: pollingUnitWhere,
      select: { id: true, stateId: true, wardId: true },
    }),
  ]);

  const scopedLgasByState = new Map<string, Array<{ id: string; stateId: string }>>();
  const scopedWardsByState = new Map<string, Array<{ id: string; stateId: string; lgaId: string }>>();
  const scopedPollingUnitsByState = new Map<string, Array<{ id: string; stateId: string; wardId: string }>>();

  for (const lga of lgas) {
    const current = scopedLgasByState.get(lga.stateId) || [];
    current.push(lga);
    scopedLgasByState.set(lga.stateId, current);
  }

  for (const ward of wards) {
    const current = scopedWardsByState.get(ward.stateId) || [];
    current.push(ward);
    scopedWardsByState.set(ward.stateId, current);
  }

  for (const pollingUnit of pollingUnits) {
    const current = scopedPollingUnitsByState.get(pollingUnit.stateId) || [];
    current.push(pollingUnit);
    scopedPollingUnitsByState.set(pollingUnit.stateId, current);
  }

  const summary = {
    expectedStates: actor && isSuperAdmin(actor) ? NIGERIA_EXPECTED_STATE_TOTAL : states.length,
    loadedStates: states.length,
    expectedLgas: 0,
    loadedLgas: 0,
    loadedWards: 0,
    loadedPollingUnits: 0,
    statesWithMissingLgas: 0,
    lgasWithoutWards: 0,
    wardsWithoutPollingUnits: 0,
  };

  const stateItems = states.map((state) => {
    const stateLgas = scopedLgasByState.get(state.id) || [];
    const stateWards = scopedWardsByState.get(state.id) || [];
    const statePollingUnits = scopedPollingUnitsByState.get(state.id) || [];
    const expectedLgas =
      actor && !isSuperAdmin(actor) && actor.adminProfile
        ? stateLgas.length
        : (NIGERIA_STATE_EXPECTED_LGA_COUNTS[state.id] ?? stateLgas.length);
    const loadedLgas = stateLgas.length;
    const loadedWards = stateWards.length;
    const loadedPollingUnits = statePollingUnits.length;
    const lgasWithoutWards = stateLgas.filter((lga) => !stateWards.some((ward) => ward.lgaId === lga.id)).length;
    const wardsWithoutPollingUnits = stateWards.filter(
      (ward) => !statePollingUnits.some((pollingUnit) => pollingUnit.wardId === ward.id),
    ).length;
    const missingLgas = Math.max(expectedLgas - loadedLgas, 0);
    const isComplete = missingLgas === 0 && lgasWithoutWards === 0 && wardsWithoutPollingUnits === 0;

    summary.expectedLgas += expectedLgas;
    summary.loadedLgas += loadedLgas;
    summary.loadedWards += loadedWards;
    summary.loadedPollingUnits += loadedPollingUnits;
    summary.statesWithMissingLgas += missingLgas > 0 ? 1 : 0;
    summary.lgasWithoutWards += lgasWithoutWards;
    summary.wardsWithoutPollingUnits += wardsWithoutPollingUnits;

    return {
      stateId: state.id,
      stateName: state.name,
      expectedLgas,
      loadedLgas,
      missingLgas,
      loadedWards,
      lgasWithoutWards,
      loadedPollingUnits,
      wardsWithoutPollingUnits,
      isComplete,
    };
  });

  if (actor && isSuperAdmin(actor)) {
    summary.expectedLgas = NIGERIA_EXPECTED_LGA_TOTAL;
  }

  return {
    generatedAt: new Date().toISOString(),
    manualBootstrapCommand: "npm run bootstrap:polling-units:national --workspace @pics-nigeria/database",
    summary,
    states: stateItems,
  };
}

async function canViewAuditLog(
  actor: NonNullable<Express.Request["authUser"]>,
  log: {
    actorUserId: string;
    targetType: string;
    targetId: string;
  },
) {
  if (isSuperAdmin(actor)) {
    return true;
  }

  if (!isAdminUser(actor)) {
    return false;
  }

  if (log.actorUserId === actor.id) {
    return true;
  }

  if (log.targetType === "User") {
    const targetAuth = await getAuthUserProfile(log.targetId);
    return Boolean(targetAuth && canManageUser(actor, targetAuth));
  }

  if (log.targetType === "Incident") {
    const incident = await prisma.incident.findUnique({
      where: { id: log.targetId },
      select: {
        geoPoliticalZoneId: true,
        stateId: true,
        senatorialDistrictId: true,
        lgaId: true,
        wardId: true,
        pollingUnitId: true,
      },
    });

    return Boolean(incident && isWithinAdminScope(actor, incident));
  }

  if (log.targetType === "FieldTask") {
    const task = await prisma.fieldTask.findUnique({
      where: { id: log.targetId },
      select: {
        geoPoliticalZoneId: true,
        stateId: true,
        senatorialDistrictId: true,
        federalConstituencyId: true,
        lgaId: true,
        wardId: true,
        stateConstituencyId: true,
        pollingUnitId: true,
      },
    });

    return Boolean(task && canCreateAgentInScope(actor, task));
  }

  if (log.targetType === "VoterEngagementTask") {
    const task = await prisma.voterEngagementTask.findUnique({
      where: { id: log.targetId },
      select: {
        geoPoliticalZoneId: true,
        stateId: true,
        senatorialDistrictId: true,
        federalConstituencyId: true,
        lgaId: true,
        wardId: true,
        stateConstituencyId: true,
        pollingUnitId: true,
      },
    });

    return Boolean(task && isWithinAdminScope(actor, task));
  }

  if (log.targetType === "RewardRedemption") {
    const redemption = await prisma.rewardRedemption.findUnique({
      where: { id: log.targetId },
      select: { voterUserId: true },
    });

    if (!redemption) {
      return false;
    }

    const voterProfile = await prisma.voterProfile.findUnique({
      where: { userId: redemption.voterUserId },
      select: {
        geoPoliticalZoneId: true,
        stateId: true,
        senatorialDistrictId: true,
        federalConstituencyId: true,
        lgaId: true,
        wardId: true,
        stateConstituencyId: true,
        pollingUnitId: true,
      },
    });

    return Boolean(voterProfile && isWithinAdminScope(actor, voterProfile));
  }

  if (log.targetType === "BroadcastMessage") {
    const broadcast = await prisma.broadcastMessage.findUnique({
      where: { id: log.targetId },
      select: {
        geoPoliticalZoneId: true,
        stateId: true,
        senatorialDistrictId: true,
        federalConstituencyId: true,
        lgaId: true,
        wardId: true,
        stateConstituencyId: true,
        pollingUnitId: true,
      },
    });

    return Boolean(broadcast && isWithinAdminScope(actor, broadcast));
  }

  if (log.targetType === "ElectionDayReport") {
    const report = await prisma.electionDayReport.findUnique({
      where: { id: log.targetId },
      select: {
        agentUserId: true,
        geoPoliticalZoneId: true,
        stateId: true,
        senatorialDistrictId: true,
        federalConstituencyId: true,
        lgaId: true,
        wardId: true,
        stateConstituencyId: true,
        pollingUnitId: true,
      },
    });

    if (!report || !canCreateAgentInScope(actor, report)) {
      return false;
    }

    const agentProfile = await prisma.agentProfile.findUnique({
      where: { userId: report.agentUserId },
      select: { politicalPartyId: true },
    });

    return Boolean(agentProfile && isWithinActorParty(actor, agentProfile.politicalPartyId));
  }

  if (log.targetType === "State") {
    const state = await prisma.state.findUnique({
      where: { id: log.targetId },
      select: { id: true },
    });

    return Boolean(state && isWithinAdminScope(actor, { stateId: state.id }));
  }

  if (log.targetType === "Poll") {
    const poll = await prisma.poll.findUnique({
      where: { id: log.targetId },
      select: {
        geoPoliticalZoneId: true,
        stateId: true,
        senatorialDistrictId: true,
        federalConstituencyId: true,
        lgaId: true,
        wardId: true,
        stateConstituencyId: true,
        pollingUnitId: true,
      },
    });

    return Boolean(poll && isWithinAdminScope(actor, poll));
  }

  return false;
}

function applyActorAdminScope<T extends {
  politicalPartyId?: string;
  geoPoliticalZoneId?: string;
  stateId?: string;
  senatorialDistrictId?: string;
  federalConstituencyId?: string;
  lgaId?: string;
  wardId?: string;
  stateConstituencyId?: string;
  pollingUnitId?: string;
}>(actor: Express.Request["authUser"], payload: T): T {
  if (!actor || actor.role !== UserRole.ADMIN || !actor.adminProfile) {
    return payload;
  }

  const scope = actor.adminProfile;

  return {
    ...payload,
    politicalPartyId: scope.politicalPartyId || payload.politicalPartyId,
    geoPoliticalZoneId: scope.geoPoliticalZoneId || payload.geoPoliticalZoneId,
    stateId: scope.stateId || payload.stateId,
    senatorialDistrictId: scope.senatorialDistrictId || payload.senatorialDistrictId,
    federalConstituencyId: scope.federalConstituencyId || payload.federalConstituencyId,
    lgaId: scope.lgaId || payload.lgaId,
    wardId: scope.wardId || payload.wardId,
    stateConstituencyId: scope.stateConstituencyId || payload.stateConstituencyId,
    pollingUnitId: scope.pollingUnitId || payload.pollingUnitId,
  };
}

async function ensurePoliticalPartyExists(politicalPartyId: string): Promise<boolean> {
  const party = await prisma.politicalParty.findUnique({
    where: { id: politicalPartyId },
    select: { id: true },
  });

  return Boolean(party);
}

function requireActorPartyForManagement(actor: Express.Request["authUser"]): string | null {
  if (!actor || actor.role !== UserRole.ADMIN) {
    return null;
  }

  return actor.adminProfile?.politicalPartyId || null;
}

router.post("/users", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = adminCreationSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid admin creation payload.", errors: parsed.error.flatten() });
  }

  const scopedPayload = applyActorAdminScope(request.authUser, parsed.data);

  if (!scopedPayload.politicalPartyId) {
    return response.status(400).json({ message: "Admin accounts must be linked to a political party." });
  }

  if (!(await ensurePoliticalPartyExists(scopedPayload.politicalPartyId))) {
    return response.status(400).json({ message: "Selected political party does not exist." });
  }

  const territoryError = validateAdminTerritoryPayload(scopedPayload);
  if (territoryError) {
    return response.status(400).json({ message: territoryError });
  }

  const territoryReferenceError = await validateTerritoryReferences(scopedPayload);
  if (territoryReferenceError) {
    return response.status(400).json({ message: territoryReferenceError });
  }

  if (!request.authUser || !canManageAdmin(request.authUser, scopedPayload)) {
    return response.status(403).json({ message: "You cannot create an admin at this level or territory." });
  }

  const email = normalizeEmail(scopedPayload.email);
  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existingUser) {
    return response.status(409).json({ message: "Email is already registered." });
  }

  const createdUser = await prisma.user.create({
    data: {
      name: parsed.data.name.trim(),
      email,
      passwordHash: await hashPassword(parsed.data.password),
      role: UserRole.ADMIN,
      adminProfile: {
        create: {
          adminLevel: scopedPayload.adminLevel,
          politicalPartyId: scopedPayload.politicalPartyId,
          geoPoliticalZoneId: scopedPayload.geoPoliticalZoneId || null,
          stateId: scopedPayload.stateId || null,
          senatorialDistrictId: scopedPayload.senatorialDistrictId || null,
          federalConstituencyId: scopedPayload.federalConstituencyId || null,
          lgaId: scopedPayload.lgaId || null,
          wardId: scopedPayload.wardId || null,
          stateConstituencyId: scopedPayload.stateConstituencyId || null,
          pollingUnitId: scopedPayload.pollingUnitId || null,
        } as Prisma.AdminProfileUncheckedCreateWithoutUserInput,
      },
    },
  });

  await createAuditLog(prisma, {
    actorUserId: request.authUser!.id,
    action: "ADMIN_CREATED",
    targetType: "User",
    targetId: createdUser.id,
    politicalPartyId: scopedPayload.politicalPartyId || null,
    territory: {
      geoPoliticalZoneId: scopedPayload.geoPoliticalZoneId || null,
      stateId: scopedPayload.stateId || null,
      senatorialDistrictId: scopedPayload.senatorialDistrictId || null,
      federalConstituencyId: scopedPayload.federalConstituencyId || null,
      lgaId: scopedPayload.lgaId || null,
      wardId: scopedPayload.wardId || null,
      stateConstituencyId: scopedPayload.stateConstituencyId || null,
      pollingUnitId: scopedPayload.pollingUnitId || null,
    },
    metadata: {
      adminLevel: scopedPayload.adminLevel,
    },
  });

  return response.status(201).json({
    message: "Admin created successfully.",
    user: await getAuthUserProfile(createdUser.id),
  });
});

router.post("/candidates", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = candidateCreationSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid candidate creation payload.", errors: parsed.error.flatten() });
  }

  const scopedPayload = applyActorAdminScope(request.authUser, parsed.data);

  if (!request.authUser || !canManageCandidateOffice(request.authUser, scopedPayload.officeType)) {
    return response.status(403).json({ message: "You cannot create a candidate for that office level." });
  }

  const territoryError = validateCandidateOfficeTerritory(scopedPayload.officeType, scopedPayload);
  if (territoryError) {
    return response.status(400).json({ message: territoryError });
  }

  const territoryReferenceError = await validateTerritoryReferences(scopedPayload);
  if (territoryReferenceError) {
    return response.status(400).json({ message: territoryReferenceError });
  }

  const actorPartyId = requireActorPartyForManagement(request.authUser);
  if (request.authUser?.role === UserRole.ADMIN && !actorPartyId) {
    return response.status(403).json({ message: "Your admin account is not linked to a political party." });
  }

  if (request.authUser?.role === UserRole.ADMIN && scopedPayload.politicalPartyId !== actorPartyId) {
    return response.status(403).json({ message: "You can only create candidates for your assigned political party." });
  }

  if (scopedPayload.politicalPartyId && !(await ensurePoliticalPartyExists(scopedPayload.politicalPartyId))) {
    return response.status(400).json({ message: "Selected political party does not exist." });
  }

  const scope = await enrichCandidateScope(scopedPayload);

  if (!request.authUser || !canViewCandidate(request.authUser, { ...scope, politicalPartyId: scopedPayload.politicalPartyId || null })) {
    return response.status(403).json({ message: "You cannot create a candidate outside your admin territory." });
  }

  const email = normalizeEmail(scopedPayload.email);
  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existingUser) {
    return response.status(409).json({ message: "Email is already registered." });
  }

  const createdUser = await prisma.user.create({
    data: {
      name: scopedPayload.name.trim(),
      email,
      passwordHash: await hashPassword(scopedPayload.password),
      role: UserRole.CANDIDATE,
      candidateProfile: {
        create: {
          officeType: scopedPayload.officeType,
          politicalPartyId: scopedPayload.politicalPartyId || null,
          ...scope,
        },
      },
    },
  });

  await createAuditLog(prisma, {
    actorUserId: request.authUser!.id,
    action: "CANDIDATE_CREATED",
    targetType: "User",
    targetId: createdUser.id,
    politicalPartyId: scopedPayload.politicalPartyId || null,
    territory: {
      geoPoliticalZoneId: scope.geoPoliticalZoneId,
      stateId: scope.stateId,
      senatorialDistrictId: scope.senatorialDistrictId,
      federalConstituencyId: scope.federalConstituencyId,
      lgaId: scope.lgaId,
      wardId: scope.wardId,
      stateConstituencyId: scope.stateConstituencyId,
      pollingUnitId: scope.pollingUnitId,
    },
    metadata: {
      officeType: scopedPayload.officeType,
    },
  });

  return response.status(201).json({
    message: "Candidate created successfully.",
    user: await getAuthUserProfile(createdUser.id),
  });
});

router.post("/candidates/assign", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const parsed = assignmentSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid candidate assignment payload.", errors: parsed.error.flatten() });
  }

  const [adminUser, candidateUser] = await Promise.all([
    prisma.user.findUnique({
      where: { id: parsed.data.adminUserId },
      include: { adminProfile: true },
    }),
    prisma.user.findUnique({
      where: { id: parsed.data.candidateUserId },
      include: { candidateProfile: true },
    }),
  ]);

  if (!adminUser?.adminProfile) {
    return response.status(404).json({ message: "Admin user was not found." });
  }

  if (!candidateUser?.candidateProfile) {
    return response.status(404).json({ message: "Candidate user was not found." });
  }

  const adminAuth = await getAuthUserProfile(adminUser.id);
  if (!adminAuth || !canViewCandidate(adminAuth, { ...candidateUser.candidateProfile, userId: candidateUser.id })) {
    return response.status(400).json({ message: "Admin territory is not compatible with the candidate territory." });
  }

  if (
    adminUser.adminProfile.politicalPartyId &&
    candidateUser.candidateProfile.politicalPartyId &&
    adminUser.adminProfile.politicalPartyId !== candidateUser.candidateProfile.politicalPartyId
  ) {
    return response.status(400).json({ message: "Admin and candidate must belong to the same political party." });
  }

  const existingAssignment = await prisma.adminCandidateAssignment.findUnique({
    where: {
      adminUserId_candidateUserId_permissionType: {
        adminUserId: parsed.data.adminUserId,
        candidateUserId: parsed.data.candidateUserId,
        permissionType: parsed.data.permissionType,
      },
    },
    select: { id: true },
  });

  if (existingAssignment) {
    return response.status(409).json({ message: "This assignment already exists." });
  }

  const assignment = await prisma.adminCandidateAssignment.create({
    data: parsed.data,
  });

  await createAuditLog(prisma, {
    actorUserId: request.authUser!.id,
    action: "CANDIDATE_ASSIGNED",
    targetType: "AdminCandidateAssignment",
    targetId: assignment.id,
    metadata: {
      adminUserId: parsed.data.adminUserId,
      candidateUserId: parsed.data.candidateUserId,
      permissionType: parsed.data.permissionType,
    },
  });

  return response.status(201).json({
    message: "Candidate assigned successfully.",
    assignment,
  });
});

router.get("/geo-political-zones", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (_request, response) => {
  const zones = await prisma.geoPoliticalZone.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  return response.json({ zones });
});

router.get("/states", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = stateLookupQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid state lookup query.", errors: parsed.error.flatten() });
  }

  // Feature 004 keeps the national reference set for reporting and INEC
  // alignment, so this lookup stays — but backfilling it must not decide
  // whether the endpoint answers, and it must not be able to take the process
  // down the way the public registration route could.
  if ((await prisma.state.count()) < 37) {
    try {
      await ensureNationalReferenceStates(prisma);
    } catch (error) {
      console.error("Reference state backfill failed; serving stored states.", error);
    }
  }

  const actor = request.authUser;
  const requestedZoneId = parsed.data.geoPoliticalZoneId;
  const actorZoneId = actor?.adminProfile?.geoPoliticalZoneId || null;

  if (actor?.role === "ADMIN" && actorZoneId && requestedZoneId && requestedZoneId !== actorZoneId) {
    return response.status(403).json({ message: "You cannot view states outside your geo-political zone." });
  }

  const states = await prisma.state.findMany({
    where: {
      geoPoliticalZoneId: requestedZoneId || actorZoneId || undefined,
      id: actor?.role === "ADMIN" ? actor.adminProfile?.stateId || undefined : undefined,
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, geoPoliticalZoneId: true },
  });

  return response.json({ states });
});

router.patch("/states/:stateId/agent-target", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const stateId = readRouteId(response, request.params.stateId, "state id");
  if (!stateId) {
    return;
  }

  const parsed = stateAgentTargetSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid state agent target payload.", errors: parsed.error.flatten() });
  }

  if (!canSetStateAgentTarget(request.authUser, stateId)) {
    return response.status(403).json({ message: "You do not have permission to update this state staffing target." });
  }

  const state = await prisma.state.findUnique({
    where: { id: stateId },
    select: { id: true, name: true, agentsPerPollingUnitTarget: true },
  });

  if (!state) {
    return response.status(404).json({ message: "State not found." });
  }

  const updatedState = await prisma.state.update({
    where: { id: stateId },
    data: { agentsPerPollingUnitTarget: parsed.data.agentsPerPollingUnitTarget },
    select: { id: true, name: true, agentsPerPollingUnitTarget: true },
  });

  await createAuditLog(prisma, {
    actorUserId: request.authUser!.id,
    action: "STATE_AGENT_TARGET_UPDATED",
    targetType: "State",
    targetId: updatedState.id,
    territory: { stateId: updatedState.id },
    metadata: {
      previousAgentsPerPollingUnitTarget: state.agentsPerPollingUnitTarget ?? 1,
      nextAgentsPerPollingUnitTarget: updatedState.agentsPerPollingUnitTarget ?? 1,
      stateName: updatedState.name,
    },
  });

  return response.json({
    message: "State staffing target updated successfully.",
    state: updatedState,
  });
});

router.get("/reference-completeness", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const report = await buildReferenceCompletenessReport(request.authUser);
  return response.json({ report });
});

router.get("/senatorial-districts", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = stateScopedLookupQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid senatorial district lookup query.", errors: parsed.error.flatten() });
  }

  const scopeError = enforceStateScope(request.authUser, parsed.data.stateId);
  if (scopeError) {
    return response.status(403).json({ message: scopeError });
  }

  const districts = await prisma.senatorialDistrict.findMany({
    where: { stateId: parsed.data.stateId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, stateId: true },
  });

  return response.json({ districts });
});

router.get("/federal-constituencies", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = federalConstituencyLookupQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid federal constituency lookup query.", errors: parsed.error.flatten() });
  }

  const scopeError = enforceStateScope(request.authUser, parsed.data.stateId);
  if (scopeError) {
    return response.status(403).json({ message: scopeError });
  }

  const constituencies = await prisma.federalConstituency.findMany({
    where: {
      stateId: parsed.data.stateId,
      senatorialDistrictId: parsed.data.senatorialDistrictId || undefined,
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, stateId: true, senatorialDistrictId: true },
  });

  return response.json({ constituencies });
});

router.get("/lgas", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = stateScopedLookupQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid LGA lookup query.", errors: parsed.error.flatten() });
  }

  const scopeError = enforceStateScope(request.authUser, parsed.data.stateId);
  if (scopeError) {
    return response.status(403).json({ message: scopeError });
  }

  let lgas = await prisma.lGA.findMany({
    where: { stateId: parsed.data.stateId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, stateId: true },
  });

  if (lgas.length === 0) {
    await syncLgasForState(prisma, parsed.data.stateId);
    lgas = await prisma.lGA.findMany({
      where: { stateId: parsed.data.stateId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, stateId: true },
    });
  }

  return response.json({ lgas });
});

router.get("/wards", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = lgaScopedLookupQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid ward lookup query.", errors: parsed.error.flatten() });
  }

  const stateScopeError = enforceStateScope(request.authUser, parsed.data.stateId);
  if (stateScopeError) {
    return response.status(403).json({ message: stateScopeError });
  }

  const lgaScopeError = enforceLgaScope(request.authUser, parsed.data.lgaId);
  if (lgaScopeError) {
    return response.status(403).json({ message: lgaScopeError });
  }

  let wards = await prisma.ward.findMany({
    where: {
      stateId: parsed.data.stateId,
      lgaId: parsed.data.lgaId || undefined,
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, stateId: true, lgaId: true },
  });

  if (wards.length === 0 && parsed.data.stateId && parsed.data.lgaId) {
    await syncWardsForLga(prisma, parsed.data.stateId, parsed.data.lgaId);
    wards = await prisma.ward.findMany({
      where: {
        stateId: parsed.data.stateId,
        lgaId: parsed.data.lgaId,
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true, stateId: true, lgaId: true },
    });
  }

  return response.json({ wards });
});

router.get("/state-constituencies", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = lgaScopedLookupQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid state constituency lookup query.", errors: parsed.error.flatten() });
  }

  const stateScopeError = enforceStateScope(request.authUser, parsed.data.stateId);
  if (stateScopeError) {
    return response.status(403).json({ message: stateScopeError });
  }

  const lgaScopeError = enforceLgaScope(request.authUser, parsed.data.lgaId);
  if (lgaScopeError) {
    return response.status(403).json({ message: lgaScopeError });
  }

  const constituencies = await prisma.stateConstituency.findMany({
    where: {
      stateId: parsed.data.stateId,
      lgaId: parsed.data.lgaId || undefined,
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, stateId: true, lgaId: true },
  });

  return response.json({ constituencies });
});

router.get("/polling-units", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = wardScopedLookupQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid polling unit lookup query.", errors: parsed.error.flatten() });
  }

  const stateScopeError = enforceStateScope(request.authUser, parsed.data.stateId);
  if (stateScopeError) {
    return response.status(403).json({ message: stateScopeError });
  }

  const lgaScopeError = enforceLgaScope(request.authUser, parsed.data.lgaId);
  if (lgaScopeError) {
    return response.status(403).json({ message: lgaScopeError });
  }

  if (parsed.data.stateId && parsed.data.wardId) {
    await syncPollingUnitsForWard(prisma, parsed.data.stateId, parsed.data.lgaId, parsed.data.wardId);
  }

  const pollingUnits = await prisma.pollingUnit.findMany({
    where: {
      stateId: parsed.data.stateId,
      lgaId: parsed.data.lgaId,
      wardId: parsed.data.wardId || undefined,
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, stateId: true, lgaId: true, wardId: true },
  });

  return response.json({ pollingUnits });
});

router.get("/admin-users", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = lgaScopedLookupQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid admin user lookup query.", errors: parsed.error.flatten() });
  }

  const stateScopeError = enforceStateScope(request.authUser, parsed.data.stateId);
  if (stateScopeError) {
    return response.status(403).json({ message: stateScopeError });
  }

  const lgaScopeError = enforceLgaScope(request.authUser, parsed.data.lgaId);
  if (lgaScopeError) {
    return response.status(403).json({ message: lgaScopeError });
  }

  const actorPartyId = requireActorPartyForManagement(request.authUser);
  if (request.authUser?.role === UserRole.ADMIN && !actorPartyId) {
    return response.status(403).json({ message: "Your admin account is not linked to a political party." });
  }

  const admins = await prisma.user.findMany({
    where: {
      role: UserRole.ADMIN,
      adminProfile: {
        is: {
          politicalPartyId: request.authUser?.role === UserRole.ADMIN ? actorPartyId || undefined : undefined,
          stateId: parsed.data.stateId || undefined,
          lgaId: parsed.data.lgaId || undefined,
        },
      },
    },
    include: { adminProfile: true },
    orderBy: { name: "asc" },
  });

  const adminUsers = admins
    .filter((admin) => admin.adminProfile)
    .map((admin) => ({
      userId: admin.id,
      name: admin.name,
      email: admin.email,
      isActive: admin.isActive,
      adminLevel: admin.adminProfile!.adminLevel,
      politicalPartyId: admin.adminProfile!.politicalPartyId || null,
      territory: serializeTerritory(admin.adminProfile!),
    }));

  return response.json({ adminUsers });
});

router.get("/users/manage", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = managedUsersQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid managed users query.", errors: parsed.error.flatten() });
  }

  const actor = request.authUser;
  const actorPartyId = requireActorPartyForManagement(actor);
  if (actor?.role === UserRole.ADMIN && !actorPartyId) {
    return response.status(403).json({ message: "Your admin account is not linked to a political party." });
  }

  const stateScopeError = parsed.data.stateId ? enforceStateScope(actor, parsed.data.stateId) : null;
  if (stateScopeError) {
    return response.status(403).json({ message: stateScopeError });
  }

  const lgaScopeError = parsed.data.lgaId ? enforceLgaScope(actor, parsed.data.lgaId) : null;
  if (lgaScopeError) {
    return response.status(403).json({ message: lgaScopeError });
  }

  const users = await prisma.user.findMany({
    where: {
      role: parsed.data.role || undefined,
      isActive: parsed.data.isActive === undefined ? undefined : parsed.data.isActive === "true",
      AND: [
        ...(parsed.data.search
          ? [
              {
                OR: [
                  { name: { contains: parsed.data.search } },
                  { email: { contains: parsed.data.search } },
                ],
              },
            ]
          : []),
        ...(parsed.data.stateId || parsed.data.lgaId || parsed.data.wardId
          ? [
              {
                OR: [
                  {
                    adminProfile: {
                      is: {
                        stateId: parsed.data.stateId || undefined,
                        lgaId: parsed.data.lgaId || undefined,
                        wardId: parsed.data.wardId || undefined,
                      },
                    },
                  },
                  {
                    candidateProfile: {
                      is: {
                        stateId: parsed.data.stateId || undefined,
                        lgaId: parsed.data.lgaId || undefined,
                        wardId: parsed.data.wardId || undefined,
                      },
                    },
                  },
                  {
                    agentProfile: {
                      is: {
                        stateId: parsed.data.stateId || undefined,
                        lgaId: parsed.data.lgaId || undefined,
                        wardId: parsed.data.wardId || undefined,
                      },
                    },
                  },
                  {
                    voterProfile: {
                      is: {
                        stateId: parsed.data.stateId || undefined,
                        lgaId: parsed.data.lgaId || undefined,
                        wardId: parsed.data.wardId || undefined,
                      },
                    },
                  },
                ],
              },
            ]
          : []),
      ],
    },
    include: {
      adminProfile: true,
      candidateProfile: true,
      agentProfile: true,
      voterProfile: true,
    },
    orderBy: { createdAt: "desc" },
    take: parsed.data.limit || 24,
  });

  const managedUsers = [];
  for (const user of users) {
    const targetAuth = await getAuthUserProfile(user.id);
    if (!actor || !targetAuth || !canManageUser(actor, targetAuth)) {
      continue;
    }

    managedUsers.push({
      userId: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      territory: serializeTerritory(user.adminProfile || user.candidateProfile || user.agentProfile || user.voterProfile || {}),
      adminLevel: user.adminProfile?.adminLevel || null,
      officeType: user.candidateProfile?.officeType || null,
      politicalPartyId: user.adminProfile?.politicalPartyId || user.candidateProfile?.politicalPartyId || user.agentProfile?.politicalPartyId || null,
      voterRegistrationRecorded: Boolean(user.voterProfile?.voterCardNumber),
    });
  }

  return response.json({ users: managedUsers });
});

router.post("/geo-political-zones", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const parsed = geoPoliticalZoneSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid geo-political zone payload.", errors: parsed.error.flatten() });
  }

  const existing = await prisma.geoPoliticalZone.findFirst({
    where: {
      OR: [
        { id: parsed.data.id },
        { name: parsed.data.name.trim() },
      ],
    },
    select: { id: true },
  });

  if (existing) {
    return response.status(409).json({ message: "Geo-political zone already exists." });
  }

  const zone = await prisma.geoPoliticalZone.create({
    data: {
      id: parsed.data.id,
      name: parsed.data.name.trim(),
    },
  });

  await createAuditLog(prisma, {
    actorUserId: request.authUser!.id,
    action: "GEO_POLITICAL_ZONE_CREATED",
    targetType: "GeoPoliticalZone",
    targetId: zone.id,
  });

  return response.status(201).json({ message: "Geo-political zone created successfully.", zone });
});

router.patch("/geo-political-zones/:zoneId", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const zoneId = readRouteId(response, request.params.zoneId, "zone id");
  if (!zoneId) {
    return;
  }

  const parsed = geoPoliticalZoneUpdateSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid geo-political zone payload.", errors: parsed.error.flatten() });
  }

  const name = parsed.data.name.trim();
  const zone = await prisma.geoPoliticalZone.findUnique({
    where: { id: zoneId },
    select: { id: true },
  });

  if (!zone) {
    return response.status(404).json({ message: "Geo-political zone not found." });
  }

  const duplicate = await prisma.geoPoliticalZone.findFirst({
    where: {
      name,
      NOT: { id: zoneId },
    },
    select: { id: true },
  });

  if (duplicate) {
    return response.status(409).json({ message: "Geo-political zone already exists." });
  }

  const updatedZone = await prisma.geoPoliticalZone.update({
    where: { id: zoneId },
    data: { name },
    select: { id: true, name: true },
  });

  await createAuditLog(prisma, {
    actorUserId: request.authUser!.id,
    action: "GEO_POLITICAL_ZONE_UPDATED",
    targetType: "GeoPoliticalZone",
    targetId: updatedZone.id,
    metadata: { name: updatedZone.name },
  });

  return response.json({ message: "Geo-political zone updated successfully.", zone: updatedZone });
});

router.delete("/geo-political-zones/:zoneId", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const zoneId = readRouteId(response, request.params.zoneId, "zone id");
  if (!zoneId) {
    return;
  }

  const zone = await prisma.geoPoliticalZone.findUnique({
    where: { id: zoneId },
    select: { id: true, name: true },
  });

  if (!zone) {
    return response.status(404).json({ message: "Geo-political zone not found." });
  }

  const [
    stateCount,
    adminProfileCount,
    candidateProfileCount,
    agentProfileCount,
    voterProfileCount,
    pollCount,
    postCount,
    feedbackCount,
    agentActivityCount,
    incidentCount,
  ] = await prisma.$transaction([
    prisma.state.count({ where: { geoPoliticalZoneId: zoneId } }),
    prisma.adminProfile.count({ where: { geoPoliticalZoneId: zoneId } }),
    prisma.candidateProfile.count({ where: { geoPoliticalZoneId: zoneId } }),
    prisma.agentProfile.count({ where: { geoPoliticalZoneId: zoneId } }),
    prisma.voterProfile.count({ where: { geoPoliticalZoneId: zoneId } }),
    prisma.poll.count({ where: { geoPoliticalZoneId: zoneId } }),
    prisma.post.count({ where: { geoPoliticalZoneId: zoneId } }),
    prisma.feedback.count({ where: { geoPoliticalZoneId: zoneId } }),
    prisma.agentActivity.count({ where: { geoPoliticalZoneId: zoneId } }),
    prisma.incident.count({ where: { geoPoliticalZoneId: zoneId } }),
  ]);

  const dependencyCounts = {
    states: stateCount,
    adminProfiles: adminProfileCount,
    candidateProfiles: candidateProfileCount,
    agentProfiles: agentProfileCount,
    voterProfiles: voterProfileCount,
    polls: pollCount,
    posts: postCount,
    feedbackItems: feedbackCount,
    agentActivities: agentActivityCount,
    incidents: incidentCount,
  };
  const totalDependencies = Object.values(dependencyCounts).reduce((sum, count) => sum + count, 0);

  if (totalDependencies > 0) {
    return response.status(409).json({
      message: "Geo-political zone cannot be deleted because it is in use.",
      dependencyCounts,
    });
  }

  await prisma.geoPoliticalZone.delete({ where: { id: zoneId } });

  await createAuditLog(prisma, {
    actorUserId: request.authUser!.id,
    action: "GEO_POLITICAL_ZONE_DELETED",
    targetType: "GeoPoliticalZone",
    targetId: zone.id,
    metadata: { name: zone.name },
  });

  return response.json({ message: "Geo-political zone deleted successfully." });
});

router.get("/political-parties", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (_request, response) => {
  const parties = await prisma.politicalParty.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      code: true,
      name: true,
      logoUrl: true,
      description: true,
      officialWebsite: true,
      isApprovedByInec: true,
      inecSourceUrl: true,
    },
  });

  return response.json({ parties });
});

router.post("/political-parties", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const parsed = politicalPartySchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid political party payload.", errors: parsed.error.flatten() });
  }

  const code = parsed.data.code.trim().toUpperCase();
  const name = parsed.data.name.trim();
  const existing = await prisma.politicalParty.findFirst({
    where: {
      OR: [
        { id: parsed.data.id },
        { code },
        { name },
      ],
    },
    select: { id: true },
  });

  if (existing) {
    return response.status(409).json({ message: "Political party already exists." });
  }

  const party = await prisma.politicalParty.create({
    data: {
      id: parsed.data.id,
      code,
      name,
      logoUrl: parsed.data.logoUrl || null,
      description: parsed.data.description || null,
      officialWebsite: parsed.data.officialWebsite || null,
      isApprovedByInec: parsed.data.isApprovedByInec ?? false,
      inecSourceUrl: parsed.data.inecSourceUrl || null,
    },
  });

  await createAuditLog(prisma, {
    actorUserId: request.authUser!.id,
    action: "POLITICAL_PARTY_CREATED",
    targetType: "PoliticalParty",
    targetId: party.id,
  });

  return response.status(201).json({ message: "Political party created successfully.", party });
});

router.patch("/political-parties/:partyId", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const partyId = readRouteId(response, request.params.partyId, "party id");
  if (!partyId) {
    return;
  }

  const parsed = politicalPartyUpdateSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid political party payload.", errors: parsed.error.flatten() });
  }

  const code = parsed.data.code.trim().toUpperCase();
  const name = parsed.data.name.trim();
  const party = await prisma.politicalParty.findUnique({
    where: { id: partyId },
    select: { id: true },
  });

  if (!party) {
    return response.status(404).json({ message: "Political party not found." });
  }

  const duplicate = await prisma.politicalParty.findFirst({
    where: {
      OR: [{ code }, { name }],
      NOT: { id: partyId },
    },
    select: { id: true },
  });

  if (duplicate) {
    return response.status(409).json({ message: "Political party already exists." });
  }

  const updatedParty = await prisma.politicalParty.update({
    where: { id: partyId },
    data: {
      code,
      name,
      logoUrl: parsed.data.logoUrl === undefined ? undefined : parsed.data.logoUrl || null,
      description: parsed.data.description === undefined ? undefined : parsed.data.description || null,
      officialWebsite: parsed.data.officialWebsite === undefined ? undefined : parsed.data.officialWebsite || null,
      isApprovedByInec: parsed.data.isApprovedByInec,
      inecSourceUrl: parsed.data.inecSourceUrl === undefined ? undefined : parsed.data.inecSourceUrl || null,
    },
    select: {
      id: true,
      code: true,
      name: true,
      logoUrl: true,
      description: true,
      officialWebsite: true,
      isApprovedByInec: true,
      inecSourceUrl: true,
    },
  });

  await createAuditLog(prisma, {
    actorUserId: request.authUser!.id,
    action: "POLITICAL_PARTY_UPDATED",
    targetType: "PoliticalParty",
    targetId: updatedParty.id,
    metadata: { code: updatedParty.code, name: updatedParty.name },
  });

  return response.json({ message: "Political party updated successfully.", party: updatedParty });
});

router.delete("/political-parties/:partyId", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const partyId = readRouteId(response, request.params.partyId, "party id");
  if (!partyId) {
    return;
  }

  const party = await prisma.politicalParty.findUnique({
    where: { id: partyId },
    select: { id: true, name: true, code: true },
  });

  if (!party) {
    return response.status(404).json({ message: "Political party not found." });
  }

  const [candidateProfileCount, adminProfileCount, agentProfileCount] = await prisma.$transaction([
    prisma.candidateProfile.count({
      where: { politicalPartyId: partyId },
    }),
    prisma.adminProfile.count({
      where: { politicalPartyId: partyId },
    }),
    prisma.agentProfile.count({
      where: { politicalPartyId: partyId },
    }),
  ]);

  if (candidateProfileCount > 0 || adminProfileCount > 0 || agentProfileCount > 0) {
    return response.status(409).json({
      message: "Political party cannot be deleted because it is in use.",
      dependencyCounts: {
        candidateProfiles: candidateProfileCount,
        adminProfiles: adminProfileCount,
        agentProfiles: agentProfileCount,
      },
    });
  }

  await prisma.politicalParty.delete({ where: { id: partyId } });

  await createAuditLog(prisma, {
    actorUserId: request.authUser!.id,
    action: "POLITICAL_PARTY_DELETED",
    targetType: "PoliticalParty",
    targetId: party.id,
    metadata: { code: party.code, name: party.name },
  });

  return response.json({ message: "Political party deleted successfully." });
});

router.get("/candidates", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const actor = request.authUser;
  const actorPartyId = requireActorPartyForManagement(actor);
  if (actor?.role === UserRole.ADMIN && !actorPartyId) {
    return response.status(403).json({ message: "Your admin account is not linked to a political party." });
  }
  const candidates = await prisma.user.findMany({
    where: {
      role: UserRole.CANDIDATE,
      candidateProfile: actor?.role === UserRole.ADMIN
        ? { is: { politicalPartyId: actorPartyId || undefined } }
        : undefined,
    },
    include: {
      candidateProfile: true,
      assignedAdminLinks: actor
        ? {
            where: { adminUserId: actor.id },
            select: { permissionType: true },
          }
        : false,
    },
    orderBy: { createdAt: "desc" },
  });

  const visibleCandidates = candidates
    .filter((candidate) => {
      if (!candidate.candidateProfile || !actor) {
        return false;
      }

      return (
        canViewCandidate(actor, { ...candidate.candidateProfile, userId: candidate.id }) ||
        candidate.assignedAdminLinks.length > 0
      );
    })
    .map((candidate) => serializeCandidateListItem(candidate));

  return response.json({ candidates: visibleCandidates });
});

router.post("/agents", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = agentCreationSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid agent creation payload.", errors: parsed.error.flatten() });
  }

  const scopedPayload = applyActorAdminScope(request.authUser, parsed.data);

  if (!scopedPayload.politicalPartyId) {
    return response.status(400).json({ message: "Agent accounts must be linked to a political party." });
  }

  if (!scopedPayload.pollingUnitId) {
    return response.status(400).json({ message: "Agent accounts must be assigned to a polling unit." });
  }

  const actorPartyId = requireActorPartyForManagement(request.authUser);
  if (request.authUser?.role === UserRole.ADMIN && !actorPartyId) {
    return response.status(403).json({ message: "Your admin account is not linked to a political party." });
  }

  if (request.authUser?.role === UserRole.ADMIN && scopedPayload.politicalPartyId !== actorPartyId) {
    return response.status(403).json({ message: "You can only create agents for your assigned political party." });
  }

  if (!(await ensurePoliticalPartyExists(scopedPayload.politicalPartyId))) {
    return response.status(400).json({ message: "Selected political party does not exist." });
  }

  const territoryReferenceError = await validateTerritoryReferences(scopedPayload);
  if (territoryReferenceError) {
    return response.status(400).json({ message: territoryReferenceError });
  }

  const state = await prisma.state.findUnique({
    where: { id: scopedPayload.stateId },
    select: { geoPoliticalZoneId: true },
  });

  const agentTerritory = {
    geoPoliticalZoneId: state?.geoPoliticalZoneId || undefined,
    stateId: scopedPayload.stateId,
    senatorialDistrictId: scopedPayload.senatorialDistrictId || undefined,
    federalConstituencyId: scopedPayload.federalConstituencyId || undefined,
    lgaId: scopedPayload.lgaId,
    wardId: scopedPayload.wardId,
    stateConstituencyId: scopedPayload.stateConstituencyId || undefined,
    pollingUnitId: scopedPayload.pollingUnitId || undefined,
  };

  if (
    request.authUser?.role === UserRole.ADMIN &&
    request.authUser.adminProfile?.adminLevel === AdminLevel.LGA &&
    (request.authUser.adminProfile.stateId !== scopedPayload.stateId || request.authUser.adminProfile.lgaId !== scopedPayload.lgaId)
  ) {
    return response.status(403).json({ message: "LGA admins can only create ward agents inside their assigned LGA." });
  }

  if (!request.authUser || !canCreateAgentInScope(request.authUser, agentTerritory)) {
    return response.status(403).json({ message: "You cannot create an agent in this territory." });
  }

  const assignedAdminUserId = await resolveTerritoryAdminUserId({
    politicalPartyId: scopedPayload.politicalPartyId,
    geoPoliticalZoneId: state?.geoPoliticalZoneId || undefined,
    stateId: scopedPayload.stateId,
    senatorialDistrictId: scopedPayload.senatorialDistrictId || undefined,
    federalConstituencyId: scopedPayload.federalConstituencyId || undefined,
    lgaId: scopedPayload.lgaId,
    wardId: scopedPayload.wardId,
    stateConstituencyId: scopedPayload.stateConstituencyId || undefined,
    pollingUnitId: scopedPayload.pollingUnitId,
  });

  const email = normalizeEmail(scopedPayload.email);
  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existingUser) {
    return response.status(409).json({ message: "Email is already registered." });
  }

  const createdUser = await prisma.user.create({
    data: {
      name: scopedPayload.name.trim(),
      email,
      phone: scopedPayload.phone?.trim() || null,
      passwordHash: await hashPassword(scopedPayload.password),
      role: UserRole.AGENT,
      agentProfile: {
        create: {
          geoPoliticalZoneId: state?.geoPoliticalZoneId || null,
          politicalPartyId: scopedPayload.politicalPartyId,
          stateId: scopedPayload.stateId,
          senatorialDistrictId: scopedPayload.senatorialDistrictId || null,
          federalConstituencyId: scopedPayload.federalConstituencyId || null,
          lgaId: scopedPayload.lgaId,
          wardId: scopedPayload.wardId,
          stateConstituencyId: scopedPayload.stateConstituencyId || null,
          pollingUnitId: scopedPayload.pollingUnitId || null,
          assignedAdminUserId,
        } as Prisma.AgentProfileUncheckedCreateWithoutUserInput,
      },
    },
  });

  await createAuditLog(prisma, {
    actorUserId: request.authUser!.id,
    action: "AGENT_CREATED",
    targetType: "User",
    targetId: createdUser.id,
    politicalPartyId: scopedPayload.politicalPartyId,
    territory: {
      geoPoliticalZoneId: state?.geoPoliticalZoneId || null,
      stateId: scopedPayload.stateId,
      senatorialDistrictId: scopedPayload.senatorialDistrictId || null,
      federalConstituencyId: scopedPayload.federalConstituencyId || null,
      lgaId: scopedPayload.lgaId,
      wardId: scopedPayload.wardId,
      stateConstituencyId: scopedPayload.stateConstituencyId || null,
      pollingUnitId: scopedPayload.pollingUnitId || null,
    },
    metadata: {
      assignedAdminUserId,
    },
  });

  return response.status(201).json({
    message: "Agent created successfully.",
    user: await getAuthUserProfile(createdUser.id),
  });
});

router.get("/agents", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const actor = request.authUser;
  const actorPartyId = requireActorPartyForManagement(actor);
  if (actor?.role === UserRole.ADMIN && !actorPartyId) {
    return response.status(403).json({ message: "Your admin account is not linked to a political party." });
  }
  const agents = await prisma.user.findMany({
    where: {
      role: UserRole.AGENT,
      agentProfile: {
        is: {
          ...getAgentScopeFilter(actor),
          politicalPartyId: actor?.role === UserRole.ADMIN ? actorPartyId || undefined : undefined,
        },
      },
    },
    include: { agentProfile: true },
    orderBy: { createdAt: "desc" },
  });

  const agentUsers = agents
    .filter((agent) => agent.agentProfile)
    .map((agent) => ({
      userId: agent.id,
      name: agent.name,
      email: agent.email,
      isActive: agent.isActive,
      phone: agent.phone || null,
      politicalPartyId: agent.agentProfile!.politicalPartyId || null,
      territory: serializeTerritory(agent.agentProfile!),
    }));

  return response.json({ agents: agentUsers });
});

router.get("/voters", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const actor = request.authUser;
  const voters = await prisma.user.findMany({
    where: {
      role: UserRole.VOTER,
      voterProfile: actor && !isSuperAdmin(actor) ? { is: getVoterScopeFilter(actor) } : undefined,
    },
    include: { voterProfile: true },
    orderBy: { createdAt: "desc" },
  });

  const voterUsers = voters
    .filter((voter) => voter.voterProfile)
    .map((voter) => ({
      userId: voter.id,
      name: voter.name,
      email: voter.email,
      phone: voter.phone,
      isActive: voter.isActive,
      voterRegistrationRecorded: Boolean(voter.voterProfile!.voterCardNumber),
      referralCode: voter.voterProfile!.referralCode,
      contactConsent: voter.voterProfile!.contactConsent,
      termsAcceptedAt: voter.voterProfile!.termsAcceptedAt?.toISOString() || null,
      territory: serializeTerritory(voter.voterProfile!),
    }));

  return response.json({ voters: voterUsers });
});

router.get("/voters/export", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const voters = await prisma.user.findMany({
    where: {
      role: UserRole.VOTER,
      isActive: true,
      voterProfile: {
        is: {
          contactConsent: true,
        },
      },
    },
    include: { voterProfile: true },
    orderBy: { createdAt: "desc" },
  });

  const rows = [
    [
      "name",
      "email",
      "phone",
      "referralCode",
      "termsAcceptedAt",
      "stateId",
      "lgaId",
      "wardId",
      "pollingUnitId",
    ].join(","),
    ...voters
      .filter((voter) => voter.voterProfile)
      .map((voter) =>
        [
          escapeCsvValue(voter.name),
          escapeCsvValue(voter.email),
          escapeCsvValue(voter.phone),
          escapeCsvValue(voter.voterProfile!.referralCode),
          escapeCsvValue(voter.voterProfile!.termsAcceptedAt?.toISOString() || ""),
          escapeCsvValue(voter.voterProfile!.stateId),
          escapeCsvValue(voter.voterProfile!.lgaId),
          escapeCsvValue(voter.voterProfile!.wardId),
          escapeCsvValue(voter.voterProfile!.pollingUnitId || ""),
        ].join(","),
      ),
  ];

  await createAuditLog(prisma, {
    actorUserId: request.authUser!.id,
    action: "VOTER_CONTACT_EXPORT",
    targetType: "VOTER_EXPORT",
    targetId: new Date().toISOString(),
    metadata: {
      recordCount: voters.length,
      includedFields: ["name", "email", "phone", "referralCode", "termsAcceptedAt", "territoryIds"],
      excludedSensitiveFields: ["voterCardNumber", "voterDocument"],
    },
  });

  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", `attachment; filename="voters-consented-${new Date().toISOString().slice(0, 10)}.csv"`);
  return response.status(200).send(rows.join("\n"));
});

router.patch("/users/:userId", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const userId = readRouteId(response, request.params.userId, "user id");
  if (!userId) {
    return;
  }

  const parsed = adminUpdateSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid admin update payload.", errors: parsed.error.flatten() });
  }

  const scopedPayload = applyActorAdminScope(request.authUser, parsed.data);

  if (!scopedPayload.politicalPartyId) {
    return response.status(400).json({ message: "Admin accounts must be linked to a political party." });
  }

  if (!(await ensurePoliticalPartyExists(scopedPayload.politicalPartyId))) {
    return response.status(400).json({ message: "Selected political party does not exist." });
  }

  const territoryError = validateAdminTerritoryPayload(scopedPayload);
  if (territoryError) {
    return response.status(400).json({ message: territoryError });
  }

  const territoryReferenceError = await validateTerritoryReferences(scopedPayload);
  if (territoryReferenceError) {
    return response.status(400).json({ message: territoryReferenceError });
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: userId },
    include: { adminProfile: true },
  });

  if (!targetUser?.adminProfile) {
    return response.status(404).json({ message: "Admin user not found." });
  }

  const targetAuth = await getAuthUserProfile(targetUser.id);
  if (!request.authUser || !targetAuth || !canManageUser(request.authUser, targetAuth) || !canManageAdmin(request.authUser, scopedPayload)) {
    return response.status(403).json({ message: "You cannot update an admin at this level or territory." });
  }

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      name: scopedPayload.name.trim(),
      adminProfile: {
        update: {
          adminLevel: scopedPayload.adminLevel,
          politicalPartyId: scopedPayload.politicalPartyId,
          geoPoliticalZoneId: scopedPayload.geoPoliticalZoneId || null,
          stateId: scopedPayload.stateId || null,
          senatorialDistrictId: scopedPayload.senatorialDistrictId || null,
          federalConstituencyId: scopedPayload.federalConstituencyId || null,
          lgaId: scopedPayload.lgaId || null,
          wardId: scopedPayload.wardId || null,
          stateConstituencyId: scopedPayload.stateConstituencyId || null,
          pollingUnitId: scopedPayload.pollingUnitId || null,
        } as Prisma.AdminProfileUncheckedUpdateWithoutUserInput,
      },
    },
  });

  await createAuditLog(prisma, {
    actorUserId: request.authUser!.id,
    action: "ADMIN_UPDATED",
    targetType: "User",
    targetId: updatedUser.id,
    politicalPartyId: scopedPayload.politicalPartyId || null,
    territory: {
      geoPoliticalZoneId: scopedPayload.geoPoliticalZoneId || null,
      stateId: scopedPayload.stateId || null,
      senatorialDistrictId: scopedPayload.senatorialDistrictId || null,
      federalConstituencyId: scopedPayload.federalConstituencyId || null,
      lgaId: scopedPayload.lgaId || null,
      wardId: scopedPayload.wardId || null,
      stateConstituencyId: scopedPayload.stateConstituencyId || null,
      pollingUnitId: scopedPayload.pollingUnitId || null,
    },
    metadata: {
      adminLevel: scopedPayload.adminLevel,
    },
  });

  return response.json({ message: "Admin updated successfully.", user: await getAuthUserProfile(updatedUser.id) });
});

router.patch("/candidates/:userId", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const userId = readRouteId(response, request.params.userId, "user id");
  if (!userId) {
    return;
  }

  const parsed = candidateUpdateSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid candidate update payload.", errors: parsed.error.flatten() });
  }

  const scopedPayload = applyActorAdminScope(request.authUser, parsed.data);

  if (!request.authUser || !canManageCandidateOffice(request.authUser, scopedPayload.officeType)) {
    return response.status(403).json({ message: "You cannot update a candidate to that office level." });
  }

  const territoryError = validateCandidateOfficeTerritory(scopedPayload.officeType, scopedPayload);
  if (territoryError) {
    return response.status(400).json({ message: territoryError });
  }

  const territoryReferenceError = await validateTerritoryReferences(scopedPayload);
  if (territoryReferenceError) {
    return response.status(400).json({ message: territoryReferenceError });
  }

  const actorPartyId = requireActorPartyForManagement(request.authUser);
  if (request.authUser?.role === UserRole.ADMIN && !actorPartyId) {
    return response.status(403).json({ message: "Your admin account is not linked to a political party." });
  }

  if (request.authUser?.role === UserRole.ADMIN && scopedPayload.politicalPartyId !== actorPartyId) {
    return response.status(403).json({ message: "You can only manage candidates for your assigned political party." });
  }

  if (scopedPayload.politicalPartyId) {
    const party = await prisma.politicalParty.findUnique({
      where: { id: scopedPayload.politicalPartyId },
      select: { id: true },
    });

    if (!party) {
      return response.status(400).json({ message: "Selected political party does not exist." });
    }
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: userId },
    include: { candidateProfile: true },
  });

  if (!targetUser?.candidateProfile) {
    return response.status(404).json({ message: "Candidate user not found." });
  }

  const scope = await enrichCandidateScope(scopedPayload);
  if (
    !request.authUser ||
    !canViewCandidate(request.authUser, { ...targetUser.candidateProfile, userId }) ||
    !canViewCandidate(request.authUser, { ...scope, politicalPartyId: scopedPayload.politicalPartyId || null })
  ) {
    return response.status(403).json({ message: "You cannot update a candidate outside your admin territory." });
  }

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      name: scopedPayload.name.trim(),
      candidateProfile: {
        update: {
          officeType: scopedPayload.officeType,
          politicalPartyId: scopedPayload.politicalPartyId || null,
          ...scope,
        },
      },
    },
  });

  await createAuditLog(prisma, {
    actorUserId: request.authUser!.id,
    action: "CANDIDATE_UPDATED",
    targetType: "User",
    targetId: updatedUser.id,
    politicalPartyId: scopedPayload.politicalPartyId || null,
    territory: {
      geoPoliticalZoneId: scope.geoPoliticalZoneId,
      stateId: scope.stateId,
      senatorialDistrictId: scope.senatorialDistrictId,
      federalConstituencyId: scope.federalConstituencyId,
      lgaId: scope.lgaId,
      wardId: scope.wardId,
      stateConstituencyId: scope.stateConstituencyId,
      pollingUnitId: scope.pollingUnitId,
    },
    metadata: {
      officeType: scopedPayload.officeType,
    },
  });

  return response.json({ message: "Candidate updated successfully.", user: await getAuthUserProfile(updatedUser.id) });
});

router.patch("/agents/:userId", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const userId = readRouteId(response, request.params.userId, "user id");
  if (!userId) {
    return;
  }

  const parsed = agentUpdateSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid agent update payload.", errors: parsed.error.flatten() });
  }

  const scopedPayload = applyActorAdminScope(request.authUser, parsed.data);

  if (!scopedPayload.politicalPartyId) {
    return response.status(400).json({ message: "Agent accounts must be linked to a political party." });
  }

  if (!scopedPayload.pollingUnitId) {
    return response.status(400).json({ message: "Agent accounts must be assigned to a polling unit." });
  }

  const actorPartyId = requireActorPartyForManagement(request.authUser);
  if (request.authUser?.role === UserRole.ADMIN && !actorPartyId) {
    return response.status(403).json({ message: "Your admin account is not linked to a political party." });
  }

  if (request.authUser?.role === UserRole.ADMIN && scopedPayload.politicalPartyId !== actorPartyId) {
    return response.status(403).json({ message: "You can only manage agents for your assigned political party." });
  }

  if (!(await ensurePoliticalPartyExists(scopedPayload.politicalPartyId))) {
    return response.status(400).json({ message: "Selected political party does not exist." });
  }

  const territoryReferenceError = await validateTerritoryReferences(scopedPayload);
  if (territoryReferenceError) {
    return response.status(400).json({ message: territoryReferenceError });
  }

  const state = await prisma.state.findUnique({
    where: { id: scopedPayload.stateId },
    select: { geoPoliticalZoneId: true },
  });

  const agentTerritory = {
    geoPoliticalZoneId: state?.geoPoliticalZoneId || undefined,
    stateId: scopedPayload.stateId,
    senatorialDistrictId: scopedPayload.senatorialDistrictId || undefined,
    federalConstituencyId: scopedPayload.federalConstituencyId || undefined,
    lgaId: scopedPayload.lgaId,
    wardId: scopedPayload.wardId,
    stateConstituencyId: scopedPayload.stateConstituencyId || undefined,
    pollingUnitId: scopedPayload.pollingUnitId || undefined,
  };

  if (!request.authUser || !canCreateAgentInScope(request.authUser, agentTerritory)) {
    return response.status(403).json({ message: "You cannot update an agent in this territory." });
  }

  const assignedAdminUserId = await resolveTerritoryAdminUserId({
    politicalPartyId: scopedPayload.politicalPartyId,
    geoPoliticalZoneId: state?.geoPoliticalZoneId || undefined,
    stateId: scopedPayload.stateId,
    senatorialDistrictId: scopedPayload.senatorialDistrictId || undefined,
    federalConstituencyId: scopedPayload.federalConstituencyId || undefined,
    lgaId: scopedPayload.lgaId,
    wardId: scopedPayload.wardId,
    stateConstituencyId: scopedPayload.stateConstituencyId || undefined,
    pollingUnitId: scopedPayload.pollingUnitId,
  });

  const targetUser = await prisma.user.findUnique({
    where: { id: userId },
    include: { agentProfile: true },
  });

  if (!targetUser?.agentProfile) {
    return response.status(404).json({ message: "Agent user not found." });
  }

  const targetAuth = await getAuthUserProfile(targetUser.id);
  if (
    !request.authUser ||
    !targetAuth ||
    !isWithinActorParty(request.authUser, targetUser.agentProfile.politicalPartyId) ||
    !canManageUser(request.authUser, targetAuth) ||
    !canCreateAgentInScope(request.authUser, agentTerritory)
  ) {
    return response.status(403).json({ message: "You cannot update an agent in this territory." });
  }

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      name: scopedPayload.name.trim(),
      phone: scopedPayload.phone?.trim() || null,
      agentProfile: {
        update: {
          geoPoliticalZoneId: state?.geoPoliticalZoneId || null,
          politicalPartyId: scopedPayload.politicalPartyId,
          stateId: scopedPayload.stateId,
          senatorialDistrictId: scopedPayload.senatorialDistrictId || null,
          federalConstituencyId: scopedPayload.federalConstituencyId || null,
          lgaId: scopedPayload.lgaId,
          wardId: scopedPayload.wardId,
          stateConstituencyId: scopedPayload.stateConstituencyId || null,
          pollingUnitId: scopedPayload.pollingUnitId || null,
          assignedAdminUserId,
        } as Prisma.AgentProfileUncheckedUpdateWithoutUserInput,
      },
    },
  });

  await createAuditLog(prisma, {
    actorUserId: request.authUser!.id,
    action: "AGENT_UPDATED",
    targetType: "User",
    targetId: updatedUser.id,
    politicalPartyId: scopedPayload.politicalPartyId || null,
    territory: {
      geoPoliticalZoneId: state?.geoPoliticalZoneId || null,
      stateId: scopedPayload.stateId,
      senatorialDistrictId: scopedPayload.senatorialDistrictId || null,
      federalConstituencyId: scopedPayload.federalConstituencyId || null,
      lgaId: scopedPayload.lgaId,
      wardId: scopedPayload.wardId,
      stateConstituencyId: scopedPayload.stateConstituencyId || null,
      pollingUnitId: scopedPayload.pollingUnitId || null,
    },
    metadata: {
      assignedAdminUserId,
    },
  });

  return response.json({ message: "Agent updated successfully.", user: await getAuthUserProfile(updatedUser.id) });
});

router.patch("/users/:userId/deactivation", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const userId = readRouteId(response, request.params.userId, "user id");
  if (!userId) {
    return;
  }

  const parsed = userDeactivationSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid user deactivation payload.", errors: parsed.error.flatten() });
  }

  if (request.authUser?.id === userId) {
    return response.status(400).json({ message: "You cannot change your own activation status." });
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      adminProfile: true,
      candidateProfile: true,
      agentProfile: true,
      voterProfile: true,
    },
  });

  if (!targetUser) {
    return response.status(404).json({ message: "User not found." });
  }

  const targetAuth = await getAuthUserProfile(targetUser.id);
  if (!request.authUser || !targetAuth || !canManageUser(request.authUser, targetAuth)) {
    return response.status(403).json({ message: "You cannot change this user's activation status." });
  }

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: { isActive: parsed.data.isActive },
  });

  await createAuditLog(prisma, {
    actorUserId: request.authUser.id,
    action: parsed.data.isActive ? "USER_REACTIVATED" : "USER_DEACTIVATED",
    targetType: "User",
    targetId: updatedUser.id,
    politicalPartyId: targetUser.adminProfile?.politicalPartyId || targetUser.candidateProfile?.politicalPartyId || targetUser.agentProfile?.politicalPartyId || null,
    territory: targetUser.adminProfile || targetUser.candidateProfile || targetUser.agentProfile || targetUser.voterProfile || undefined,
    metadata: {
      isActive: parsed.data.isActive,
      role: targetUser.role,
    },
  });

  return response.json({
    message: parsed.data.isActive ? "User reactivated successfully." : "User deactivated successfully.",
    user: await getAuthUserProfile(updatedUser.id),
  });
});

router.post("/agents/:agentUserId/revoke-session", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const agentUserId = readRouteId(response, request.params.agentUserId, "agent user id");
  if (!agentUserId) {
    return;
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: agentUserId },
    include: {
      agentProfile: true,
    },
  });

  if (!targetUser || targetUser.role !== UserRole.AGENT || !targetUser.agentProfile) {
    return response.status(404).json({ message: "Agent account not found." });
  }

  const targetAuth = await getAuthUserProfile(targetUser.id);
  if (
    !request.authUser ||
    !targetAuth ||
    !canManageUser(request.authUser, targetAuth) ||
    !isWithinActorParty(request.authUser, targetUser.agentProfile.politicalPartyId)
  ) {
    return response.status(403).json({ message: "You cannot revoke this agent session." });
  }

  await prisma.agentProfile.update({
    where: { userId: targetUser.id },
    data: { activeSessionNonce: null },
  });

  await createAuditLog(prisma, {
    actorUserId: request.authUser.id,
    action: "AGENT_SESSION_REVOKED",
    targetType: "User",
    targetId: targetUser.id,
    politicalPartyId: targetUser.agentProfile.politicalPartyId || null,
    territory: targetUser.agentProfile,
  });

  return response.json({ message: "Agent session revoked successfully." });
});

router.delete("/users/:userId", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const userId = readRouteId(response, request.params.userId, "user id");
  if (!userId) {
    return;
  }

  if (request.authUser?.id === userId) {
    return response.status(400).json({ message: "You cannot delete your own account." });
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      adminProfile: true,
      candidateProfile: true,
      agentProfile: true,
      voterProfile: true,
    },
  });

  if (!targetUser) {
    return response.status(404).json({ message: "User not found." });
  }

  if (targetUser.role === UserRole.SUPER_ADMIN) {
    return response.status(403).json({ message: "Super admin accounts cannot be deleted from this workflow." });
  }

  if (targetUser.isActive) {
    return response.status(400).json({ message: "Deactivate the account before deleting it." });
  }

  const targetAuth = await getAuthUserProfile(targetUser.id);
  if (!request.authUser || !targetAuth || !canManageUser(request.authUser, targetAuth)) {
    return response.status(403).json({ message: "You cannot delete this account." });
  }

  const [
    assignedAdmins,
    assignedAgents,
    managedCandidateLinks,
    assignedCandidateLinks,
    createdTasks,
    assignedTasks,
    createdBroadcasts,
    createdPolls,
    authoredPosts,
    candidatePosts,
    createdCampaignEvents,
    candidateCampaignEvents,
    notifications,
    rewardEntries,
    authoritativeLedgerEntries,
    legacyBalanceCarryovers,
    payoutAssignments,
    payoutTransactions,
    payoutExecutions,
    rewardRedemptions,
    agentActivities,
    reportedIncidents,
    voterFeedbackItems,
    agentFeedbackItems,
    candidateFeedbackItems,
    voterProfileDependents,
    engagementTaskClaims,
  ] = await prisma.$transaction([
    prisma.adminProfile.count({ where: { userId } }),
    prisma.agentProfile.count({ where: { assignedAdminUserId: userId } }),
    prisma.adminCandidateAssignment.count({ where: { adminUserId: userId } }),
    prisma.adminCandidateAssignment.count({ where: { candidateUserId: userId } }),
    prisma.fieldTask.count({ where: { createdByUserId: userId } }),
    prisma.fieldTask.count({ where: { assignedToUserId: userId } }),
    prisma.broadcastMessage.count({ where: { createdByUserId: userId } }),
    prisma.poll.count({ where: { createdByUserId: userId } }),
    prisma.post.count({ where: { authorUserId: userId } }),
    prisma.post.count({ where: { candidateUserId: userId } }),
    prisma.campaignEvent.count({ where: { createdByUserId: userId } }),
    prisma.campaignEvent.count({ where: { candidateUserId: userId } }),
    prisma.notification.count({ where: { userId } }),
    prisma.rewardLedger.count({ where: { OR: [{ voterUserId: userId }, { relatedUserId: userId }] } }),
    prisma.rewardLedgerEntry.count({ where: { OR: [{ userId }, { relatedUserId: userId }] } }),
    prisma.legacyBalanceCarryover.count({ where: { userId } }),
    prisma.payoutAssignment.count({
      where: { OR: [{ beneficiaryUserId: userId }, { payoutOfficerUserId: userId }] },
    }),
    prisma.payoutTransaction.count({ where: { payoutOfficerUserId: userId } }),
    prisma.payoutExecution.count({
      where: { OR: [{ beneficiaryUserId: userId }, { executedByUserId: userId }] },
    }),
    prisma.rewardRedemption.count({ where: { OR: [{ voterUserId: userId }, { reviewedByUserId: userId }] } }),
    prisma.agentActivity.count({ where: { agentUserId: userId } }),
    prisma.incident.count({ where: { OR: [{ reportedByUserId: userId }, { assignedAdminUserId: userId }, { escalatedByUserId: userId }] } }),
    prisma.feedback.count({ where: { voterUserId: userId } }),
    prisma.feedback.count({ where: { agentUserId: userId } }),
    prisma.feedback.count({ where: { candidateUserId: userId } }),
    prisma.voterProfile.count({ where: { referredByUserId: userId } }),
    prisma.voterEngagementClaim.count({ where: { voterUserId: userId } }),
  ]);

  const dependencyCounts: ManagedUserDependencyCounts = {
    assignedAdmins,
    assignedAgents,
    managedCandidateLinks,
    assignedCandidateLinks,
    createdTasks,
    assignedTasks,
    createdBroadcasts,
    createdPolls,
    authoredPosts,
    candidatePosts,
    createdCampaignEvents,
    candidateCampaignEvents,
    notifications,
    rewardEntries,
    authoritativeLedgerEntries,
    legacyBalanceCarryovers,
    payoutAssignments,
    payoutTransactions,
    payoutExecutions,
    rewardRedemptions,
    agentActivities,
    reportedIncidents,
    feedbackItems: voterFeedbackItems + agentFeedbackItems + candidateFeedbackItems,
    voterProfileDependents,
    engagementTaskClaims,
  };

  const hasDependencies = Object.values(dependencyCounts).some((count) => count > 0);
  if (hasDependencies) {
    return response.status(409).json({
      message: "This account cannot be deleted because operational records still depend on it.",
      dependencyCounts,
    });
  }

  await prisma.user.delete({ where: { id: userId } });

  await createAuditLog(prisma, {
    actorUserId: request.authUser.id,
    action: "USER_DELETED",
    targetType: "User",
    targetId: userId,
    politicalPartyId: targetUser.adminProfile?.politicalPartyId || targetUser.candidateProfile?.politicalPartyId || targetUser.agentProfile?.politicalPartyId || null,
    territory: targetUser.adminProfile || targetUser.candidateProfile || targetUser.agentProfile || targetUser.voterProfile || undefined,
    metadata: { role: targetUser.role },
  });

  return response.json({ message: "User deleted successfully." });
});

router.get("/agent-activity-summaries", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const scopeFilter = getAgentScopeFilter(request.authUser);
  const agents = await prisma.user.findMany({
    where: {
      role: UserRole.AGENT,
      ...getAdminPartyScopedAgentUserFilter(request.authUser),
    },
    include: {
      agentProfile: true,
      agentActivities: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const summaries = agents
    .filter((agent) => {
      if (!agent.agentProfile || !request.authUser) {
        return false;
      }

      return canCreateAgentInScope(request.authUser, agent.agentProfile);
    })
    .map((agent) => {
      const latest = agent.agentActivities[0];

      return serializeAgentActivitySummary({
        agentUserId: agent.id,
        name: agent.name,
        email: agent.email,
        territory: serializeTerritory(agent.agentProfile!),
        latestActivityType: latest?.type || null,
        latestActivityAt: latest?.createdAt.toISOString() || null,
        latestLatitude: latest?.latitude ?? null,
        latestLongitude: latest?.longitude ?? null,
        pollingUnitId: latest?.pollingUnitId || agent.agentProfile?.pollingUnitId || null,
      });
    });

  return response.json({ agentActivitySummaries: summaries, scope: scopeFilter });
});

router.get("/agent-activities", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = agentActivityQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid activity query.", errors: parsed.error.flatten() });
  }

  const page = parsed.data.page || 1;
  const pageSize = parsed.data.pageSize || 20;
  const createdAtFilter =
    parsed.data.dateFrom || parsed.data.dateTo
      ? {
          gte: parsed.data.dateFrom ? new Date(parsed.data.dateFrom) : undefined,
          lte: parsed.data.dateTo ? new Date(parsed.data.dateTo) : undefined,
        }
      : undefined;

  const scopeFilter = getAgentActivityScopeFilter(request.authUser);
  const activities = await prisma.agentActivity.findMany({
    where: {
      ...scopeFilter,
      agentUser: getAdminPartyScopedAgentRelationFilter(request.authUser),
      agentUserId: parsed.data.agentUserId,
      type: parsed.data.type,
      createdAt: createdAtFilter,
    },
    include: {
      agentUser: {
        select: { id: true, name: true, email: true },
      },
    },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

  return response.json({
    page,
    pageSize,
    activities,
  });
});

router.post("/participation", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = participationSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid participation payload.", errors: parsed.error.flatten() });
  }

  const voter = await prisma.user.findUnique({
    where: { id: parsed.data.voterUserId },
    include: { voterProfile: true },
  });

  if (!voter?.voterProfile) {
    return response.status(404).json({ message: "Voter was not found." });
  }

  if (request.authUser && !isSuperAdmin(request.authUser) && !canCreateAgentInScope(request.authUser, voter.voterProfile)) {
    return response.status(403).json({ message: "You cannot record participation for this voter." });
  }

  const result = await prisma.$transaction(async (transaction) => {
    const recorded = await recordParticipationAndReward(transaction, parsed.data);

    // Minting spendable points was the one financial mutation that left no
    // audit row. It is the only ledger writer whose point figure comes from a
    // caller rather than a versioned reward rule, which makes the trail more
    // necessary here than anywhere else, not less.
    if (recorded.created) {
      await createAuditLog(transaction, {
        actorUserId: request.authUser!.id,
        action: "PARTICIPATION_POINTS_AWARDED",
        targetType: "User",
        targetId: parsed.data.voterUserId,
        territory: voter.voterProfile || undefined,
        metadata: {
          type: parsed.data.type,
          pointsAwarded: parsed.data.pointsAwarded,
          description: parsed.data.description,
          eventId: recorded.eventId,
          relatedPollId: parsed.data.relatedPollId || null,
          relatedPostId: parsed.data.relatedPostId || null,
        },
      });
    }

    return recorded;
  });

  if (!result.created) {
    return response.status(409).json({ message: "This participation action was already recorded." });
  }

  return response.status(201).json({
    message: "Participation recorded successfully.",
    eventId: result.eventId,
  });
});

router.post("/polls", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = pollCreationSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid poll payload.", errors: parsed.error.flatten() });
  }

  const territoryReferenceError = await validateTerritoryReferences(parsed.data);
  if (territoryReferenceError) {
    return response.status(400).json({ message: territoryReferenceError });
  }

  if (request.authUser && isAdminUser(request.authUser) && !canCreateAgentInScope(request.authUser, parsed.data)) {
    return response.status(403).json({ message: "You cannot create a poll outside your territory." });
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

  const poll = await prisma.poll.create({
    data: {
      title: parsed.data.title.trim(),
      description: parsed.data.description?.trim() || null,
      candidateUserId: parsed.data.candidateUserId || null,
      officeType: parsed.data.officeType || null,
      stateId: parsed.data.stateId || null,
      senatorialDistrictId: parsed.data.senatorialDistrictId || null,
      federalConstituencyId: parsed.data.federalConstituencyId || null,
      lgaId: parsed.data.lgaId || null,
      wardId: parsed.data.wardId || null,
      stateConstituencyId: parsed.data.stateConstituencyId || null,
      pollingUnitId: parsed.data.pollingUnitId || null,
      createdByUserId: request.authUser!.id,
      options: {
        create: parsed.data.options.map((label) => ({ label })),
      },
    },
    include: { options: true },
  });

  return response.status(201).json({
    message: "Poll created successfully.",
    poll,
  });
});

router.get("/polls/:pollId/results", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const pollId = readRouteId(response, request.params.pollId, "poll id");
  if (!pollId) {
    return;
  }

  const poll = await prisma.poll.findUnique({
    where: { id: pollId },
    include: {
      options: {
        include: {
          _count: {
            select: { responses: true },
          },
        },
      },
    },
  });

  if (!poll) {
    return response.status(404).json({ message: "Poll was not found." });
  }

  if (request.authUser && isAdminUser(request.authUser) && !canCreateAgentInScope(request.authUser, poll)) {
    return response.status(403).json({ message: "You cannot view this poll result." });
  }

  return response.json({
    poll: {
      id: poll.id,
      title: poll.title,
      totalResponses: poll.options.reduce((sum, option) => sum + option._count.responses, 0),
      options: poll.options.map((option) => ({
        id: option.id,
        label: option.label,
        responses: option._count.responses,
      })),
    },
  });
});

router.get("/feedback", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const actorScope = getFeedbackScopeFilter(request.authUser);
  const partyScope = getAdminPartyScopedFeedbackWhere(request.authUser);
  const feedback = await prisma.feedback.findMany({
    where: {
      ...actorScope,
      ...partyScope,
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return response.json({
    feedback: feedback.map(serializeFeedbackItem),
  });
});

router.get("/incidents", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = incidentQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid incident query.", errors: parsed.error.flatten() });
  }

  const page = parsed.data.page || 1;
  const pageSize = parsed.data.pageSize || 20;
  const incidents = await prisma.incident.findMany({
    where: {
      ...getIncidentScopeFilter(request.authUser),
      ...getAdminPartyScopedIncidentWhere(request.authUser),
      status: parsed.data.status,
      type: parsed.data.type,
      createdAt: getDateRange(parsed.data),
    },
    include: {
      reportedByUser: {
        select: {
          role: true,
          agentProfile: {
            select: {
              stateId: true,
              lgaId: true,
              wardId: true,
              pollingUnitId: true,
            },
          },
          voterProfile: {
            select: {
              stateId: true,
              lgaId: true,
              wardId: true,
              pollingUnitId: true,
            },
          },
          adminProfile: {
            select: {
              stateId: true,
              lgaId: true,
              wardId: true,
              pollingUnitId: true,
            },
          },
          candidateProfile: {
            select: {
              stateId: true,
              lgaId: true,
              wardId: true,
              pollingUnitId: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

  const governedIncidents = await buildGovernedIncidentItems(incidents);
  const visibleIncidents = governedIncidents.filter((incident) => {
    if (parsed.data.flaggedOnly === "true" && (incident.governance?.flags.length || 0) === 0) {
      return false;
    }

    if (parsed.data.reviewPriority && incident.governance?.reviewPriority !== parsed.data.reviewPriority) {
      return false;
    }

    return true;
  });

  return response.json({
    page,
    pageSize,
    incidents: visibleIncidents,
    governance: summarizeIncidentGovernance(governedIncidents),
  });
});

router.patch("/incidents/:incidentId/status", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = incidentStatusUpdateSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid incident status payload.", errors: parsed.error.flatten() });
  }

  const incidentId = readRouteId(response, request.params.incidentId, "incident id");
  if (!incidentId) {
    return;
  }

  const incident = await prisma.incident.findUnique({ where: { id: incidentId } });
  if (!incident) {
    return response.status(404).json({ message: "Incident was not found." });
  }

  if (request.authUser && !isWithinAdminScope(request.authUser, incident)) {
    return response.status(403).json({ message: "You cannot update this incident." });
  }

  const updatedIncident = await prisma.incident.update({
    where: { id: incident.id },
    data: { status: parsed.data.status },
  });

  await prisma.$transaction(async (transaction) => {
    if (updatedIncident.assignedAdminUserId) {
      await createNotification(transaction, {
        userId: updatedIncident.assignedAdminUserId,
        type: NotificationType.INCIDENT_UPDATED,
        title: "Incident status updated",
        message: `${updatedIncident.title} is now ${updatedIncident.status}.`,
      });
    }

    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: "INCIDENT_STATUS_UPDATED",
      targetType: "Incident",
      targetId: updatedIncident.id,
      territory: updatedIncident,
      metadata: { status: updatedIncident.status },
    });
  });

  return response.json({
    message: "Incident status updated successfully.",
    incident: serializeIncidentItem(updatedIncident),
  });
});

router.patch("/incidents/:incidentId/assign", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = incidentAssignSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid incident assignment payload.", errors: parsed.error.flatten() });
  }

  const incidentId = readRouteId(response, request.params.incidentId, "incident id");
  if (!incidentId) {
    return;
  }

  const [incident, assignedAdmin] = await Promise.all([
    prisma.incident.findUnique({ where: { id: incidentId } }),
    prisma.user.findUnique({
      where: { id: parsed.data.assignedAdminUserId },
      include: { adminProfile: true },
    }),
  ]);

  if (!incident) {
    return response.status(404).json({ message: "Incident was not found." });
  }

  if (request.authUser && !isWithinAdminScope(request.authUser, incident)) {
    return response.status(403).json({ message: "You cannot assign this incident." });
  }

  if (!assignedAdmin?.adminProfile) {
    return response.status(400).json({ message: "Assigned admin was not found." });
  }

  const assignedAdminAuth = await getAuthUserProfile(assignedAdmin.id);
  if (!assignedAdminAuth || !isWithinAdminScope(assignedAdminAuth, incident)) {
    return response.status(400).json({ message: "Assigned admin is outside the incident scope." });
  }

  const updatedIncident = await prisma.incident.update({
    where: { id: incident.id },
    data: { assignedAdminUserId: assignedAdmin.id },
  });

  await prisma.$transaction(async (transaction) => {
    await createNotification(transaction, {
      userId: assignedAdmin.id,
      type: NotificationType.INCIDENT_ASSIGNED,
      title: "Incident assigned to you",
      message: `${updatedIncident.title} has been assigned for follow-up.`,
    });

    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: "INCIDENT_ASSIGNED",
      targetType: "Incident",
      targetId: updatedIncident.id,
      territory: updatedIncident,
      metadata: { assignedAdminUserId: assignedAdmin.id },
    });
  });

  return response.json({
    message: "Incident assigned successfully.",
    incident: serializeIncidentItem(updatedIncident),
  });
});

router.patch("/incidents/:incidentId/escalate", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = escalationSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid escalation payload.", errors: parsed.error.flatten() });
  }

  const incidentId = readRouteId(response, request.params.incidentId, "incident id");
  if (!incidentId) {
    return;
  }

  const incident = await prisma.incident.findUnique({ where: { id: incidentId } });
  if (!incident) {
    return response.status(404).json({ message: "Incident was not found." });
  }

  if (request.authUser && !isWithinAdminScope(request.authUser, incident)) {
    return response.status(403).json({ message: "You cannot escalate this incident." });
  }

  const updatedIncident = await prisma.incident.update({
    where: { id: incident.id },
    data: {
      escalatedAt: new Date(),
      escalatedByUserId: request.authUser!.id,
      escalationNote: parsed.data.escalationNote,
    },
  });

  await prisma.$transaction(async (transaction) => {
    if (updatedIncident.assignedAdminUserId) {
      await createNotification(transaction, {
        userId: updatedIncident.assignedAdminUserId,
        type: NotificationType.INCIDENT_UPDATED,
        title: "Incident escalated",
        message: `${updatedIncident.title} has been escalated.`,
      });
    }

    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: "INCIDENT_ESCALATED",
      targetType: "Incident",
      targetId: updatedIncident.id,
      territory: updatedIncident,
      metadata: { escalationNote: parsed.data.escalationNote },
    });
  });

  return response.json({
    message: "Incident escalated successfully.",
    incident: serializeIncidentItem(updatedIncident),
  });
});

router.get("/election-day-reports", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = electionDayReportQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid election-day report query.", errors: parsed.error.flatten() });
  }

  const reports = await prisma.electionDayReport.findMany({
    where: {
      ...(request.authUser && !isSuperAdmin(request.authUser)
        ? toScopeFilter(getAgentScopeFilter(request.authUser))
        : {}),
      agentUser: getAdminPartyScopedAgentRelationFilter(request.authUser),
      status: parsed.data.status,
      reportDate: parsed.data.reportDate ? new Date(`${parsed.data.reportDate}T00:00:00.000Z`) : undefined,
    },
    include: {
      agentUser: { select: { name: true } },
      reviewedByUser: { select: { name: true } },
    },
    orderBy: [{ reportDate: "desc" }, { createdAt: "desc" }],
    take: 100,
  });

  return response.json({
    reports: reports.map((report) =>
      serializeElectionDayReportItem({
        ...report,
        voteEntries: parseElectionDayVoteEntries(report.voteEntriesJson),
      }),
    ),
  });
});

router.get("/election-day-report-assets/:assetId", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const assetId = readRouteId(response, request.params.assetId, "asset id");
  if (!assetId) {
    return;
  }

  const asset = await prisma.electionDayReportAsset.findUnique({
    where: { id: assetId },
    include: {
      arrivalReport: {
        select: {
          geoPoliticalZoneId: true,
          stateId: true,
          senatorialDistrictId: true,
          federalConstituencyId: true,
          lgaId: true,
          wardId: true,
          stateConstituencyId: true,
          pollingUnitId: true,
        },
      },
      postCountingReport: {
        select: {
          geoPoliticalZoneId: true,
          stateId: true,
          senatorialDistrictId: true,
          federalConstituencyId: true,
          lgaId: true,
          wardId: true,
          stateConstituencyId: true,
          pollingUnitId: true,
        },
      },
    },
  });

  if (!asset) {
    return response.status(404).json({ message: "Election report asset was not found." });
  }

  const relatedReport = asset.arrivalReport || asset.postCountingReport;
  if (!relatedReport || (request.authUser && !isSuperAdmin(request.authUser) && !canCreateAgentInScope(request.authUser, relatedReport))) {
    return response.status(403).json({ message: "You do not have permission to view this election report asset." });
  }

  if (request.authUser && !isSuperAdmin(request.authUser) && request.authUser.role === UserRole.ADMIN) {
    const ownerProfile = await prisma.agentProfile.findUnique({
      where: { userId: asset.ownerUserId },
      select: { politicalPartyId: true },
    });

    if (!ownerProfile || !isWithinActorParty(request.authUser, ownerProfile.politicalPartyId)) {
      return response.status(403).json({ message: "You do not have permission to view this election report asset." });
    }
  }

  response.setHeader("Content-Type", asset.mimeType);
  response.setHeader("Content-Length", asset.data.length.toString());
  response.setHeader("Cache-Control", "private, max-age=300");
  response.setHeader("Last-Modified", asset.updatedAt.toUTCString());
  return response.send(Buffer.from(asset.data));
});

router.patch("/election-day-reports/:reportId/status", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = electionDayReportStatusSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid election-day report review payload.", errors: parsed.error.flatten() });
  }

  const reportId = readRouteId(response, request.params.reportId, "report id");
  if (!reportId) {
    return;
  }

  const report = await prisma.electionDayReport.findUnique({
    where: { id: reportId },
    include: {
      agentUser: { select: { name: true } },
      reviewedByUser: { select: { name: true } },
    },
  });

  if (!report) {
    return response.status(404).json({ message: "Election-day report was not found." });
  }

  if (request.authUser && !isSuperAdmin(request.authUser) && !canCreateAgentInScope(request.authUser, report)) {
    return response.status(403).json({ message: "You do not have permission to review this election-day report." });
  }

  if (request.authUser && !isSuperAdmin(request.authUser) && request.authUser.role === UserRole.ADMIN) {
    const agentProfile = await prisma.agentProfile.findUnique({
      where: { userId: report.agentUserId },
      select: { politicalPartyId: true },
    });

    if (!agentProfile || !isWithinActorParty(request.authUser, agentProfile.politicalPartyId)) {
      return response.status(403).json({ message: "You do not have permission to review this election-day report." });
    }
  }

  const updatedReport = await prisma.$transaction(async (transaction) => {
    const nextReport = await transaction.electionDayReport.update({
      where: { id: report.id },
      data: {
        status: parsed.data.status,
        reviewNote: parsed.data.reviewNote?.trim() || null,
        reviewedByUserId: request.authUser!.id,
        reviewedAt: new Date(),
      },
      include: {
        agentUser: { select: { name: true } },
        reviewedByUser: { select: { name: true } },
      },
    });

    await createNotification(transaction, {
      userId: nextReport.agentUserId,
      type: NotificationType.SYSTEM,
      title: "Election-day report reviewed",
      message: `Your election-day report is now ${nextReport.status}.`,
    });

    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: "ELECTION_DAY_REPORT_STATUS_UPDATED",
      targetType: "ElectionDayReport",
      targetId: nextReport.id,
      territory: nextReport,
      metadata: {
        status: nextReport.status,
        reviewNote: parsed.data.reviewNote?.trim() || null,
      },
    });

    return nextReport;
  });

  const reportTerritory = {
    stateId: updatedReport.stateId,
    senatorialDistrictId: updatedReport.senatorialDistrictId,
    federalConstituencyId: updatedReport.federalConstituencyId,
    stateConstituencyId: updatedReport.stateConstituencyId,
    wardId: updatedReport.wardId,
    pollingUnitId: updatedReport.pollingUnitId,
  };
  publishRealtimeEvent(
    createElectionDayRealtimeEvent({
      eventType: "election.report.reviewed",
      actorUserId: request.authUser!.id,
      territory: reportTerritory,
      idempotencyKey: `report-reviewed:${updatedReport.id}:${updatedReport.updatedAt.toISOString()}`,
      payload: {
        reportId: updatedReport.id,
        status: updatedReport.status,
        reviewedAt: updatedReport.reviewedAt?.toISOString() || null,
        pollingUnitId: updatedReport.pollingUnitId,
      },
    }),
  );
  publishRealtimeEvent(
    createElectionDayRealtimeEvent({
      eventType: "election.situation.updated",
      actorUserId: request.authUser!.id,
      territory: reportTerritory,
      idempotencyKey: `situation:${updatedReport.id}:${updatedReport.updatedAt.toISOString()}`,
      payload: { reason: "REPORT_REVIEWED", pollingUnitId: updatedReport.pollingUnitId },
    }),
  );

  return response.json({
    message: "Election-day report status updated successfully.",
    report: serializeElectionDayReportItem({
      ...updatedReport,
      voteEntries: parseElectionDayVoteEntries(updatedReport.voteEntriesJson),
    }),
  });
});

router.get("/tasks", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const tasks = await prisma.fieldTask.findMany({
    where: getFieldTaskScopeFilter(request.authUser),
    include: {
      createdByUser: { select: { name: true } },
      assignedToUser: { select: { name: true } },
    },
    orderBy: [
      { status: "asc" },
      { priority: "desc" },
      { createdAt: "desc" },
    ],
    take: 100,
  });

  return response.json({
    tasks: tasks.map(serializeFieldTaskItem),
  });
});

router.post("/tasks", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = fieldTaskCreationSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid task payload.", errors: parsed.error.flatten() });
  }

  const assignedAgent = await prisma.user.findUnique({
    where: { id: parsed.data.assignedToUserId },
    include: { agentProfile: true },
  });

  if (!assignedAgent?.agentProfile) {
    return response.status(400).json({ message: "Assigned user must be an agent." });
  }

  if (request.authUser && !canCreateAgentInScope(request.authUser, assignedAgent.agentProfile)) {
    return response.status(403).json({ message: "You cannot assign tasks outside your agent scope." });
  }

  if (request.authUser && !isWithinActorParty(request.authUser, assignedAgent.agentProfile.politicalPartyId)) {
    return response.status(403).json({ message: "You cannot assign tasks outside your political party scope." });
  }

  let linkedIncident: Awaited<ReturnType<typeof prisma.incident.findUnique>> | null = null;
  if (parsed.data.incidentId) {
    linkedIncident = await prisma.incident.findUnique({ where: { id: parsed.data.incidentId } });
    if (!linkedIncident) {
      return response.status(404).json({ message: "Linked incident was not found." });
    }

    if (request.authUser && !isWithinAdminScope(request.authUser, linkedIncident)) {
      return response.status(403).json({ message: "You cannot create tasks for this incident." });
    }
  }

  const task = await createScopedFieldTask(
    request.authUser!,
    assignedAgent as Awaited<ReturnType<typeof prisma.user.findUnique>> & { agentProfile: NonNullable<typeof assignedAgent.agentProfile> },
    parsed.data,
    linkedIncident,
  );

  return response.status(201).json({
    message: "Field task created successfully.",
    task: serializeFieldTaskItem(task),
  });
});

router.post("/tasks/bulk", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = fieldTaskBulkCreationSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid bulk task payload.", errors: parsed.error.flatten() });
  }

  const scopedPayload = applyActorAdminScope(request.authUser, parsed.data);
  if (
    !scopedPayload.agentUserIds?.length &&
    !scopedPayload.stateId &&
    !scopedPayload.lgaId &&
    !scopedPayload.wardId &&
    !scopedPayload.senatorialDistrictId &&
    !scopedPayload.federalConstituencyId &&
    !scopedPayload.stateConstituencyId &&
    !scopedPayload.pollingUnitId
  ) {
    return response.status(400).json({ message: "Select agents directly or provide a territory or constituency filter." });
  }

  const territoryReferenceError = await validateTerritoryReferences({
    geoPoliticalZoneId: scopedPayload.geoPoliticalZoneId,
    stateId: scopedPayload.stateId,
    senatorialDistrictId: scopedPayload.senatorialDistrictId,
    federalConstituencyId: scopedPayload.federalConstituencyId,
    lgaId: scopedPayload.lgaId,
    wardId: scopedPayload.wardId,
    stateConstituencyId: scopedPayload.stateConstituencyId,
    pollingUnitId: scopedPayload.pollingUnitId,
  });

  if (territoryReferenceError) {
    return response.status(400).json({ message: territoryReferenceError });
  }

  const agents = await prisma.user.findMany({
    where: {
      role: UserRole.AGENT,
      isActive: true,
      ...(scopedPayload.agentUserIds?.length ? { id: { in: scopedPayload.agentUserIds } } : {}),
      agentProfile: {
        is: {
          ...(scopedPayload.geoPoliticalZoneId ? { geoPoliticalZoneId: scopedPayload.geoPoliticalZoneId } : {}),
          ...(scopedPayload.stateId ? { stateId: scopedPayload.stateId } : {}),
          ...(scopedPayload.senatorialDistrictId ? { senatorialDistrictId: scopedPayload.senatorialDistrictId } : {}),
          ...(scopedPayload.federalConstituencyId ? { federalConstituencyId: scopedPayload.federalConstituencyId } : {}),
          ...(scopedPayload.lgaId ? { lgaId: scopedPayload.lgaId } : {}),
          ...(scopedPayload.wardId ? { wardId: scopedPayload.wardId } : {}),
          ...(scopedPayload.stateConstituencyId ? { stateConstituencyId: scopedPayload.stateConstituencyId } : {}),
          ...(scopedPayload.pollingUnitId ? { pollingUnitId: scopedPayload.pollingUnitId } : {}),
        },
      },
    },
    include: {
      agentProfile: true,
    },
    take: 250,
  });

  const eligibleAgents = agents.filter((agent) => {
    if (!agent.agentProfile || !request.authUser) {
      return false;
    }

    return canCreateAgentInScope(request.authUser, agent.agentProfile) && isWithinActorParty(request.authUser, agent.agentProfile.politicalPartyId);
  });

  if (eligibleAgents.length === 0) {
    return response.status(404).json({ message: "No eligible agents were found for the selected target." });
  }

  const tasks = [];
  for (const agent of eligibleAgents) {
    const task = await createScopedFieldTask(
      request.authUser!,
      agent as Awaited<ReturnType<typeof prisma.user.findUnique>> & { agentProfile: NonNullable<typeof agent.agentProfile> },
      {
        title: scopedPayload.title,
        description: scopedPayload.description,
        priority: scopedPayload.priority,
        dueAt: scopedPayload.dueAt,
      },
      null,
    );
    tasks.push(task);
  }

  return response.status(201).json({
    message: `${tasks.length} field task${tasks.length === 1 ? "" : "s"} assigned successfully.`,
    count: tasks.length,
    tasks: tasks.map(serializeFieldTaskItem),
  });
});

router.patch("/tasks/:taskId", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = fieldTaskUpdateSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid task update payload.", errors: parsed.error.flatten() });
  }

  const taskId = readRouteId(response, request.params.taskId, "task id");
  if (!taskId) {
    return;
  }

  const task = await prisma.fieldTask.findUnique({
    where: { id: taskId },
    include: {
      createdByUser: { select: { name: true } },
      assignedToUser: { select: { name: true } },
    },
  });

  if (!task) {
    return response.status(404).json({ message: "Task was not found." });
  }

  if (request.authUser && !isWithinAdminScope(request.authUser, task)) {
    return response.status(403).json({ message: "You cannot update this task." });
  }

  const updatedTask = await prisma.$transaction(async (transaction) => {
    const nextTask = await transaction.fieldTask.update({
      where: { id: task.id },
      data: {
        status: parsed.data.status,
        priority: parsed.data.priority,
        dueAt: parsed.data.dueAt === undefined ? undefined : parsed.data.dueAt ? new Date(parsed.data.dueAt) : null,
        resolutionNote: parsed.data.resolutionNote === undefined ? undefined : parsed.data.resolutionNote,
        completedAt:
          parsed.data.status === undefined
            ? undefined
            : parsed.data.status === FieldTaskStatus.DONE
              ? new Date()
              : null,
      },
      include: {
        createdByUser: { select: { name: true } },
        assignedToUser: { select: { name: true } },
      },
    });

    await createNotification(transaction, {
      userId: nextTask.assignedToUserId,
      type: NotificationType.SYSTEM,
      title: "Field task updated",
      message: `${nextTask.title} is now ${nextTask.status}.`,
    });

    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: "FIELD_TASK_UPDATED",
      targetType: "FieldTask",
      targetId: nextTask.id,
      territory: nextTask,
      metadata: {
        status: nextTask.status,
        priority: nextTask.priority,
      },
    });

    return nextTask;
  });

  return response.json({
    message: "Field task updated successfully.",
    task: serializeFieldTaskItem(updatedTask),
  });
});

router.get("/broadcasts", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const broadcasts = await prisma.broadcastMessage.findMany({
    where: getFieldTaskScopeFilter(request.authUser),
    include: {
      createdByUser: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return response.json({
    broadcasts: broadcasts.map(serializeBroadcastMessageItem),
  });
});

router.post("/broadcasts/preview", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = broadcastCreationSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid broadcast payload.", errors: parsed.error.flatten() });
  }

  const targetScope = buildBroadcastScope(parsed.data);
  const territoryReferenceError = await validateTerritoryReferences(targetScope);
  if (territoryReferenceError) {
    return response.status(400).json({ message: territoryReferenceError });
  }

  if (request.authUser && !isWithinAdminScope(request.authUser, targetScope)) {
    return response.status(403).json({ message: "You cannot preview broadcasts outside your territory scope." });
  }

  const targetingError = validateBroadcastTargeting(parsed.data);
  if (targetingError) {
    return response.status(400).json({ message: targetingError });
  }

  const partyScopeError = validateBroadcastPartyScope(request.authUser, parsed.data.politicalPartyId);
  if (partyScopeError) {
    return response.status(403).json({ message: partyScopeError });
  }

  const effectivePoliticalPartyId =
    parsed.data.politicalPartyId ||
    (request.authUser?.role === UserRole.ADMIN ? request.authUser.adminProfile?.politicalPartyId || null : null);

  const recipients = await prisma.user.findMany({
    where: {
      isActive: true,
      ...buildBroadcastRecipientWhere(parsed.data, targetScope, request.authUser),
    },
    select: { role: true },
    take: 500,
  });

  return response.json({
    preview: {
      recipientCount: recipients.length,
      breakdown: {
        admins: recipients.filter((item) => item.role === UserRole.ADMIN).length,
        agents: recipients.filter((item) => item.role === UserRole.AGENT).length,
        voters: recipients.filter((item) => item.role === UserRole.VOTER).length,
        candidates: recipients.filter((item) => item.role === UserRole.CANDIDATE).length,
      },
      filters: {
        audience: parsed.data.audience,
        taskStatus: parsed.data.taskStatus || null,
        politicalPartyId: effectivePoliticalPartyId,
        adminLevel: parsed.data.adminLevel || null,
        officeType: parsed.data.officeType || null,
      },
      territory: serializeTerritory(targetScope),
    },
  });
});

router.post("/broadcasts", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = broadcastCreationSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid broadcast payload.", errors: parsed.error.flatten() });
  }

  const targetScope = buildBroadcastScope(parsed.data);
  const territoryReferenceError = await validateTerritoryReferences(targetScope);
  if (territoryReferenceError) {
    return response.status(400).json({ message: territoryReferenceError });
  }

  if (request.authUser && !isWithinAdminScope(request.authUser, targetScope)) {
    return response.status(403).json({ message: "You cannot broadcast outside your territory scope." });
  }

  const targetingError = validateBroadcastTargeting(parsed.data);
  if (targetingError) {
    return response.status(400).json({ message: targetingError });
  }

  const partyScopeError = validateBroadcastPartyScope(request.authUser, parsed.data.politicalPartyId);
  if (partyScopeError) {
    return response.status(403).json({ message: partyScopeError });
  }

  const effectivePoliticalPartyId =
    parsed.data.politicalPartyId ||
    (request.authUser?.role === UserRole.ADMIN ? request.authUser.adminProfile?.politicalPartyId || null : null);

  const recipients = await prisma.user.findMany({
      where: {
        isActive: true,
        ...buildBroadcastRecipientWhere(parsed.data, targetScope, request.authUser),
      },
      select: { id: true },
      take: 500,
  });

  const recipientIds = recipients.map((recipient) => recipient.id);
  if (recipientIds.length === 0) {
    return response.status(400).json({ message: "No visible recipients matched the selected communication target." });
  }

  const broadcastId = await prisma.$transaction(async (transaction) => {
    const broadcast = await transaction.broadcastMessage.create({
      data: {
        title: parsed.data.title,
        message: parsed.data.message,
        audience: parsed.data.audience,
        taskStatus: parsed.data.taskStatus || null,
        createdByUserId: request.authUser!.id,
        recipientCount: recipientIds.length,
        geoPoliticalZoneId: targetScope.geoPoliticalZoneId,
        stateId: targetScope.stateId,
        senatorialDistrictId: targetScope.senatorialDistrictId,
        federalConstituencyId: targetScope.federalConstituencyId,
        lgaId: targetScope.lgaId,
        wardId: targetScope.wardId,
        stateConstituencyId: targetScope.stateConstituencyId,
        pollingUnitId: targetScope.pollingUnitId,
      },
    });

    for (const recipientId of recipientIds) {
      await createNotification(transaction, {
        userId: recipientId,
        type: NotificationType.SYSTEM,
        title: parsed.data.title,
        message: parsed.data.message,
      });
    }

    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: "BROADCAST_CREATED",
      targetType: "BroadcastMessage",
      targetId: broadcast.id,
        metadata: {
          audience: parsed.data.audience,
          recipientCount: recipientIds.length,
          taskStatus: parsed.data.taskStatus || null,
          politicalPartyId: effectivePoliticalPartyId,
          adminLevel: parsed.data.adminLevel || null,
          officeType: parsed.data.officeType || null,
        },
      });

    return broadcast.id;
  });

  const broadcast = await prisma.broadcastMessage.findUnique({
    where: { id: broadcastId },
    include: {
      createdByUser: { select: { name: true } },
    },
  });

  if (!broadcast) {
    return response.status(500).json({ message: "Broadcast was created but could not be loaded." });
  }

  return response.status(201).json({
    message: "Broadcast sent successfully.",
    broadcast: serializeBroadcastMessageItem(broadcast),
  });
});

router.get("/engagement-tasks", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const tasks = await prisma.voterEngagementTask.findMany({
    where: getFieldTaskScopeFilter(request.authUser),
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return response.json({
    tasks: tasks.map((task) =>
      serializeVoterEngagementTaskItem({
        ...task,
        progressCount: 0,
        completed: false,
        claimed: false,
      }),
    ),
  });
});

router.post("/engagement-tasks", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = engagementTaskCreationSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid engagement task payload.", errors: parsed.error.flatten() });
  }

  const targetScope = buildEngagementTaskScope(parsed.data);
  const territoryReferenceError = await validateTerritoryReferences(targetScope);
  if (territoryReferenceError) {
    return response.status(400).json({ message: territoryReferenceError });
  }

  if (request.authUser && !isWithinAdminScope(request.authUser, targetScope)) {
    return response.status(403).json({ message: "You cannot create voter engagement tasks outside your territory scope." });
  }

  const task = await prisma.voterEngagementTask.create({
    data: {
      title: parsed.data.title,
      description: parsed.data.description,
      type: parsed.data.type,
      rewardPoints: parsed.data.rewardPoints,
      targetCount: parsed.data.targetCount || 1,
      createdByUserId: request.authUser!.id,
      geoPoliticalZoneId: targetScope.geoPoliticalZoneId || null,
      stateId: targetScope.stateId || null,
      senatorialDistrictId: targetScope.senatorialDistrictId || null,
      federalConstituencyId: targetScope.federalConstituencyId || null,
      lgaId: targetScope.lgaId || null,
      wardId: targetScope.wardId || null,
      stateConstituencyId: targetScope.stateConstituencyId || null,
      pollingUnitId: targetScope.pollingUnitId || null,
    },
  });

  await createAuditLog(prisma, {
    actorUserId: request.authUser!.id,
    action: "VOTER_ENGAGEMENT_TASK_CREATED",
    targetType: "VoterEngagementTask",
    targetId: task.id,
    territory: task,
    metadata: {
      type: task.type,
      rewardPoints: task.rewardPoints,
      targetCount: task.targetCount,
    },
  });

  return response.status(201).json({
    message: "Voter engagement task created successfully.",
    task: serializeVoterEngagementTaskItem({
      ...task,
      progressCount: 0,
      completed: false,
      claimed: false,
    }),
  });
});

router.get("/map-summary", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const [agents, incidents, pollingUnits] = await Promise.all([
    prisma.user.findMany({
      where: {
        role: UserRole.AGENT,
        ...getAdminPartyScopedAgentUserFilter(request.authUser),
      },
      include: {
        agentProfile: true,
        agentActivities: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    }),
    prisma.incident.findMany({
      where: {
        ...getIncidentScopeFilter(request.authUser),
        ...getAdminPartyScopedIncidentWhere(request.authUser),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.pollingUnit.findMany({
      where: getPollingUnitScopeFilter(request.authUser),
      orderBy: { name: "asc" },
    }),
  ]);

  const activeAgents = agents
    .filter((agent) => agent.agentProfile && request.authUser && canCreateAgentInScope(request.authUser, agent.agentProfile))
    .map((agent) => {
      const latest = agent.agentActivities[0];
      return serializeAgentActivitySummary({
        agentUserId: agent.id,
        name: agent.name,
        email: agent.email,
        territory: serializeTerritory(agent.agentProfile!),
        latestActivityType: latest?.type || null,
        latestActivityAt: latest?.createdAt.toISOString() || null,
        latestLatitude: latest?.latitude ?? null,
        latestLongitude: latest?.longitude ?? null,
        pollingUnitId: latest?.pollingUnitId || agent.agentProfile?.pollingUnitId || null,
      });
    })
    .filter((item) => item.latestLatitude !== null && item.latestLongitude !== null);

  const counts = {
    byStatus: incidents.reduce<Record<string, number>>((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {}),
    bySeverity: incidents.reduce<Record<string, number>>((acc, item) => {
      acc[item.severity] = (acc[item.severity] || 0) + 1;
      return acc;
    }, {}),
    byType: incidents.reduce<Record<string, number>>((acc, item) => {
      acc[item.type] = (acc[item.type] || 0) + 1;
      return acc;
    }, {}),
  };

  return response.json({
    mapSummary: serializeAdminMapSummary({
      activeAgents,
      incidents: incidents.filter((item) => item.latitude !== null && item.longitude !== null).map(serializeIncidentItem),
      pollingUnits: pollingUnits.map((unit) => ({
        id: unit.id,
        name: unit.name,
        stateId: unit.stateId,
        lgaId: unit.lgaId,
        wardId: unit.wardId,
      })),
      counts,
    }),
  });
});

router.get("/redemptions", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const voterProfiles = await prisma.voterProfile.findMany({
    where: getVoterScopeFilter(request.authUser),
    select: { userId: true },
  });

  const redemptions = await prisma.rewardRedemption.findMany({
    where: {
      voterUserId: {
        in: voterProfiles.map((item) => item.userId),
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return response.json({
    redemptions: redemptions.map(serializeRewardRedemption),
  });
});

router.get("/reward-ledger", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const voterProfiles = await prisma.voterProfile.findMany({
    where: toScopeFilter(getVoterScopeFilter(request.authUser)),
    select: { userId: true },
  });

  const voterUserIds = voterProfiles.map((item) => item.userId);
  if (voterUserIds.length === 0) {
    return response.json({ rewardLedger: [], rewardHistory: [] });
  }

  const [ledgerEntries, redemptions] = await Promise.all([
    prisma.rewardLedger.findMany({
      where: {
        voterUserId: { in: voterUserIds },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.rewardRedemption.findMany({
      where: {
        voterUserId: { in: voterUserIds },
      },
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

router.patch("/redemptions/:redemptionId/approve", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = redemptionReviewSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid redemption review payload.", errors: parsed.error.flatten() });
  }

  const redemptionId = readRouteId(response, request.params.redemptionId, "redemption id");
  if (!redemptionId) {
    return;
  }

  const redemption = await prisma.rewardRedemption.findUnique({ where: { id: redemptionId } });
  if (!redemption) {
    return response.status(404).json({ message: "Redemption was not found." });
  }

  const voterProfile = await prisma.voterProfile.findUnique({ where: { userId: redemption.voterUserId } });
  if (!voterProfile || (request.authUser && !isWithinAdminScope(request.authUser, voterProfile))) {
    return response.status(403).json({ message: "You cannot review this redemption." });
  }

  if (redemption.status !== RewardRedemptionStatus.PENDING) {
    return response.status(400).json({ message: "Only pending redemptions can be approved." });
  }

  const updated = await prisma.$transaction(async (transaction) => {
    // The previous guard read the legacy ledger and compared
    // `pointsRequested > availablePoints + pointsRequested`, which is
    // unsatisfiable for any positive request — it never rejected anything.
    //
    // This one can fire. The redemption already reserves its points, so what
    // must hold at approval is that the member's earnings still cover every
    // reservation against them. If other commitments have since consumed the
    // balance, approving would confirm points the member does not have.
    const balance = await getAuthoritativeBalance(transaction, redemption.voterUserId);
    if (balance.reservedPoints > balance.confirmedPoints) {
      throw new Error("REDEMPTION_BALANCE_INSUFFICIENT");
    }

    // Re-valued here, so the amount that is later paid is one this server
    // computed. A redemption raised before the authority existed — or by a seed
    // — carries a client-supplied `amountRequested`, and the PAID transition
    // records that figure verbatim. Without revaluing, an old row remains
    // approvable and payable at an amount nothing ever authorized.
    const valuation = await valuePayout(transaction, {
      userId: redemption.voterUserId,
      requestedPoints: redemption.pointsRequested,
      excludeRedemptionId: redemption.id,
    });
    if (!valuation.meetsThreshold) {
      throw new Error("REDEMPTION_BALANCE_INSUFFICIENT");
    }

    const next = await transaction.rewardRedemption.update({
      where: { id: redemption.id },
      data: {
        status: RewardRedemptionStatus.APPROVED,
        amountRequested: Number(valuation.payableAmount),
        note: parsed.data.note || redemption.note,
        reviewedByUserId: request.authUser!.id,
        reviewedAt: new Date(),
      },
    });

    await createNotification(transaction, {
      userId: redemption.voterUserId,
      type: NotificationType.REWARD_REDEMPTION,
      title: "Redemption approved",
      message: `${redemption.pointsRequested} points redemption has been approved.`,
    });

    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: "REWARD_REDEMPTION_APPROVED",
      targetType: "RewardRedemption",
      targetId: redemption.id,
      territory: voterProfile,
      metadata: {
        note: parsed.data.note || null,
        voterUserId: redemption.voterUserId,
        pointsRequested: redemption.pointsRequested,
      },
    });

    return next;
  }).catch((error: unknown) => {
    throw error;
  });

  return response.json({
    message: "Redemption approved successfully.",
    redemption: serializeRewardRedemption(updated),
  });
});

router.patch("/redemptions/:redemptionId/reject", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = redemptionReviewSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid redemption review payload.", errors: parsed.error.flatten() });
  }

  const redemptionId = readRouteId(response, request.params.redemptionId, "redemption id");
  if (!redemptionId) {
    return;
  }

  const redemption = await prisma.rewardRedemption.findUnique({ where: { id: redemptionId } });
  if (!redemption) {
    return response.status(404).json({ message: "Redemption was not found." });
  }

  const voterProfile = await prisma.voterProfile.findUnique({ where: { userId: redemption.voterUserId } });
  if (!voterProfile || (request.authUser && !isWithinAdminScope(request.authUser, voterProfile))) {
    return response.status(403).json({ message: "You cannot review this redemption." });
  }

  if (redemption.status !== RewardRedemptionStatus.PENDING) {
    return response.status(400).json({ message: "Only pending redemptions can be rejected." });
  }

  const updated = await prisma.$transaction(async (transaction) => {
    const next = await transaction.rewardRedemption.update({
      where: { id: redemption.id },
      data: {
        status: RewardRedemptionStatus.REJECTED,
        note: parsed.data.note || redemption.note,
        reviewedByUserId: request.authUser!.id,
        reviewedAt: new Date(),
      },
    });

    await createNotification(transaction, {
      userId: redemption.voterUserId,
      type: NotificationType.REWARD_REDEMPTION,
      title: "Redemption rejected",
      message: `${redemption.pointsRequested} points redemption was rejected.`,
    });

    await createAuditLog(transaction, {
      actorUserId: request.authUser!.id,
      action: "REWARD_REDEMPTION_REJECTED",
      targetType: "RewardRedemption",
      targetId: redemption.id,
      territory: voterProfile,
      metadata: {
        note: parsed.data.note || null,
        voterUserId: redemption.voterUserId,
        pointsRequested: redemption.pointsRequested,
      },
    });

    return next;
  });

  return response.json({
    message: "Redemption rejected successfully.",
    redemption: serializeRewardRedemption(updated),
  });
});

router.patch("/redemptions/:redemptionId/paid", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const redemptionId = readRouteId(response, request.params.redemptionId, "redemption id");
  if (!redemptionId) {
    return;
  }

  // A payment reference is now required on this path too. The assignment path
  // always demanded one; the redemption path recorded no execution artefact at
  // all, so a paid redemption could never be reconciled against a bank record.
  const parsed = redemptionPaymentSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid redemption payment payload.", errors: parsed.error.flatten() });
  }

  const redemption = await prisma.rewardRedemption.findUnique({ where: { id: redemptionId } });
  if (!redemption) {
    return response.status(404).json({ message: "Redemption was not found." });
  }

  const voterProfile = await prisma.voterProfile.findUnique({ where: { userId: redemption.voterUserId } });
  if (!voterProfile || (request.authUser && !isWithinAdminScope(request.authUser, voterProfile))) {
    return response.status(403).json({ message: "You cannot update this redemption." });
  }

  // The state check, the kill switch, the revaluation, the atomic claim, the
  // execution record and the audit row all belong to the execution authority.
  // This route authorizes the actor and reports the outcome; it does not pay.
  let executed;
  try {
    executed = await executePayout(prisma, {
      kind: "REDEMPTION",
      redemptionId: redemption.id,
      actorUserId: request.authUser!.id,
      paymentReference: parsed.data.paymentReference,
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

  await createNotification(prisma, {
    userId: redemption.voterUserId,
    type: NotificationType.REWARD_REDEMPTION,
    title: "Redemption paid",
    message: `${redemption.pointsRequested} points redemption has been marked as paid.`,
  });

  const updated = await prisma.rewardRedemption.findUniqueOrThrow({ where: { id: redemption.id } });

  return response.json({
    message: "Redemption marked as paid successfully.",
    redemption: serializeRewardRedemption(updated),
  });
});

router.get("/polling-unit-coverage", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const recentActivitySince = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const { stateWhere, lgaWhere, wardWhere, pollingUnitWhere, scopeWarning } = await getAuthoritativeReferenceScope(request.authUser);
  const partyScopedAgentProfileFilter = getAdminPartyScopedAgentProfileFilter(request.authUser);
  const [statesInScope, statesInScopeList, realLgasInScope, wardsInScope, pollingUnits, agents, recentActivities, incidents] = await Promise.all([
    prisma.state.count({
      where: stateWhere,
    }),
    prisma.state.findMany({
      where: stateWhere,
      select: { id: true },
    }),
    prisma.lGA.findMany({
      where: {
        AND: [
          lgaWhere,
          {
            id: {
              not: {
                startsWith: BOOTSTRAP_LGA_ID_PREFIX,
              },
            },
          },
        ],
      },
      select: { id: true },
    }),
    prisma.ward.count({
      where: wardWhere,
    }),
    prisma.pollingUnit.findMany({
      where: pollingUnitWhere,
      select: { id: true },
    }),
    prisma.agentProfile.findMany({
      where: {
        ...toScopeFilter(getAgentScopeFilter(request.authUser)),
        ...partyScopedAgentProfileFilter,
        pollingUnitId: { not: null },
      },
      select: { pollingUnitId: true },
    }),
    prisma.agentActivity.findMany({
      where: {
        ...toScopeFilter(getAgentActivityScopeFilter(request.authUser)),
        agentUser: getAdminPartyScopedAgentRelationFilter(request.authUser),
        pollingUnitId: { not: null },
        createdAt: { gte: recentActivitySince },
      },
      select: { pollingUnitId: true },
    }),
    prisma.incident.findMany({
      where: {
        ...getIncidentScopeFilter(request.authUser),
        ...getAdminPartyScopedIncidentWhere(request.authUser),
        pollingUnitId: { not: null },
      },
      select: { pollingUnitId: true },
    }),
  ]);

  const authoritativeLgasInScope = shouldUseExpectedStateLgaTotals(request.authUser)
    ? getExpectedLgaTotalForStates(statesInScopeList.map((state) => state.id))
    : realLgasInScope.length;

  const totalPollingUnitsInScope = pollingUnits.length;
  const assignedSet = new Set(agents.map((item) => item.pollingUnitId).filter(Boolean));
  const recentSet = new Set(recentActivities.map((item) => item.pollingUnitId).filter(Boolean));
  const incidentSet = new Set(incidents.map((item) => item.pollingUnitId).filter(Boolean));

  return response.json({
    coverage: serializePollingUnitCoverageSummary({
      totalStatesInScope: statesInScope,
      totalLgasInScope: authoritativeLgasInScope,
      totalWardsInScope: wardsInScope,
      totalPollingUnitsInScope,
      pollingUnitsWithAssignedAgents: assignedSet.size,
      pollingUnitsWithRecentActivity: recentSet.size,
      pollingUnitsWithIncidents: incidentSet.size,
      pollingUnitsWithoutActivity: Math.max(totalPollingUnitsInScope - recentSet.size, 0),
      scopeWarning,
    }),
  });
});

router.get("/coverage-insights", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const recentActivitySince = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const { stateWhere, lgaWhere, wardWhere, pollingUnitWhere, scopeWarning } = await getAuthoritativeReferenceScope(request.authUser);
  const agentScope = toScopeFilter(getAgentScopeFilter(request.authUser));
  const partyScopedAgentProfileFilter = getAdminPartyScopedAgentProfileFilter(request.authUser);
  const [statesInScope, realLgasInScope, syntheticBootstrapLgaCount, pollingUnits, agents, recentActivities, incidents, agentsWithoutPollingUnitAssignments, loadedStates, loadedWards, loadedWardsWithoutPollingUnits] = await Promise.all([
    prisma.state.findMany({
      where: stateWhere,
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.lGA.findMany({
      where: {
        AND: [
          lgaWhere,
          {
            id: {
              not: {
                startsWith: BOOTSTRAP_LGA_ID_PREFIX,
              },
            },
          },
        ],
      },
      select: { id: true, stateId: true },
    }),
    prisma.lGA.count({
      where: {
        AND: [
          lgaWhere,
          {
            id: {
              startsWith: BOOTSTRAP_LGA_ID_PREFIX,
            },
          },
        ],
      },
    }),
    prisma.pollingUnit.findMany({
      where: pollingUnitWhere,
      select: {
        id: true,
        name: true,
        stateId: true,
        state: { select: { name: true, agentsPerPollingUnitTarget: true } },
        wardId: true,
        ward: { select: { name: true } },
        lgaId: true,
        lga: { select: { name: true } },
      },
      orderBy: [{ lga: { name: "asc" } }, { ward: { name: "asc" } }, { name: "asc" }],
    }),
    prisma.agentProfile.findMany({
      where: {
        ...agentScope,
        ...partyScopedAgentProfileFilter,
        pollingUnitId: { not: null },
      },
      select: { pollingUnitId: true },
    }),
    prisma.agentActivity.findMany({
      where: {
        ...toScopeFilter(getAgentActivityScopeFilter(request.authUser)),
        agentUser: getAdminPartyScopedAgentRelationFilter(request.authUser),
        pollingUnitId: { not: null },
        createdAt: { gte: recentActivitySince },
      },
      select: { pollingUnitId: true },
    }),
    prisma.incident.findMany({
      where: {
        ...getIncidentScopeFilter(request.authUser),
        ...getAdminPartyScopedIncidentWhere(request.authUser),
        pollingUnitId: { not: null },
        status: { in: [IncidentStatus.OPEN, IncidentStatus.IN_PROGRESS] },
      },
      select: { pollingUnitId: true },
    }),
    prisma.user.findMany({
      where: {
        role: UserRole.AGENT,
        agentProfile: {
          is: {
            ...agentScope,
            ...partyScopedAgentProfileFilter,
            pollingUnitId: null,
          },
        },
      },
      select: {
        id: true,
        name: true,
        email: true,
        agentProfile: {
          select: {
            politicalPartyId: true,
            geoPoliticalZoneId: true,
            stateId: true,
            senatorialDistrictId: true,
            federalConstituencyId: true,
            lgaId: true,
            wardId: true,
            stateConstituencyId: true,
            pollingUnitId: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.state.count({
      where: stateWhere,
    }),
    prisma.ward.count({
      where: wardWhere,
    }),
    prisma.ward.count({
      where: {
        ...wardWhere,
        pollingUnits: { none: {} },
      },
    }),
  ]);

  const authoritativeLgasInScope = shouldUseExpectedStateLgaTotals(request.authUser)
    ? getExpectedLgaTotalForStates(statesInScope.map((state) => state.id))
    : realLgasInScope.length;
  const wardAndPollingUnitInventoryComplete =
    syntheticBootstrapLgaCount === 0 &&
    realLgasInScope.length >= authoritativeLgasInScope &&
    loadedWardsWithoutPollingUnits === 0;
  const inventoryWarning = wardAndPollingUnitInventoryComplete
    ? null
    : syntheticBootstrapLgaCount > 0
      ? "Reference inventory is not yet authoritative for this scope because synthetic bootstrap LGAs are still present. Run the reference cleanup/backfill before relying on ward and polling-unit totals."
      : loadedWardsWithoutPollingUnits > 0
        ? "Ward and polling-unit totals are still incomplete in this scope. Run the full polling-unit bootstrap before relying on staffing totals."
        : realLgasInScope.length < authoritativeLgasInScope
          ? "Reference inventory is incomplete for this scope. Some LGAs do not yet have complete ward and polling-unit data loaded."
          : null;

  const assignedCountByPollingUnit = new Map<string, number>();
  for (const item of agents) {
    if (!item.pollingUnitId) {
      continue;
    }
    assignedCountByPollingUnit.set(item.pollingUnitId, (assignedCountByPollingUnit.get(item.pollingUnitId) || 0) + 1);
  }

  const recentActivityByPollingUnit = new Map<string, number>();
  for (const item of recentActivities) {
    if (!item.pollingUnitId) {
      continue;
    }
    recentActivityByPollingUnit.set(item.pollingUnitId, (recentActivityByPollingUnit.get(item.pollingUnitId) || 0) + 1);
  }

  const openIncidentsByPollingUnit = new Map<string, number>();
  for (const item of incidents) {
    if (!item.pollingUnitId) {
      continue;
    }
    openIncidentsByPollingUnit.set(item.pollingUnitId, (openIncidentsByPollingUnit.get(item.pollingUnitId) || 0) + 1);
  }

  const stateTargetMap = new Map<string, {
    stateId: string;
    stateName: string;
    targetAgentsPerPollingUnit: number;
    pollingUnitCount: number;
    assignedAgentCount: number;
    targetAgentCount: number;
    remainingAgentCount: number;
  }>();

  const pollingUnitInsights = pollingUnits.map((unit) => {
    const assignedAgentCount = assignedCountByPollingUnit.get(unit.id) || 0;
    const recentActivityCount = recentActivityByPollingUnit.get(unit.id) || 0;
    const openIncidentCount = openIncidentsByPollingUnit.get(unit.id) || 0;
    const targetAgentsPerPollingUnit = unit.state.agentsPerPollingUnitTarget || 1;
    const targetAgentCount = targetAgentsPerPollingUnit;
    const hasAssignedAgent = assignedAgentCount > 0;
    const hasRecentActivity = recentActivityCount > 0;
    const remainingAgentCount = Math.max(targetAgentCount - assignedAgentCount, 0);

    const stateCurrent = stateTargetMap.get(unit.stateId) || {
      stateId: unit.stateId,
      stateName: unit.state.name,
      targetAgentsPerPollingUnit,
      pollingUnitCount: 0,
      assignedAgentCount: 0,
      targetAgentCount: 0,
      remainingAgentCount: 0,
    };

    stateCurrent.pollingUnitCount += 1;
    stateCurrent.assignedAgentCount += assignedAgentCount;
    stateCurrent.targetAgentCount += targetAgentCount;
    stateCurrent.remainingAgentCount += remainingAgentCount;
    stateTargetMap.set(unit.stateId, stateCurrent);

    return {
      pollingUnitId: unit.id,
      pollingUnitName: unit.name,
      stateId: unit.stateId,
      stateName: unit.state.name,
      wardId: unit.wardId,
      wardName: unit.ward.name,
      lgaId: unit.lgaId,
      lgaName: unit.lga.name,
      assignedAgentCount,
      targetAgentCount,
      remainingAgentCount,
      recentActivityCount,
      openIncidentCount,
      hasAssignedAgent,
      hasRecentActivity,
      requiresAttention: assignedAgentCount < targetAgentCount || !hasRecentActivity || openIncidentCount > 0,
    };
  });

  const wardMap = new Map<string, {
    wardId: string;
    wardName: string;
    lgaId: string;
    lgaName: string;
    pollingUnitCount: number;
    assignedAgentCount: number;
    targetAgentCount: number;
    remainingAgentCount: number;
    pollingUnitsWithoutAgents: number;
    pollingUnitsWithoutRecentActivity: number;
    openIncidentCount: number;
  }>();

  for (const item of pollingUnitInsights) {
    const current = wardMap.get(item.wardId) || {
      wardId: item.wardId,
      wardName: item.wardName,
      lgaId: item.lgaId,
      lgaName: item.lgaName,
      pollingUnitCount: 0,
      assignedAgentCount: 0,
      targetAgentCount: 0,
      remainingAgentCount: 0,
      pollingUnitsWithoutAgents: 0,
      pollingUnitsWithoutRecentActivity: 0,
      openIncidentCount: 0,
    };

    current.pollingUnitCount += 1;
    current.assignedAgentCount += item.assignedAgentCount;
    current.targetAgentCount += item.targetAgentCount;
    current.remainingAgentCount += item.remainingAgentCount;
    if (!item.hasAssignedAgent) {
      current.pollingUnitsWithoutAgents += 1;
    }
    if (!item.hasRecentActivity) {
      current.pollingUnitsWithoutRecentActivity += 1;
    }
    current.openIncidentCount += item.openIncidentCount;
    wardMap.set(item.wardId, current);
  }

  const weakCoveragePollingUnits = pollingUnitInsights.filter((item) => item.requiresAttention).length;
  const pollingUnitsWithoutAssignedAgents = pollingUnitInsights.filter((item) => !item.hasAssignedAgent).length;
  const assignedAgentsInScope = pollingUnitInsights.reduce((sum, item) => sum + item.assignedAgentCount, 0);
  const targetAgentsInScope = pollingUnitInsights.reduce((sum, item) => sum + item.targetAgentCount, 0);
  const remainingAgentsToTarget = Math.max(targetAgentsInScope - assignedAgentsInScope, 0);
  const wards = Array.from(wardMap.values()).sort((left, right) => {
    const leftRisk = left.pollingUnitsWithoutRecentActivity + left.pollingUnitsWithoutAgents + left.openIncidentCount;
    const rightRisk = right.pollingUnitsWithoutRecentActivity + right.pollingUnitsWithoutAgents + right.openIncidentCount;
    return rightRisk - leftRisk;
  });
  const stateTargets = Array.from(stateTargetMap.values()).sort((left, right) => left.stateName.localeCompare(right.stateName));

    return response.json({
      insights: serializeCoverageInsights({
        summary: {
          totalStatesInScope: loadedStates,
          totalLgasInScope: authoritativeLgasInScope,
          totalWardsInScope: loadedWards,
          totalPollingUnitsInScope: pollingUnits.length,
        pollingUnitsWithAssignedAgents: pollingUnitInsights.filter((item) => item.hasAssignedAgent).length,
        pollingUnitsWithRecentActivity: pollingUnitInsights.filter((item) => item.hasRecentActivity).length,
        pollingUnitsWithIncidents: pollingUnitInsights.filter((item) => item.openIncidentCount > 0).length,
        pollingUnitsWithoutActivity: pollingUnitInsights.filter((item) => !item.hasRecentActivity).length,
        wardsInScope: wards.length,
        weakCoveragePollingUnits,
        pollingUnitsWithoutAssignedAgents,
        agentsWithoutPollingUnitAssignments: agentsWithoutPollingUnitAssignments.length,
        assignedAgentsInScope,
        targetAgentsInScope,
        remainingAgentsToTarget,
        scopeWarning,
      },
        scopeWarning,
        referenceData: {
          loadedStates,
          loadedLgas: realLgasInScope.length,
          loadedWards,
          loadedPollingUnits: pollingUnits.length,
          loadedWardsWithoutPollingUnits,
          authoritativeStates: statesInScope.length,
          authoritativeLgas: authoritativeLgasInScope,
          syntheticBootstrapLgas: syntheticBootstrapLgaCount,
          wardAndPollingUnitInventoryComplete,
          inventoryWarning,
        },
      stateTargets,
      wards,
      pollingUnits: pollingUnitInsights.sort((left, right) => {
        const leftRisk = Number(left.requiresAttention) * 10 + left.openIncidentCount;
        const rightRisk = Number(right.requiresAttention) * 10 + right.openIncidentCount;
        return rightRisk - leftRisk;
      }),
      agentsWithoutPollingUnitAssignments: agentsWithoutPollingUnitAssignments
        .filter((item) => item.agentProfile)
        .map((item) => ({
          userId: item.id,
          name: item.name,
          email: item.email,
          politicalPartyId: item.agentProfile!.politicalPartyId || null,
          territory: serializeTerritory(item.agentProfile!),
        })),
    }),
  });
});

router.get("/recent-changes", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = recentChangesQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid recent changes query.", errors: parsed.error.flatten() });
  }

  const since = new Date(parsed.data.since);
  const [newIncidents, newAgentActivities, updatedIncidentStatuses] = await Promise.all([
    prisma.incident.findMany({
      where: {
        ...getIncidentScopeFilter(request.authUser),
        ...getAdminPartyScopedIncidentWhere(request.authUser),
        createdAt: { gt: since },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.agentActivity.findMany({
      where: {
        ...toScopeFilter(getAgentActivityScopeFilter(request.authUser)),
        agentUser: getAdminPartyScopedAgentRelationFilter(request.authUser),
        createdAt: { gt: since },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.incident.findMany({
      where: {
        ...getIncidentScopeFilter(request.authUser),
        ...getAdminPartyScopedIncidentWhere(request.authUser),
        updatedAt: { gt: since },
        NOT: { createdAt: { gt: since } },
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
  ]);

  return response.json({
    newIncidents: newIncidents.map(serializeIncidentItem),
    newAgentActivities,
    updatedIncidentStatuses: updatedIncidentStatuses.map(serializeIncidentItem),
  });
});

router.get("/analytics", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = analyticsQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid analytics query.", errors: parsed.error.flatten() });
  }

  const dateRange = getDateRange(parsed.data);
  const [incidents, agentActivities, rewards, polls, voterRegistrations] = await Promise.all([
    prisma.incident.findMany({
      where: {
        ...getIncidentScopeFilter(request.authUser),
        ...getAdminPartyScopedIncidentWhere(request.authUser),
        createdAt: dateRange,
      },
      select: { type: true, severity: true, status: true },
    }),
    prisma.agentActivity.findMany({
      where: {
        ...toScopeFilter(getAgentActivityScopeFilter(request.authUser)),
        agentUser: getAdminPartyScopedAgentRelationFilter(request.authUser),
        createdAt: dateRange,
      },
      select: { type: true },
    }),
    prisma.rewardLedger.findMany({
      where: {
        voterUser: {
          is: {
            voterProfile: {
              is: getVoterScopeFilter(request.authUser),
            },
          },
        },
        createdAt: dateRange,
      },
      select: { type: true, points: true },
    }),
    prisma.poll.findMany({
      where: {
        ...getPollScopeFilter(request.authUser),
        createdAt: dateRange,
      },
      include: {
        _count: {
          select: { responses: true },
        },
      },
    }),
    prisma.user.findMany({
      where: {
        role: UserRole.VOTER,
        voterProfile: {
          is: getVoterScopeFilter(request.authUser),
        },
        createdAt: dateRange,
      },
      select: { createdAt: true },
    }),
  ]);

  return response.json({
    analytics: {
      incidentCountsByType: incidents.reduce<Record<string, number>>((acc, item) => {
        acc[item.type] = (acc[item.type] || 0) + 1;
        return acc;
      }, {}),
      incidentCountsBySeverity: incidents.reduce<Record<string, number>>((acc, item) => {
        acc[item.severity] = (acc[item.severity] || 0) + 1;
        return acc;
      }, {}),
      incidentCountsByStatus: incidents.reduce<Record<string, number>>((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, {}),
      agentActivitiesByType: agentActivities.reduce<Record<string, number>>((acc, item) => {
        acc[item.type] = (acc[item.type] || 0) + 1;
        return acc;
      }, {}),
      rewardTotalsByType: rewards.reduce<Record<string, number>>((acc, item) => {
        acc[item.type] = (acc[item.type] || 0) + item.points;
        return acc;
      }, {}),
      pollResponseTotalsByPoll: polls.map((poll) => ({
        pollId: poll.id,
        title: poll.title,
        responses: poll._count.responses,
      })),
      voterRegistrationsOverTime: voterRegistrations.reduce<Record<string, number>>((acc, item) => {
        const day = item.createdAt.toISOString().slice(0, 10);
        acc[day] = (acc[day] || 0) + 1;
        return acc;
      }, {}),
    },
  });
});

router.get("/audit-logs", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const parsed = auditLogQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid audit log query.", errors: parsed.error.flatten() });
  }

  const logs = await prisma.auditLog.findMany({
    where: {
      actorUserId: parsed.data.actorUserId,
      action: parsed.data.action,
      targetType: parsed.data.targetType,
      createdAt: getDateRange(parsed.data),
    },
    include: {
      actorUser: {
        select: { name: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const visibleLogs = [];
  for (const log of logs) {
    if (!request.authUser || !(await canViewAuditLog(request.authUser, log))) {
      continue;
    }

    visibleLogs.push(log);
  }

  return response.json({
    auditLogs: visibleLogs.map(serializeAuditLogItem),
  });
});

router.get("/summary", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"), async (request, response) => {
  const actor = request.authUser;
  const voterScopeFilter = getVoterScopeFilter(actor);
  const agentScopeFilter = getAgentScopeFilter(actor);
  const partyScopedAgentProfileFilter = getAdminPartyScopedAgentProfileFilter(actor);
  const feedbackScopeFilter = getFeedbackScopeFilter(actor);
  const partyScopedFeedbackFilter = getAdminPartyScopedFeedbackWhere(actor);
  const pollScopeFilter = getPollScopeFilter(actor);
  const incidentScopeFilter = getIncidentScopeFilter(actor);
  const todayStart = getTodayStart();

  const [
    totalVotersInScope,
    totalAgentsInScope,
    totalFeedbackItemsInScope,
    totalActivePollsInScope,
    totalAgentCheckInsToday,
    activeAgentRows,
    totalIncidentsOpen,
    totalIncidentsCritical,
    totalPollResponsesInScope,
    totalVoterFeedbackItemsInScope,
    candidates,
  ] =
    await Promise.all([
      prisma.voterProfile.count({ where: voterScopeFilter }),
      prisma.agentProfile.count({ where: { ...agentScopeFilter, ...partyScopedAgentProfileFilter } }),
      prisma.feedback.count({ where: { ...feedbackScopeFilter, ...partyScopedFeedbackFilter } }),
      prisma.poll.count({ where: { ...pollScopeFilter, isActive: true } }),
      prisma.agentActivity.count({
        where: {
          ...toScopeFilter(getAgentActivityScopeFilter(actor)),
          agentUser: getAdminPartyScopedAgentRelationFilter(actor),
          type: AgentActivityType.CHECK_IN,
          createdAt: { gte: todayStart },
        },
      }),
      prisma.agentActivity.findMany({
        where: {
          ...toScopeFilter(getAgentActivityScopeFilter(actor)),
          agentUser: getAdminPartyScopedAgentRelationFilter(actor),
          createdAt: { gte: todayStart },
        },
        select: { agentUserId: true },
        distinct: ["agentUserId"],
      }),
      prisma.incident.count({
        where: {
          ...incidentScopeFilter,
          ...getAdminPartyScopedIncidentWhere(actor),
          status: IncidentStatus.OPEN,
        },
      }),
      prisma.incident.count({
        where: {
          ...incidentScopeFilter,
          ...getAdminPartyScopedIncidentWhere(actor),
          severity: IncidentSeverity.CRITICAL,
        },
      }),
      prisma.pollResponse.count({
        where: {
          poll: {
            is: pollScopeFilter,
          },
        },
      }),
      prisma.feedback.count({
        where: {
          ...feedbackScopeFilter,
          voterUserId: { not: null },
        },
      }),
      prisma.user.findMany({
        where: { role: UserRole.CANDIDATE },
        include: {
          candidateProfile: true,
          assignedAdminLinks: actor
            ? {
                where: { adminUserId: actor.id },
                select: { permissionType: true },
              }
            : false,
        },
      }),
    ]);

  const totalCandidatesVisibleInScope = candidates.filter((candidate) => {
    if (!candidate.candidateProfile || !actor) {
      return false;
    }

    return (
      canViewCandidate(actor, { ...candidate.candidateProfile, userId: candidate.id }) ||
      candidate.assignedAdminLinks.length > 0
    );
  }).length;

  return response.json({
    summary: serializeAdminSummary({
      totalVotersInScope,
      totalAgentsInScope,
      totalFeedbackItemsInScope,
      totalActivePollsInScope,
      totalCandidatesVisibleInScope,
      totalAgentCheckInsToday,
      totalActiveAgentsToday: activeAgentRows.length,
      totalIncidentsOpen,
      totalIncidentsCritical,
      totalPollResponsesInScope,
      totalVoterFeedbackItemsInScope,
    }),
  });
});

export default router;
