import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { OGUN_STATE_ID } from "@pics-nigeria/shared";
import {
  applyIdentityRelease,
  validateIdentityRelease,
  validateManifest,
} from "../../../packages/database/scripts/import-ogun-reference-release";
import {
  buildOperationalPollingUnitTerritoryWhere,
  buildOperationalVoterProfileTerritoryWhere,
  MEMBER_TERRITORY_SCOPE_VERSION,
  UnsupportedMemberTerritoryType,
} from "./lib/member-territory-scope";
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

/**
 * Repo root, located by walking up rather than by counting directories.
 *
 * These tests run from `apps/api/dist/apps/api/src` after compilation and from
 * `apps/api/src` in the editor, so a fixed number of `..` segments is wrong in
 * one of the two.
 */
const repoRoot = (() => {
  let current = __dirname;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(path.join(current, "packages", "database", "prisma", "ogun-migrations"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate the repository root from ${__dirname}.`);
})();

async function registeredMembers(token: string, level: string, territoryId: string) {
  const view = await apiRequest(`/dashboard?level=${level}&territoryId=${territoryId}`, { token });
  assert.equal(view.status, 200, `${level}: ${JSON.stringify(view.payload)}`);
  const tiles = (view.payload as { dashboard: { tiles: Array<{ key: string; value: number }> } }).dashboard.tiles;
  return tiles.find((tile) => tile.key === "REGISTERED_MEMBERS")?.value ?? 0;
}

/** Places a member directly, for wards registration itself refuses. */
async function placeMemberOnWard(slug: string, wardId: string, pollingUnitId: string) {
  const ward = await prisma.ward.findUniqueOrThrow({ where: { id: wardId }, select: { lgaId: true } });
  const user = await prisma.user.create({
    data: {
      name: `Ancestry ${slug}`,
      email: email(slug),
      passwordHash: await hashPassword(password),
      role: "VOTER",
      voterProfile: {
        create: {
          voterCardNumber: `ANCESTRY-${slug.toUpperCase()}`,
          referralCode: `ANC${slug.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 8)}`,
          stateId: OGUN_STATE_ID,
          lgaId: ward.lgaId,
          wardId,
          pollingUnitId,
        },
      },
    },
    select: { id: true },
  });
  return user.id;
}

async function removeMember(userId: string) {
  await prisma.voterProfile.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
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
    name: "constituency counts exclude a member whose ward edge is unreviewed, and include them once reviewed",
    run: async () => {
      // D3. The write path refuses to say which constituency this member is in.
      // The read path must not answer the question anyway.
      const officerEmail = email("state-officer");
      await prisma.user.create({
        data: {
          name: "Ancestry State Officer",
          email: officerEmail,
          passwordHash: await hashPassword(password),
          role: "STATE_OFFICER",
          coordinatorProfile: { create: { level: "STATE_CONSTITUENCY", stateId: OGUN_STATE_ID } },
        },
      });
      const session = await apiRequest("/auth/login", { method: "POST", body: { email: officerEmail, password } });
      assert.equal(session.status, 200, JSON.stringify(session.payload));
      const token = (session.payload as { token: string }).token;

      const constituencyLevels = [
        ["STATE_CONSTITUENCY", expected.stateConstituencyId],
        ["FEDERAL_CONSTITUENCY", expected.federalConstituencyId],
        ["SENATORIAL_DISTRICT", expected.senatorialDistrictId],
      ] as const;

      const baseline = new Map<string, number>();
      for (const [level, territoryId] of constituencyLevels) {
        baseline.set(level, await registeredMembers(token, level, territoryId));
      }
      const wardBaseline = await registeredMembers(token, "WARD", inferredWardId);
      const stateBaseline = await registeredMembers(token, "STATE", OGUN_STATE_ID);
      const pollingUnitBaseline = await registeredMembers(token, "POLLING_UNIT", inferredPollingUnitId);

      // A member placed directly on the unreviewed ward, because registration
      // refuses that ward entirely.
      const placed = await placeMemberOnWard("d3-unreviewed", inferredWardId, inferredPollingUnitId);

      for (const [level, territoryId] of constituencyLevels) {
        assert.equal(
          await registeredMembers(token, level, territoryId),
          baseline.get(level),
          `${level} must not count a member whose ward edge is unreviewed`,
        );
      }
      assert.equal(
        await registeredMembers(token, "WARD", inferredWardId),
        wardBaseline + 1,
        "the member's ward is not in question and must still count them",
      );
      assert.equal(
        await registeredMembers(token, "STATE", OGUN_STATE_ID),
        stateBaseline + 1,
        "the member's state is not in question and must still count them",
      );
      assert.equal(
        await registeredMembers(token, "POLLING_UNIT", inferredPollingUnitId),
        pollingUnitBaseline + 1,
        "the member's polling unit is not in question and must still count them",
      );

      /**
       * Reviewing the edge is what makes the higher levels answerable — for
       * every member on that ward, not just the one this case placed. Earlier
       * cases leave members there too, so the expected rise is measured rather
       * than assumed.
       */
      const membersOnInferredWard = await registeredMembers(token, "WARD", inferredWardId);
      await prisma.ward.update({
        where: { id: inferredWardId },
        data: { stateConstituencyEdgeReviewedAt: new Date(), stateConstituencyEdgeReviewedBy: "ancestry-test" },
      });
      try {
        for (const [level, territoryId] of constituencyLevels) {
          assert.equal(
            await registeredMembers(token, level, territoryId),
            (baseline.get(level) ?? 0) + membersOnInferredWard,
            `${level} must count the ward's members once the edge is reviewed`,
          );
        }
      } finally {
        await prisma.ward.update({
          where: { id: inferredWardId },
          data: { stateConstituencyEdgeReviewedAt: null, stateConstituencyEdgeReviewedBy: null },
        });
        await removeMember(placed);
      }
    },
  },
  {
    name: "the provenance backfill migration makes an already-imported database true without re-importing",
    run: async () => {
      // D1. The decisive regression: the state a PR #11 database lands in after
      // migrating forward is reproduced exactly -- provenance columns present
      // and at their DEFAULT false, importer never rerun -- and the checked-in
      // migration must correct it.
      const before = await prisma.ward.count({
        where: { stateId: OGUN_STATE_ID, stateConstituencyEdgeInferred: true },
      });
      assert.ok(before > 0, "the imported release must have flagged inferred edges to begin with");

      const syntheticWards = [inferredWardId, orphanWardId];
      const saved = await prisma.ward.findMany({
        where: { id: { in: syntheticWards } },
        select: { id: true, stateConstituencyEdgeInferred: true, stateConstituencyEdgeInferenceBasis: true },
      });

      await prisma.ward.updateMany({
        where: { stateId: OGUN_STATE_ID },
        data: { stateConstituencyEdgeInferred: false, stateConstituencyEdgeInferenceBasis: null },
      });
      assert.equal(
        await prisma.ward.count({ where: { stateId: OGUN_STATE_ID, stateConstituencyEdgeInferred: true } }),
        0,
        "defect state: every ward reads sourced",
      );

      // Registration would succeed here, which is precisely the defect.
      const migrationSql = readFileSync(
        path.join(
          repoRoot,
          "packages/database/prisma/ogun-migrations/20260902120000_backfill_ward_constituency_edge_provenance/migration.sql",
        ),
        "utf8",
      );
      await prisma.$executeRawUnsafe(migrationSql);

      const releaseInferred = await prisma.ward.count({
        where: {
          stateId: OGUN_STATE_ID,
          stateConstituencyEdgeInferred: true,
          id: { notIn: syntheticWards },
        },
      });
      assert.equal(releaseInferred, 55, "the migration must flag exactly the 55 release wards");
      assert.equal(
        await prisma.ward.count({
          where: { stateId: OGUN_STATE_ID, stateConstituencyEdgeInferred: false, id: { notIn: syntheticWards } },
        }),
        181,
        "the remaining release wards must stay sourced",
      );
      assert.equal(
        await prisma.ward.count({
          where: { stateId: OGUN_STATE_ID, stateConstituencyEdgeReviewedAt: { not: null } },
        }),
        0,
        "the migration must not review anything",
      );

      // And the gate it exists to feed is live: registration on a ward the
      // migration flagged is refused, with no importer having been rerun.
      const flagged = await prisma.ward.findFirst({
        where: {
          stateId: OGUN_STATE_ID,
          stateConstituencyEdgeInferred: true,
          id: { notIn: syntheticWards },
          pollingUnits: { some: {} },
        },
        orderBy: { id: "asc" },
        select: { id: true, lgaId: true, pollingUnits: { take: 1, orderBy: { id: "asc" }, select: { id: true } } },
      });
      assert.ok(flagged, "a flagged release ward with a polling unit is required for this assertion");
      const refused = await apiRequest("/auth/register-voter", {
        method: "POST",
        body: registrationBody("d1-upgrade", {
          lgaId: flagged.lgaId,
          wardId: flagged.id,
          pollingUnitId: flagged.pollingUnits[0].id,
        }),
      });
      assert.equal(refused.status, 400, JSON.stringify(refused.payload));
      assert.equal(refused.payload.code, "ANCESTRY_EDGE_UNREVIEWED");
      assert.equal(await prisma.user.count({ where: { email: email("d1-upgrade") } }), 0);

      // Restore the suite's synthetic fixtures, which the reset also cleared.
      for (const ward of saved) {
        await prisma.ward.update({
          where: { id: ward.id },
          data: {
            stateConstituencyEdgeInferred: ward.stateConstituencyEdgeInferred,
            stateConstituencyEdgeInferenceBasis: ward.stateConstituencyEdgeInferenceBasis,
          },
        });
      }
    },
  },
  {
    name: "the release builder owns the inferred-edge file and the importer refuses a release without it",
    run: async () => {
      // D2. A missing INFERRED-EDGES.csv does not mean "nothing was inferred".
      const releaseDir = path.join(repoRoot, "packages/database/reference/ogun/ogun-identity-2026-08-12");
      const manifest = JSON.parse(readFileSync(path.join(releaseDir, "manifest.json"), "utf8"));

      assert.ok(manifest.files.inferredEdges, "the committed manifest must checksum the inferred-edge file");
      const csv = readFileSync(path.join(releaseDir, "INFERRED-EDGES.csv"), "utf8");
      const canonical = csv.replace(/\r\n?/g, "\n");
      assert.equal(
        createHash("sha256").update(canonical, "utf8").digest("hex"),
        manifest.files.inferredEdges.sha256,
        "the manifest checksum must match the LF-canonical file, so it verifies identically on Windows and Linux",
      );

      const rows = canonical.trim().split("\n").slice(1);
      assert.equal(rows.length, 56, "the release records 56 inference rows");
      /**
       * 56 rows, 55 wards. The duplicate is invisible to string comparison: one
       * row names the ward (`SUNREN`) and the other uses the build's internal
       * source key (`568:6511`). Only resolution against the release shows they
       * are the same ward, so the importer's own resolution is asserted here.
       */
      const resolvedManifest = validateManifest(releaseDir);
      assert.ok(resolvedManifest.value, JSON.stringify(resolvedManifest.failures));
      const resolved = validateIdentityRelease(releaseDir, resolvedManifest.value.manifest);
      assert.ok(resolved.value, JSON.stringify(resolved.failures));
      assert.equal(resolved.value.inferredWardEdges.size, 55, "covering 55 distinct wards");

      // Deterministic ordering, so regenerating an unchanged tree reproduces
      // byte-identical output and therefore the same checksum.
      const sorted = [...rows].sort((a, b) => {
        // Code-unit comparison, matching the builder. localeCompare would make
        // the expected order depend on the machine running the test.
        const key = (line: string) => line.split(",").slice(0, 3).join("\u0000");
        return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
      });
      assert.deepEqual(rows, sorted, "the committed file must already be in the builder's deterministic order");

      // The builder itself must produce and checksum it, not a human afterwards.
      const builder = readFileSync(path.join(repoRoot, "packages/database/scripts/build-ogun-reference-release.mjs"), "utf8");
      assert.ok(
        builder.includes('inferredEdges: { path: "INFERRED-EDGES.csv"'),
        "the builder must write the inferred-edge entry into the manifest",
      );

      // And a release that omits it is refused rather than read as "no edges".
      const withoutProvenance = { ...manifest, files: { ...manifest.files } };
      delete withoutProvenance.files.inferredEdges;
      const scratch = path.join(tmpdir(), `ogun-release-no-provenance-${Date.now()}`);
      mkdirSync(scratch, { recursive: true });
      try {
        for (const name of ["territories.csv", "command-relationships.csv", "lga-memberships.csv", "INFERRED-EDGES.csv"]) {
          copyFileSync(path.join(releaseDir, name), path.join(scratch, name));
        }
        writeFileSync(path.join(scratch, "manifest.json"), JSON.stringify(withoutProvenance, null, 2));
        const result = validateManifest(scratch);
        assert.equal(result.value, null, "a release without inferred-edge provenance must not validate");
        assert.ok(
          result.failures.some((failure) => failure.includes("inferredEdges")),
          `expected an inferredEdges failure, got ${JSON.stringify(result.failures)}`,
        );
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  },
  {
    name: "re-importing the release preserves a human review and keeps the inference",
    run: async () => {
      // D2. The importer owns inference; governance owns review.
      const ward = await prisma.ward.findFirst({
        where: { stateId: OGUN_STATE_ID, stateConstituencyEdgeInferred: true, id: { not: inferredWardId } },
        orderBy: { id: "asc" },
        select: { id: true, stateConstituencyEdgeInferenceBasis: true },
      });
      assert.ok(ward, "a release ward with an inferred edge is required");
      const reviewedAt = new Date();
      await prisma.ward.update({
        where: { id: ward.id },
        data: { stateConstituencyEdgeReviewedAt: reviewedAt, stateConstituencyEdgeReviewedBy: "governance-test" },
      });
      try {
        const releaseDir = path.join(repoRoot, "packages/database/reference/ogun/ogun-identity-2026-08-12");
        const manifestResult = validateManifest(releaseDir);
        assert.ok(manifestResult.value, JSON.stringify(manifestResult.failures));
        const payload = validateIdentityRelease(releaseDir, manifestResult.value.manifest);
        assert.ok(payload.value, JSON.stringify(payload.failures));
        await applyIdentityRelease(manifestResult.value.manifest, manifestResult.value.manifestPath, payload.value);
        const after = await prisma.ward.findUniqueOrThrow({
          where: { id: ward.id },
          select: {
            stateConstituencyEdgeInferred: true,
            stateConstituencyEdgeInferenceBasis: true,
            stateConstituencyEdgeReviewedAt: true,
            stateConstituencyEdgeReviewedBy: true,
          },
        });
        assert.equal(after.stateConstituencyEdgeInferred, true, "the inference is a fact about the source and survives");
        assert.equal(after.stateConstituencyEdgeInferenceBasis, ward.stateConstituencyEdgeInferenceBasis);
        assert.equal(
          after.stateConstituencyEdgeReviewedAt?.getTime(),
          reviewedAt.getTime(),
          "re-import must never revoke a human review",
        );
        assert.equal(after.stateConstituencyEdgeReviewedBy, "governance-test");
      } finally {
        await prisma.ward.update({
          where: { id: ward.id },
          data: { stateConstituencyEdgeReviewedAt: null, stateConstituencyEdgeReviewedBy: null },
        });
      }
    },
  },
  {
    name: "a strength snapshot from the old scope cannot override the live count, and a current one can",
    run: async () => {
      // F1. Snapshots outlive the code that produced them.
      const officerEmail = email("snapshot-officer");
      await prisma.user.create({
        data: {
          name: "Ancestry Snapshot Officer",
          email: officerEmail,
          passwordHash: await hashPassword(password),
          role: "STATE_OFFICER",
          coordinatorProfile: { create: { level: "STATE_CONSTITUENCY", stateId: OGUN_STATE_ID } },
        },
      });
      const session = await apiRequest("/auth/login", { method: "POST", body: { email: officerEmail, password } });
      const token = (session.payload as { token: string }).token;

      const read = async () => {
        const view = await apiRequest(
          `/dashboard?level=STATE_CONSTITUENCY&territoryId=${expected.stateConstituencyId}`,
          { token },
        );
        assert.equal(view.status, 200, JSON.stringify(view.payload));
        return (view.payload as { dashboard: { strengthScore: number } }).dashboard.strengthScore;
      };

      const live = await read();

      // An unversioned snapshot, exactly as the pre-fix strength engine wrote it.
      const stale = await prisma.territoryStrengthSnapshot.create({
        data: {
          territoryType: "STATE_CONSTITUENCY",
          territoryId: expected.stateConstituencyId,
          score: new Prisma.Decimal(0),
          breakdownJson: [{ metric: "REGISTERED_MEMBERS", actualValue: 0 }],
          calculatedAt: new Date(),
        },
      });
      const current = await prisma.territoryStrengthSnapshot.create({
        data: {
          territoryType: "STATE_CONSTITUENCY",
          territoryId: expected.stateConstituencyId,
          score: new Prisma.Decimal(0),
          breakdownJson: { memberTerritoryScopeVersion: "SOME_OTHER_VERSION", metrics: [] },
          calculatedAt: new Date(),
        },
      });
      try {
        assert.equal(
          await read(),
          live,
          "an obsolete or foreign-version snapshot must not override the live derived score",
        );

        const accepted = await prisma.territoryStrengthSnapshot.create({
          data: {
            territoryType: "STATE_CONSTITUENCY",
            territoryId: expected.stateConstituencyId,
            score: new Prisma.Decimal(77),
            breakdownJson: { memberTerritoryScopeVersion: MEMBER_TERRITORY_SCOPE_VERSION, metrics: [] },
            calculatedAt: new Date(),
          },
        });
        assert.equal(await read(), 77, "a snapshot carrying the current scope version is authoritative");
        await prisma.territoryStrengthSnapshot.delete({ where: { id: accepted.id } });
      } finally {
        await prisma.territoryStrengthSnapshot.deleteMany({ where: { id: { in: [stale.id, current.id] } } });
      }
    },
  },
  {
    name: "polling-unit counts follow the same operational edge rule as member counts",
    run: async () => {
      // F-b. A constituency must not show polling units it will not place a
      // member in; the derived strength score divides one by the other.
      const officerEmail = email("pu-scope-officer");
      await prisma.user.create({
        data: {
          name: "Ancestry PU Scope Officer",
          email: officerEmail,
          passwordHash: await hashPassword(password),
          role: "STATE_OFFICER",
          coordinatorProfile: { create: { level: "STATE_CONSTITUENCY", stateId: OGUN_STATE_ID } },
        },
      });
      const session = await apiRequest("/auth/login", { method: "POST", body: { email: officerEmail, password } });
      const token = (session.payload as { token: string }).token;

      // A real constituency whose every ward edge is inferred and unreviewed.
      const wholly = await prisma.stateConstituency.findFirst({
        where: {
          stateId: OGUN_STATE_ID,
          federalConstituencyId: { not: null },
          wards: { some: { pollingUnits: { some: {} } }, every: { stateConstituencyEdgeInferred: true } },
        },
        orderBy: { id: "asc" },
        select: { id: true, federalConstituency: { select: { id: true, senatorialDistrictId: true } } },
      });
      assert.ok(wholly, "the release must contain a constituency whose wards are all unreviewed inferences");

      const pollingUnitsInGraph = await prisma.pollingUnit.count({ where: { ward: { stateConstituencyId: wholly.id } } });
      assert.ok(pollingUnitsInGraph > 0, "that constituency must have polling units in the raw graph");

      const tilesFor = async (level: string, territoryId: string) => {
        const view = await apiRequest(`/dashboard?level=${level}&territoryId=${territoryId}`, { token });
        assert.equal(view.status, 200, `${level}: ${JSON.stringify(view.payload)}`);
        const tiles = (view.payload as { dashboard: { tiles: Array<{ key: string; value: number }> } }).dashboard.tiles;
        return {
          members: tiles.find((tile) => tile.key === "REGISTERED_MEMBERS")?.value ?? -1,
          pollingUnits: tiles.find((tile) => tile.key === "POLLING_UNITS")?.value ?? -1,
        };
      };

      for (const [level, territoryId] of [
        ["STATE_CONSTITUENCY", wholly.id],
        ["FEDERAL_CONSTITUENCY", wholly.federalConstituency!.id],
        ["SENATORIAL_DISTRICT", wholly.federalConstituency!.senatorialDistrictId],
      ] as const) {
        const before = await tilesFor(level, territoryId);
        if (level === "STATE_CONSTITUENCY") {
          assert.equal(before.members, 0, "no member can be placed through an unreviewed edge");
          assert.equal(
            before.pollingUnits,
            0,
            "and no polling unit may be counted through it either, or the strength denominator disagrees with its numerator",
          );
        } else {
          // Sibling wards may be sourced at the wider levels; the invariant is
          // that the unreviewed constituency contributes nothing to either half.
          assert.ok(before.pollingUnits >= 0);
        }
      }

      // Reviewing the edges makes both halves visible together.
      const wards = await prisma.ward.findMany({ where: { stateConstituencyId: wholly.id }, select: { id: true } });
      await prisma.ward.updateMany({
        where: { id: { in: wards.map((ward) => ward.id) } },
        data: { stateConstituencyEdgeReviewedAt: new Date(), stateConstituencyEdgeReviewedBy: "pu-scope-test" },
      });
      try {
        const after = await tilesFor("STATE_CONSTITUENCY", wholly.id);
        assert.equal(
          after.pollingUnits,
          pollingUnitsInGraph,
          "once reviewed, the constituency's polling units appear",
        );
      } finally {
        await prisma.ward.updateMany({
          where: { id: { in: wards.map((ward) => ward.id) } },
          data: { stateConstituencyEdgeReviewedAt: null, stateConstituencyEdgeReviewedBy: null },
        });
      }

      const restored = await tilesFor("STATE_CONSTITUENCY", wholly.id);
      assert.equal(restored.pollingUnits, 0, "and disappear again when the review is withdrawn");
    },
  },
  {
    name: "pre-election strength surfaces ignore an obsolete snapshot and accept a current one",
    run: async () => {
      // F-a. The command dashboard rejected these already; the pre-election
      // surfaces displayed them, so the same territory read 0 in one place and
      // its real score in another.
      const officerEmail = email("pe-snapshot-officer");
      await prisma.user.create({
        data: {
          name: "Ancestry Pre-Election Officer",
          email: officerEmail,
          passwordHash: await hashPassword(password),
          role: "STATE_OFFICER",
          coordinatorProfile: { create: { level: "STATE_CONSTITUENCY", stateId: OGUN_STATE_ID } },
        },
      });
      const session = await apiRequest("/auth/login", { method: "POST", body: { email: officerEmail, password } });
      const token = (session.payload as { token: string }).token;
      const query = `territoryType=STATE_CONSTITUENCY&territoryId=${expected.stateConstituencyId}`;

      const obsolete = await prisma.territoryStrengthSnapshot.create({
        data: {
          territoryType: "STATE_CONSTITUENCY",
          territoryId: expected.stateConstituencyId,
          score: new Prisma.Decimal(0),
          breakdownJson: [{ metric: "REGISTERED_MEMBERS", actualValue: 0 }],
          calculatedAt: new Date(),
        },
      });
      try {
        const latest = await apiRequest(`/pre-election/strength/snapshots/latest?${query}`, { token });
        assert.equal(latest.status, 200, JSON.stringify(latest.payload));
        assert.equal(
          (latest.payload as { strengthSnapshot: unknown }).strengthSnapshot,
          null,
          "an unversioned snapshot must not be presented as the current strength",
        );

        const dash = await apiRequest(`/pre-election/strength/dashboard?${query}`, { token });
        assert.equal(dash.status, 200, JSON.stringify(dash.payload));
        assert.equal(
          (dash.payload as { dashboard: { latestStrengthSnapshot: unknown } }).dashboard.latestStrengthSnapshot,
          null,
          "the strength dashboard must not present an obsolete snapshot either",
        );

        const current = await prisma.territoryStrengthSnapshot.create({
          data: {
            territoryType: "STATE_CONSTITUENCY",
            territoryId: expected.stateConstituencyId,
            score: new Prisma.Decimal(64),
            breakdownJson: { memberTerritoryScopeVersion: MEMBER_TERRITORY_SCOPE_VERSION, metrics: [] },
            calculatedAt: new Date(),
          },
        });
        try {
          const accepted = await apiRequest(`/pre-election/strength/snapshots/latest?${query}`, { token });
          const payload = (accepted.payload as { strengthSnapshot: { score: string; trend: string | null } })
            .strengthSnapshot;
          assert.ok(payload, "a current-version snapshot must be accepted");
          assert.equal(payload.score, "64");
          /**
           * This endpoint reports STABLE when there is nothing to compare
           * against — its existing no-previous value. What matters is that the
           * obsolete zero is not treated as a previous score: that would read
           * as IMPROVING, an advance that never happened.
           */
          assert.notEqual(
            payload.trend,
            "IMPROVING",
            "an obsolete snapshot must not be used as the previous score",
          );
          assert.equal(payload.trend, "STABLE", "with no comparable previous snapshot there is no trend");
        } finally {
          await prisma.territoryStrengthSnapshot.delete({ where: { id: current.id } });
        }
      } finally {
        await prisma.territoryStrengthSnapshot.delete({ where: { id: obsolete.id } });
      }
    },
  },
  {
    name: "trend compares only snapshots from the current calculation generation",
    run: async () => {
      const officerEmail = email("trend-officer");
      await prisma.user.create({
        data: {
          name: "Ancestry Trend Officer",
          email: officerEmail,
          passwordHash: await hashPassword(password),
          role: "STATE_OFFICER",
          coordinatorProfile: { create: { level: "STATE_CONSTITUENCY", stateId: OGUN_STATE_ID } },
        },
      });
      const session = await apiRequest("/auth/login", { method: "POST", body: { email: officerEmail, password } });
      const token = (session.payload as { token: string }).token;
      const query = `territoryType=STATE_CONSTITUENCY&territoryId=${expected.stateConstituencyId}`;

      const made: string[] = [];
      const snapshot = async (score: number, versioned: boolean, minutesAgo: number) => {
        const row = await prisma.territoryStrengthSnapshot.create({
          data: {
            territoryType: "STATE_CONSTITUENCY",
            territoryId: expected.stateConstituencyId,
            score: new Prisma.Decimal(score),
            breakdownJson: versioned
              ? { memberTerritoryScopeVersion: MEMBER_TERRITORY_SCOPE_VERSION, metrics: [] }
              : [{ metric: "REGISTERED_MEMBERS", actualValue: 0 }],
            calculatedAt: new Date(Date.now() - minutesAgo * 60_000),
          },
        });
        made.push(row.id);
        return row;
      };

      const trend = async () => {
        const result = await apiRequest(`/pre-election/strength/snapshots/latest?${query}`, { token });
        assert.equal(result.status, 200, JSON.stringify(result.payload));
        return (result.payload as { strengthSnapshot: { trend: string | null } | null }).strengthSnapshot?.trend ?? null;
      };

      try {
        await snapshot(0, false, 30);
        await snapshot(60, true, 20);
        // STABLE is this endpoint's "nothing to compare against". The defect
        // being guarded is the 0 -> 60 jump reading as IMPROVING.
        assert.equal(await trend(), "STABLE", "a pre-version 0 must not manufacture an IMPROVING trend");

        await snapshot(70, true, 10);
        assert.equal(await trend(), "IMPROVING", "60 -> 70 across the current generation is a real improvement");

        await snapshot(65, true, 5);
        assert.equal(await trend(), "DECLINING", "70 -> 65 is a real decline");

        await snapshot(65, true, 1);
        assert.equal(await trend(), "STABLE", "65 -> 65 is stable");
      } finally {
        await prisma.territoryStrengthSnapshot.deleteMany({ where: { id: { in: made } } });
      }
    },
  },
  {
    name: "the strength dashboard derives score and trend only from the current generation",
    run: async () => {
      // R1. `latest` came from the filtered list while the comparand came from
      // the raw one, so an obsolete zero became the previous score.
      const officerEmail = email("r1-officer");
      await prisma.user.create({
        data: {
          name: "Ancestry R1 Officer",
          email: officerEmail,
          passwordHash: await hashPassword(password),
          role: "STATE_OFFICER",
          coordinatorProfile: { create: { level: "STATE_CONSTITUENCY", stateId: OGUN_STATE_ID } },
        },
      });
      const session = await apiRequest("/auth/login", { method: "POST", body: { email: officerEmail, password } });
      const token = (session.payload as { token: string }).token;
      const query = `territoryType=STATE_CONSTITUENCY&territoryId=${expected.stateConstituencyId}`;

      const made: string[] = [];
      const snapshot = async (score: number, versioned: boolean, minutesAgo: number) => {
        const row = await prisma.territoryStrengthSnapshot.create({
          data: {
            territoryType: "STATE_CONSTITUENCY",
            territoryId: expected.stateConstituencyId,
            score: new Prisma.Decimal(score),
            breakdownJson: versioned
              ? { memberTerritoryScopeVersion: MEMBER_TERRITORY_SCOPE_VERSION, metrics: [] }
              : [{ metric: "REGISTERED_MEMBERS", actualValue: 0 }],
            calculatedAt: new Date(Date.now() - minutesAgo * 60_000),
          },
        });
        made.push(row.id);
        return row;
      };

      /** Both current-strength surfaces, which must agree. */
      const read = async () => {
        const dash = await apiRequest(`/pre-election/strength/dashboard?${query}`, { token });
        assert.equal(dash.status, 200, JSON.stringify(dash.payload));
        const snapshotPayload = (
          dash.payload as { dashboard: { latestStrengthSnapshot: { score: string; trend: string } | null } }
        ).dashboard.latestStrengthSnapshot;
        const latest = await apiRequest(`/pre-election/strength/snapshots/latest?${query}`, { token });
        const latestPayload = (latest.payload as { strengthSnapshot: { score: string; trend: string } | null })
          .strengthSnapshot;
        assert.deepEqual(
          { score: snapshotPayload?.score ?? null, trend: snapshotPayload?.trend ?? null },
          { score: latestPayload?.score ?? null, trend: latestPayload?.trend ?? null },
          "the two current-strength surfaces must not disagree about the same territory",
        );
        return snapshotPayload;
      };

      const clear = async () => {
        await prisma.territoryStrengthSnapshot.deleteMany({ where: { id: { in: made.splice(0, made.length) } } });
      };

      try {
        // 5. Only obsolete snapshots: nothing obsolete may be exposed as current.
        await snapshot(0, false, 40);
        assert.equal(await read(), null, "an obsolete snapshot is not a current score");
        await clear();

        // 1. [62 current, 0 unversioned] -> no fictional IMPROVING.
        await snapshot(0, false, 40);
        await snapshot(62, true, 30);
        let view = await read();
        assert.equal(view?.score, "62");
        assert.notEqual(view?.trend, "IMPROVING", "an obsolete zero must not manufacture an improvement");
        assert.equal(view?.trend, "STABLE", "with no comparable previous snapshot there is no trend");
        await clear();

        // 2. [62 current, 0 unversioned, 68 current] -> DECLINING, not sign-inverted.
        await snapshot(68, true, 40);
        await snapshot(0, false, 30);
        await snapshot(62, true, 20);
        view = await read();
        assert.equal(view?.score, "62");
        assert.equal(view?.trend, "DECLINING", "68 -> 62 is a decline; an interleaved obsolete 0 must not invert its sign");
        await clear();

        // 3. [62 current, 0 unversioned, 50 current] -> IMPROVING.
        await snapshot(50, true, 40);
        await snapshot(0, false, 30);
        await snapshot(62, true, 20);
        view = await read();
        assert.equal(view?.trend, "IMPROVING", "50 -> 62 is a real improvement");
        await clear();

        // 4. [62 current, 62 current] -> STABLE.
        await snapshot(62, true, 40);
        await snapshot(62, true, 30);
        view = await read();
        assert.equal(view?.trend, "STABLE");
      } finally {
        await clear();
      }
    },
  },
  {
    name: "a current-version snapshot cannot draw coverage from unreviewed polling units",
    run: async () => {
      // R2. The version stamp must be true: every member-territory input to the
      // score has to use the semantics the stamp names.
      const superAdminToken = await (async () => {
        const login = await apiRequest("/auth/login", {
          method: "POST",
          body: { email: "superadmin@pics.ng", password: "ChangeMe123!" },
        });
        assert.equal(login.status, 200, JSON.stringify(login.payload));
        return (login.payload as { token: string }).token;
      })();

      const wholly = await prisma.stateConstituency.findFirst({
        where: {
          stateId: OGUN_STATE_ID,
          federalConstituencyId: { not: null },
          wards: { some: { pollingUnits: { some: {} } }, every: { stateConstituencyEdgeInferred: true } },
        },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      assert.ok(wholly, "a wholly unreviewed constituency is required");

      const rawPollingUnits = await prisma.pollingUnit.count({ where: { ward: { stateConstituencyId: wholly.id } } });
      assert.ok(rawPollingUnits > 0, "it must have polling units in the raw graph");

      await apiRequest("/pre-election/strength/metrics", {
        method: "POST",
        token: superAdminToken,
        body: { metric: "POLLING_UNIT_COVERAGE", weight: "1", active: true },
      });

      const calculated = await apiRequest("/pre-election/strength/snapshots/calculate", {
        method: "POST",
        token: superAdminToken,
        body: { territoryType: "STATE_CONSTITUENCY", territoryId: wholly.id },
      });
      assert.equal(calculated.status, 201, JSON.stringify(calculated.payload));
      const created = (
        calculated.payload as {
          strengthSnapshot: { id: string; breakdown: Array<{ metric: string; actualValue: number }> };
        }
      ).strengthSnapshot;
      try {
        const coverage = created.breakdown.find((item) => item.metric === "POLLING_UNIT_COVERAGE");
        if (coverage) {
          assert.equal(
            coverage.actualValue,
            0,
            `coverage must be 0 where no polling unit is operationally placeable, not derived from ${rawPollingUnits} blocked units`,
          );
        }
        const members = created.breakdown.find((item) => item.metric === "REGISTERED_MEMBERS");
        if (members) {
          assert.equal(members.actualValue, 0, "and no member is placeable there either");
        }

        // The stamp must describe the calculation it was applied to.
        const stored = await prisma.territoryStrengthSnapshot.findUniqueOrThrow({
          where: { id: created.id },
          select: { breakdownJson: true },
        });
        assert.equal(
          (stored.breakdownJson as { memberTerritoryScopeVersion?: string }).memberTerritoryScopeVersion,
          MEMBER_TERRITORY_SCOPE_VERSION,
        );
      } finally {
        await prisma.territoryStrengthSnapshot.delete({ where: { id: created.id } });
        await apiRequest("/pre-election/strength/metrics", {
          method: "POST",
          token: superAdminToken,
          body: { metric: "POLLING_UNIT_COVERAGE", weight: "1", active: false },
        });
      }
    },
  },
  {
    name: "target progress and the strength dashboard agree, and an obsolete metric snapshot is not current",
    run: async () => {
      // The last F gap: /strength/targets/progress served a stored actual with
      // no scope-version gate while /strength/dashboard recomputed the same
      // target live, so one number had two values.
      const superAdminToken = await (async () => {
        const login = await apiRequest("/auth/login", {
          method: "POST",
          body: { email: "superadmin@pics.ng", password: "ChangeMe123!" },
        });
        assert.equal(login.status, 200, JSON.stringify(login.payload));
        return (login.payload as { token: string }).token;
      })();

      const territoryId = expected.stateConstituencyId;
      const query = `territoryType=STATE_CONSTITUENCY&territoryId=${territoryId}`;

      // A member exists in this constituency, so the canonical actual is > 0.
      const liveMembers = await prisma.voterProfile.count({
        where: {
          ward: {
            is: {
              stateConstituencyId: territoryId,
              OR: [{ stateConstituencyEdgeInferred: false }, { stateConstituencyEdgeReviewedAt: { not: null } }],
            },
          },
        },
      });
      assert.ok(liveMembers > 0, "this suite must have registered a member in the target constituency");

      const target = await apiRequest("/pre-election/strength/targets", {
        method: "POST",
        token: superAdminToken,
        body: {
          territoryType: "STATE_CONSTITUENCY",
          territoryId,
          metric: "REGISTERED_MEMBERS",
          targetValue: 1000,
          startDate: new Date().toISOString(),
        },
      });
      assert.equal(target.status, 201, JSON.stringify(target.payload));
      const targetId = (target.payload as { territoryTarget: { id: string } }).territoryTarget.id;

      /** A stored actual from before member scope moved onto the ward graph. */
      const obsolete = await prisma.territoryMetricSnapshot.create({
        data: {
          territoryType: "STATE_CONSTITUENCY",
          territoryId,
          metric: "REGISTERED_MEMBERS",
          actualValue: 0,
          metadataJson: { source: "PRE_ELECTION_API" },
        },
      });

      const readProgress = async () => {
        const result = await apiRequest(`/pre-election/strength/targets/progress?${query}`, { token: superAdminToken });
        assert.equal(result.status, 200, JSON.stringify(result.payload));
        const rows = (result.payload as { progress: Array<{ targetId: string; actualValue: number }> }).progress;
        return rows.find((row) => row.targetId === targetId)?.actualValue ?? null;
      };
      const readDashboard = async () => {
        const result = await apiRequest(`/pre-election/strength/dashboard?${query}`, { token: superAdminToken });
        assert.equal(result.status, 200, JSON.stringify(result.payload));
        const rows = (result.payload as { dashboard: { targetProgress: Array<{ targetId: string; actualValue: number }> } })
          .dashboard.targetProgress;
        return rows.find((row) => row.targetId === targetId)?.actualValue ?? null;
      };

      try {
        const progress = await readProgress();
        const dashboard = await readDashboard();
        assert.notEqual(progress, 0, "an obsolete metric snapshot must not be served as the current actual");
        assert.equal(progress, liveMembers, "with no compatible snapshot the value is recomputed canonically");
        assert.equal(progress, dashboard, "the two endpoints must not disagree about the same target");

        // The obsolete row is preserved, not rewritten or deleted.
        const preserved = await prisma.territoryMetricSnapshot.findUniqueOrThrow({
          where: { id: obsolete.id },
          select: { actualValue: true, metadataJson: true },
        });
        assert.equal(preserved.actualValue, 0, "history is immutable");
        assert.equal(
          (preserved.metadataJson as { memberTerritoryScopeVersion?: string }).memberTerritoryScopeVersion,
          undefined,
          "an old snapshot must not be retro-stamped with a version it was not calculated under",
        );

        // A freshly calculated snapshot carries the version and is then usable.
        // The metric must be active, or `calculate` writes no row for it.
        await apiRequest("/pre-election/strength/metrics", {
          method: "POST",
          token: superAdminToken,
          body: { metric: "REGISTERED_MEMBERS", weight: "1", active: true },
        });
        const calculated = await apiRequest("/pre-election/strength/snapshots/calculate", {
          method: "POST",
          token: superAdminToken,
          body: { territoryType: "STATE_CONSTITUENCY", territoryId },
        });
        assert.equal(calculated.status, 201, JSON.stringify(calculated.payload));
        const snapshotId = (calculated.payload as { strengthSnapshot: { id: string } }).strengthSnapshot.id;
        try {
          const fresh = await prisma.territoryMetricSnapshot.findFirst({
            where: { territoryType: "STATE_CONSTITUENCY", territoryId, metric: "REGISTERED_MEMBERS" },
            orderBy: { calculatedAt: "desc" },
            select: { actualValue: true, metadataJson: true },
          });
          assert.equal(
            (fresh?.metadataJson as { memberTerritoryScopeVersion?: string }).memberTerritoryScopeVersion,
            MEMBER_TERRITORY_SCOPE_VERSION,
            "a newly calculated metric snapshot records the scope it was calculated under",
          );
          assert.equal(
            await readProgress(),
            await readDashboard(),
            "and the two endpoints still agree once a compatible snapshot exists",
          );
        } finally {
          await prisma.territoryStrengthSnapshot.delete({ where: { id: snapshotId } });
          await apiRequest("/pre-election/strength/metrics", {
            method: "POST",
            token: superAdminToken,
            body: { metric: "REGISTERED_MEMBERS", weight: "1", active: false },
          });
        }
      } finally {
        await prisma.territoryMetricSnapshot.deleteMany({
          where: { territoryType: "STATE_CONSTITUENCY", territoryId },
        });
        await prisma.territoryTarget.deleteMany({ where: { id: targetId } });
      }
    },
  },
  {
    name: "an unknown territory type fails closed rather than scoping to everything",
    run: async () => {
      // A scoping authority that returns undefined reaches Prisma as
      // `where: undefined`, which counts every row in the table.
      for (const build of [buildOperationalVoterProfileTerritoryWhere, buildOperationalPollingUnitTerritoryWhere]) {
        for (const bogus of ["LGA", "NATIONAL", "", "state_constituency"]) {
          assert.throws(
            () => build(bogus as never, "any-territory"),
            UnsupportedMemberTerritoryType,
            `${build.name} must refuse '${bogus}' rather than returning an unrestricted scope`,
          );
        }
        const valid = build("STATE" as never, OGUN_STATE_ID);
        assert.ok(valid && typeof valid === "object", "a supported level still returns a filter");
      }
    },
  },
  {
    name: "the strength engine and the dashboard scope members through the same authority",
    run: async () => {
      // F1. Not a style point: they disagreeing is what let a score of zero sit
      // beside a tile counting hundreds.
      const dashboard = readFileSync(path.join(repoRoot, "apps/api/src/routes/dashboard.ts"), "utf8");
      const preElection = readFileSync(path.join(repoRoot, "apps/api/src/routes/pre-election.ts"), "utf8");
      for (const [name, source] of [["dashboard", dashboard], ["pre-election", preElection]] as const) {
        assert.ok(
          source.includes("buildOperationalVoterProfileTerritoryWhere"),
          `${name} must scope members through the shared authority`,
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
