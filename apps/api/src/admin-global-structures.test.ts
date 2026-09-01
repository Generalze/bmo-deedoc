import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "./app";
import { prisma } from "./prisma";

type Case = {
  name: string;
  run: () => Promise<void>;
};

let baseUrl = "";
let server: http.Server | null = null;
const createdZoneIds = new Set<string>();
const createdPartyIds = new Set<string>();
const createdUserEmails = new Set<string>();

async function login(email: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, agentGpsConsent: true }),
  });

  const payload = (await response.json()) as { token?: string; message?: string };
  assert.equal(response.status, 200, payload.message || "Login failed.");
  assert.ok(payload.token, "Login response did not include a token.");
  return payload.token;
}

async function apiRequest(
  path: string,
  options: {
    method?: string;
    token: string;
    body?: Record<string, unknown>;
  },
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${options.token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = (await response.json()) as Record<string, unknown>;
  return { status: response.status, payload };
}

function readUserId(payload: Record<string, unknown>): string {
  const user = payload.user as { id?: string } | undefined;
  assert.ok(user?.id, "Response payload did not include a user id.");
  return user.id;
}

async function createAdminFixture(token: string, suffix: string) {
  const email = `test-admin-${suffix}@pics.ng`;
  createdUserEmails.add(email);
  const created = await apiRequest("/admin/users", {
    method: "POST",
    token,
    body: {
      name: `Test Admin ${suffix}`,
      email,
      password: "TestAdmin123!",
      adminLevel: "STATE",
      politicalPartyId: "seed-party-independent-alliance",
      stateId: OGUN_FIXTURE.stateId,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  return { email, userId: readUserId(created.payload) };
}

async function createCandidateFixture(token: string, suffix: string) {
  const email = `test-candidate-${suffix}@pics.ng`;
  createdUserEmails.add(email);
  const created = await apiRequest("/admin/candidates", {
    method: "POST",
    token,
    body: {
      name: `Test Candidate ${suffix}`,
      email,
      password: "TestCandidate123!",
      officeType: "GOVERNORSHIP",
      politicalPartyId: "seed-party-independent-alliance",
      stateId: OGUN_FIXTURE.stateId,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  return { email, userId: readUserId(created.payload) };
}

async function createAgentFixture(token: string, suffix: string) {
  const email = `test-agent-${suffix}@pics.ng`;
  createdUserEmails.add(email);
  const created = await apiRequest("/admin/agents", {
    method: "POST",
    token,
    body: {
      name: `Test Agent ${suffix}`,
      email,
      password: "TestAgent123!",
      phone: "08031111111",
      politicalPartyId: "seed-party-independent-alliance",
      stateId: OGUN_FIXTURE.stateId,
      lgaId: OGUN_FIXTURE.lgaId,
      wardId: OGUN_FIXTURE.wardId,
      pollingUnitId: OGUN_FIXTURE.pollingUnitId,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  return { email, userId: readUserId(created.payload) };
}

async function createVoterFixture(suffix: string) {
  const email = `test-voter-${suffix}@pics.ng`;
  createdUserEmails.add(email);
  const response = await fetch(`${baseUrl}/auth/register-voter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fullName: `Test Voter ${suffix}`,
      email,
      phone: "08037778888",
      password: "TestVoter123!",
      voterCardNumber: `VIN-${suffix}`,
      stateId: OGUN_FIXTURE.stateId,
      lgaId: OGUN_FIXTURE.lgaId,
      wardId: OGUN_FIXTURE.wardId,
      pollingUnitId: OGUN_FIXTURE.pollingUnitId,
      acceptTerms: true,
      contactConsent: true,
      confirmAdult: true,
    }),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 201);
  return { email, userId: readUserId(payload) };
}

const cases: Case[] = [
  {
    name: "super admin can update and delete an unused geo-political zone",
    run: async () => {
      const token = await login("superadmin@pics.ng", "ChangeMe123!");
      const zoneId = `test-zone-${Date.now()}`;
      createdZoneIds.add(zoneId);

      const created = await apiRequest("/admin/geo-political-zones", {
        method: "POST",
        token,
        body: { id: zoneId, name: `Test Zone ${zoneId}` },
      });
      assert.equal(created.status, 201);

      const updated = await apiRequest(`/admin/geo-political-zones/${zoneId}`, {
        method: "PATCH",
        token,
        body: { name: `Updated Zone ${zoneId}` },
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.payload.message, "Geo-political zone updated successfully.");

      const deleted = await apiRequest(`/admin/geo-political-zones/${zoneId}`, {
        method: "DELETE",
        token,
      });
      assert.equal(deleted.status, 200);
      assert.equal(deleted.payload.message, "Geo-political zone deleted successfully.");
      createdZoneIds.delete(zoneId);
    },
  },
  {
    name: "geo-political zone delete is blocked when records depend on it",
    run: async () => {
      const token = await login("superadmin@pics.ng", "ChangeMe123!");

      const deleted = await apiRequest("/admin/geo-political-zones/ng-zone-south-west", {
        method: "DELETE",
        token,
      });
      assert.equal(deleted.status, 409);
      assert.equal(deleted.payload.message, "Geo-political zone cannot be deleted because it is in use.");

      const dependencyCounts = deleted.payload.dependencyCounts as Record<string, number>;
      assert.ok(dependencyCounts.states > 0);
    },
  },
  {
    name: "super admin can update and delete an unused political party",
    run: async () => {
      const token = await login("superadmin@pics.ng", "ChangeMe123!");
      const suffix = String(Date.now()).slice(-3);
      const partyId = `test-party-${Date.now()}`;
      createdPartyIds.add(partyId);

      const created = await apiRequest("/admin/political-parties", {
        method: "POST",
        token,
        body: { id: partyId, code: `T${suffix}`, name: `Test Party ${partyId}` },
      });
      assert.equal(created.status, 201);

      const updated = await apiRequest(`/admin/political-parties/${partyId}`, {
        method: "PATCH",
        token,
        body: { code: `U${suffix}`, name: `Updated Party ${partyId}` },
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.payload.message, "Political party updated successfully.");

      const deleted = await apiRequest(`/admin/political-parties/${partyId}`, {
        method: "DELETE",
        token,
      });
      assert.equal(deleted.status, 200);
      assert.equal(deleted.payload.message, "Political party deleted successfully.");
      createdPartyIds.delete(partyId);
    },
  },
  {
    name: "political party delete is blocked when a candidate depends on it",
    run: async () => {
      const token = await login("superadmin@pics.ng", "ChangeMe123!");
      // The dependency used to come from a seeded candidate persona. The test
      // now creates the record it depends on, so it proves the guard rather
      // than proving the seed ran.
      await createCandidateFixture(token, `party-dependency-${Date.now()}`);

      const deleted = await apiRequest("/admin/political-parties/seed-party-independent-alliance", {
        method: "DELETE",
        token,
      });
      assert.equal(deleted.status, 409);
      assert.equal(deleted.payload.message, "Political party cannot be deleted because it is in use.");

      const dependencyCounts = deleted.payload.dependencyCounts as Record<string, number>;
      assert.ok(dependencyCounts.candidateProfiles > 0);
    },
  },
  {
    name: "non-super-admin cannot create, update, or delete global structures",
    run: async () => {
      const token = await login(SUITE_STATE_ADMIN.email, SUITE_STATE_ADMIN.password);
      const zoneId = `forbidden-zone-${Date.now()}`;
      const partyId = `forbidden-party-${Date.now()}`;

      const createZone = await apiRequest("/admin/geo-political-zones", {
        method: "POST",
        token,
        body: { id: zoneId, name: "Forbidden Zone" },
      });
      assert.equal(createZone.status, 403);

      const updateZone = await apiRequest("/admin/geo-political-zones/ng-zone-south-west", {
        method: "PATCH",
        token,
        body: { name: "Should Not Work" },
      });
      assert.equal(updateZone.status, 403);

      const deleteZone = await apiRequest("/admin/geo-political-zones/ng-zone-south-west", {
        method: "DELETE",
        token,
      });
      assert.equal(deleteZone.status, 403);

      const createParty = await apiRequest("/admin/political-parties", {
        method: "POST",
        token,
        body: { id: partyId, code: "FBD", name: "Forbidden Party" },
      });
      assert.equal(createParty.status, 403);

      const updateParty = await apiRequest("/admin/political-parties/seed-party-independent-alliance", {
        method: "PATCH",
        token,
        body: { code: "NOPE", name: "Should Not Work" },
      });
      assert.equal(updateParty.status, 403);

      const deleteParty = await apiRequest("/admin/political-parties/seed-party-independent-alliance", {
        method: "DELETE",
        token,
      });
      assert.equal(deleteParty.status, 403);
    },
  },
  {
    name: "super admin can update admin, candidate, and agent records",
    run: async () => {
      const token = await login("superadmin@pics.ng", "ChangeMe123!");
      const suffix = String(Date.now());
      const admin = await createAdminFixture(token, `${suffix}-admin`);
      const candidate = await createCandidateFixture(token, `${suffix}-candidate`);
      const agent = await createAgentFixture(token, `${suffix}-agent`);

      const updatedAdmin = await apiRequest(`/admin/users/${admin.userId}`, {
        method: "PATCH",
        token,
        body: {
          // WARD, not LGA: the Ogun command structure runs
          // State -> Senatorial -> Federal -> State Constituency -> Ward -> PU,
          // and LGA is reference data for reporting rather than a rung of
          // authority. The endpoint now refuses the levels it cannot place.
          name: "Updated Admin",
          adminLevel: "WARD",
          politicalPartyId: "seed-party-independent-alliance",
          stateId: OGUN_FIXTURE.stateId,
          lgaId: OGUN_FIXTURE.lgaId,
          wardId: OGUN_FIXTURE.wardId,
        },
      });
      assert.equal(updatedAdmin.status, 200, JSON.stringify(updatedAdmin.payload));
      assert.equal(updatedAdmin.payload.message, "Admin updated successfully.");

      const updatedCandidate = await apiRequest(`/admin/candidates/${candidate.userId}`, {
        method: "PATCH",
        token,
        body: {
          name: "Updated Candidate",
          officeType: "HOUSE_OF_REP",
          politicalPartyId: "seed-party-independent-alliance",
          stateId: OGUN_FIXTURE.stateId,
          senatorialDistrictId: OGUN_FIXTURE.senatorialDistrictId,
          federalConstituencyId: OGUN_FIXTURE.federalConstituencyId,
        },
      });
      assert.equal(updatedCandidate.status, 200, JSON.stringify(updatedCandidate.payload));
      assert.equal(updatedCandidate.payload.message, "Candidate updated successfully.");

      const updatedAgent = await apiRequest(`/admin/agents/${agent.userId}`, {
        method: "PATCH",
        token,
        body: {
          name: "Updated Agent",
          phone: "08032223333",
          politicalPartyId: "seed-party-independent-alliance",
          stateId: OGUN_FIXTURE.stateId,
          lgaId: OGUN_FIXTURE.lgaId,
          wardId: OGUN_FIXTURE.wardId,
          pollingUnitId: OGUN_FIXTURE.pollingUnitId,
        },
      });
      assert.equal(updatedAgent.status, 200, JSON.stringify(updatedAgent.payload));
      assert.equal(updatedAgent.payload.message, "Agent updated successfully.");
    },
  },
  {
    name: "state admin can update an agent in scope but cannot update admins or candidates",
    run: async () => {
      const superToken = await login("superadmin@pics.ng", "ChangeMe123!");
      const stateToken = await login(SUITE_STATE_ADMIN.email, SUITE_STATE_ADMIN.password);
      const suffix = String(Date.now());
      const admin = await createAdminFixture(superToken, `${suffix}-admin`);
      const candidate = await createCandidateFixture(superToken, `${suffix}-candidate`);
      const agent = await createAgentFixture(superToken, `${suffix}-agent`);

      const updatedAgent = await apiRequest(`/admin/agents/${agent.userId}`, {
        method: "PATCH",
        token: stateToken,
        body: {
          name: "Scoped Agent Update",
          phone: "08034445555",
          politicalPartyId: "seed-party-independent-alliance",
          stateId: OGUN_FIXTURE.stateId,
          lgaId: OGUN_FIXTURE.lgaId,
          wardId: OGUN_FIXTURE.wardId,
          pollingUnitId: OGUN_FIXTURE.pollingUnitId,
        },
      });
      assert.equal(updatedAgent.status, 200, JSON.stringify(updatedAgent.payload));
      assert.equal(updatedAgent.payload.message, "Agent updated successfully.");

      const deniedAdmin = await apiRequest(`/admin/users/${admin.userId}`, {
        method: "PATCH",
        token: stateToken,
        body: {
          name: "Denied",
          adminLevel: "STATE",
          politicalPartyId: "seed-party-independent-alliance",
          stateId: OGUN_FIXTURE.stateId,
        },
      });
      assert.equal(deniedAdmin.status, 403, JSON.stringify(deniedAdmin.payload));

      const deniedCandidate = await apiRequest(`/admin/candidates/${candidate.userId}`, {
        method: "PATCH",
        token: stateToken,
        body: {
          name: "Denied",
          officeType: "GOVERNORSHIP",
          politicalPartyId: "seed-party-independent-alliance",
          stateId: OGUN_FIXTURE.stateId,
        },
      });
      assert.equal(deniedCandidate.status, 403, JSON.stringify(deniedCandidate.payload));
    },
  },
  {
    name: "super admin can deactivate and reactivate managed users",
    run: async () => {
      const token = await login("superadmin@pics.ng", "ChangeMe123!");
      const suffix = String(Date.now());
      const candidate = await createCandidateFixture(token, `${suffix}-candidate`);

      const deactivated = await apiRequest(`/admin/users/${candidate.userId}/deactivation`, {
        method: "PATCH",
        token,
        body: { isActive: false },
      });
      assert.equal(deactivated.status, 200);
      assert.equal(deactivated.payload.message, "User deactivated successfully.");

      const reactivated = await apiRequest(`/admin/users/${candidate.userId}/deactivation`, {
        method: "PATCH",
        token,
        body: { isActive: true },
      });
      assert.equal(reactivated.status, 200);
      assert.equal(reactivated.payload.message, "User reactivated successfully.");
    },
  },
  {
    name: "deactivated users cannot log in or use existing tokens",
    run: async () => {
      const token = await login("superadmin@pics.ng", "ChangeMe123!");
      const suffix = String(Date.now());
      const agent = await createAgentFixture(token, `${suffix}-agent`);
      const agentToken = await login(agent.email, "TestAgent123!");

      const deactivated = await apiRequest(`/admin/users/${agent.userId}/deactivation`, {
        method: "PATCH",
        token,
        body: { isActive: false },
      });
      assert.equal(deactivated.status, 200);

      const blockedLogin = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: agent.email, password: "TestAgent123!" }),
      });
      const blockedLoginPayload = (await blockedLogin.json()) as { message?: string };
      assert.equal(blockedLogin.status, 403);
      assert.equal(blockedLoginPayload.message, "This account has been deactivated.");

      const blockedMe = await fetch(`${baseUrl}/auth/me`, {
        headers: { Authorization: `Bearer ${agentToken}` },
      });
      const blockedMePayload = (await blockedMe.json()) as { message?: string };
      assert.equal(blockedMe.status, 403);
      assert.equal(blockedMePayload.message, "This account has been deactivated.");

      const reactivated = await apiRequest(`/admin/users/${agent.userId}/deactivation`, {
        method: "PATCH",
        token,
        body: { isActive: true },
      });
      assert.equal(reactivated.status, 200);
    },
  },
  {
    name: "deactivated voters cannot access voter endpoints with existing tokens",
    run: async () => {
      const adminToken = await login("superadmin@pics.ng", "ChangeMe123!");
      const suffix = String(Date.now());
      const voter = await createVoterFixture(`${suffix}-voter`);
      const voterToken = await login(voter.email, "TestVoter123!");

      const deactivated = await apiRequest(`/admin/users/${voter.userId}/deactivation`, {
        method: "PATCH",
        token: adminToken,
        body: { isActive: false },
      });
      assert.equal(deactivated.status, 200);

      const blockedRewards = await fetch(`${baseUrl}/voter/rewards`, {
        headers: { Authorization: `Bearer ${voterToken}` },
      });
      const blockedRewardsPayload = (await blockedRewards.json()) as { message?: string };
      assert.equal(blockedRewards.status, 403);
      assert.equal(blockedRewardsPayload.message, "This account has been deactivated.");

      const reactivated = await apiRequest(`/admin/users/${voter.userId}/deactivation`, {
        method: "PATCH",
        token: adminToken,
        body: { isActive: true },
      });
      assert.equal(reactivated.status, 200);
    },
  },
];

/**
 * Ogun territory for fixtures, resolved from reference data.
 *
 * Creating territory inside Ogun is not an option: its structure is verified
 * (20 LGAs, 26 state constituencies, and so on) and the organization-tree
 * integrity check fails the moment a suite invents an extra one. Earlier this
 * fixture did create its own, which is what pushed the LGA count to 21.
 */
const OGUN_FIXTURE = {
  stateId: "ng-state-ogun",
  senatorialDistrictId: "",
  federalConstituencyId: "",
  stateConstituencyId: "",
  lgaId: "",
  wardId: "",
  pollingUnitId: "",
};

async function resolveOgunFixture() {
  const [district, federal, lga, stateConstituency] = await Promise.all([
    prisma.senatorialDistrict.findFirst({ where: { stateId: OGUN_FIXTURE.stateId }, orderBy: { name: "asc" } }),
    prisma.federalConstituency.findFirst({ where: { stateId: OGUN_FIXTURE.stateId }, orderBy: { name: "asc" } }),
    prisma.lGA.findFirst({ where: { stateId: OGUN_FIXTURE.stateId }, orderBy: { name: "asc" } }),
    prisma.stateConstituency.findFirst({ where: { stateId: OGUN_FIXTURE.stateId }, orderBy: { name: "asc" } }),
  ]);
  if (!district || !federal || !lga || !stateConstituency) {
    throw new Error("Ogun reference data must be loaded before this suite.");
  }
  const ward = await prisma.ward.findFirst({
    where: { stateId: OGUN_FIXTURE.stateId, lgaId: lga.id },
    orderBy: { name: "asc" },
  });
  if (!ward) {
    throw new Error("Ogun wards must be loaded before this suite.");
  }
  const pollingUnit = await prisma.pollingUnit.findFirst({
    where: { stateId: OGUN_FIXTURE.stateId, wardId: ward.id },
    orderBy: { name: "asc" },
  });
  if (!pollingUnit) {
    throw new Error("Ogun polling units must be loaded before this suite.");
  }

  OGUN_FIXTURE.senatorialDistrictId = district.id;
  OGUN_FIXTURE.federalConstituencyId = federal.id;
  OGUN_FIXTURE.lgaId = lga.id;
  OGUN_FIXTURE.stateConstituencyId = stateConstituency.id;
  OGUN_FIXTURE.wardId = ward.id;
  OGUN_FIXTURE.pollingUnitId = pollingUnit.id;
}

const SUITE_STATE_ADMIN = { email: "global-structures-state-admin@pics.ng", password: "StateAdmin123!" };

/**
 * The suite provisions the scoped admin it needs.
 *
 * It used to sign in as a persona the product seed created. Fabricated people
 * with known passwords are not something a seed should manufacture for a real
 * platform, so the fixture moved here — where it is owned, scoped and cleaned up
 * by the suite that actually needs it.
 */
async function createSuiteStateAdmin() {
  const superToken = await login("superadmin@pics.ng", "ChangeMe123!");
  createdUserEmails.add(SUITE_STATE_ADMIN.email);
  const created = await apiRequest("/admin/users", {
    method: "POST",
    token: superToken,
    body: {
      name: "Global Structures State Admin",
      email: SUITE_STATE_ADMIN.email,
      password: SUITE_STATE_ADMIN.password,
      adminLevel: "STATE",
      // Admin and candidate accounts must be linked to a party; the seeded
      // party is reference data rather than a fabricated person, so it stays.
      politicalPartyId: "seed-party-independent-alliance",
      stateId: OGUN_FIXTURE.stateId,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
}

async function setup() {
  await resolveOgunFixture();
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not start.");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
  await createSuiteStateAdmin();
}

async function teardown() {
  if (createdUserEmails.size > 0) {
    await prisma.user.deleteMany({
      where: { email: { in: Array.from(createdUserEmails) } },
    });
  }

  if (createdPartyIds.size > 0) {
    await prisma.politicalParty.deleteMany({
      where: { id: { in: Array.from(createdPartyIds) } },
    });
  }

  if (createdZoneIds.size > 0) {
    await prisma.geoPoliticalZone.deleteMany({
      where: { id: { in: Array.from(createdZoneIds) } },
    });
  }

  await prisma.$disconnect();

  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

export async function runAdminGlobalStructureTests() {
  await setup();
  const failures: string[] = [];

  try {
    for (const testCase of cases) {
      try {
        await testCase.run();
        console.log(`PASS ${testCase.name}`);
      } catch (error) {
        failures.push(`${testCase.name}: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`FAIL ${testCase.name}`);
      }
    }
  } finally {
    await teardown();
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
}
