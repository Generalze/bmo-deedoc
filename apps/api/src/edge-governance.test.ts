import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { OGUN_STATE_ID } from "@pics-nigeria/shared";

import {
  applyIdentityRelease,
  validateIdentityRelease,
  validateManifest,
} from "../../../packages/database/scripts/import-ogun-reference-release";
import { hashPassword } from "./auth/password";
import { createApp } from "./app";
import { isWardConstituencyEdgeOperational, OPERATIONAL_WARD_EDGE } from "./lib/member-territory-scope";
import { prisma } from "./prisma";

/**
 * PR #13. Governance for inferred Ward -> State Constituency edges.
 *
 * The property under test throughout is that a decision is about an *edge*, and
 * that only an approval of the edge a ward currently has makes it operational.
 * A rejection is a decision too, and stamps the same review columns — which is
 * exactly why nothing may read a review timestamp as permission.
 *
 * Every fixture is synthetic Ogun territory created here and removed in
 * teardown. No real inferred edge is decided.
 */

type ApiResult = { status: number; payload: Record<string, unknown> };

const password = "EdgeGovTest123!";
const prefix = "edge-gov";

let baseUrl = "";
let server: http.Server | null = null;
let lgaId = "";

/** Two real constituencies, so an approval can be shown not to travel. */
let constituencyA = "";
let constituencyB = "";

let wardId = "";
let pollingUnitId = "";
let memberUserId = "";

const repoRoot = (() => {
  let current = __dirname;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(path.join(current, "packages", "database", "prisma", "ogun-migrations"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate the repository root from ${__dirname}.`);
})();

async function apiRequest(pathname: string, options?: { token?: string; method?: string; body?: unknown }): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options?.method || "GET",
    headers: {
      ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, payload: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

const tokens: Record<string, string> = {};

async function login(email: string, secret = password) {
  const result = await apiRequest("/auth/login", { method: "POST", body: { email, password: secret } });
  assert.equal(result.status, 200, `${email}: ${JSON.stringify(result.payload)}`);
  return (result.payload as { token: string }).token;
}

function email(slug: string) {
  return `${prefix}-${slug}@pics.ng`;
}

/** Returns the ward to a clean, undecided, inferred state on constituency A. */
async function resetEdge() {
  await prisma.wardConstituencyEdgeReview.deleteMany({ where: { wardId } });
  await prisma.ward.update({
    where: { id: wardId },
    data: {
      stateConstituencyId: constituencyA,
      stateConstituencyEdgeInferred: true,
      stateConstituencyEdgeInferenceBasis: "token overlap (1)",
      stateConstituencyEdgeApprovedForId: null,
      stateConstituencyEdgeReviewedAt: null,
      stateConstituencyEdgeReviewedBy: null,
    },
  });
}

async function wardRow() {
  return prisma.ward.findUniqueOrThrow({
    where: { id: wardId },
    select: {
      stateConstituencyId: true,
      stateConstituencyEdgeInferred: true,
      stateConstituencyEdgeApprovedForId: true,
      stateConstituencyEdgeReviewedAt: true,
      stateConstituencyEdgeReviewedBy: true,
    },
  });
}

/** Whether the shared filter — the one every scope query uses — admits the ward. */
async function operationalByFilter() {
  const match = await prisma.ward.count({ where: { id: wardId, ...OPERATIONAL_WARD_EDGE } });
  return match === 1;
}

async function setup() {
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Edge governance test server did not start.");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const constituencies = await prisma.stateConstituency.findMany({
    where: { stateId: OGUN_STATE_ID, federalConstituencyId: { not: null } },
    orderBy: { id: "asc" },
    take: 2,
    select: { id: true, lgaId: true },
  });
  assert.equal(constituencies.length, 2, "Ogun reference data must be imported before this suite.");
  constituencyA = constituencies[0].id;
  constituencyB = constituencies[1].id;
  lgaId = constituencies[0].lgaId;

  wardId = `${prefix}-ward`;
  await prisma.ward.create({
    data: {
      id: wardId,
      name: "Edge Governance Test Ward",
      stateId: OGUN_STATE_ID,
      lgaId,
      stateConstituencyId: constituencyA,
      stateConstituencyEdgeInferred: true,
      stateConstituencyEdgeInferenceBasis: "token overlap (1)",
    },
  });
  pollingUnitId = `${prefix}-pu`;
  await prisma.pollingUnit.create({
    data: { id: pollingUnitId, name: "Edge Governance Test PU", stateId: OGUN_STATE_ID, lgaId, wardId },
  });

  const passwordHash = await hashPassword(password);
  for (const [slug, role] of [
    ["state-officer", "STATE_OFFICER"],
    ["coordinator", "COORDINATOR"],
    ["validator", "VALIDATOR"],
    ["payout-officer", "PAYOUT_OFFICER"],
    ["member", "MEMBER"],
  ] as const) {
    await prisma.user.create({
      data: { name: `Edge Gov ${slug}`, email: email(slug), passwordHash, role },
    });
    tokens[slug] = await login(email(slug));
  }
  tokens.superAdmin = await login("superadmin@pics.ng", "ChangeMe123!");

  // A member on the ward, so impact counts have something to report.
  const member = await prisma.user.create({
    data: {
      name: "Edge Gov Member",
      email: email("ward-member"),
      passwordHash,
      role: "VOTER",
      voterProfile: {
        create: {
          voterCardNumber: "EDGE-GOV-MEMBER",
          referralCode: "EDGEGOV1",
          stateId: OGUN_STATE_ID,
          lgaId,
          wardId,
          pollingUnitId,
        },
      },
    },
    select: { id: true },
  });
  memberUserId = member.id;
}

async function teardown() {
  await prisma.wardConstituencyEdgeReview.deleteMany({ where: { wardId } });
  const users = await prisma.user.findMany({ where: { email: { startsWith: prefix } }, select: { id: true } });
  const ids = users.map((user) => user.id);
  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({ where: { actorUserId: { in: ids } } });
    await prisma.voterProfile.deleteMany({ where: { userId: { in: ids } } });
    await prisma.coordinatorProfile.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.pollingUnit.deleteMany({ where: { id: pollingUnitId } });
  await prisma.ward.deleteMany({ where: { id: wardId } });
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
}

const approve = (body: unknown, token = tokens.superAdmin) =>
  apiRequest(`/governance/inferred-edges/${wardId}/approve`, { method: "POST", token, body });
const reject = (body: unknown, token = tokens.superAdmin) =>
  apiRequest(`/governance/inferred-edges/${wardId}/reject`, { method: "POST", token, body });

const goodReason = "Cross-checked the workbook ward list against the delimitation API for this LGA.";

const cases: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "an undecided inferred edge is blocked and listed as pending",
    run: async () => {
      await resetEdge();
      const ward = await wardRow();
      assert.equal(isWardConstituencyEdgeOperational(ward), false);
      assert.equal(await operationalByFilter(), false, "the row rule and the query filter must agree");

      const list = await apiRequest("/governance/inferred-edges?state=PENDING", { token: tokens.superAdmin });
      assert.equal(list.status, 200, JSON.stringify(list.payload));
      const edges = (list.payload as { edges: Array<{ wardId: string; reviewState: string; operational: boolean }> }).edges;
      const mine = edges.find((edge) => edge.wardId === wardId);
      assert.ok(mine, "the undecided edge must appear in the pending list");
      assert.equal(mine.reviewState, "PENDING");
      assert.equal(mine.operational, false);
    },
  },
  {
    name: "approval makes the exact edge operational",
    run: async () => {
      await resetEdge();
      const result = await approve({ stateConstituencyId: constituencyA, reason: goodReason });
      assert.equal(result.status, 201, JSON.stringify(result.payload));

      const ward = await wardRow();
      assert.equal(ward.stateConstituencyEdgeApprovedForId, constituencyA);
      assert.equal(isWardConstituencyEdgeOperational(ward), true);
      assert.equal(await operationalByFilter(), true, "the row rule and the query filter must agree");
    },
  },
  {
    name: "rejection stamps a review timestamp and the edge stays blocked",
    run: async () => {
      // The decisive test that the old `reviewedAt != null` rule is dead: a
      // rejection sets exactly the column that used to mean "approved".
      await resetEdge();
      const result = await reject({ stateConstituencyId: constituencyA, reason: "The workbook places this ward in a different constituency." });
      assert.equal(result.status, 201, JSON.stringify(result.payload));

      const ward = await wardRow();
      assert.ok(ward.stateConstituencyEdgeReviewedAt, "a rejection is still a review and is timestamped");
      assert.equal(ward.stateConstituencyEdgeApprovedForId, null);
      assert.equal(isWardConstituencyEdgeOperational(ward), false, "a rejected edge must never be operational");
      assert.equal(await operationalByFilter(), false);
    },
  },
  {
    name: "a decision without a reason is refused",
    run: async () => {
      await resetEdge();
      for (const body of [
        { stateConstituencyId: constituencyA },
        { stateConstituencyId: constituencyA, reason: "" },
        { stateConstituencyId: constituencyA, reason: "too short" },
      ]) {
        assert.equal((await reject(body)).status, 400, `reject must require a reason: ${JSON.stringify(body)}`);
        assert.equal((await approve(body)).status, 400, `approve must require a reason: ${JSON.stringify(body)}`);
      }
      assert.equal(await prisma.wardConstituencyEdgeReview.count({ where: { wardId } }), 0);
    },
  },
  {
    name: "an approval does not carry to a different constituency",
    run: async () => {
      await resetEdge();
      assert.equal((await approve({ stateConstituencyId: constituencyA, reason: goodReason })).status, 201);

      /**
       * Moving the edge while leaving the approval behind is no longer a state
       * the database will hold, so this cannot be staged as a bare column
       * write — the attempt itself is the first assertion.
       */
      await assert.rejects(
        prisma.$executeRawUnsafe(`UPDATE "Ward" SET "stateConstituencyId" = $1 WHERE "id" = $2`, constituencyB, wardId),
        /Ward_edge_approval_matches_current_edge_check/,
        "an approval cannot be left naming the edge the ward has moved away from",
      );

      // A re-point therefore always carries the approval away with it, which is
      // what the importer does in one statement.
      await prisma.$executeRawUnsafe(
        `UPDATE "Ward" SET "stateConstituencyEdgeApprovedForId" = NULL, "stateConstituencyId" = $1 WHERE "id" = $2`,
        constituencyB,
        wardId,
      );

      const ward = await wardRow();
      assert.equal(ward.stateConstituencyEdgeApprovedForId, null, "the approval of A did not follow the ward to B");
      assert.equal(isWardConstituencyEdgeOperational(ward), false, "an approval of A must not make B operational");
      assert.equal(await operationalByFilter(), false, "and the filter agrees");

      const detail = await apiRequest(`/governance/inferred-edges/${wardId}`, { token: tokens.superAdmin });
      assert.equal((detail.payload as { edge: { reviewState: string } }).edge.reviewState, "PENDING", "B is undecided");
    },
  },
  {
    name: "a decision submitted against a stale edge is refused with 409",
    run: async () => {
      await resetEdge();
      // The reviewer opened the screen on A; the ward has since moved to B.
      // No approval exists yet, so the edge alone moves.
      await prisma.ward.update({ where: { id: wardId }, data: { stateConstituencyId: constituencyB } });

      const stale = await approve({ stateConstituencyId: constituencyA, reason: goodReason });
      assert.equal(stale.status, 409, JSON.stringify(stale.payload));
      assert.equal(stale.payload.code, "EDGE_CHANGED_RELOAD");
      assert.equal(await prisma.wardConstituencyEdgeReview.count({ where: { wardId } }), 0, "nothing is recorded");

      const ward = await wardRow();
      assert.equal(ward.stateConstituencyEdgeApprovedForId, null, "and B is certainly not approved");
      assert.equal(isWardConstituencyEdgeOperational(ward), false);
    },
  },
  {
    name: "re-importing the release clears an approval whose edge it moves, and keeps one it does not",
    run: async () => {
      // Exercises the importer's own clearing branch, not a simulation of it.
      //
      // This mutates a real release ward, so every mutation is undone in a
      // finally: an assertion failing here must not leave one of the genuine 55
      // edges sitting approved with no decision behind it.
      const releaseWard = await prisma.ward.findFirstOrThrow({
        where: { stateId: OGUN_STATE_ID, stateConstituencyEdgeInferred: true, id: { not: wardId } },
        orderBy: { id: "asc" },
        select: {
          id: true,
          stateConstituencyId: true,
          stateConstituencyEdgeInferred: true,
          stateConstituencyEdgeInferenceBasis: true,
          stateConstituencyEdgeApprovedForId: true,
          stateConstituencyEdgeReviewedAt: true,
          stateConstituencyEdgeReviewedBy: true,
        },
      });
      const releaseEdge = releaseWard.stateConstituencyId!;
      const otherConstituency = releaseEdge === constituencyA ? constituencyB : constituencyA;

      const restoreReleaseWard = async () => {
        await prisma.ward.update({
          where: { id: releaseWard.id },
          data: {
            // Order matters: the CHECK refuses an approval that names a
            // different edge, so the edge and its approval are restored together.
            stateConstituencyId: releaseWard.stateConstituencyId,
            stateConstituencyEdgeInferred: releaseWard.stateConstituencyEdgeInferred,
            stateConstituencyEdgeInferenceBasis: releaseWard.stateConstituencyEdgeInferenceBasis,
            stateConstituencyEdgeApprovedForId: releaseWard.stateConstituencyEdgeApprovedForId,
            stateConstituencyEdgeReviewedAt: releaseWard.stateConstituencyEdgeReviewedAt,
            stateConstituencyEdgeReviewedBy: releaseWard.stateConstituencyEdgeReviewedBy,
          },
        });
        await prisma.wardConstituencyEdgeReview.deleteMany({ where: { wardId: releaseWard.id } });
      };

      try {
        // Point it somewhere else and approve that, so the release disagrees.
        await prisma.ward.update({
          where: { id: releaseWard.id },
          data: { stateConstituencyId: otherConstituency, stateConstituencyEdgeApprovedForId: otherConstituency },
        });

        const releaseDir = path.join(repoRoot, "packages/database/reference/ogun/ogun-identity-2026-08-12");
        const manifest = validateManifest(releaseDir);
        assert.ok(manifest.value, JSON.stringify(manifest.failures));
        const payload = validateIdentityRelease(releaseDir, manifest.value.manifest);
        assert.ok(payload.value, JSON.stringify(payload.failures));
        await applyIdentityRelease(manifest.value.manifest, manifest.value.manifestPath, payload.value);

        const afterMove = await prisma.ward.findUniqueOrThrow({
          where: { id: releaseWard.id },
          select: { stateConstituencyId: true, stateConstituencyEdgeApprovedForId: true },
        });
        assert.equal(afterMove.stateConstituencyId, releaseEdge, "the release restored its own edge");
        assert.equal(
          afterMove.stateConstituencyEdgeApprovedForId,
          null,
          "an approval for the edge the release moved away from must be cleared",
        );

        // Now approve the edge the release actually asserts, and re-import again.
        await prisma.ward.update({
          where: { id: releaseWard.id },
          data: { stateConstituencyEdgeApprovedForId: releaseEdge },
        });
        await applyIdentityRelease(manifest.value.manifest, manifest.value.manifestPath, payload.value);
        const afterSame = await prisma.ward.findUniqueOrThrow({
          where: { id: releaseWard.id },
          select: { stateConstituencyEdgeApprovedForId: true },
        });
        assert.equal(
          afterSame.stateConstituencyEdgeApprovedForId,
          releaseEdge,
          "re-importing the same release must not revoke a human approval",
        );
      } finally {
        await restoreReleaseWard();
      }

      const restored = await prisma.ward.findUniqueOrThrow({
        where: { id: releaseWard.id },
        select: { stateConstituencyId: true, stateConstituencyEdgeApprovedForId: true },
      });
      assert.equal(restored.stateConstituencyId, releaseEdge, "the release ward is left as it was found");
      assert.equal(restored.stateConstituencyEdgeApprovedForId, null, "and unapproved");
    },
  },
  {
    name: "an edge the release reclassifies as sourced loses its approval projection",
    run: async () => {
      await resetEdge();
      assert.equal((await approve({ stateConstituencyId: constituencyA, reason: goodReason })).status, 201);

      // A release that no longer infers this edge.
      await prisma.$executeRawUnsafe(
        `UPDATE "Ward" SET "stateConstituencyEdgeApprovedForId" = NULL, "stateConstituencyEdgeInferred" = false WHERE "id" = $1`,
        wardId,
      );
      const ward = await wardRow();
      assert.equal(ward.stateConstituencyEdgeApprovedForId, null);
      assert.equal(
        isWardConstituencyEdgeOperational(ward),
        true,
        "a sourced edge is operational by the source rule, not by an approval",
      );
    },
  },
  {
    name: "each decision writes an audit entry carrying the edge, reason and impact",
    run: async () => {
      await resetEdge();
      const before = await prisma.auditLog.count();
      // Audit is append-only, so earlier cases in this suite have already
      // written entries for this same edge. Only this case's own decisions are
      // asserted on.
      const startedAt = new Date();
      await new Promise((resolve) => setTimeout(resolve, 5));

      assert.equal((await approve({ stateConstituencyId: constituencyA, reason: goodReason })).status, 201);
      assert.equal(
        (await reject({ stateConstituencyId: constituencyA, reason: "Reversing on further reading of the workbook." })).status,
        201,
      );

      const entries = await prisma.auditLog.findMany({
        where: {
          targetType: "WARD_CONSTITUENCY_EDGE",
          targetId: `${wardId}:${constituencyA}`,
          createdAt: { gte: startedAt },
        },
        orderBy: { createdAt: "asc" },
        select: { action: true, metadataJson: true, actorUserId: true },
      });
      assert.equal(entries.length, 2, "one entry per decision");
      assert.equal(entries[0].action, "WARD_EDGE_REVIEW_APPROVED");
      assert.equal(entries[1].action, "WARD_EDGE_REVIEW_REJECTED");
      assert.ok(await prisma.auditLog.count() > before, "audit is append-only");

      for (const entry of entries) {
        const metadata = JSON.parse(entry.metadataJson || "{}");
        assert.ok(metadata.reason, "the reason is preserved in the audit record");
        assert.equal(metadata.inferenceBasis, "token overlap (1)");
        assert.equal(typeof metadata.affectedMemberCount, "number");
        assert.equal(typeof metadata.affectedCoordinatorCount, "number");
        assert.equal(metadata.territory.wardId, wardId);
        assert.equal(metadata.territory.stateConstituencyId, constituencyA);
      }
    },
  },
  {
    name: "only a super admin may decide an edge",
    run: async () => {
      await resetEdge();
      for (const role of ["state-officer", "coordinator", "validator", "payout-officer", "member"]) {
        const denied = await approve({ stateConstituencyId: constituencyA, reason: goodReason }, tokens[role]);
        assert.equal(denied.status, 403, `${role} must not decide: ${JSON.stringify(denied.payload)}`);
        const deniedList = await apiRequest("/governance/inferred-edges", { token: tokens[role] });
        assert.equal(deniedList.status, 403, `${role} must not read the governance queue`);
      }
      const anonymous = await apiRequest(`/governance/inferred-edges/${wardId}/approve`, {
        method: "POST",
        body: { stateConstituencyId: constituencyA, reason: goodReason },
      });
      assert.equal(anonymous.status, 401);
      assert.equal(await prisma.wardConstituencyEdgeReview.count({ where: { wardId } }), 0, "nothing was decided");
    },
  },
  {
    name: "approval makes the edge usable for member ancestry, and rejection does not",
    run: async () => {
      await resetEdge();
      const register = (slug: string) =>
        apiRequest("/auth/register-voter", {
          method: "POST",
          body: {
            fullName: `Edge Gov ${slug}`,
            email: email(slug),
            phone: "08032000002",
            password,
            voterCardNumber: `EDGE-GOV-${slug.toUpperCase()}`,
            stateId: OGUN_STATE_ID,
            lgaId,
            wardId,
            pollingUnitId,
            acceptTerms: true,
            acceptPrivacy: true,
            contactConsent: true,
            confirmAdult: true,
          },
        });

      const blocked = await register("pending-registrant");
      assert.equal(blocked.status, 400, JSON.stringify(blocked.payload));
      assert.equal(blocked.payload.code, "ANCESTRY_EDGE_UNREVIEWED");

      assert.equal((await reject({ stateConstituencyId: constituencyA, reason: "Not confident in this mapping yet." })).status, 201);
      const stillBlocked = await register("rejected-registrant");
      assert.equal(stillBlocked.payload.code, "ANCESTRY_EDGE_UNREVIEWED", "a rejection does not unblock");

      assert.equal((await approve({ stateConstituencyId: constituencyA, reason: goodReason })).status, 201);
      const allowed = await register("approved-registrant");
      assert.equal(allowed.status, 201, JSON.stringify(allowed.payload));
      const profile = await prisma.voterProfile.findFirstOrThrow({
        where: { user: { email: email("approved-registrant") } },
        select: { stateConstituencyId: true },
      });
      assert.equal(profile.stateConstituencyId, constituencyA, "and the derived ancestry is the approved edge");
    },
  },
  {
    name: "approval changes constituency-level counting through the shared authority",
    run: async () => {
      await resetEdge();
      const officerEmail = email("dashboard-officer");
      if (!(await prisma.user.findUnique({ where: { email: officerEmail } }))) {
        await prisma.user.create({
          data: {
            name: "Edge Gov Dashboard Officer",
            email: officerEmail,
            passwordHash: await hashPassword(password),
            role: "STATE_OFFICER",
            coordinatorProfile: { create: { level: "STATE_CONSTITUENCY", stateId: OGUN_STATE_ID } },
          },
        });
      }
      const token = await login(officerEmail);
      const count = async () => {
        const view = await apiRequest(`/dashboard?level=STATE_CONSTITUENCY&territoryId=${constituencyA}`, { token });
        assert.equal(view.status, 200, JSON.stringify(view.payload));
        const tiles = (view.payload as { dashboard: { tiles: Array<{ key: string; value: number }> } }).dashboard.tiles;
        return tiles.find((tile) => tile.key === "REGISTERED_MEMBERS")?.value ?? 0;
      };

      const blocked = await count();
      assert.equal((await reject({ stateConstituencyId: constituencyA, reason: "Holding this one back for now." })).status, 201);
      assert.equal(await count(), blocked, "a rejection changes no count");

      assert.equal((await approve({ stateConstituencyId: constituencyA, reason: goodReason })).status, 201);
      assert.ok(await count() > blocked, "approval brings the ward's members into the constituency count");
    },
  },
  {
    name: "impact counts are reads and no profile is modified by a decision",
    run: async () => {
      await resetEdge();
      const before = await prisma.voterProfile.findFirstOrThrow({
        where: { userId: memberUserId },
        select: { stateId: true, lgaId: true, wardId: true, stateConstituencyId: true, federalConstituencyId: true, senatorialDistrictId: true },
      });
      const coordinatorsBefore = await prisma.coordinatorProfile.count();

      const detail = await apiRequest(`/governance/inferred-edges/${wardId}`, { token: tokens.superAdmin });
      const impact = (detail.payload as { edge: { impact: { members: number; coordinators: number } } }).edge.impact;
      assert.ok(impact.members >= 1, "the member on this ward is reported");
      assert.equal(typeof impact.coordinators, "number");

      assert.equal((await approve({ stateConstituencyId: constituencyA, reason: goodReason })).status, 201);

      const after = await prisma.voterProfile.findFirstOrThrow({
        where: { userId: memberUserId },
        select: { stateId: true, lgaId: true, wardId: true, stateConstituencyId: true, federalConstituencyId: true, senatorialDistrictId: true },
      });
      assert.deepEqual(after, before, "a governance decision must not rewrite a member profile");
      assert.equal(await prisma.coordinatorProfile.count(), coordinatorsBefore, "nor touch coordinators");
    },
  },
  {
    name: "a decision never rewrites the ward's constituency, and there is no bulk route",
    run: async () => {
      await resetEdge();
      assert.equal(
        (await reject({ stateConstituencyId: constituencyA, reason: "This mapping looks wrong to me." })).status,
        201,
      );
      const ward = await wardRow();
      assert.equal(
        ward.stateConstituencyId,
        constituencyA,
        "rejecting records a judgement; correcting the mapping belongs to the reference data",
      );

      /**
       * The module registers exactly four routes and no others. Asserting the
       * whole set is stronger than blacklisting words a comment may legitimately
       * use, and it fails if any new decision surface appears.
       */
      const source = readFileSync(path.join(repoRoot, "apps/api/src/routes/edge-governance.ts"), "utf8");
      const registered = [...source.matchAll(/router\.(get|post)\(\s*"([^"]+)"/g)].map(
        (match) => `${match[1].toUpperCase()} ${match[2]}`,
      );
      assert.deepEqual(
        registered.sort(),
        [
          "GET /inferred-edges",
          "GET /inferred-edges/:wardId",
          "POST /inferred-edges/:wardId/approve",
          "POST /inferred-edges/:wardId/reject",
        ],
        `governance exposes an unexpected route surface: ${JSON.stringify(registered)}`,
      );
      assert.ok(!source.includes("updateMany"), "no decision may be applied to more than one edge");
      for (const route of ["/governance/inferred-edges/approve-all", "/governance/inferred-edges/bulk"]) {
        const attempt = await apiRequest(route, { method: "POST", token: tokens.superAdmin, body: { reason: goodReason } });
        assert.equal(attempt.status, 404, `${route} must not exist`);
      }
    },
  },
  {
    name: "the database refuses a projection that names an edge the ward does not have",
    run: async () => {
      await resetEdge();
      // The last wall. Application code can only try to preserve this; the
      // constraint makes the divergent state unrepresentable, which is what
      // makes the null-checking filter equivalent to the row rule.
      await assert.rejects(
        prisma.$executeRawUnsafe(
          `UPDATE "Ward" SET "stateConstituencyEdgeApprovedForId" = $1 WHERE "id" = $2`,
          constituencyB,
          wardId,
        ),
        /Ward_edge_approval_matches_current_edge_check/,
        "an approval naming a different constituency must be rejected by the database",
      );

      await assert.rejects(
        prisma.$executeRawUnsafe(
          `UPDATE "Ward" SET "stateConstituencyId" = NULL, "stateConstituencyEdgeApprovedForId" = $1 WHERE "id" = $2`,
          constituencyA,
          wardId,
        ),
        /Ward_edge_approval_matches_current_edge_check/,
        "an approval on a ward with no current edge must be rejected; a NULL comparison must not slip through",
      );

      await assert.rejects(
        prisma.$executeRawUnsafe(
          `UPDATE "Ward" SET "stateConstituencyEdgeInferred" = false, "stateConstituencyEdgeApprovedForId" = $1 WHERE "id" = $2`,
          constituencyA,
          wardId,
        ),
        /Ward_edge_approval_matches_current_edge_check/,
        "an inferred-edge approval has no meaning on a sourced edge",
      );

      const ward = await wardRow();
      assert.equal(ward.stateConstituencyEdgeApprovedForId, null, "and none of it took effect");
    },
  },
  {
    name: "a decision taken while the edge moves underneath it cannot leave a mismatched projection",
    run: async () => {
      await resetEdge();
      // Governance and the importer racing on one ward. Whichever order they
      // land in, the forbidden end state -- current edge B, approval A -- must
      // be unreachable, and the loser must fail cleanly.
      const decision = approve({ stateConstituencyId: constituencyA, reason: goodReason });
      const repoint = prisma.$executeRawUnsafe(
        `UPDATE "Ward" SET "stateConstituencyEdgeApprovedForId" = NULL, "stateConstituencyId" = $1 WHERE "id" = $2`,
        constituencyB,
        wardId,
      );
      const [decided] = await Promise.all([decision, repoint.catch(() => -1)]);

      const ward = await wardRow();
      if (ward.stateConstituencyEdgeApprovedForId !== null) {
        assert.equal(
          ward.stateConstituencyEdgeApprovedForId,
          ward.stateConstituencyId,
          "an approval may only ever name the edge the ward currently has",
        );
      }
      assert.ok(
        [201, 409].includes(decided.status),
        `the decision must either succeed against the edge it saw or be refused: ${decided.status}`,
      );
      if (decided.status === 409) {
        assert.equal(decided.payload.code, "EDGE_CHANGED_RELOAD");
      }
      assert.equal(
        isWardConstituencyEdgeOperational(ward),
        await operationalByFilter(),
        "the row rule and the filter must agree even after a race",
      );
    },
  },
  {
    name: "concurrent approve and reject leave one decision governing, agreed everywhere",
    run: async () => {
      await resetEdge();
      const [first, second] = await Promise.all([
        approve({ stateConstituencyId: constituencyA, reason: "Approving after checking the workbook." }),
        reject({ stateConstituencyId: constituencyA, reason: "Rejecting after checking the workbook." }),
      ]);
      assert.equal(first.status, 201, JSON.stringify(first.payload));
      assert.equal(second.status, 201, JSON.stringify(second.payload));

      // Append-only: both are recorded.
      const history = await prisma.wardConstituencyEdgeReview.findMany({
        where: { wardId, stateConstituencyId: constituencyA },
        orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
        select: { outcome: true, decidedAt: true },
      });
      assert.equal(history.length, 2, "both decisions are kept");
      assert.notEqual(
        history[0].decidedAt.getTime(),
        history[1].decidedAt.getTime(),
        "decision times are forced apart under the lock, so 'newest' is deterministic",
      );

      // And one of them governs, consistently across every surface.
      const ward = await wardRow();
      const detail = await apiRequest(`/governance/inferred-edges/${wardId}`, { token: tokens.superAdmin });
      const edge = (detail.payload as { edge: { reviewState: string; operational: boolean } }).edge;
      const latest = history[0].outcome;

      assert.equal(edge.operational, isWardConstituencyEdgeOperational(ward));
      assert.equal(edge.operational, await operationalByFilter());
      if (latest === "APPROVED") {
        assert.equal(ward.stateConstituencyEdgeApprovedForId, constituencyA);
        assert.equal(edge.reviewState, "APPROVED");
        assert.equal(edge.operational, true);
      } else {
        assert.equal(ward.stateConstituencyEdgeApprovedForId, null);
        assert.equal(edge.reviewState, "REJECTED");
        assert.equal(edge.operational, false);
      }
    },
  },
  {
    name: "a ward repointed away and back is offered for review again, not shown as approved",
    run: async () => {
      await resetEdge();
      assert.equal((await approve({ stateConstituencyId: constituencyA, reason: goodReason })).status, 201);

      // A release moves it away — the approval goes with the edge...
      await prisma.$executeRawUnsafe(
        `UPDATE "Ward" SET "stateConstituencyEdgeApprovedForId" = NULL, "stateConstituencyId" = $1 WHERE "id" = $2`,
        constituencyB,
        wardId,
      );
      // ...and a later correction brings it back. The evidence in between
      // changed; the old approval is history, not a current verdict.
      await prisma.$executeRawUnsafe(
        `UPDATE "Ward" SET "stateConstituencyId" = $1, "referenceImportReleaseId" = NULL WHERE "id" = $2`,
        constituencyA,
        wardId,
      );

      const ward = await wardRow();
      assert.equal(isWardConstituencyEdgeOperational(ward), false, "the ward is blocked");

      const detail = await apiRequest(`/governance/inferred-edges/${wardId}`, { token: tokens.superAdmin });
      const edge = (detail.payload as { edge: { reviewState: string; operational: boolean } }).edge;
      assert.equal(edge.operational, false);
      assert.equal(
        edge.reviewState,
        "PENDING",
        "a blocked ward must not be reported as approved, or it disappears from the queue",
      );

      const pendingList = await apiRequest("/governance/inferred-edges?state=PENDING", { token: tokens.superAdmin });
      const listed = (pendingList.payload as { edges: Array<{ wardId: string }> }).edges;
      assert.ok(
        listed.some((item) => item.wardId === wardId),
        "and it is offered for review again",
      );

      // The earlier decision is still visible as history.
      const history = (detail.payload as { history: Array<{ outcome: string }> }).history;
      assert.ok(history.some((entry) => entry.outcome === "APPROVED"), "history keeps the earlier approval");
    },
  },
  {
    name: "the row rule and the scope filter select the same wards across the whole state",
    run: async () => {
      // The filter can only test the approval for null; the row rule also
      // compares it to the ward's current edge. They agree only because the
      // importer clears a stale approval — so that agreement is measured.
      await resetEdge();
      const wards = await prisma.ward.findMany({
        where: { stateId: OGUN_STATE_ID },
        select: {
          id: true,
          stateConstituencyId: true,
          stateConstituencyEdgeInferred: true,
          stateConstituencyEdgeApprovedForId: true,
        },
      });
      const byRule = new Set(wards.filter((ward) => isWardConstituencyEdgeOperational(ward)).map((ward) => ward.id));
      const byFilter = new Set(
        (
          await prisma.ward.findMany({ where: { stateId: OGUN_STATE_ID, ...OPERATIONAL_WARD_EDGE }, select: { id: true } })
        ).map((ward) => ward.id),
      );
      assert.equal(byRule.size, byFilter.size, `row rule ${byRule.size} vs filter ${byFilter.size}`);
      for (const id of byRule) {
        assert.ok(byFilter.has(id), `${id} is operational by the row rule but not by the filter`);
      }
    },
  },
];

export async function runEdgeGovernanceTests() {
  await setup();
  try {
    for (const testCase of cases) {
      await testCase.run();
      console.log(`PASS ${testCase.name}`);
    }
  } finally {
    await resetEdge().catch(() => undefined);
    await teardown();
  }
}
