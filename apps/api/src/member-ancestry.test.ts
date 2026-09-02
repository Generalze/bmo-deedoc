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
import { MEMBER_TERRITORY_SCOPE_VERSION } from "./lib/member-territory-scope";
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
