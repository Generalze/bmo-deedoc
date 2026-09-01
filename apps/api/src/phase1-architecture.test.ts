import assert from "node:assert/strict";
import http from "node:http";
import type { AuthUserProfile, CoordinatorLevel } from "@pics-nigeria/shared";
import { OGUN_STATE_ID, emptyTerritorySummary } from "@pics-nigeria/shared";
import {
  applyPhase1IdentityMigration,
  planPhase1IdentityMigration,
} from "../../../packages/database/scripts/migrate-phase1-identities";
import {
  authorizeAction,
  canCreateCoordinator,
  canManageTargetUser,
  resolveOperationalTerritory,
} from "./authorization";
import { hashPassword } from "./auth/password";
import { createApp } from "./app";
import { prisma } from "./prisma";

type ApiResult = { status: number; payload: Record<string, unknown> };
type Branch = {
  senatorialDistrictId: string;
  federalConstituencyId: string;
  stateConstituencyId: string;
  wardId: string;
  pollingUnitId: string;
};

const password = "Phase1Test123!";
/** A real Ogun LGA, resolved at setup. LGA is reference data, not a command level. */
let lgaId = "";
const createdCandidateIds = new Set<string>();
let branches: Branch[] = [];
let baseUrl = "";
let server: http.Server | null = null;
let stateOfficerEmail = "";
let superAdminEmail = "";
let wardCoordinatorEmail = "";
let memberEmail = "";
let validatorEmail = "";
let suspendedEmail = "";
let legacyAgentEmail = "";
let legacyVoterEmail = "";
let legacyCandidateEmail = "";
let legacyStateAdminEmail = "";
let legacyLgaAdminEmail = "";

async function apiRequest(path: string, options?: { token?: string; method?: string; body?: unknown }): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options?.method || "GET",
    headers: {
      ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
}

async function login(email: string) {
  const result = await apiRequest("/auth/login", { method: "POST", body: { email, password, agentGpsConsent: true } });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal(typeof result.payload.token, "string");
  return result.payload.token as string;
}

function testEmail(label: string) {
  return `phase1-test-${label}@pics.ng`;
}

/**
 * Builds the command branches this suite exercises from the real Ogun reference
 * structure.
 *
 * It used to synthesise 20 LGAs and 26 state constituencies, because the count
 * gate demands exactly those numbers and no authoritative Ogun dataset existed.
 * Now one does, and inventing a parallel structure alongside it simply doubles
 * every count and blocks the very hierarchy this suite needs.
 */
async function createCommandHierarchy() {
  const stateConstituencies = await prisma.stateConstituency.findMany({
    where: {
      stateId: OGUN_STATE_ID,
      federalConstituencyId: { not: null },
      wards: { some: { pollingUnits: { some: {} } } },
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      federalConstituency: { select: { id: true, senatorialDistrictId: true } },
      wards: {
        where: { pollingUnits: { some: {} } },
        orderBy: { id: "asc" },
        take: 1,
        select: { id: true, pollingUnits: { orderBy: { id: "asc" }, take: 1, select: { id: true } } },
      },
    },
  });

  assert.ok(
    stateConstituencies.length >= 26,
    `Ogun reference data must be imported before this suite; found ${stateConstituencies.length} usable state constituencies.`,
  );

  branches = stateConstituencies.slice(0, 26).map((stateConstituency) => ({
    senatorialDistrictId: stateConstituency.federalConstituency!.senatorialDistrictId,
    federalConstituencyId: stateConstituency.federalConstituency!.id,
    stateConstituencyId: stateConstituency.id,
    wardId: stateConstituency.wards[0].id,
    pollingUnitId: stateConstituency.wards[0].pollingUnits[0].id,
  }));
}

function coordinatorData(level: CoordinatorLevel, branch: Branch) {
  return {
    level,
    stateId: OGUN_STATE_ID,
    senatorialDistrictId: branch.senatorialDistrictId,
    federalConstituencyId:
      level === "SENATORIAL_DISTRICT" ? null : branch.federalConstituencyId,
    stateConstituencyId:
      level === "SENATORIAL_DISTRICT" || level === "FEDERAL_CONSTITUENCY"
        ? null
        : branch.stateConstituencyId,
    wardId: level === "WARD" || level === "POLLING_UNIT" ? branch.wardId : null,
    pollingUnitId: level === "POLLING_UNIT" ? branch.pollingUnitId : null,
  };
}

async function createTargetUser(
  label: string,
  role: "STATE_OFFICER" | "COORDINATOR" | "VALIDATOR" | "PAYOUT_OFFICER" | "MEMBER",
  options?: { level?: CoordinatorLevel; branch?: Branch; accountStatus?: "ACTIVE" | "INACTIVE" | "SUSPENDED" },
) {
  const email = testEmail(label);
  const passwordHash = await hashPassword(password);
  const branch = options?.branch || branches[0];
  return prisma.user.create({
    data: {
      name: `Phase 1 Test ${label}`,
      email,
      passwordHash,
      role,
      accountStatus: options?.accountStatus || "ACTIVE",
      isActive: options?.accountStatus ? options.accountStatus === "ACTIVE" : true,
      coordinatorProfile:
        role === "COORDINATOR" && options?.level
          ? { create: coordinatorData(options.level, branch) }
          : undefined,
      voterProfile:
        role === "MEMBER"
          ? {
              create: {
                voterCardNumber: `PHASE1-${label.toUpperCase()}`,
                referralCode: `P1${label.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10)}`,
                stateId: OGUN_STATE_ID,
                senatorialDistrictId: branch.senatorialDistrictId,
                federalConstituencyId: branch.federalConstituencyId,
                stateConstituencyId: branch.stateConstituencyId,
                lgaId,
                wardId: branch.wardId,
                pollingUnitId: branch.pollingUnitId,
              },
            }
          : undefined,
    },
  });
}

async function createTargetFixtures() {
  const otherDistrictBranch = branches.find(
    (branch) => branch.senatorialDistrictId !== branches[0].senatorialDistrictId,
  ) || branches[1];
  stateOfficerEmail = (await createTargetUser("state-officer", "STATE_OFFICER")).email;
  superAdminEmail = testEmail("super-admin");
  await prisma.user.create({
    data: {
      name: "Phase 1 Test Super Admin",
      email: superAdminEmail,
      passwordHash: await hashPassword(password),
      role: "SUPER_ADMIN",
    },
  });
  await createTargetUser("senatorial", "COORDINATOR", { level: "SENATORIAL_DISTRICT", branch: branches[0] });
  await createTargetUser("federal", "COORDINATOR", { level: "FEDERAL_CONSTITUENCY", branch: branches[0] });
  await createTargetUser("state-constituency", "COORDINATOR", { level: "STATE_CONSTITUENCY", branch: branches[0] });
  wardCoordinatorEmail = (await createTargetUser("ward", "COORDINATOR", { level: "WARD", branch: branches[0] })).email;
  await createTargetUser("polling-unit", "COORDINATOR", { level: "POLLING_UNIT", branch: branches[0] });
  await createTargetUser("peer-ward", "COORDINATOR", { level: "WARD", branch: otherDistrictBranch });
  validatorEmail = (await createTargetUser("validator", "VALIDATOR")).email;
  await createTargetUser("payout", "PAYOUT_OFFICER");
  memberEmail = (await createTargetUser("member", "MEMBER", { branch: branches[0] })).email;
  suspendedEmail = (await createTargetUser("suspended", "VALIDATOR", { accountStatus: "SUSPENDED" })).email;
}

async function createLegacyFixtures() {
  const passwordHash = await hashPassword(password);
  const superAdmin = await prisma.user.findFirstOrThrow({ where: { role: "SUPER_ADMIN" }, select: { id: true } });
  const branch = branches[0];

  legacyAgentEmail = testEmail("legacy-agent");
  const agent = await prisma.user.create({
    data: {
      name: "Phase 1 Test Legacy Agent",
      email: legacyAgentEmail,
      passwordHash,
      role: "AGENT",
      agentProfile: {
        create: {
          stateId: OGUN_STATE_ID,
          senatorialDistrictId: branch.senatorialDistrictId,
          federalConstituencyId: branch.federalConstituencyId,
          stateConstituencyId: branch.stateConstituencyId,
          lgaId,
          wardId: branch.wardId,
          pollingUnitId: branch.pollingUnitId,
          gpsTrackingConsentAt: new Date(),
          activeSessionNonce: "phase1-preserved-session-nonce",
        },
      },
    },
  });
  await prisma.agentActivity.create({
    data: {
      agentUserId: agent.id,
      type: "CHECK_IN",
      stateId: OGUN_STATE_ID,
      lgaId,
      wardId: branch.wardId,
      pollingUnitId: branch.pollingUnitId,
    },
  });
  const incident = await prisma.incident.create({
    data: {
      reportedByUserId: agent.id,
      type: "OTHER",
      title: "Phase 1 preservation incident",
      description: "Operational history must remain linked after identity migration.",
      severity: "LOW",
      status: "OPEN",
      stateId: OGUN_STATE_ID,
      senatorialDistrictId: branch.senatorialDistrictId,
      lgaId,
      wardId: branch.wardId,
      pollingUnitId: branch.pollingUnitId,
    },
  });
  await prisma.fieldTask.create({
    data: {
      title: "Phase 1 preservation task",
      description: "Retain assignment history",
      createdByUserId: superAdmin.id,
      assignedToUserId: agent.id,
      incidentId: incident.id,
      stateId: OGUN_STATE_ID,
      senatorialDistrictId: branch.senatorialDistrictId,
      federalConstituencyId: branch.federalConstituencyId,
      stateConstituencyId: branch.stateConstituencyId,
      lgaId,
      wardId: branch.wardId,
      pollingUnitId: branch.pollingUnitId,
    },
  });
  const [arrivalPhoto, postCountingPhoto] = await Promise.all([
    prisma.electionDayReportAsset.create({
      data: {
        ownerUserId: agent.id,
        kind: "ARRIVAL_PHOTO",
        fileName: "phase1-arrival.jpg",
        mimeType: "image/jpeg",
        data: Buffer.from("phase1-arrival"),
        sizeBytes: 14,
      },
    }),
    prisma.electionDayReportAsset.create({
      data: {
        ownerUserId: agent.id,
        kind: "POST_COUNTING_PHOTO",
        fileName: "phase1-post-counting.jpg",
        mimeType: "image/jpeg",
        data: Buffer.from("phase1-post-counting"),
        sizeBytes: 20,
      },
    }),
  ]);
  await prisma.electionDayReport.create({
    data: {
      agentUserId: agent.id,
      reportDate: new Date("2026-08-09T00:00:00.000Z"),
      openingStatus: "OPENED_ON_TIME",
      arrivalConfirmedAt: new Date("2026-08-09T07:00:00.000Z"),
      turnoutObservation: "Phase 1 migration preservation fixture.",
      voteEntriesJson: [],
      arrivalPhotoAssetId: arrivalPhoto.id,
      postCountingPhotoAssetId: postCountingPhoto.id,
      stateId: OGUN_STATE_ID,
      senatorialDistrictId: branch.senatorialDistrictId,
      federalConstituencyId: branch.federalConstituencyId,
      stateConstituencyId: branch.stateConstituencyId,
      lgaId,
      wardId: branch.wardId,
      pollingUnitId: branch.pollingUnitId,
    },
  });
  await prisma.notification.create({
    data: {
      userId: agent.id,
      type: "SYSTEM",
      title: "Phase 1 preservation notification",
      message: "Notification history must remain linked after identity migration.",
    },
  });
  await prisma.auditLog.create({
    data: {
      actorUserId: agent.id,
      action: "PHASE1_TEST_LEGACY_AGENT_HISTORY",
      targetType: "AgentProfile",
      targetId: agent.id,
    },
  });

  legacyVoterEmail = testEmail("legacy-voter");
  await prisma.user.create({
    data: {
      name: "Phase 1 Test Legacy Voter",
      email: legacyVoterEmail,
      passwordHash,
      role: "VOTER",
      voterProfile: {
        create: {
          voterCardNumber: "PHASE1-LEGACY-VOTER",
          referralCode: "P1LEGACYVOTER",
          stateId: OGUN_STATE_ID,
          senatorialDistrictId: branch.senatorialDistrictId,
          federalConstituencyId: branch.federalConstituencyId,
          stateConstituencyId: branch.stateConstituencyId,
          lgaId,
          wardId: branch.wardId,
          pollingUnitId: branch.pollingUnitId,
        },
      },
    },
  });

  legacyCandidateEmail = testEmail("legacy-candidate");
  const candidateUser = await prisma.user.create({
    data: {
      name: "Phase 1 Test Legacy Candidate",
      email: legacyCandidateEmail,
      passwordHash,
      role: "CANDIDATE",
      candidateProfile: {
        create: {
          officeType: "HOUSE_OF_REP",
          campaignSlogan: "Preserve every relation",
          bio: "Legacy candidate data fixture",
          isProfilePublished: true,
          stateId: OGUN_STATE_ID,
          senatorialDistrictId: branch.senatorialDistrictId,
          federalConstituencyId: branch.federalConstituencyId,
        },
      },
    },
  });
  await prisma.post.create({
    data: {
      authorUserId: candidateUser.id,
      candidateUserId: candidateUser.id,
      title: "Phase 1 legacy post",
      content: "This post must remain attached to the candidate domain.",
      isPublished: true,
      stateId: OGUN_STATE_ID,
      senatorialDistrictId: branch.senatorialDistrictId,
      federalConstituencyId: branch.federalConstituencyId,
    },
  });
  await prisma.campaignEvent.create({
    data: {
      candidateUserId: candidateUser.id,
      createdByUserId: candidateUser.id,
      title: "Phase 1 legacy event",
      description: "This event must remain attached to the candidate domain.",
      venue: "Abeokuta",
      startsAt: new Date(Date.now() + 86_400_000),
      isPublished: true,
      stateId: OGUN_STATE_ID,
      senatorialDistrictId: branch.senatorialDistrictId,
      federalConstituencyId: branch.federalConstituencyId,
    },
  });

  legacyStateAdminEmail = testEmail("legacy-state-admin");
  await prisma.user.create({
    data: {
      name: "Phase 1 Test Legacy State Admin",
      email: legacyStateAdminEmail,
      passwordHash,
      role: "ADMIN",
      adminProfile: { create: { adminLevel: "STATE", stateId: OGUN_STATE_ID } },
    },
  });
  legacyLgaAdminEmail = testEmail("legacy-lga-admin");
  await prisma.user.create({
    data: {
      name: "Phase 1 Test Legacy LGA Admin",
      email: legacyLgaAdminEmail,
      passwordHash,
      role: "ADMIN",
      adminProfile: { create: { adminLevel: "LGA", stateId: OGUN_STATE_ID, lgaId } },
    },
  });
}

function mockActor(
  role: AuthUserProfile["role"],
  options?: { id?: string; level?: CoordinatorLevel; branch?: Branch; status?: "ACTIVE" | "INACTIVE" | "SUSPENDED" },
): AuthUserProfile {
  const branch = options?.branch || branches[0];
  const territory = options?.level ? coordinatorData(options.level, branch) : null;
  return {
    id: options?.id || `actor-${role}-${options?.level || "none"}`,
    name: "Actor",
    email: "actor@example.test",
    phone: null,
    role,
    isActive: options?.status ? options.status === "ACTIVE" : true,
    accountStatus: options?.status || "ACTIVE",
    coordinatorProfile: territory ? { ...emptyTerritorySummary(), ...territory } : null,
    adminProfile: null,
    candidateProfile: null,
    voterProfile: null,
    agentProfile: null,
  };
}

const cases: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "Ogun-only registration is enforced by the server, not by the form",
    run: async () => {
      // Feature 001. The endpoint is public and unauthenticated, so whatever it
      // accepts is reachable regardless of what the picker offers.
      const outsideOgun = await apiRequest("/auth/register-voter", {
        method: "POST",
        body: {
          fullName: "Outside Ogun Applicant",
          email: "phase1-outside-ogun@pics.ng",
          phone: "08039999001",
          password: "OutsideOgun123!",
          voterCardNumber: "PHASE1-OUTSIDE-OGUN",
          stateId: "ng-state-lagos",
          lgaId: "any-lga",
          wardId: "any-ward",
          pollingUnitId: "any-pu",
          acceptTerms: true,
          acceptPrivacy: true,
          contactConsent: true,
          confirmAdult: true,
        },
      });
      assert.equal(outsideOgun.status, 400, JSON.stringify(outsideOgun.payload));
      assert.equal(outsideOgun.payload.code, "OUTSIDE_OGUN_STATE");
      assert.equal(
        await prisma.user.count({ where: { email: "phase1-outside-ogun@pics.ng" } }),
        0,
        "a registration outside Ogun must create no account",
      );
    },
  },
  {
    name: "the public state list offers Ogun only",
    run: async () => {
      const states = await apiRequest("/auth/territories/states");
      assert.equal(states.status, 200, JSON.stringify(states.payload));
      const offered = states.payload.states as Array<{ id: string }>;
      assert.ok(
        offered.every((state) => state.id === OGUN_STATE_ID),
        `the registration picker must not offer a state registration will refuse: ${JSON.stringify(offered)}`,
      );
    },
  },
  {
    name: "NATIONAL, GEO_POLITICAL_ZONE and LGA cannot be assigned as command levels",
    run: async () => {
      // Features 001 and 003. A level above the state does not exist here, and
      // LGA is reference data rather than a rung of authority.
      for (const adminLevel of ["NATIONAL", "GEO_POLITICAL_ZONE", "LGA"]) {
        const created = await apiRequest("/admin/users", {
          method: "POST",
          token: await login(superAdminEmail),
          body: {
            name: `Phase1 ${adminLevel} Admin`,
            email: `phase1-${adminLevel.toLowerCase()}@pics.ng`,
            password: "UnplaceableLevel123!",
            adminLevel,
            stateId: OGUN_STATE_ID,
          },
        });
        assert.equal(created.status, 400, `${adminLevel} must be refused: ${JSON.stringify(created.payload)}`);
        assert.equal(
          await prisma.user.count({ where: { email: `phase1-${adminLevel.toLowerCase()}@pics.ng` } }),
          0,
          `${adminLevel} must create no operator the command model cannot place`,
        );
      }
    },
  },
  {
    name: "RBAC matrix enforces own, subordinate, peer, superior, specialist, and LGA boundaries",
    run: async () => {
      const own = await resolveOperationalTerritory(prisma, { stateId: OGUN_STATE_ID, pollingUnitId: branches[0].pollingUnitId });
      const peer = await resolveOperationalTerritory(prisma, { stateId: OGUN_STATE_ID, pollingUnitId: branches[1].pollingUnitId });
      const ward = mockActor("COORDINATOR", { level: "WARD", branch: branches[0] });
      const pollingUnit = mockActor("COORDINATOR", { level: "POLLING_UNIT", branch: branches[0] });
      const federal = mockActor("COORDINATOR", { level: "FEDERAL_CONSTITUENCY", branch: branches[0] });
      const member = mockActor("MEMBER");

      assert.equal(authorizeAction(mockActor("SUPER_ADMIN"), "MANAGE_USERS", peer), true);
      assert.equal(authorizeAction(mockActor("STATE_OFFICER"), "MANAGE_USERS", peer), true);
      assert.equal(authorizeAction(ward, "VIEW_TERRITORY", own), true);
      assert.equal(authorizeAction(ward, "VIEW_TERRITORY", peer), false);
      assert.equal(authorizeAction(pollingUnit, "VIEW_TERRITORY", own), true);
      assert.equal(authorizeAction(pollingUnit, "VIEW_TERRITORY", { ...own, pollingUnitId: null }), false);
      assert.equal(authorizeAction(federal, "VIEW_TERRITORY", own), true);
      assert.equal(authorizeAction(mockActor("VALIDATOR"), "VIEW_TERRITORY", own), false);
      assert.equal(authorizeAction(mockActor("PAYOUT_OFFICER"), "MANAGE_USERS", own), false);
      assert.equal(authorizeAction(mockActor("MEMBER"), "VIEW_TERRITORY", own), false);
      assert.equal(authorizeAction(mockActor("COORDINATOR", { level: "WARD", status: "INACTIVE" }), "VIEW_TERRITORY", own), false);
      assert.equal(authorizeAction(mockActor("COORDINATOR", { level: "WARD", status: "SUSPENDED" }), "VIEW_TERRITORY", own), false);
      assert.equal(canManageTargetUser(ward, member, own), true);
      assert.equal(canManageTargetUser(mockActor("STATE_OFFICER"), member, null), false);
      assert.equal(canManageTargetUser(ward, mockActor("COORDINATOR", { id: ward.id, level: "POLLING_UNIT" }), own), false);
      assert.equal(canCreateCoordinator(ward, own, "POLLING_UNIT"), true);
      assert.equal(canCreateCoordinator(ward, peer, "POLLING_UNIT"), false);
      // Both branches share the same LGA; that association grants no access to the peer branch.
      assert.equal(authorizeAction(ward, "MANAGE_USERS", peer), false);
    },
  },
  {
    name: "organization tree rejects incomplete references and returns only coordinator scope",
    run: async () => {
      const stateToken = await login(stateOfficerEmail);
      const orphanWardId = "phase1-test-orphan-ward";
      await prisma.ward.create({
        data: { id: orphanWardId, name: "Phase 1 Orphan Ward", stateId: OGUN_STATE_ID, lgaId },
      });
      const blocked = await apiRequest("/platform/organization-tree", { token: stateToken });
      assert.equal(blocked.status, 409);
      const blockers = blocked.payload.blockers as Array<{ code: string }>;
      assert.ok(blockers.some((item) => item.code === "WARD_WITHOUT_STATE_CONSTITUENCY_PARENT"));
      await prisma.ward.delete({ where: { id: orphanWardId } });

      const complete = await apiRequest("/platform/organization-tree", { token: stateToken });
      assert.equal(complete.status, 200, JSON.stringify(complete.payload));
      const wardToken = await login(wardCoordinatorEmail);
      const scoped = await apiRequest("/platform/organization-tree", { token: wardToken });
      assert.equal(scoped.status, 200);
      const tree = scoped.payload.tree as {
        stateOfficers: unknown[];
        senatorialDistricts: Array<{ federalConstituencies: Array<{ stateConstituencies: Array<{ wards: Array<{ id: string }> }> }> }>;
      };
      assert.equal(tree.stateOfficers.length, 0);
      const visibleWards = tree.senatorialDistricts.flatMap((item) => item.federalConstituencies).flatMap((item) => item.stateConstituencies).flatMap((item) => item.wards);
      assert.deepEqual(visibleWards.map((item) => item.id), [branches[0].wardId]);
    },
  },
  {
    name: "controlled assignment blocks self-change, peer IDOR, and specialist command access",
    run: async () => {
      const wardToken = await login(wardCoordinatorEmail);
      const wardUser = await prisma.user.findUniqueOrThrow({ where: { email: wardCoordinatorEmail }, select: { id: true } });
      const selfChange = await apiRequest(`/platform/coordinators/${wardUser.id}/assignment`, {
        token: wardToken,
        method: "PATCH",
        body: { level: "WARD", territory: { stateId: OGUN_STATE_ID, wardId: branches[1].wardId } },
      });
      assert.equal(selfChange.status, 403);

      const peerCreate = await apiRequest("/platform/coordinators", {
        token: wardToken,
        method: "POST",
        body: {
          name: "Phase 1 Test Forbidden PUC",
          email: testEmail("forbidden-puc"),
          password,
          level: "POLLING_UNIT",
          territory: { stateId: OGUN_STATE_ID, pollingUnitId: branches[1].pollingUnitId },
        },
      });
      assert.equal(peerCreate.status, 403);
      const ownCreate = await apiRequest("/platform/coordinators", {
        token: wardToken,
        method: "POST",
        body: {
          name: "Phase 1 Test Created PUC",
          email: testEmail("created-puc"),
          password,
          level: "POLLING_UNIT",
          territory: { stateId: OGUN_STATE_ID, pollingUnitId: branches[0].pollingUnitId },
        },
      });
      assert.equal(ownCreate.status, 201, JSON.stringify(ownCreate.payload));

      const validatorToken = await login(validatorEmail);
      assert.equal((await apiRequest("/platform/organization-tree", { token: validatorToken })).status, 403);
      assert.equal((await apiRequest("/platform/organization-tree", { token: await login(memberEmail) })).status, 403);
    },
  },
  {
    name: "inactive and suspended status invalidates existing and new protected sessions",
    run: async () => {
      const wardToken = await login(wardCoordinatorEmail);
      const stateToken = await login(stateOfficerEmail);
      const wardUser = await prisma.user.findUniqueOrThrow({ where: { email: wardCoordinatorEmail }, select: { id: true } });
      const suspended = await apiRequest(`/platform/users/${wardUser.id}/status`, {
        token: stateToken,
        method: "PATCH",
        body: { status: "SUSPENDED" },
      });
      assert.equal(suspended.status, 200);
      const existingTokenDenied = await apiRequest("/platform/organization-tree", { token: wardToken });
      assert.equal(existingTokenDenied.status, 403);
      assert.equal(existingTokenDenied.payload.message, "This account has been suspended.");
      const loginDenied = await apiRequest("/auth/login", { method: "POST", body: { email: wardCoordinatorEmail, password } });
      assert.equal(loginDenied.status, 403);
      const restored = await apiRequest(`/platform/users/${wardUser.id}/status`, {
        token: stateToken,
        method: "PATCH",
        body: { status: "ACTIVE" },
      });
      assert.equal(restored.status, 200);
      const suspendedLogin = await apiRequest("/auth/login", { method: "POST", body: { email: suspendedEmail, password } });
      assert.equal(suspendedLogin.status, 403);
    },
  },
  {
    name: "candidate target domain is public data and requires no candidate authentication",
    run: async () => {
      const stateToken = await login(stateOfficerEmail);
      const created = await apiRequest("/platform/candidates", {
        token: stateToken,
        method: "POST",
        body: {
          fullName: "Phase 1 Test Domain Candidate",
          officeType: "GOVERNORSHIP",
          campaignSlogan: "Candidate is domain data",
          isPublished: true,
          territory: { stateId: OGUN_STATE_ID },
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.payload));
      const candidate = created.payload.candidate as { id: string };
      createdCandidateIds.add(candidate.id);
      const publicProfile = await apiRequest(`/platform/candidates/${candidate.id}`);
      assert.equal(publicProfile.status, 200);
      assert.equal((publicProfile.payload.candidate as { fullName: string }).fullName, "Phase 1 Test Domain Candidate");
    },
  },
  {
    name: "identity migration preserves candidate, agent, member, and operational relations and is rerunnable",
    run: async () => {
      const dryRun = await planPhase1IdentityMigration(prisma);
      assert.ok(dryRun.entries.some((item) => item.email === legacyAgentEmail && item.action === "MAP_AGENT_TO_PU_COORDINATOR" && item.status === "READY"));
      assert.ok(dryRun.entries.some((item) => item.email === legacyVoterEmail && item.action === "MAP_VOTER_TO_MEMBER" && item.status === "READY"));
      assert.ok(dryRun.entries.some((item) => item.email === legacyCandidateEmail && item.action === "CREATE_CANDIDATE_DOMAIN" && item.status === "READY"));
      assert.ok(dryRun.entries.some((item) => item.email === legacyLgaAdminEmail && item.status === "BLOCKED" && item.reason?.includes("reference-only")));

      const applied = await applyPhase1IdentityMigration(prisma);
      assert.equal(applied.dryRun, false);
      const agent = await prisma.user.findUniqueOrThrow({ where: { email: legacyAgentEmail }, include: { agentProfile: true, coordinatorProfile: true, agentActivities: true, assignedTasks: true, reportedIncidents: true, electionDayReports: true, electionDayReportAssets: true, notifications: true, auditLogs: true } });
      assert.equal(agent.role, "COORDINATOR");
      assert.equal(agent.coordinatorProfile?.level, "POLLING_UNIT");
      assert.ok(agent.agentProfile);
      assert.ok(agent.agentProfile.gpsTrackingConsentAt);
      assert.equal(agent.agentProfile.activeSessionNonce, "phase1-preserved-session-nonce");
      assert.equal(agent.agentActivities.length, 1);
      assert.equal(agent.assignedTasks.length, 1);
      assert.equal(agent.reportedIncidents.length, 1);
      assert.equal(agent.electionDayReports.length, 1);
      assert.equal(agent.electionDayReportAssets.length, 2);
      assert.equal(agent.notifications.length, 1);
      assert.ok(agent.auditLogs.some((item) => item.action === "PHASE1_TEST_LEGACY_AGENT_HISTORY"));

      const member = await prisma.user.findUniqueOrThrow({ where: { email: legacyVoterEmail }, include: { voterProfile: true } });
      assert.equal(member.role, "MEMBER");
      assert.ok(member.voterProfile);
      const candidateUser = await prisma.user.findUniqueOrThrow({ where: { email: legacyCandidateEmail }, include: { candidateProfile: true, legacyCandidateDomain: true, candidatePosts: true, candidateCampaignEvents: true } });
      assert.equal(candidateUser.role, "CANDIDATE");
      assert.ok(candidateUser.candidateProfile);
      assert.ok(candidateUser.legacyCandidateDomain);
      assert.equal(candidateUser.candidatePosts[0].candidateId, candidateUser.legacyCandidateDomain!.id);
      assert.equal(candidateUser.candidateCampaignEvents[0].candidateId, candidateUser.legacyCandidateDomain!.id);

      assert.equal((await prisma.user.findUniqueOrThrow({ where: { email: legacyStateAdminEmail } })).role, "STATE_OFFICER");
      const lgaAdmin = await prisma.user.findUniqueOrThrow({ where: { email: legacyLgaAdminEmail }, include: { coordinatorProfile: true } });
      assert.equal(lgaAdmin.role, "ADMIN");
      assert.equal(lgaAdmin.coordinatorProfile, null);

      const secondPlan = await planPhase1IdentityMigration(prisma);
      assert.ok(secondPlan.entries.some((item) => item.email === legacyCandidateEmail && item.status === "UNCHANGED"));
      await applyPhase1IdentityMigration(prisma);
      assert.equal(await prisma.candidate.count({ where: { legacyUserId: candidateUser.id } }), 1);

      const migratedAgentToken = await login(legacyAgentEmail);
      assert.equal((await apiRequest("/agent/activities", { token: migratedAgentToken })).status, 200);
      const migratedMemberToken = await login(legacyVoterEmail);
      assert.equal((await apiRequest("/voter/posts", { token: migratedMemberToken })).status, 200);
    },
  },
];

async function setup() {
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Phase 1 test server did not start.");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  const referenceLga = await prisma.lGA.findFirst({ where: { stateId: OGUN_STATE_ID }, orderBy: { id: "asc" } });
  assert.ok(referenceLga, "Ogun LGA reference data must be imported before this suite.");
  lgaId = referenceLga.id;
  await createCommandHierarchy();
  await createTargetFixtures();
  await createLegacyFixtures();
}

async function teardown() {
  await prisma.candidate.deleteMany({ where: { OR: [{ id: { in: Array.from(createdCandidateIds) } }, { fullName: { startsWith: "Phase 1 Test" } }] } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "phase1-test-" } } });
  await prisma.pollingUnit.deleteMany({ where: { id: { startsWith: "phase1-test-" } } });
  await prisma.ward.deleteMany({ where: { id: { startsWith: "phase1-test-" } } });
  await prisma.stateConstituency.deleteMany({ where: { id: { startsWith: "phase1-test-" } } });
  await prisma.lGA.deleteMany({ where: { id: { startsWith: "phase1-test-lga-" } } });

  if (server) {
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  }
  await prisma.$disconnect();
}

export async function runPhase1ArchitectureTests() {
  const failures: string[] = [];
  await setup();
  try {
    for (const testCase of cases) {
      try {
        await testCase.run();
        console.log(`PASS ${testCase.name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${testCase.name}: ${message}`);
        console.error(`FAIL ${testCase.name}: ${message}`);
      }
    }
  } finally {
    await teardown();
  }
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
}
