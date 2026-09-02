import { Router } from "express";
import { FieldTaskStatus, Prisma, VoterVerificationStatus } from "@prisma/client";
import {
  DASHBOARD_CHILD_LEVEL,
  DASHBOARD_LEVELS,
  DASHBOARD_LEVEL_PRESENTATION,
  LEADERBOARD_METRICS,
  OGUN_STATE_ID,
  strengthBandFor,
  type AuthUserProfile,
  type DashboardChildRow,
  type DashboardLeaderboardEntry,
  type DashboardLevel,
  type DashboardMetricTile,
  type HierarchicalDashboard,
  type LeaderboardMetric,
  type OperationalTerritory,
} from "@pics-nigeria/shared";
import { z } from "zod";
import { authorizeAction, resolveOperationalTerritory } from "../authorization";
import {
  buildOperationalPollingUnitTerritoryWhere,
  buildOperationalVoterProfileTerritoryWhere,
  selectCurrentMemberTerritorySnapshots,
  SNAPSHOT_COMPATIBILITY_SCAN_LIMIT,
} from "../lib/member-territory-scope";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../prisma";

const router = Router();

const dashboardQuerySchema = z.object({
  level: z.enum(DASHBOARD_LEVELS).optional(),
  territoryId: z.string().trim().optional(),
  leaderboardMetric: z.enum(LEADERBOARD_METRICS).default("VERIFIED_REFERRALS"),
  leaderboardLimit: z.coerce.number().int().min(1).max(50).default(10),
});

/**
 * The territory a dashboard request resolves to when the caller does not name
 * one: the deepest level the actor commands. A Ward Coordinator therefore lands
 * on their Ward, and a State Officer on Ogun State, without either having to
 * know the level names.
 */
function defaultScopeForActor(actor: AuthUserProfile): { level: DashboardLevel; territoryId: string } | null {
  if (actor.role === "SUPER_ADMIN" || actor.role === "STATE_OFFICER") {
    return { level: "STATE", territoryId: OGUN_STATE_ID };
  }

  const profile = actor.coordinatorProfile;
  if (!profile) {
    return null;
  }
  if (profile.pollingUnitId) return { level: "POLLING_UNIT", territoryId: profile.pollingUnitId };
  if (profile.wardId) return { level: "WARD", territoryId: profile.wardId };
  if (profile.stateConstituencyId) return { level: "STATE_CONSTITUENCY", territoryId: profile.stateConstituencyId };
  if (profile.federalConstituencyId) return { level: "FEDERAL_CONSTITUENCY", territoryId: profile.federalConstituencyId };
  if (profile.senatorialDistrictId) return { level: "SENATORIAL_DISTRICT", territoryId: profile.senatorialDistrictId };
  return { level: "STATE", territoryId: profile.stateId || OGUN_STATE_ID };
}

/** Maps a level plus id onto the operational territory used for authorization. */
function territoryFor(level: DashboardLevel, territoryId: string): OperationalTerritory {
  const base: OperationalTerritory = { stateId: OGUN_STATE_ID };
  switch (level) {
    case "STATE":
      return base;
    case "SENATORIAL_DISTRICT":
      return { ...base, senatorialDistrictId: territoryId };
    case "FEDERAL_CONSTITUENCY":
      return { ...base, federalConstituencyId: territoryId };
    case "STATE_CONSTITUENCY":
      return { ...base, stateConstituencyId: territoryId };
    case "WARD":
      return { ...base, wardId: territoryId };
    case "POLLING_UNIT":
      return { ...base, pollingUnitId: territoryId };
  }
}

/**
 * Members are scoped by the one canonical authority, shared with the strength
 * engine so a dashboard tile and the score printed beside it cannot disagree.
 */
function voterWhereFor(level: DashboardLevel, territoryId: string): Prisma.VoterProfileWhereInput {
  return buildOperationalVoterProfileTerritoryWhere(level, territoryId);
}

function coordinatorWhereFor(level: DashboardLevel, territoryId: string): Prisma.CoordinatorProfileWhereInput {
  switch (level) {
    case "STATE":
      return { stateId: territoryId };
    case "SENATORIAL_DISTRICT":
      return { senatorialDistrictId: territoryId };
    case "FEDERAL_CONSTITUENCY":
      return { federalConstituencyId: territoryId };
    case "STATE_CONSTITUENCY":
      return { stateConstituencyId: territoryId };
    case "WARD":
      return { wardId: territoryId };
    case "POLLING_UNIT":
      return { pollingUnitId: territoryId };
  }
}

/**
 * Polling units answer to the same operational predicate as members, so a
 * constituency cannot show polling units it will not place members in.
 */
function pollingUnitWhereFor(level: DashboardLevel, territoryId: string): Prisma.PollingUnitWhereInput {
  return buildOperationalPollingUnitTerritoryWhere(level, territoryId);
}

async function territoryNameFor(level: DashboardLevel, territoryId: string): Promise<string | null> {
  switch (level) {
    case "STATE":
      return (await prisma.state.findUnique({ where: { id: territoryId }, select: { name: true } }))?.name || null;
    case "SENATORIAL_DISTRICT":
      return (await prisma.senatorialDistrict.findUnique({ where: { id: territoryId }, select: { name: true } }))?.name || null;
    case "FEDERAL_CONSTITUENCY":
      return (await prisma.federalConstituency.findUnique({ where: { id: territoryId }, select: { name: true } }))?.name || null;
    case "STATE_CONSTITUENCY":
      return (await prisma.stateConstituency.findUnique({ where: { id: territoryId }, select: { name: true } }))?.name || null;
    case "WARD":
      return (await prisma.ward.findUnique({ where: { id: territoryId }, select: { name: true } }))?.name || null;
    case "POLLING_UNIT":
      return (await prisma.pollingUnit.findUnique({ where: { id: territoryId }, select: { name: true } }))?.name || null;
  }
}

/** Lists the direct children of a territory at the next command level down. */
async function childrenOf(level: DashboardLevel, territoryId: string): Promise<Array<{ id: string; name: string }>> {
  switch (level) {
    case "STATE":
      return prisma.senatorialDistrict.findMany({ where: { stateId: territoryId }, select: { id: true, name: true }, orderBy: { name: "asc" } });
    case "SENATORIAL_DISTRICT":
      return prisma.federalConstituency.findMany({
        where: { senatorialDistrictId: territoryId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      });
    case "FEDERAL_CONSTITUENCY":
      return prisma.stateConstituency.findMany({
        where: { federalConstituencyId: territoryId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      });
    case "STATE_CONSTITUENCY":
      return prisma.ward.findMany({ where: { stateConstituencyId: territoryId }, select: { id: true, name: true }, orderBy: { name: "asc" } });
    case "WARD":
      return prisma.pollingUnit.findMany({ where: { wardId: territoryId }, select: { id: true, name: true }, orderBy: { name: "asc" } });
    case "POLLING_UNIT":
      return [];
  }
}

/**
 * Builds the ancestry trail so an officer can navigate back up the hierarchy.
 * Fails soft: a missing ancestor yields a shorter breadcrumb rather than an
 * error, because incomplete reference data must not break the dashboard.
 */
async function breadcrumbFor(level: DashboardLevel, territoryId: string) {
  const trail: Array<{ level: DashboardLevel; territoryId: string; name: string }> = [];
  const stateName = (await prisma.state.findUnique({ where: { id: OGUN_STATE_ID }, select: { name: true } }))?.name || "Ogun State";
  trail.push({ level: "STATE", territoryId: OGUN_STATE_ID, name: stateName });

  if (level === "STATE") {
    return trail;
  }

  const pollingUnit =
    level === "POLLING_UNIT"
      ? await prisma.pollingUnit.findUnique({
          where: { id: territoryId },
          include: { ward: { include: { stateConstituency: { include: { federalConstituency: true } } } } },
        })
      : null;
  const ward =
    level === "WARD"
      ? await prisma.ward.findUnique({ where: { id: territoryId }, include: { stateConstituency: { include: { federalConstituency: true } } } })
      : pollingUnit?.ward || null;
  const stateConstituency =
    level === "STATE_CONSTITUENCY"
      ? await prisma.stateConstituency.findUnique({ where: { id: territoryId }, include: { federalConstituency: true } })
      : ward?.stateConstituency || null;
  const federalConstituency =
    level === "FEDERAL_CONSTITUENCY"
      ? await prisma.federalConstituency.findUnique({ where: { id: territoryId } })
      : stateConstituency?.federalConstituency || null;
  const senatorialDistrictId =
    level === "SENATORIAL_DISTRICT" ? territoryId : federalConstituency?.senatorialDistrictId || null;

  if (senatorialDistrictId) {
    const district = await prisma.senatorialDistrict.findUnique({ where: { id: senatorialDistrictId }, select: { name: true } });
    if (district) {
      trail.push({ level: "SENATORIAL_DISTRICT", territoryId: senatorialDistrictId, name: district.name });
    }
  }
  if (federalConstituency) {
    trail.push({ level: "FEDERAL_CONSTITUENCY", territoryId: federalConstituency.id, name: federalConstituency.name });
  }
  if (stateConstituency) {
    trail.push({ level: "STATE_CONSTITUENCY", territoryId: stateConstituency.id, name: stateConstituency.name });
  }
  if (ward) {
    trail.push({ level: "WARD", territoryId: ward.id, name: ward.name });
  }
  if (pollingUnit) {
    trail.push({ level: "POLLING_UNIT", territoryId: pollingUnit.id, name: pollingUnit.name });
  }

  // Drop anything below the requested level so the trail ends at the current view.
  const currentIndex = trail.findIndex((entry) => entry.level === level && entry.territoryId === territoryId);
  return currentIndex >= 0 ? trail.slice(0, currentIndex + 1) : trail;
}

type LevelCounts = {
  registeredMembers: number;
  verifiedMembers: number;
  pendingVerifications: number;
  coordinators: number;
  pollingUnits: number;
  activePollingUnits: number;
};

async function countsFor(level: DashboardLevel, territoryId: string): Promise<LevelCounts> {
  const voterWhere = voterWhereFor(level, territoryId);
  const puWhere = pollingUnitWhereFor(level, territoryId);

  const [registeredMembers, verifiedMembers, pendingVerifications, coordinators, pollingUnits, activePollingUnits] = await Promise.all([
    prisma.voterProfile.count({ where: voterWhere }),
    prisma.voterVerification.count({
      where: { status: VoterVerificationStatus.VERIFIED, memberUser: { voterProfile: { is: voterWhere } } },
    }),
    prisma.voterVerification.count({
      where: { status: VoterVerificationStatus.PENDING, memberUser: { voterProfile: { is: voterWhere } } },
    }),
    prisma.coordinatorProfile.count({
      where: { ...coordinatorWhereFor(level, territoryId), user: { isActive: true, accountStatus: "ACTIVE" } },
    }),
    prisma.pollingUnit.count({ where: puWhere }),
    prisma.pollingUnit.count({ where: { ...puWhere, agentProfiles: { some: { user: { isActive: true, accountStatus: "ACTIVE" } } } } }),
  ]);

  return { registeredMembers, verifiedMembers, pendingVerifications, coordinators, pollingUnits, activePollingUnits };
}

/**
 * Strength score on a 0-100 scale.
 *
 * Prefers the configured snapshot engine when a snapshot exists for this
 * territory, so the dashboard and the strength module never disagree. Falls back
 * to a transparent composite of verification rate and Polling Unit coverage,
 * which keeps every level usable before snapshots are calculated.
 */
async function strengthFor(level: DashboardLevel, territoryId: string, counts: LevelCounts) {
  /**
   * Only snapshots calculated under the current member-scope semantics.
   *
   * A snapshot outlives the code that produced it, and this function prefers one
   * over the live count below. A snapshot from before member scope moved onto
   * the ward graph scored territories on nullable ancestry columns — typically
   * zero — and would otherwise keep overriding a correct live count forever,
   * surviving the backfill that fixed the underlying data. Older snapshots are
   * ignored, not rewritten: they record what was calculated at the time.
   */
  const candidateSnapshots = await prisma.territoryStrengthSnapshot.findMany({
    where: { territoryType: level, territoryId },
    orderBy: { calculatedAt: "desc" },
    take: SNAPSHOT_COMPATIBILITY_SCAN_LIMIT,
    select: { score: true, breakdownJson: true },
  });
  const snapshots = selectCurrentMemberTerritorySnapshots(candidateSnapshots, 2);

  if (snapshots.length > 0) {
    const latest = snapshots[0].score.toNumber();
    const score = Math.max(0, Math.min(100, Math.round(latest)));
    const trend =
      snapshots.length < 2
        ? null
        : latest > snapshots[1].score.toNumber()
          ? ("IMPROVING" as const)
          : latest < snapshots[1].score.toNumber()
            ? ("DECLINING" as const)
            : ("STABLE" as const);
    return { score, trend, source: "SNAPSHOT" as const };
  }

  const verificationRate = counts.registeredMembers > 0 ? counts.verifiedMembers / counts.registeredMembers : 0;
  const coverageRate = counts.pollingUnits > 0 ? counts.activePollingUnits / counts.pollingUnits : 0;
  const score = Math.round((verificationRate * 0.6 + coverageRate * 0.4) * 100);
  return { score: Math.max(0, Math.min(100, score)), trend: null, source: "DERIVED" as const };
}

async function tilesFor(level: DashboardLevel, territoryId: string, counts: LevelCounts): Promise<DashboardMetricTile[]> {
  const targets = await prisma.territoryTarget.findMany({
    where: { territoryType: level, territoryId },
    select: { metric: true, targetValue: true },
  });
  const targetByMetric = new Map(targets.map((target) => [target.metric, target.targetValue]));

  const definitions: Array<{ key: string; label: string; value: number }> = [
    { key: "REGISTERED_MEMBERS", label: "Registered members", value: counts.registeredMembers },
    { key: "VERIFIED_MEMBERS", label: "Verified members", value: counts.verifiedMembers },
    { key: "PENDING_VERIFICATIONS", label: "Pending verifications", value: counts.pendingVerifications },
    { key: "COORDINATORS", label: "Active coordinators", value: counts.coordinators },
    { key: "POLLING_UNITS", label: "Polling Units", value: counts.pollingUnits },
    { key: "COVERED_POLLING_UNITS", label: "Covered Polling Units", value: counts.activePollingUnits },
  ];

  return definitions.map((definition) => {
    const target = targetByMetric.get(definition.key) ?? null;
    return {
      ...definition,
      target,
      percentageOfTarget: target && target > 0 ? Math.round((definition.value / target) * 100) : null,
      shortfall: target ? Math.max(0, target - definition.value) : null,
    };
  });
}

/**
 * Ranks coordinators on approved operational metrics only (Feature 078).
 * Nothing here reads vote choice, ballot behaviour, or political preference.
 */
async function leaderboardFor(
  level: DashboardLevel,
  territoryId: string,
  metric: LeaderboardMetric,
  limit: number,
): Promise<DashboardLeaderboardEntry[]> {
  const coordinators = await prisma.coordinatorProfile.findMany({
    where: { ...coordinatorWhereFor(level, territoryId), user: { isActive: true, accountStatus: "ACTIVE" } },
    include: { user: { select: { id: true, name: true } } },
    take: 500,
  });

  if (coordinators.length === 0) {
    return [];
  }

  const userIds = coordinators.map((coordinator) => coordinator.userId);
  const valueByUser = new Map<string, number>();

  if (metric === "VERIFIED_REFERRALS") {
    const groups = await prisma.referral.groupBy({
      by: ["referrerUserId"],
      where: { referrerUserId: { in: userIds }, status: { in: ["QUALIFIED", "REWARD_PROCESSED"] } },
      _count: true,
    });
    for (const group of groups) valueByUser.set(group.referrerUserId, group._count);
  } else if (metric === "REGISTERED_MEMBERS") {
    const groups = await prisma.referral.groupBy({
      by: ["referrerUserId"],
      where: { referrerUserId: { in: userIds } },
      _count: true,
    });
    for (const group of groups) valueByUser.set(group.referrerUserId, group._count);
  } else if (metric === "TASK_COMPLETION") {
    const groups = await prisma.fieldTask.groupBy({
      by: ["assignedToUserId"],
      where: { assignedToUserId: { in: userIds }, status: FieldTaskStatus.DONE },
      _count: true,
    });
    for (const group of groups) {
      if (group.assignedToUserId) valueByUser.set(group.assignedToUserId, group._count);
    }
  } else if (metric === "FIELD_ACTIVITY") {
    const groups = await prisma.agentActivity.groupBy({
      by: ["agentUserId"],
      where: { agentUserId: { in: userIds } },
      _count: true,
    });
    for (const group of groups) valueByUser.set(group.agentUserId, group._count);
  } else {
    // COVERAGE and READINESS are Polling-Unit shaped: a coordinator scores on
    // whether their assigned Polling Unit is staffed and has checked in.
    const checkedIn = await prisma.agentActivity.groupBy({
      by: ["agentUserId"],
      where: { agentUserId: { in: userIds }, type: metric === "READINESS" ? "CHECK_IN" : undefined },
      _count: true,
    });
    for (const group of checkedIn) valueByUser.set(group.agentUserId, group._count);
  }

  return coordinators
    .map((coordinator) => ({
      coordinatorUserId: coordinator.userId,
      name: coordinator.user.name,
      coordinatorLevel: coordinator.level,
      territoryId:
        coordinator.pollingUnitId || coordinator.wardId || coordinator.stateConstituencyId || coordinator.federalConstituencyId || null,
      territoryName: null,
      metric,
      value: valueByUser.get(coordinator.userId) || 0,
    }))
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name))
    .slice(0, limit)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

router.get("/", requireAuth, async (request, response) => {
  const parsed = dashboardQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid dashboard query.", errors: parsed.error.flatten() });
  }

  const fallback = defaultScopeForActor(request.authUser!);
  const level = parsed.data.level || fallback?.level || null;
  const territoryId = parsed.data.territoryId || (parsed.data.level ? null : fallback?.territoryId) || null;

  if (!level || !territoryId) {
    return response.status(403).json({ message: "A command dashboard scope is required." });
  }

  // Authorization is applied once, here, for every level. A caller may only view
  // a territory they command, so drilling down cannot cross into a sibling.
  const territory = territoryFor(level, territoryId);
  const resolved = await resolveOperationalTerritory(prisma, territory);
  if (!authorizeAction(request.authUser!, "VIEW_TERRITORY", resolved)) {
    return response.status(403).json({ message: "You cannot view this territory's dashboard." });
  }

  const territoryName = await territoryNameFor(level, territoryId);
  if (!territoryName) {
    return response.status(404).json({ message: "Territory was not found." });
  }

  const counts = await countsFor(level, territoryId);
  const [strength, tiles, breadcrumb, childRecords] = await Promise.all([
    strengthFor(level, territoryId, counts),
    tilesFor(level, territoryId, counts),
    breadcrumbFor(level, territoryId),
    childrenOf(level, territoryId),
  ]);

  const childLevel = DASHBOARD_CHILD_LEVEL[level];
  const children: DashboardChildRow[] = [];
  for (const child of childRecords.slice(0, 200)) {
    const childCounts = await countsFor(childLevel!, child.id);
    const childStrength = await strengthFor(childLevel!, child.id, childCounts);
    children.push({
      territoryId: child.id,
      name: child.name,
      level: childLevel!,
      strengthScore: childStrength.score,
      band: strengthBandFor(childStrength.score),
      registeredMembers: childCounts.registeredMembers,
      verifiedMembers: childCounts.verifiedMembers,
      coordinators: childCounts.coordinators,
      pollingUnits: childCounts.pollingUnits,
      trend: childStrength.trend,
    });
  }

  let pollingUnitDetail: HierarchicalDashboard["pollingUnitDetail"] = null;
  if (level === "POLLING_UNIT") {
    const [activity, incidentCount, reportCount, evidenceCount, coordinator] = await Promise.all([
      prisma.agentActivity.findFirst({
        where: { pollingUnitId: territoryId, type: "CHECK_IN" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      prisma.incident.count({ where: { pollingUnitId: territoryId } }),
      prisma.electionDayReport.count({ where: { pollingUnitId: territoryId } }),
      prisma.evidenceAsset.count({ where: { pollingUnitId: territoryId } }),
      prisma.coordinatorProfile.findFirst({
        where: { pollingUnitId: territoryId, user: { isActive: true, accountStatus: "ACTIVE" } },
        include: { user: { select: { name: true } } },
      }),
    ]);
    pollingUnitDetail = {
      operationalStatus: activity ? "CHECKED_IN" : "NOT_CHECKED_IN",
      checkedInAt: activity?.createdAt.toISOString() || null,
      coordinatorName: coordinator?.user.name || null,
      incidentCount,
      reportCount,
      evidenceCount,
    };
  }

  const dashboard: HierarchicalDashboard = {
    level,
    territoryId,
    territoryName,
    presentation: DASHBOARD_LEVEL_PRESENTATION[level],
    breadcrumb,
    strengthScore: strength.score,
    band: strengthBandFor(strength.score),
    trend: strength.trend,
    tiles,
    childLevel,
    children,
    leaderboard: await leaderboardFor(level, territoryId, parsed.data.leaderboardMetric, parsed.data.leaderboardLimit),
    pollingUnitDetail,
    territory,
    generatedAt: new Date().toISOString(),
    // A non-terminal level with no children means the approved Ogun reference
    // release for that level has not been imported. Reported explicitly so the
    // UI shows a data gap instead of implying the hierarchy is genuinely empty.
    referenceDataIncomplete: childLevel !== null && childRecords.length === 0,
  };

  return response.json({ dashboard });
});

export default router;
