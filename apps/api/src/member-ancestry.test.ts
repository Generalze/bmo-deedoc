import assert from "node:assert/strict";
import http from "node:http";
import { OGUN_STATE_ID } from "@pics-nigeria/shared";
import { runMemberAncestryBackfill } from "../../../packages/database/scripts/backfill-member-ancestry";
import { hashPassword } from "./auth/password";
import { createApp } from "./app";
import { prisma } from "./prisma";

/**
 * P0 #4. Member constituency ancestry is derived by the server from the ward,
 * or the registration does not happen.
 *
 * Every fixture below is synthetic Ogun territory created by this suite and
 * removed afterwards. No real member data is used.
 */

type ApiResult = { status: number; payload: Record<string, unknown> };

const password = "AncestryTest123!";
const prefix = "ancestry-test";

let baseUrl = "";
let server: http.Server | null = null;
let lgaId = "";

/** A ward whose State Constituency edge came from the source, not inference. */
let sourcedWardId = "";
let sourcedPollingUnitId = "";
let expected = { senatorialDistrictId: "", federalConstituencyId: "", stateConstituencyId: "" };

/** A second sourced ward, used to prove a polling unit cannot cross wards. */
let otherWardId = "";
let otherPollingUnitId = "";

/** Synthetic ward carrying an inferred, unreviewed edge. */
let inferredWardId = "";
let inferredPollingUnitId = "";

/** Synthetic ward with no State Constituency at all. */
let orphanWardId = "";
let orphanPollingUnitId = "";

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

function email(slug: string) {
  return `${prefix}-${slug}@pics.ng`;
}

function registrationBody(slug: string, territory: { lgaId: string; wardId: string; pollingUnitId: string }) {
  return {
    fullName: `Ancestry ${slug}`,
    email: email(slug),
    phone: "08031000001",
    password,
    voterCardNumber: `ANCESTRY-${slug.toUpperCase()}`,
    stateId: OGUN_STATE_ID,
    lgaId: territory.lgaId,
    wardId: territory.wardId,
    pollingUnitId: territory.pollingUnitId,
    acceptTerms: true,
    acceptPrivacy: true,
    contactConsent: true,
    confirmAdult: true,
  };
}

async function setup() {
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Member ancestry test server did not start.");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;

  // Two real, sourced wards with a complete chain and at least one polling unit.
  const sourced = await prisma.ward.findMany({
    where: {
      stateId: OGUN_STATE_ID,
      stateConstituencyEdgeInferred: false,
      stateConstituencyId: { not: null },
      pollingUnits: { some: {} },
      stateConstituency: { is: { federalConstituencyId: { not: null } } },
    },
    orderBy: { id: "asc" },
    take: 2,
    select: {
      id: true,
      lgaId: true,
      pollingUnits: { orderBy: { id: "asc" }, take: 1, select: { id: true } },
      stateConstituency: {
        select: { id: true, federalConstituency: { select: { id: true, senatorialDistrictId: true } } },
      },
    },
  });

  assert.ok(
    sourced.length === 2,
    `Ogun reference data with sourced constituency edges must be imported before this suite; found ${sourced.length}.`,
  );

  sourcedWardId = sourced[0].id;
  sourcedPollingUnitId = sourced[0].pollingUnits[0].id;
  lgaId = sourced[0].lgaId;
  expected = {
    stateConstituencyId: sourced[0].stateConstituency!.id,
    federalConstituencyId: sourced[0].stateConstituency!.federalConstituency!.id,
    senatorialDistrictId: sourced[0].stateConstituency!.federalConstituency!.senatorialDistrictId,
  };
  otherWardId = sourced[1].id;
  otherPollingUnitId = sourced[1].pollingUnits[0].id;

  // A ward whose edge is inferred and unreviewed. Created rather than borrowed
  // from the 55 real ones so the suite does not depend on which wards those are.
  inferredWardId = `${prefix}-inferred-ward`;
  await prisma.ward.create({
    data: {
      id: inferredWardId,
      name: "Ancestry Test Inferred Ward",
      stateId: OGUN_STATE_ID,
      lgaId,
      stateConstituencyId: expected.stateConstituencyId,
      stateConstituencyEdgeInferred: true,
      stateConstituencyEdgeInferenceBasis: "token overlap (1)",
    },
  });
  inferredPollingUnitId = `${prefix}-inferred-pu`;
  await prisma.pollingUnit.create({
    data: {
      id: inferredPollingUnitId,
      name: "Ancestry Test Inferred PU",
      stateId: OGUN_STATE_ID,
      lgaId,
      wardId: inferredWardId,
    },
  });

  // A ward with no State Constituency: a deliberately broken chain.
  orphanWardId = `${prefix}-orphan-ward`;
  await prisma.ward.create({
    data: {
      id: orphanWardId,
      name: "Ancestry Test Orphan Ward",
      stateId: OGUN_STATE_ID,
      lgaId,
      stateConstituencyId: null,
    },
  });
  orphanPollingUnitId = `${prefix}-orphan-pu`;
  await prisma.pollingUnit.create({
    data: {
      id: orphanPollingUnitId,
      name: "Ancestry Test Orphan PU",
      stateId: OGUN_STATE_ID,
      lgaId,
      wardId: orphanWardId,
    },
  });
}

async function teardown() {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: prefix } },
    select: { id: true },
  });
  const userIds = users.map((user) => user.id);
  if (userIds.length > 0) {
    await prisma.voterVerificationHistory.deleteMany({ where: { verification: { memberUserId: { in: userIds } } } });
    await prisma.voterVerificationDocument.deleteMany({ where: { verification: { memberUserId: { in: userIds } } } });
    await prisma.voterVerification.deleteMany({ where: { memberUserId: { in: userIds } } });
    await prisma.referral.deleteMany({ where: { referredUserId: { in: userIds } } });
    await prisma.voterProfile.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.pollingUnit.deleteMany({ where: { id: { in: [inferredPollingUnitId, orphanPollingUnitId] } } });
  await prisma.ward.deleteMany({ where: { id: { in: [inferredWardId, orphanWardId] } } });
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
}

async function profileFor(slug: string) {
  return prisma.voterProfile.findFirst({
    where: { user: { email: email(slug) } },
    select: {
      id: true,
      senatorialDistrictId: true,
      federalConstituencyId: true,
      stateConstituencyId: true,
      wardId: true,
    },
  });
}

const cases: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "registration derives the constituency chain from the ward",
    run: async () => {
      const created = await apiRequest("/auth/register-voter", {
        method: "POST",
        body: registrationBody("derives", { lgaId, wardId: sourcedWardId, pollingUnitId: sourcedPollingUnitId }),
      });
      assert.equal(created.status, 201, JSON.stringify(created.payload));

      const profile = await profileFor("derives");
      assert.ok(profile, "a successful registration must persist a voter profile");
      assert.equal(profile.stateConstituencyId, expected.stateConstituencyId);
      assert.equal(profile.federalConstituencyId, expected.federalConstituencyId);
      assert.equal(profile.senatorialDistrictId, expected.senatorialDistrictId);
    },
  },
  {
    name: "a caller cannot author its own constituency ancestry",
    run: async () => {
      // The endpoint is public, so anything it accepts is reachable by anyone.
      for (const field of ["stateConstituencyId", "federalConstituencyId", "senatorialDistrictId"]) {
        const attempt = await apiRequest("/auth/register-voter", {
          method: "POST",
          body: {
            ...registrationBody(`override-${field}`, {
              lgaId,
              wardId: sourcedWardId,
              pollingUnitId: sourcedPollingUnitId,
            }),
            [field]: "attacker-selected",
          },
        });
        assert.equal(attempt.status, 400, `${field} must be refused: ${JSON.stringify(attempt.payload)}`);
        assert.equal(attempt.payload.code, "ANCESTRY_NOT_CALLER_SUPPLIED");
        assert.equal(
          await prisma.user.count({ where: { email: email(`override-${field}`) } }),
          0,
          "a rejected registration must create no account",
        );
      }
    },
  },
  {
    name: "an incomplete constituency chain fails closed and writes nothing",
    run: async () => {
      const attempt = await apiRequest("/auth/register-voter", {
        method: "POST",
        body: registrationBody("orphan", { lgaId, wardId: orphanWardId, pollingUnitId: orphanPollingUnitId }),
      });
      assert.equal(attempt.status, 400, JSON.stringify(attempt.payload));
      assert.equal(attempt.payload.code, "ANCESTRY_INCOMPLETE");
      assert.equal(await prisma.user.count({ where: { email: email("orphan") } }), 0);
      assert.equal(await prisma.voterProfile.count({ where: { wardId: orphanWardId } }), 0);
    },
  },
  {
    name: "an unreviewed inferred edge cannot become member ancestry",
    run: async () => {
      const attempt = await apiRequest("/auth/register-voter", {
        method: "POST",
        body: registrationBody("inferred", { lgaId, wardId: inferredWardId, pollingUnitId: inferredPollingUnitId }),
      });
      assert.equal(attempt.status, 400, JSON.stringify(attempt.payload));
      assert.equal(attempt.payload.code, "ANCESTRY_EDGE_UNREVIEWED");
      assert.equal(await prisma.user.count({ where: { email: email("inferred") } }), 0);
      assert.equal(await prisma.voterProfile.count({ where: { wardId: inferredWardId } }), 0);
    },
  },
  {
    name: "a reviewed inferred edge is usable again",
    run: async () => {
      // Review is a governance act, not an engineering one; this proves the
      // mechanism releases the block, and reverts so nothing stays approved.
      await prisma.ward.update({
        where: { id: inferredWardId },
        data: { stateConstituencyEdgeReviewedAt: new Date(), stateConstituencyEdgeReviewedBy: "ancestry-test" },
      });
      try {
        const created = await apiRequest("/auth/register-voter", {
          method: "POST",
          body: registrationBody("reviewed", { lgaId, wardId: inferredWardId, pollingUnitId: inferredPollingUnitId }),
        });
        assert.equal(created.status, 201, JSON.stringify(created.payload));
        const profile = await profileFor("reviewed");
        assert.equal(profile?.stateConstituencyId, expected.stateConstituencyId);
      } finally {
        await prisma.ward.update({
          where: { id: inferredWardId },
          data: { stateConstituencyEdgeReviewedAt: null, stateConstituencyEdgeReviewedBy: null },
        });
      }
    },
  },
  {
    name: "Ogun-only enforcement still refuses a territory outside the state",
    run: async () => {
      const attempt = await apiRequest("/auth/register-voter", {
        method: "POST",
        body: {
          ...registrationBody("outside", { lgaId, wardId: sourcedWardId, pollingUnitId: sourcedPollingUnitId }),
          stateId: "ng-state-lagos",
        },
      });
      assert.equal(attempt.status, 400, JSON.stringify(attempt.payload));
      assert.equal(attempt.payload.code, "OUTSIDE_OGUN_STATE");
      assert.equal(await prisma.user.count({ where: { email: email("outside") } }), 0);
    },
  },
  {
    name: "a polling unit from another ward cannot derive that ward's ancestry",
    run: async () => {
      const attempt = await apiRequest("/auth/register-voter", {
        method: "POST",
        body: registrationBody("crossward", {
          lgaId,
          wardId: sourcedWardId,
          pollingUnitId: otherPollingUnitId,
        }),
      });
      assert.equal(attempt.status, 400, JSON.stringify(attempt.payload));
      assert.equal(await prisma.user.count({ where: { email: email("crossward") } }), 0);
    },
  },
  {
    name: "the backfill repairs a null ancestry from the canonical graph",
    run: async () => {
      const profile = await profileFor("derives");
      assert.ok(profile);
      // Return the row to the pre-derivation state the product actually produced.
      await prisma.voterProfile.update({
        where: { id: profile.id },
        data: { senatorialDistrictId: null, federalConstituencyId: null, stateConstituencyId: null },
      });

      const dry = await runMemberAncestryBackfill(prisma, { apply: false });
      assert.equal(dry.report.mode, "dry-run");
      assert.ok(dry.report.eligibleNullAncestry >= 1, JSON.stringify(dry.report));
      assert.equal(dry.report.changed, 0, "a dry run must not write");
      const stillNull = await profileFor("derives");
      assert.equal(stillNull?.stateConstituencyId, null, "a dry run must leave the row untouched");

      const applied = await runMemberAncestryBackfill(prisma, { apply: true });
      assert.ok(applied.report.changed >= 1, JSON.stringify(applied.report));
      const repaired = await profileFor("derives");
      assert.equal(repaired?.stateConstituencyId, expected.stateConstituencyId);
      assert.equal(repaired?.federalConstituencyId, expected.federalConstituencyId);
      assert.equal(repaired?.senatorialDistrictId, expected.senatorialDistrictId);
    },
  },
  {
    name: "the backfill is idempotent",
    run: async () => {
      const second = await runMemberAncestryBackfill(prisma, { apply: true });
      assert.equal(second.report.changed, 0, `a second run must change nothing: ${JSON.stringify(second.report)}`);
      assert.equal(second.report.wouldChange, 0);
    },
  },
  {
    name: "the backfill reports a conflicting ancestry rather than trusting it",
    run: async () => {
      const profile = await profileFor("derives");
      assert.ok(profile);
      // A stale value from the client era, disagreeing with the ward.
      await prisma.voterProfile.update({
        where: { id: profile.id },
        data: { stateConstituencyId: expected.stateConstituencyId, federalConstituencyId: null },
      });

      const dry = await runMemberAncestryBackfill(prisma, { apply: false });
      assert.ok(dry.report.conflictingAncestry >= 1, JSON.stringify(dry.report));

      const applied = await runMemberAncestryBackfill(prisma, { apply: true });
      assert.ok(applied.report.changed >= 1);
      const repaired = await profileFor("derives");
      assert.equal(repaired?.federalConstituencyId, expected.federalConstituencyId, "the ward is the authority");
    },
  },
  {
    name: "the backfill never repairs a member on an unreviewed inferred edge",
    run: async () => {
      // Placed directly, because registration itself refuses this ward.
      const user = await prisma.user.create({
        data: {
          name: "Ancestry Legacy Inferred",
          email: email("legacy-inferred"),
          passwordHash: await hashPassword(password),
          role: "VOTER",
          voterProfile: {
            create: {
              voterCardNumber: "ANCESTRY-LEGACY-INFERRED",
              referralCode: "ANCLEGINF",
              stateId: OGUN_STATE_ID,
              lgaId,
              wardId: inferredWardId,
              pollingUnitId: inferredPollingUnitId,
            },
          },
        },
        select: { id: true },
      });

      const applied = await runMemberAncestryBackfill(prisma, { apply: true });
      assert.ok(applied.report.inferredEdgeUnreviewed >= 1, JSON.stringify(applied.report));

      const profile = await prisma.voterProfile.findFirst({
        where: { userId: user.id },
        select: { stateConstituencyId: true, federalConstituencyId: true, senatorialDistrictId: true },
      });
      assert.equal(profile?.stateConstituencyId, null, "an unreviewed edge must never be promoted");
      assert.equal(profile?.federalConstituencyId, null);
      assert.equal(profile?.senatorialDistrictId, null);
    },
  },
  {
    name: "the command dashboard counts a member through the constituency chain",
    run: async () => {
      const officerEmail = email("state-officer");
      await prisma.user.create({
        data: {
          name: "Ancestry State Officer",
          email: officerEmail,
          passwordHash: await hashPassword(password),
          role: "STATE_OFFICER",
          coordinatorProfile: {
            create: { level: "STATE_CONSTITUENCY", stateId: OGUN_STATE_ID },
          },
        },
      });
      const session = await apiRequest("/auth/login", {
        method: "POST",
        body: { email: officerEmail, password },
      });
      assert.equal(session.status, 200, JSON.stringify(session.payload));
      const token = (session.payload as { token: string }).token;

      for (const [level, territoryId] of [
        ["STATE_CONSTITUENCY", expected.stateConstituencyId],
        ["FEDERAL_CONSTITUENCY", expected.federalConstituencyId],
        ["SENATORIAL_DISTRICT", expected.senatorialDistrictId],
      ] as const) {
        const view = await apiRequest(`/dashboard?level=${level}&territoryId=${territoryId}`, { token });
        assert.equal(view.status, 200, `${level}: ${JSON.stringify(view.payload)}`);
        const tiles =
          (view.payload as { dashboard?: { tiles?: Array<{ key: string; value: number }> } }).dashboard?.tiles ?? [];
        const registered = tiles.find((tile) => tile.key === "REGISTERED_MEMBERS")?.value ?? 0;
        assert.ok(
          registered >= 1,
          `${level} must count the member registered in its ward: ${JSON.stringify(tiles)}`,
        );
      }
    },
  },
];

export async function runMemberAncestryTests() {
  await setup();
  try {
    for (const testCase of cases) {
      await testCase.run();
      console.log(`PASS ${testCase.name}`);
    }
  } finally {
    await teardown();
  }
}
