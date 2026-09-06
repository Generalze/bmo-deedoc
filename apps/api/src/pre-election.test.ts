import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import {
  CommittedObjectDeletionRefused,
  discardPendingObject,
  getPrivateObjectStorage,
  promotePendingObject,
} from "@pics-nigeria/object-storage";
import { createApp } from "./app";
import { hashPassword } from "./auth/password";
import { env } from "./env";
import { PayoutExecutionDisabledError, setPayoutExecutionEnabledForTests } from "./lib/payout-authority";
import { PayoutExecutionError, executePayout } from "./lib/payout-execution";
import { createRewardEntryWithNotification } from "./lib/rewards";
import { prisma } from "./prisma";

type ApiResult = { status: number; payload: Record<string, unknown> };

const password = "PreElection123!";
const stateId = "ng-state-ogun";
const senatorialDistrictId = "pre-election-test-sen";
const federalConstituencyId = "pre-election-test-fed";
const stateConstituencyId = "pre-election-test-state-const";
const lgaId = "pre-election-test-lga";
const wardId = "pre-election-test-ward";
const pollingUnitId = "pre-election-test-pu";
const emailPrefix = "pre-election-test";

let baseUrl = "";
let server: http.Server | null = null;

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

async function textRequest(path: string, options?: { token?: string; method?: string; body?: unknown }) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options?.method || "GET",
    headers: {
      ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, body: await response.text() };
}

async function login(email: string) {
  const result = await apiRequest("/auth/login", { method: "POST", body: { email, password } });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal(typeof result.payload.token, "string");
  return result.payload.token as string;
}

function testEmail(label: string) {
  return `${emailPrefix}-${label}@pics.ng`;
}

async function createTerritoryFixtures() {
  await prisma.state.upsert({
    where: { id: stateId },
    update: { name: "Ogun" },
    create: { id: stateId, name: "Ogun" },
  });
  await prisma.lGA.upsert({
    where: { id: lgaId },
    update: { name: "Pre Election Test LGA", stateId },
    create: { id: lgaId, name: "Pre Election Test LGA", stateId },
  });
  await prisma.senatorialDistrict.upsert({
    where: { id: senatorialDistrictId },
    update: { name: "Pre Election Test Senatorial", stateId },
    create: { id: senatorialDistrictId, name: "Pre Election Test Senatorial", stateId },
  });
  await prisma.federalConstituency.upsert({
    where: { id: federalConstituencyId },
    update: { name: "Pre Election Test Federal", stateId, senatorialDistrictId },
    create: { id: federalConstituencyId, name: "Pre Election Test Federal", stateId, senatorialDistrictId },
  });
  await prisma.stateConstituency.upsert({
    where: { id: stateConstituencyId },
    update: { name: "Pre Election Test State Constituency", stateId, lgaId, federalConstituencyId },
    create: { id: stateConstituencyId, name: "Pre Election Test State Constituency", stateId, lgaId, federalConstituencyId },
  });
  await prisma.ward.upsert({
    where: { id: wardId },
    update: { name: "Pre Election Test Ward", stateId, lgaId, stateConstituencyId },
    create: { id: wardId, name: "Pre Election Test Ward", stateId, lgaId, stateConstituencyId },
  });
  await prisma.pollingUnit.upsert({
    where: { id: pollingUnitId },
    update: { name: "Pre Election Test Polling Unit", stateId, lgaId, wardId },
    create: { id: pollingUnitId, name: "Pre Election Test Polling Unit", stateId, lgaId, wardId },
  });
}

async function createUserFixtures() {
  const passwordHash = await hashPassword(password);
  await prisma.user.create({
    data: {
      name: "Pre Election Test Super Admin",
      email: testEmail("super-admin"),
      passwordHash,
      role: "SUPER_ADMIN",
    },
  });
  await prisma.user.create({
    data: {
      name: "Pre Election Test Validator",
      email: testEmail("validator"),
      passwordHash,
      role: "VALIDATOR",
    },
  });
  await prisma.user.create({
    data: {
      name: "Pre Election Test Payout Officer",
      email: testEmail("payout"),
      passwordHash,
      role: "PAYOUT_OFFICER",
    },
  });
  await prisma.user.create({
    data: {
      name: "Pre Election Test Other Payout Officer",
      email: testEmail("payout-other"),
      passwordHash,
      role: "PAYOUT_OFFICER",
    },
  });
  await prisma.user.create({
    data: {
      name: "Pre Election Test Coordinator",
      email: testEmail("coordinator"),
      passwordHash,
      role: "COORDINATOR",
      coordinatorProfile: {
        create: {
          level: "WARD",
          stateId,
          senatorialDistrictId,
          federalConstituencyId,
          stateConstituencyId,
          wardId,
        },
      },
    },
  });
}

/**
 * A minimal, genuinely valid PDF. The server checks the magic number and hashes
 * the bytes, so a fixture has to be a real document: two members sharing a seed
 * share a hash because they submitted the same file, which is what the
 * duplicate-document check is meant to detect.
 */
function pdfDocument(seed: string) {
  return Buffer.from(`%PDF-1.4
% pre-election test document ${seed}
%%EOF
`, "utf8").toString("base64");
}

async function registerMember(label: string, referralCode: string | null, documentSeed: string) {
  const response = await apiRequest("/auth/register-voter", {
    method: "POST",
    body: {
      fullName: `Pre Election Test Member ${label}`,
      email: testEmail(`member-${label}`),
      phone: `08030000${label.padStart(3, "0")}`,
      password,
      voterCardNumber: `PRE-ELECTION-VIN-${label}`,
      stateId,
      // The three constituency ids are no longer part of the request contract;
      // the server derives them from the ward and refuses a caller that sends
      // them. The fixture's ward still resolves to the same chain.
      lgaId,
      wardId,
      pollingUnitId,
      referredByCode: referralCode || undefined,
      acceptTerms: true,
      acceptPrivacy: true,
      contactConsent: true,
      documentProcessingConsent: true,
      confirmAdult: true,
      consentVersion: "pre-election-test-v1",
      voterDocument: {
        originalFileName: `${label}.pdf`,
        mimeType: "application/pdf",
        content: pdfDocument(documentSeed),
      },
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.payload));
  return response.payload.user as { id: string; email: string };
}

async function cleanup() {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: emailPrefix } },
    select: { id: true },
  });
  const userIds = users.map((user) => user.id);

  if (userIds.length > 0) {
    await prisma.payoutExecution.deleteMany({
      where: { OR: [{ beneficiaryUserId: { in: userIds } }, { executedByUserId: { in: userIds } }] },
    });
    await prisma.payoutTransaction.deleteMany({
      where: { OR: [{ payoutOfficerUserId: { in: userIds } }, { payoutAssignment: { beneficiaryUserId: { in: userIds } } }] },
    });
    await prisma.payoutAssignment.deleteMany({
      where: { OR: [{ payoutOfficerUserId: { in: userIds } }, { beneficiaryUserId: { in: userIds } }] },
    });
    await prisma.payoutBatch.deleteMany({ where: { assignments: { none: {} } } });
    await prisma.payoutCycle.deleteMany({ where: { batches: { none: {} }, assignments: { none: {} } } });
    await prisma.payoutConfiguration.deleteMany({ where: { createdByUserId: { in: userIds } } });
    await prisma.territoryStrengthSnapshot.deleteMany({ where: { territoryId: { in: [stateId, wardId, pollingUnitId] } } });
    await prisma.territoryMetricSnapshot.deleteMany({ where: { territoryId: { in: [stateId, wardId, pollingUnitId] } } });
    await prisma.territoryTarget.deleteMany({ where: { createdByUserId: { in: userIds } } });
    await prisma.strengthWeightConfiguration.deleteMany({ where: { createdByUserId: { in: userIds } } });
    await prisma.strengthMetricDefinition.deleteMany({ where: { createdByUserId: { in: userIds } } });
    await prisma.legacyBalanceCarryover.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.legacyReconciliationPolicy.deleteMany({ where: { createdByUserId: { in: userIds } } });
    await prisma.legacyMigrationBatch.deleteMany({ where: { snapshotChecksum: "test-snapshot-checksum" } });
    await prisma.rewardLedgerEntry.deleteMany({
      where: { OR: [{ userId: { in: userIds } }, { relatedUserId: { in: userIds } }] },
    });
    await prisma.rewardEvent.deleteMany({
      where: {
        OR: [
          { referral: { referrerUserId: { in: userIds } } },
          { referral: { referredUserId: { in: userIds } } },
          // Milestone bonus events carry no referral link, so they are matched
          // through the rule version that produced them.
          { rewardRuleVersion: { rewardRule: { createdByUserId: { in: userIds } } } },
        ],
      },
    });
    await prisma.rewardRuleVersion.deleteMany({
      where: { rewardRule: { createdByUserId: { in: userIds } } },
    });
    await prisma.rewardRule.deleteMany({ where: { createdByUserId: { in: userIds } } });
    await prisma.referral.deleteMany({
      where: { OR: [{ referrerUserId: { in: userIds } }, { referredUserId: { in: userIds } }] },
    });
    await prisma.referralCode.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await prisma.voterVerification.deleteMany({ where: { memberUserId: { in: userIds } } });
    await prisma.rewardLedger.deleteMany({
      where: { OR: [{ voterUserId: { in: userIds } }, { relatedUserId: { in: userIds } }] },
    });
    await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  await prisma.pollingUnit.deleteMany({ where: { id: pollingUnitId } });
  await prisma.ward.deleteMany({ where: { id: wardId } });
  await prisma.stateConstituency.deleteMany({ where: { id: stateConstituencyId } });
  await prisma.federalConstituency.deleteMany({ where: { id: federalConstituencyId } });
  await prisma.senatorialDistrict.deleteMany({ where: { id: senatorialDistrictId } });
  await prisma.lGA.deleteMany({ where: { id: lgaId } });
}

export async function runPreElectionTests() {
  await cleanup();
  await createTerritoryFixtures();
  await createUserFixtures();

  server = createApp().listen(0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const superAdminToken = await login(testEmail("super-admin"));
    const validatorToken = await login(testEmail("validator"));
    const coordinatorToken = await login(testEmail("coordinator"));
    const payoutToken = await login(testEmail("payout"));
    const otherPayoutToken = await login(testEmail("payout-other"));

    const validatorRuleAttempt = await apiRequest("/pre-election/reward-rules", {
      method: "POST",
      token: validatorToken,
      body: { name: "Validator forbidden rule", directPoints: 10 },
    });
    assert.equal(validatorRuleAttempt.status, 403);

    const payoutDecisionAttempt = await apiRequest("/pre-election/verifications/missing/decision", {
      method: "PATCH",
      token: payoutToken,
      body: { decision: "APPROVE" },
    });
    assert.equal(payoutDecisionAttempt.status, 403);

    const rule = await apiRequest("/pre-election/reward-rules", {
      method: "POST",
      token: superAdminToken,
      body: { name: "Verified referral coordinator rule", directPoints: 25, eligibleRole: "COORDINATOR" },
    });
    assert.equal(rule.status, 201, JSON.stringify(rule.payload));

    const referralCodeResponse = await apiRequest("/pre-election/referral-code", { token: coordinatorToken });
    assert.equal(referralCodeResponse.status, 200, JSON.stringify(referralCodeResponse.payload));
    assert.equal(typeof referralCodeResponse.payload.referralCode, "string");

    const referredMember = await registerMember(
      "001",
      referralCodeResponse.payload.referralCode as string,
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    const referredMemberToken = await login(testEmail("member-001"));
    const referrer = await prisma.user.findUniqueOrThrow({ where: { email: testEmail("coordinator") }, select: { id: true } });

    assert.equal(await prisma.rewardLedger.count({ where: { voterUserId: referrer.id } }), 0);
    assert.equal(await prisma.rewardLedgerEntry.count({ where: { userId: referrer.id } }), 0);

    const referral = await prisma.referral.findUniqueOrThrow({ where: { referredUserId: referredMember.id } });
    assert.equal(referral.status, "PENDING_VERIFICATION");

    const memberVerification = await apiRequest("/pre-election/verifications/me", { token: referredMemberToken });
    assert.equal(memberVerification.status, 200, JSON.stringify(memberVerification.payload));
    assert.equal((memberVerification.payload.verification as { status: string }).status, "PENDING");

    const resubmission = await apiRequest("/pre-election/verifications/me/documents", {
      method: "POST",
      token: referredMemberToken,
      body: {
        documentProcessingConsent: true,
        voterDocument: {
          originalFileName: "001-resubmission.pdf",
          mimeType: "application/pdf",
          content: pdfDocument("001-resubmission"),
        },
      },
    });
    assert.equal(resubmission.status, 201, JSON.stringify(resubmission.payload));
    assert.equal(await prisma.rewardLedgerEntry.count({ where: { userId: referrer.id } }), 0);

    const queue = await apiRequest("/pre-election/verifications?status=PENDING", { token: validatorToken });
    assert.equal(queue.status, 200, JSON.stringify(queue.payload));
    const cases = queue.payload.verifications as Array<{ id: string; documents: Array<{ id: string }> }>;
    const verificationCase = cases.find((item) => item.id);
    assert.ok(verificationCase);
    assert.ok(verificationCase.documents.length >= 2);

    const verificationCsv = await textRequest("/pre-election/verifications?status=PENDING&export=csv", { token: validatorToken });
    assert.equal(verificationCsv.status, 200);
    assert.match(verificationCsv.body, /memberName/);

    const access = await apiRequest(
      `/pre-election/verifications/${verificationCase.id}/documents/${verificationCase.documents[0].id}/access`,
      { token: validatorToken },
    );
    assert.equal(access.status, 200, JSON.stringify(access.payload));
    // The old assertion accepted any string here, and the route satisfied it
    // with crypto.randomUUID(): a token that granted nothing and verified
    // nothing, for a document that had never been stored.
    assert.equal(typeof access.payload.url, "string", "access must return a URL to the stored document");
    assert.equal(
      typeof access.payload.verifiedSha256,
      "string",
      "access must verify the stored bytes against the recorded hash",
    );
    assert.equal(
      new Date(access.payload.expiresAt as string).getTime() - Date.now() <= 6 * 60 * 1000,
      true,
      "the signed URL must be short lived",
    );
    // The storage key is an internal object address, never a public URL.
    assert.equal(/^https?:\/\//i.test(access.payload.storageKey as string), false);

    const claim = await apiRequest(`/pre-election/verifications/${verificationCase.id}/claim`, {
      method: "POST",
      token: validatorToken,
    });
    assert.equal(claim.status, 200, JSON.stringify(claim.payload));

    const approve = await apiRequest(`/pre-election/verifications/${verificationCase.id}/decision`, {
      method: "PATCH",
      token: validatorToken,
      body: { decision: "APPROVE", note: "Evidence matched voter record." },
    });
    assert.equal(approve.status, 200, JSON.stringify(approve.payload));

    assert.equal(await prisma.rewardLedgerEntry.count({ where: { userId: referrer.id, category: "VERIFIED_REFERRAL" } }), 1);
    const processedReferral = await prisma.referral.findUniqueOrThrow({ where: { id: referral.id } });
    assert.equal(processedReferral.status, "REWARD_PROCESSED");

    const rewardBalance = await apiRequest(`/pre-election/rewards/balance?userId=${referrer.id}`, {
      token: superAdminToken,
    });
    assert.equal(rewardBalance.status, 200, JSON.stringify(rewardBalance.payload));
    assert.equal(rewardBalance.payload.confirmedPoints, 25);
    assert.equal(rewardBalance.payload.availablePoints, 25);

    const referralStats = await apiRequest(`/pre-election/referrals/stats?territoryType=WARD&territoryId=${wardId}`, {
      token: coordinatorToken,
    });
    assert.equal(referralStats.status, 200, JSON.stringify(referralStats.payload));
    assert.equal(referralStats.payload.directRegistrations, 1);
    assert.equal(referralStats.payload.directVerifiedRegistrations, 1);

    const referralManagement = await apiRequest(`/pre-election/referrals?territoryType=WARD&territoryId=${wardId}`, {
      token: coordinatorToken,
    });
    assert.equal(referralManagement.status, 200, JSON.stringify(referralManagement.payload));
    assert.equal((referralManagement.payload.referrals as Array<{ status: string }>).length, 1);

    const rewardLedger = await apiRequest(`/pre-election/rewards/ledger?userId=${referrer.id}`, {
      token: superAdminToken,
    });
    assert.equal(rewardLedger.status, 200, JSON.stringify(rewardLedger.payload));
    assert.equal((rewardLedger.payload.rewardLedgerEntries as Array<{ category: string }>)[0].category, "VERIFIED_REFERRAL");

    const payoutConfigDenied = await apiRequest("/pre-election/payout/configurations", {
      method: "POST",
      token: payoutToken,
      body: { minimumPoints: 25, pointConversionRate: 2, frequency: "WEEKLY" },
    });
    assert.equal(payoutConfigDenied.status, 403);

    const payoutConfig = await apiRequest("/pre-election/payout/configurations", {
      method: "POST",
      token: superAdminToken,
      body: { minimumPoints: 25, pointConversionRate: 2, frequency: "WEEKLY" },
    });
    assert.equal(payoutConfig.status, 201, JSON.stringify(payoutConfig.payload));

    const payoutCycle = await apiRequest("/pre-election/payout/cycles", {
      method: "POST",
      token: superAdminToken,
      body: {
        name: "Pre Election Test Weekly Cycle",
        opensAt: "2026-08-10T00:00:00.000Z",
        closesAt: "2026-08-12T00:00:00.000Z",
        payoutDate: "2026-08-13T00:00:00.000Z",
      },
    });
    assert.equal(payoutCycle.status, 201, JSON.stringify(payoutCycle.payload));
    const payoutCycleId = (payoutCycle.payload.payoutCycle as { id: string }).id;
    const payoutOfficer = await prisma.user.findUniqueOrThrow({ where: { email: testEmail("payout") }, select: { id: true } });

    const payoutOfficers = await apiRequest("/pre-election/payout/officers", { token: superAdminToken });
    assert.equal(payoutOfficers.status, 200, JSON.stringify(payoutOfficers.payload));
    assert.ok((payoutOfficers.payload.payoutOfficers as Array<{ id: string }>).some((item) => item.id === payoutOfficer.id));

    const payoutEligibility = await apiRequest(`/pre-election/payout/eligibility?cycleId=${payoutCycleId}`, { token: superAdminToken });
    assert.equal(payoutEligibility.status, 200, JSON.stringify(payoutEligibility.payload));
    assert.equal((payoutEligibility.payload.payoutEligibility as Array<{ userId: string }>)[0].userId, referrer.id);

    const payoutBatch = await apiRequest(`/pre-election/payout/cycles/${payoutCycleId}/batches`, {
      method: "POST",
      token: superAdminToken,
      body: { payoutOfficerUserId: payoutOfficer.id, beneficiaryUserIds: [referrer.id] },
    });
    assert.equal(payoutBatch.status, 201, JSON.stringify(payoutBatch.payload));
    const assignments = (payoutBatch.payload.payoutBatch as { assignments: Array<{ id: string; points: number; amount: string }> })
      .assignments;
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0].points, 25);
    assert.equal(assignments[0].amount, "50.00");

    const payoutBatches = await apiRequest("/pre-election/payout/batches", { token: superAdminToken });
    assert.equal(payoutBatches.status, 200, JSON.stringify(payoutBatches.payload));
    assert.ok((payoutBatches.payload.payoutBatches as Array<{ id: string }>).some((item) => item.id === (payoutBatch.payload.payoutBatch as { id: string }).id));

    const duplicatePayoutBatch = await apiRequest(`/pre-election/payout/cycles/${payoutCycleId}/batches`, {
      method: "POST",
      token: superAdminToken,
      body: { payoutOfficerUserId: payoutOfficer.id, beneficiaryUserIds: [referrer.id] },
    });
    assert.equal(duplicatePayoutBatch.status, 400);

    const assignmentId = assignments[0].id;
    const approveBatch = await apiRequest(`/pre-election/payout/batches/${(payoutBatch.payload.payoutBatch as { id: string }).id}/approve`, {
      method: "PATCH",
      token: superAdminToken,
    });
    assert.equal(approveBatch.status, 200, JSON.stringify(approveBatch.payload));

    const unauthorizedPayout = await apiRequest(`/pre-election/payout/assignments/${assignmentId}/status`, {
      method: "PATCH",
      token: otherPayoutToken,
      body: { status: "PROCESSING" },
    });
    assert.equal(unauthorizedPayout.status, 403);

    const processingPayout = await apiRequest(`/pre-election/payout/assignments/${assignmentId}/status`, {
      method: "PATCH",
      token: payoutToken,
      body: { status: "PROCESSING" },
    });
    assert.equal(processingPayout.status, 200, JSON.stringify(processingPayout.payload));

    const payoutOfficerAssignments = await apiRequest("/pre-election/payout/assignments?status=PROCESSING", {
      token: payoutToken,
    });
    assert.equal(payoutOfficerAssignments.status, 200, JSON.stringify(payoutOfficerAssignments.payload));
    assert.equal((payoutOfficerAssignments.payload.payoutAssignments as Array<{ id: string }>)[0].id, assignmentId);

    // The kill switch is disabled by default in every environment, so a PAID
    // transition is refused until an operator explicitly enables execution.
    const blockedByKillSwitch = await apiRequest(`/pre-election/payout/assignments/${assignmentId}/status`, {
      method: "PATCH",
      token: payoutToken,
      body: { status: "PAID", paymentReference: "blocked-by-kill-switch" },
    });
    assert.equal(blockedByKillSwitch.status, 409, JSON.stringify(blockedByKillSwitch.payload));
    assert.equal(blockedByKillSwitch.payload.payoutExecutionEnabled, false);
    const stillUnpaid = await prisma.payoutAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
    assert.notEqual(stillUnpaid.status, "PAID", "the kill switch must prevent the money-out transition");

    setPayoutExecutionEnabledForTests(true);

    // A cycle created before the payout authority priced its assignments at a
    // caller-supplied rate. Those amounts were never server-derived, so they
    // are refused at execution rather than paid — the same treatment a
    // pre-authority redemption gets, which it previously did not receive.
    const legacyCycle = await prisma.payoutCycle.findUniqueOrThrow({ where: { id: payoutCycleId } });
    assert.ok(legacyCycle.payoutConfigurationId, "a cycle created now must record the configuration it priced from");
    await prisma.payoutCycle.update({
      where: { id: payoutCycleId },
      data: { payoutConfigurationId: null },
    });
    const unprovenAssignment = await prisma.payoutAssignment.findFirstOrThrow({ where: { payoutCycleId } });
    await assert.rejects(
      () =>
        executePayout(prisma, {
          kind: "ASSIGNMENT",
          assignmentId: unprovenAssignment.id,
          actorUserId: payoutOfficer.id,
          paymentReference: "UNPROVEN-CYCLE-REF",
        }),
      (error: unknown) =>
        error instanceof PayoutExecutionError &&
        error.code === "AMOUNT_NOT_AUTHORITATIVE" &&
        /predates server-side valuation/.test(error.message),
      "an assignment priced by a caller-supplied rate must not be payable",
    );
    assert.equal(
      await prisma.payoutExecution.count({ where: { paymentReference: "UNPROVEN-CYCLE-REF" } }),
      0,
      "a refused assignment must leave no execution record",
    );
    await prisma.payoutCycle.update({
      where: { id: payoutCycleId },
      data: { payoutConfigurationId: legacyCycle.payoutConfigurationId },
    });

    const paidPayout = await apiRequest(`/pre-election/payout/assignments/${assignmentId}/status`, {
      method: "PATCH",
      token: payoutToken,
      body: {
        status: "PAID",
        paymentReference: "PRE-ELECTION-PAYOUT-REF-001",
        proofStorageKey: "payout-proofs/pre-election-test/ref-001.pdf",
        note: "Paid by transfer.",
      },
    });
    assert.equal(paidPayout.status, 200, JSON.stringify(paidPayout.payload));
    assert.equal(await prisma.payoutTransaction.count({ where: { payoutAssignmentId: assignmentId } }), 1);

    // The execution record is the artefact that says money left. It is written
    // in the same transaction as the transition, so its absence would mean the
    // transition committed alone.
    const assignmentExecution = await prisma.payoutExecution.findUniqueOrThrow({
      where: { payoutAssignmentId: assignmentId },
    });
    assert.equal(assignmentExecution.kind, "ASSIGNMENT");
    assert.equal(assignmentExecution.paymentReference, "PRE-ELECTION-PAYOUT-REF-001");
    assert.equal(assignmentExecution.points, 25);
    assert.equal(Number(assignmentExecution.amount), 50);

    // Executing the same assignment twice pays once. The second attempt is
    // refused by the state claim, and no second execution record appears.
    const doubleExecute = await apiRequest(`/pre-election/payout/assignments/${assignmentId}/status`, {
      method: "PATCH",
      token: payoutToken,
      body: { status: "PAID", paymentReference: "PRE-ELECTION-PAYOUT-REF-002" },
    });
    assert.equal(doubleExecute.status, 409, JSON.stringify(doubleExecute.payload));
    assert.equal(
      await prisma.payoutExecution.count({ where: { payoutAssignmentId: assignmentId } }),
      1,
      "a repeated execution must not create a second execution record",
    );

    // A payment reference identifies exactly one payment, across both kinds.
    await assert.rejects(
      () =>
        executePayout(prisma, {
          kind: "ASSIGNMENT",
          assignmentId,
          actorUserId: payoutOfficer.id,
          paymentReference: "PRE-ELECTION-PAYOUT-REF-001",
        }),
      (error: unknown) =>
        error instanceof PayoutExecutionError && error.code === "DUPLICATE_PAYMENT_REFERENCE",
      "a reused payment reference must be refused",
    );

    // Called directly, bypassing every route: the chokepoint itself refuses
    // while the switch is off. This is the assertion the previous design could
    // not make, because there was no service to call.
    setPayoutExecutionEnabledForTests(false);
    await assert.rejects(
      () =>
        executePayout(prisma, {
          kind: "ASSIGNMENT",
          assignmentId,
          actorUserId: payoutOfficer.id,
          paymentReference: "DIRECT-CALL-WHILE-DISABLED",
        }),
      (error: unknown) => error instanceof PayoutExecutionDisabledError,
      "the execution authority must refuse a direct call while the kill switch is off",
    );
    assert.equal(
      await prisma.payoutExecution.count({ where: { paymentReference: "DIRECT-CALL-WHILE-DISABLED" } }),
      0,
      "a refused execution must leave no execution record",
    );
    setPayoutExecutionEnabledForTests(true);

    const finalizedPayoutChange = await apiRequest(`/pre-election/payout/assignments/${assignmentId}/status`, {
      method: "PATCH",
      token: payoutToken,
      body: { status: "HELD" },
    });
    assert.equal(finalizedPayoutChange.status, 409);

    const postPayoutBalance = await apiRequest(`/pre-election/rewards/balance?userId=${referrer.id}`, {
      token: superAdminToken,
    });
    assert.equal(postPayoutBalance.status, 200, JSON.stringify(postPayoutBalance.payload));
    assert.equal(postPayoutBalance.payload.reservedPayoutPoints, 25);
    assert.equal(postPayoutBalance.payload.availablePoints, 0);

    const strengthMetric = await apiRequest("/pre-election/strength/metrics", {
      method: "POST",
      token: superAdminToken,
      body: { metric: "VERIFIED_MEMBERS", description: "Verified members in scope" },
    });
    assert.equal(strengthMetric.status, 201, JSON.stringify(strengthMetric.payload));

    const strengthWeight = await apiRequest("/pre-election/strength/weights", {
      method: "POST",
      token: superAdminToken,
      body: { metric: "VERIFIED_MEMBERS", weight: 1 },
    });
    assert.equal(strengthWeight.status, 201, JSON.stringify(strengthWeight.payload));

    const strengthTarget = await apiRequest("/pre-election/strength/targets", {
      method: "POST",
      token: superAdminToken,
      body: {
        territoryType: "WARD",
        territoryId: wardId,
        metric: "VERIFIED_MEMBERS",
        targetValue: 1,
        startDate: "2026-08-01T00:00:00.000Z",
      },
    });
    assert.equal(strengthTarget.status, 201, JSON.stringify(strengthTarget.payload));

    const strengthSnapshot = await apiRequest("/pre-election/strength/snapshots/calculate", {
      method: "POST",
      token: superAdminToken,
      body: { territoryType: "WARD", territoryId: wardId },
    });
    assert.equal(strengthSnapshot.status, 201, JSON.stringify(strengthSnapshot.payload));
    const breakdown = (strengthSnapshot.payload.strengthSnapshot as { breakdown: Array<{ metric: string; actualValue: number }> }).breakdown;
    const verifiedMembersMetric = breakdown.find((item) => item.metric === "VERIFIED_MEMBERS");
    assert.ok(verifiedMembersMetric);
    assert.equal(verifiedMembersMetric.actualValue, 1);

    const targetProgress = await apiRequest(`/pre-election/strength/targets/progress?territoryType=WARD&territoryId=${wardId}`, {
      token: superAdminToken,
    });
    assert.equal(targetProgress.status, 200, JSON.stringify(targetProgress.payload));
    assert.equal((targetProgress.payload.progress as Array<{ metric: string; actualValue: number }>)[0].actualValue, 1);

    const strengthDashboard = await apiRequest(`/pre-election/strength/dashboard?territoryType=WARD&territoryId=${wardId}`, {
      token: coordinatorToken,
    });
    assert.equal(strengthDashboard.status, 200, JSON.stringify(strengthDashboard.payload));
    assert.equal((strengthDashboard.payload.dashboard as { coordinatorPerformance: Array<{ userId: string }> }).coordinatorPerformance[0].userId, referrer.id);

    const approveAgain = await apiRequest(`/pre-election/verifications/${verificationCase.id}/decision`, {
      method: "PATCH",
      token: validatorToken,
      body: { decision: "APPROVE" },
    });
    assert.equal(approveAgain.status, 409);
    assert.equal(await prisma.rewardLedgerEntry.count({ where: { userId: referrer.id, category: "VERIFIED_REFERRAL" } }), 1);

    const duplicateMember = await registerMember(
      "002",
      null,
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    const duplicateVerification = await prisma.voterVerification.findUniqueOrThrow({
      where: { memberUserId: duplicateMember.id },
    });
    assert.equal(duplicateVerification.isFlagged, true);
    assert.equal(duplicateVerification.fraudReason, "DUPLICATE_DOCUMENT_HASH");

    // --- Feature 043: system-controlled bonus points -------------------------

    // Only a Super Admin may define a bonus rule. A Payout Officer, who moves
    // money, must not be able to create the rule that decides how much exists.
    const payoutBonusAttempt = await apiRequest("/pre-election/reward-rules", {
      method: "POST",
      token: payoutToken,
      body: {
        name: "Payout officer forbidden bonus",
        directPoints: 500,
        qualifyingEvent: "REFERRAL_MILESTONE_REACHED",
        milestoneThreshold: 1,
      },
    });
    assert.equal(payoutBonusAttempt.status, 403, JSON.stringify(payoutBonusAttempt.payload));

    // A bonus rule with no system trigger is rejected: bonus points may only
    // come into existence through a computed milestone.
    const untriggeredBonus = await apiRequest("/pre-election/reward-rules", {
      method: "POST",
      token: superAdminToken,
      body: { name: "Bonus without trigger", directPoints: 50, qualifyingEvent: "REFERRAL_MILESTONE_REACHED" },
    });
    assert.equal(untriggeredBonus.status, 400, JSON.stringify(untriggeredBonus.payload));

    const bonusRule = await apiRequest("/pre-election/reward-rules", {
      method: "POST",
      token: superAdminToken,
      body: {
        name: "Two qualified referrals milestone",
        directPoints: 100,
        qualifyingEvent: "REFERRAL_MILESTONE_REACHED",
        milestoneThreshold: 2,
        eligibleRole: "COORDINATOR",
      },
    });
    assert.equal(bonusRule.status, 201, JSON.stringify(bonusRule.payload));

    // Not yet awarded: the coordinator has one qualified referral, not two.
    assert.equal(await prisma.rewardLedgerEntry.count({ where: { userId: referrer.id, category: "BONUS" } }), 0);

    // A second qualified referral crosses the threshold.
    const secondReferred = await registerMember(
      "003",
      referralCodeResponse.payload.referralCode as string,
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    );
    const secondCase = await prisma.voterVerification.findUniqueOrThrow({ where: { memberUserId: secondReferred.id } });
    const secondApprove = await apiRequest(`/pre-election/verifications/${secondCase.id}/decision`, {
      method: "PATCH",
      token: validatorToken,
      body: { decision: "APPROVE", note: "Second referral verified." },
    });
    assert.equal(secondApprove.status, 200, JSON.stringify(secondApprove.payload));

    const bonusEntries = await prisma.rewardLedgerEntry.findMany({
      where: { userId: referrer.id, category: "BONUS" },
    });
    assert.equal(bonusEntries.length, 1, "the milestone must award exactly one bonus");
    assert.equal(bonusEntries[0].points, 100);
    assert.equal(bonusEntries[0].sourceEventType, "REFERRAL_MILESTONE_REACHED");
    // The amount comes from a versioned rule, never an operator-supplied value.
    assert.ok(bonusEntries[0].rewardRuleVersionId, "a bonus must reference the rule version that produced it");

    // Re-processing must never pay the same milestone twice.
    const bonusEvent = await prisma.rewardEvent.findFirstOrThrow({
      where: { eventType: "REFERRAL_MILESTONE_REACHED", sourceId: `${referrer.id}:2` },
    });
    assert.equal(bonusEvent.status, "PROCESSED");
    assert.equal(
      await prisma.rewardEvent.count({ where: { eventType: "REFERRAL_MILESTONE_REACHED", sourceId: `${referrer.id}:2` } }),
      1,
    );

    // --- Features 059-065, 077, 078: hierarchical dashboard ------------------

    // One engine, every level. A Super Admin walks the full hierarchy and each
    // level must present its own identity, its own child unit, and a heatmap
    // band for every child.
    const levels = [
      { level: "STATE", territoryId: stateId, childUnit: "Senatorial Districts" },
      { level: "SENATORIAL_DISTRICT", territoryId: senatorialDistrictId, childUnit: "Federal Constituencies" },
      { level: "FEDERAL_CONSTITUENCY", territoryId: federalConstituencyId, childUnit: "State Constituencies" },
      { level: "STATE_CONSTITUENCY", territoryId: stateConstituencyId, childUnit: "Wards" },
      { level: "WARD", territoryId: wardId, childUnit: "Polling Units" },
    ] as const;

    for (const entry of levels) {
      const view = await apiRequest(`/dashboard?level=${entry.level}&territoryId=${entry.territoryId}`, {
        token: superAdminToken,
      });
      assert.equal(view.status, 200, `${entry.level}: ${JSON.stringify(view.payload)}`);
      const dashboard = view.payload.dashboard as {
        level: string;
        territoryName: string;
        presentation: { childUnitPlural: string; accent: string; singular: string };
        breadcrumb: Array<{ level: string; name: string }>;
        strengthScore: number;
        band: string;
        tiles: Array<{ key: string; value: number }>;
        childLevel: string | null;
        children: Array<{ band: string; strengthScore: number; level: string }>;
        referenceDataIncomplete: boolean;
      };

      assert.equal(dashboard.level, entry.level);
      assert.equal(dashboard.presentation.childUnitPlural, entry.childUnit, "each level must name its own child unit");
      assert.ok(dashboard.presentation.accent, "each level must carry a distinct visual accent");
      assert.ok(dashboard.breadcrumb.length >= 1, "every level must be navigable back up the hierarchy");
      assert.equal(dashboard.breadcrumb[0].level, "STATE");
      assert.ok(dashboard.strengthScore >= 0 && dashboard.strengthScore <= 100);
      assert.ok(["CRITICAL", "WEAK", "MODERATE", "STRONG"].includes(dashboard.band));
      assert.ok(dashboard.tiles.some((tile) => tile.key === "REGISTERED_MEMBERS"));
      assert.equal(dashboard.referenceDataIncomplete, false, `${entry.level} has fixture children loaded`);

      // Heatmap: every child carries a band so the grid can always be coloured.
      assert.ok(dashboard.children.length > 0, `${entry.level} should list children`);
      for (const child of dashboard.children) {
        assert.ok(["CRITICAL", "WEAK", "MODERATE", "STRONG"].includes(child.band));
        assert.equal(child.level, dashboard.childLevel);
      }
    }

    // The terminal level stops the drill-down and exposes ground truth instead.
    const pollingUnitView = await apiRequest(`/dashboard?level=POLLING_UNIT&territoryId=${pollingUnitId}`, {
      token: superAdminToken,
    });
    assert.equal(pollingUnitView.status, 200, JSON.stringify(pollingUnitView.payload));
    const pollingUnitDashboard = pollingUnitView.payload.dashboard as {
      childLevel: string | null;
      children: unknown[];
      pollingUnitDetail: { operationalStatus: string; incidentCount: number } | null;
      breadcrumb: Array<{ level: string }>;
    };
    assert.equal(pollingUnitDashboard.childLevel, null, "Polling Unit is the terminal command level");
    assert.equal(pollingUnitDashboard.children.length, 0);
    assert.ok(pollingUnitDashboard.pollingUnitDetail, "the terminal level must expose Polling Unit readiness");
    assert.equal(pollingUnitDashboard.breadcrumb.length, 6, "full ancestry from State to Polling Unit");

    // A coordinator with no explicit scope lands on the territory they command.
    const coordinatorDefault = await apiRequest("/dashboard", { token: coordinatorToken });
    assert.equal(coordinatorDefault.status, 200, JSON.stringify(coordinatorDefault.payload));
    assert.equal((coordinatorDefault.payload.dashboard as { level: string }).level, "WARD");

    // Leaderboards rank on approved operational metrics only.
    const leaderboardView = await apiRequest(
      `/dashboard?level=WARD&territoryId=${wardId}&leaderboardMetric=VERIFIED_REFERRALS`,
      { token: coordinatorToken },
    );
    assert.equal(leaderboardView.status, 200, JSON.stringify(leaderboardView.payload));
    const leaderboard = (leaderboardView.payload.dashboard as {
      leaderboard: Array<{ rank: number; coordinatorUserId: string; value: number; metric: string }>;
    }).leaderboard;
    assert.ok(leaderboard.length >= 1, "the ward coordinator should appear on its own leaderboard");
    assert.equal(leaderboard[0].rank, 1);
    assert.equal(leaderboard[0].metric, "VERIFIED_REFERRALS");
    assert.equal(leaderboard[0].coordinatorUserId, referrer.id);
    assert.equal(leaderboard[0].value, 2, "two qualified referrals were created above");

    // Authorization is applied by the same engine at every level: a Validator
    // holds no command territory and cannot read a command dashboard.
    const validatorDenied = await apiRequest(`/dashboard?level=WARD&territoryId=${wardId}`, { token: validatorToken });
    assert.equal(validatorDenied.status, 403, JSON.stringify(validatorDenied.payload));

    // A Payout Officer likewise commands no territory.
    const payoutDenied = await apiRequest("/dashboard", { token: payoutToken });
    assert.equal(payoutDenied.status, 403, JSON.stringify(payoutDenied.payload));

    // --- PR #10: one authoritative financial model --------------------------

    const memberUser = await prisma.user.findUniqueOrThrow({
      where: { email: testEmail("member-001") },
      select: { id: true },
    });

    // The exact bypass the audit found: a member holding far less than the
    // configured minimum could be paid through the legacy redemption path,
    // which read a second ledger and applied neither threshold nor rate.
    // A member with no eligible points is refused for that reason.
    const noBalance = await apiRequest("/voter/redemptions", {
      method: "POST",
      token: referredMemberToken,
      body: { pointsRequested: 1 },
    });
    assert.equal(noBalance.status, 400, JSON.stringify(noBalance.payload));
    assert.match(String(noBalance.payload.message), /exceed the eligible balance/i);
    assert.equal(await prisma.rewardRedemption.count({ where: { voterUserId: memberUser.id } }), 0);

    // Give the member real eligible points, so the next two assertions exercise
    // the threshold and the valuation rather than the empty-balance branch. The
    // active configuration is minimumPoints 25 at a rate of 2.
    const funded = await apiRequest("/admin/participation", {
      method: "POST",
      token: superAdminToken,
      body: {
        voterUserId: memberUser.id,
        type: "VOTER_EDUCATION_DRIVE",
        description: "Completed a verified voter education drive.",
        pointsAwarded: 30,
      },
    });
    assert.equal(funded.status, 201, JSON.stringify(funded.payload));

    // Below the configured minimum, with enough balance to cover it — so only
    // the threshold can produce this refusal.
    const belowThreshold = await apiRequest("/voter/redemptions", {
      method: "POST",
      token: referredMemberToken,
      body: { pointsRequested: 10 },
    });
    assert.equal(belowThreshold.status, 400, JSON.stringify(belowThreshold.payload));
    assert.match(
      String(belowThreshold.payload.message),
      /minimum payout threshold of 25/i,
      "the threshold must be the reason, not an incidental empty balance",
    );
    assert.equal(await prisma.rewardRedemption.count({ where: { voterUserId: memberUser.id } }), 0);

    // The client may request points; it may never assert the monetary amount.
    // This request WOULD succeed on its points alone, so the assertion turns on
    // the stored amount rather than on a refusal that some other rule produced.
    const clientSuppliedAmount = await apiRequest("/voter/redemptions", {
      method: "POST",
      token: referredMemberToken,
      body: { pointsRequested: 30, amountRequested: 1_000_000 },
    });
    assert.equal(clientSuppliedAmount.status, 201, JSON.stringify(clientSuppliedAmount.payload));
    const storedRedemption = await prisma.rewardRedemption.findFirstOrThrow({
      where: { voterUserId: memberUser.id },
    });
    assert.equal(
      storedRedemption.amountRequested,
      60,
      "the stored amount must be 30 points x the configured rate of 2, never the client's figure",
    );
    assert.notEqual(storedRedemption.amountRequested, 1_000_000);

    // That redemption reserves the points, so the balance is spent exactly once.
    const afterRedemption = await apiRequest(`/pre-election/rewards/balance?userId=${memberUser.id}`, {
      token: superAdminToken,
    });
    assert.equal(
      (afterRedemption.payload as { availablePoints: number }).availablePoints,
      0,
      "a pending redemption must reserve the points it was valued against",
    );

    // The payout-cycle path must see the same reservation. Before the authority
    // was shared it subtracted only payout assignments, so these 30 points were
    // simultaneously redeemable and payable through a cycle.
    const eligibilityAfterRedemption = await apiRequest(
      `/pre-election/payout/eligibility?cycleId=${payoutCycleId}`,
      { token: superAdminToken },
    );
    assert.equal(eligibilityAfterRedemption.status, 200, JSON.stringify(eligibilityAfterRedemption.payload));
    const eligibleIds = (
      eligibilityAfterRedemption.payload.payoutEligibility as Array<{ userId: string }>
    ).map((entry) => entry.userId);
    assert.ok(
      !eligibleIds.includes(memberUser.id),
      "points reserved by a redemption must not also be payable through a payout cycle",
    );

    await prisma.rewardRedemption.delete({ where: { id: storedRedemption.id } });

    // The legacy ledger is read-only: no new earnings may be written to it.
    await assert.rejects(
      () =>
        prisma.$transaction((transaction) =>
          createRewardEntryWithNotification(transaction, {
            voterUserId: memberUser.id,
            type: "PARTICIPATION",
            points: 500,
            description: "attempted legacy write",
          }),
        ),
      /read-only/i,
      "the legacy RewardLedger must refuse new earnings",
    );

    // A migrated legacy balance is preserved and visible, but never spendable
    // until an approved equivalence ratio credits it.
    const batch = await prisma.legacyMigrationBatch.create({
      data: {
        memberCount: 1,
        beforeTotalPoints: 350,
        migratedTotalPoints: 350,
        pendingTotalPoints: 350,
        snapshotChecksum: "test-snapshot-checksum",
      },
    });
    const carryover = await prisma.legacyBalanceCarryover.create({
      data: {
        userId: referrer.id,
        migrationBatchId: batch.id,
        sourceRowIdsJson: ["legacy-row-1", "legacy-row-2"],
        legacyPointBalance: 350,
        rowChecksum: "test-row-checksum",
        status: "LEGACY_CARRYOVER_PENDING",
      },
    });

    const carriedBalance = await apiRequest(`/pre-election/rewards/balance?userId=${referrer.id}`, {
      token: superAdminToken,
    });
    assert.equal(carriedBalance.status, 200, JSON.stringify(carriedBalance.payload));
    const carried = carriedBalance.payload as {
      confirmedPoints: number;
      availablePoints: number;
      payablePoints: number;
      legacyCarryoverPendingPoints: number;
    };
    assert.equal(carried.legacyCarryoverPendingPoints, 350, "the preserved legacy balance must be visible");
    // Asserted against the ledger itself, not against a sibling response field.
    // Comparing payablePoints to availablePoints proves nothing: the handler
    // assigns the same expression to both keys, so it compares a value to
    // itself and passes however badly the invariant is broken.
    const referrerLedger = await prisma.rewardLedgerEntry.aggregate({
      where: { userId: referrer.id },
      _sum: { points: true },
    });
    const referrerAssignments = await prisma.payoutAssignment.aggregate({
      where: { beneficiaryUserId: referrer.id },
      _sum: { points: true },
    });
    const expectedAvailable = Math.max(
      (referrerLedger._sum.points || 0) - (referrerAssignments._sum.points || 0),
      0,
    );
    assert.equal(
      carried.availablePoints,
      expectedAvailable,
      "the spendable balance must be exactly the authoritative ledger less reservations, with no carryover in it",
    );
    assert.equal(carried.payablePoints, expectedAvailable);
    const beforeReconciliation = carried.confirmedPoints;

    // With no approved policy there is no equivalence between a legacy point and
    // an authoritative one, so there is nothing to convert. Fail closed.
    assert.equal(
      await prisma.legacyReconciliationPolicy.count({ where: { status: "APPROVED" } }),
      0,
      "no reconciliation ratio may be approved by default",
    );
    const unapproved = await apiRequest("/pre-election/rewards/legacy-carryover/reconcile", {
      method: "POST",
      token: superAdminToken,
      body: { carryoverId: carryover.id },
    });
    assert.equal(unapproved.status, 409, JSON.stringify(unapproved.payload));
    assert.equal(unapproved.payload.code, "RECONCILIATION_POLICY_NOT_APPROVED");
    assert.equal(
      (await prisma.legacyBalanceCarryover.findUniqueOrThrow({ where: { id: carryover.id } })).status,
      "LEGACY_CARRYOVER_PENDING",
      "a refused reconciliation must leave the carryover pending",
    );
    assert.equal(
      await prisma.rewardLedgerEntry.count({ where: { userId: referrer.id, category: "LEGACY_CARRYOVER" } }),
      0,
      "a refused reconciliation must credit nothing",
    );
    const batchBeforeAnyPolicy = await prisma.legacyMigrationBatch.findUniqueOrThrow({ where: { id: batch.id } });
    assert.equal(batchBeforeAnyPolicy.reconciledTotalPoints, 0, "counters must not move for a refused reconciliation");

    // The caller may no longer assert the valuation. A request carrying one is
    // rejected outright rather than silently stripped, so an old client is told
    // its figure was refused instead of quietly having it ignored.
    const callerRatio = await apiRequest("/pre-election/rewards/legacy-carryover/reconcile", {
      method: "POST",
      token: superAdminToken,
      body: { carryoverId: carryover.id, conversionRatio: 1000 },
    });
    assert.equal(callerRatio.status, 400, JSON.stringify(callerRatio.payload));
    const callerVersion = await apiRequest("/pre-election/rewards/legacy-carryover/reconcile", {
      method: "POST",
      token: superAdminToken,
      body: { carryoverId: carryover.id, reconciliationRuleVersion: "attacker-chosen" },
    });
    assert.equal(callerVersion.status, 400, JSON.stringify(callerVersion.payload));

    // Governance approves a ratio in two deliberate acts: drafting proposes a
    // valuation, approving authorises it. A draft alone converts nothing.
    const draft = await apiRequest("/pre-election/rewards/legacy-reconciliation-policy", {
      method: "POST",
      token: superAdminToken,
      body: { version: "legacy-reconciliation-v1", conversionRatio: 0.5, rationale: "Board-approved equivalence." },
    });
    assert.equal(draft.status, 201, JSON.stringify(draft.payload));
    const draftedPolicy = (draft.payload as { policy: { id: string; status: string } }).policy;
    assert.equal(draftedPolicy.status, "DRAFT");
    const draftOnly = await apiRequest("/pre-election/rewards/legacy-carryover/reconcile", {
      method: "POST",
      token: superAdminToken,
      body: { carryoverId: carryover.id },
    });
    assert.equal(draftOnly.status, 409, "a drafted but unapproved ratio must convert nothing");
    assert.equal(draftOnly.payload.code, "RECONCILIATION_POLICY_NOT_APPROVED");

    const approvedPolicy = await apiRequest(
      `/pre-election/rewards/legacy-reconciliation-policy/${draftedPolicy.id}/approve`,
      { method: "POST", token: superAdminToken, body: {} },
    );
    assert.equal(approvedPolicy.status, 200, JSON.stringify(approvedPolicy.payload));
    assert.equal((approvedPolicy.payload as { policy: { status: string } }).policy.status, "APPROVED");

    // Reconciliation is the only path that turns a carryover into spendable
    // points, and its ratio and version now come from the approved policy.
    const reconciled = await apiRequest("/pre-election/rewards/legacy-carryover/reconcile", {
      method: "POST",
      token: superAdminToken,
      body: { carryoverId: carryover.id },
    });
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.payload));
    const reconciledCarryover = (reconciled.payload as { carryover: { creditedPoints: number; status: string } }).carryover;
    // 350 legacy points at a 0.5 ratio credits 175, not 350: a non-parity ratio
    // is handled by the same mechanism without rewriting history.
    assert.equal(reconciledCarryover.creditedPoints, 175);
    assert.equal(reconciledCarryover.status, "LEGACY_CARRYOVER_CONFIRMED");

    // Provenance: the credit traces back to the governance decision that
    // authorised it, not merely to a number someone passed in.
    const provenance = await prisma.legacyBalanceCarryover.findUniqueOrThrow({ where: { id: carryover.id } });
    assert.equal(provenance.reconciliationPolicyId, draftedPolicy.id);
    assert.equal(provenance.reconciliationRuleVersion, "legacy-reconciliation-v1");
    assert.equal(provenance.conversionRatio?.toString(), "0.5");
    const reconciliationAudit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "LEGACY_BALANCE_RECONCILED", targetId: carryover.id },
      orderBy: { createdAt: "desc" },
    });
    const auditMetadata = JSON.parse(reconciliationAudit.metadataJson || "{}") as Record<string, unknown>;
    assert.equal(auditMetadata.reconciliationPolicyId, draftedPolicy.id);
    assert.equal(auditMetadata.reconciliationPolicyVersion, "legacy-reconciliation-v1");
    assert.equal(auditMetadata.conversionRatio, "0.5");
    assert.equal(auditMetadata.creditedPoints, 175);
    assert.equal(auditMetadata.sourceBalance, 350);

    const afterReconciliation = await apiRequest(`/pre-election/rewards/balance?userId=${referrer.id}`, {
      token: superAdminToken,
    });
    const after = afterReconciliation.payload as { confirmedPoints: number; legacyCarryoverPendingPoints: number };
    assert.equal(after.confirmedPoints, beforeReconciliation + 175);
    assert.equal(after.legacyCarryoverPendingPoints, 0, "a confirmed carryover must leave the pending pool");

    // The original legacy figure is preserved unchanged: history is corrected
    // by explicit events, never by editing the record.
    const storedCarryover = await prisma.legacyBalanceCarryover.findUniqueOrThrow({ where: { id: carryover.id } });
    assert.equal(storedCarryover.legacyPointBalance, 350, "the source balance must never be rewritten");
    assert.equal(storedCarryover.reconciliationRuleVersion, "legacy-reconciliation-v1");
    assert.ok(storedCarryover.reconciledLedgerEntryId);

    // Reconciling CONCURRENTLY must not credit twice either. The PENDING check
    // runs before the transaction, so every request passes it; what stops the
    // losers is the conditional claim inside. The audit could not verify from
    // source alone whether that claim is a real compare-and-swap, so it is
    // exercised here rather than argued: under READ COMMITTED a loser blocks on
    // the row lock, re-evaluates its WHERE against the committed row, and
    // matches nothing.
    const raceMember = await registerMember("903", null, "e".repeat(64));
    const raceBatch = await prisma.legacyMigrationBatch.create({
      data: {
        memberCount: 1,
        beforeTotalPoints: 200,
        migratedTotalPoints: 200,
        pendingTotalPoints: 200,
        snapshotChecksum: "race-checksum",
      },
    });
    const raceCarryover = await prisma.legacyBalanceCarryover.create({
      data: {
        userId: raceMember.id,
        migrationBatchId: raceBatch.id,
        sourceRowIdsJson: ["legacy-row-race"],
        legacyPointBalance: 200,
        rowChecksum: "race-row",
        status: "LEGACY_CARRYOVER_PENDING",
      },
    });

    const raced = await Promise.all(
      [1, 2, 3].map(() =>
        apiRequest("/pre-election/rewards/legacy-carryover/reconcile", {
          method: "POST",
          token: superAdminToken,
          body: { carryoverId: raceCarryover.id },
        }),
      ),
    );
    assert.equal(
      raced.filter((result) => result.status === 200).length,
      1,
      `exactly one concurrent reconciliation may succeed: ${JSON.stringify(raced.map((r) => r.status))}`,
    );
    assert.equal(raced.filter((result) => result.status === 409).length, 2);

    assert.equal(
      await prisma.rewardLedgerEntry.count({ where: { userId: raceMember.id, category: "LEGACY_CARRYOVER" } }),
      1,
      "a concurrent reconciliation must post exactly one credit",
    );
    const racedBatch = await prisma.legacyMigrationBatch.findUniqueOrThrow({ where: { id: raceBatch.id } });
    assert.equal(
      racedBatch.pendingTotalPoints,
      0,
      "the batch counters must move exactly once, not once per concurrent request",
    );
    assert.equal(racedBatch.reconciledTotalPoints, 100);

    // One carryover per member is now a database constraint, not a check the
    // cutover script performs outside its own write transaction. Without it a
    // second batch credits the same legacy rows again.
    await assert.rejects(
      () =>
        prisma.legacyBalanceCarryover.create({
          data: {
            userId: raceMember.id,
            migrationBatchId: batch.id,
            sourceRowIdsJson: ["legacy-row-duplicate"],
            legacyPointBalance: 200,
            rowChecksum: "duplicate-carryover-row",
            status: "LEGACY_CARRYOVER_PENDING",
          },
        }),
      /Unique constraint/i,
      "a member must not be able to hold two carryovers for the same legacy balance",
    );

    // Reconciling twice must not credit twice.
    const doubleReconcile = await apiRequest("/pre-election/rewards/legacy-carryover/reconcile", {
      method: "POST",
      token: superAdminToken,
      body: { carryoverId: carryover.id },
    });
    assert.equal(doubleReconcile.status, 409, JSON.stringify(doubleReconcile.payload));
    const finalBalance = await apiRequest(`/pre-election/rewards/balance?userId=${referrer.id}`, { token: superAdminToken });
    assert.equal(
      (finalBalance.payload as { confirmedPoints: number }).confirmedPoints,
      beforeReconciliation + 175,
      "a second reconciliation must not double-count",
    );

    // A member holding financial history must be refused deletion with the
    // explained 409, not a raw foreign-key failure. Earnings now post to the
    // authoritative ledger rather than the legacy one, so the dependency guard
    // has to count both it and preserved carryover value; otherwise this delete
    // passes the pre-check and fails in the database instead.
    const participation = await apiRequest("/admin/participation", {
      method: "POST",
      token: superAdminToken,
      body: {
        voterUserId: referredMember.id,
        type: "TOWN_HALL_ATTENDANCE",
        description: "Attended a verified town hall meeting.",
        pointsAwarded: 5,
      },
    });
    assert.equal(participation.status, 201, JSON.stringify(participation.payload));
    assert.ok(
      (await prisma.rewardLedgerEntry.count({ where: { userId: referredMember.id } })) > 0,
      "participation must credit the authoritative ledger",
    );
    await prisma.legacyBalanceCarryover.create({
      data: {
        userId: referredMember.id,
        migrationBatchId: batch.id,
        sourceRowIdsJson: ["legacy-row-3"],
        legacyPointBalance: 40,
        rowChecksum: "test-row-checksum-member",
        status: "LEGACY_CARRYOVER_PENDING",
      },
    });

    // The member-facing endpoints must not serve the carryover as spendable
    // either. Both used to sum the legacy ledger — which after the cutover is
    // precisely the preserved carryover — so the redemption screen itself, the
    // one screen where a figure most reads as spendable, showed it as payable.
    const memberLedger = await prisma.rewardLedgerEntry.aggregate({
      where: { userId: referredMember.id },
      _sum: { points: true },
    });
    const memberRedemptions = await apiRequest("/voter/redemptions", { token: referredMemberToken });
    assert.equal(memberRedemptions.status, 200, JSON.stringify(memberRedemptions.payload));
    const memberBalance = (memberRedemptions.payload as {
      balance: { availablePoints: number; legacyCarryoverPendingPoints: number };
    }).balance;
    assert.equal(
      memberBalance.availablePoints,
      memberLedger._sum.points || 0,
      "the redemption screen must not present preserved carryover as spendable",
    );
    assert.equal(
      memberBalance.legacyCarryoverPendingPoints,
      40,
      "the preserved balance is still shown to the member, separately",
    );

    // Deactivation is an earlier precondition of the delete route; it is
    // satisfied here so the request reaches the dependency guard under test.
    await prisma.user.update({ where: { id: referredMember.id }, data: { isActive: false } });
    const deleteFinancialMember = await apiRequest(`/admin/users/${referredMember.id}`, {
      method: "DELETE",
      token: superAdminToken,
    });
    assert.equal(deleteFinancialMember.status, 409, JSON.stringify(deleteFinancialMember.payload));
    const deleteCounts = deleteFinancialMember.payload.dependencyCounts as Record<string, number>;
    assert.ok(
      deleteCounts.authoritativeLedgerEntries > 0,
      "the delete guard must see entries in the authoritative ledger",
    );
    assert.ok(deleteCounts.legacyBalanceCarryovers > 0, "the delete guard must see preserved legacy value");
    const survivingMember = await prisma.user.findUnique({ where: { id: referredMember.id } });
    assert.ok(survivingMember, "a member holding financial history must still exist after a refused delete");

    // Payout rows must block a delete too. Both payout foreign keys are
    // Restrict, so a beneficiary holding them has to be refused with the
    // explained 409 rather than reaching the database and failing there.
    const existingAssignment = await prisma.payoutAssignment.findFirstOrThrow({
      where: { beneficiaryUserId: referrer.id },
      select: { payoutBatchId: true },
    });
    await prisma.payoutAssignment.create({
      data: {
        payoutCycleId,
        payoutBatchId: existingAssignment.payoutBatchId,
        beneficiaryUserId: referredMember.id,
        payoutOfficerUserId: payoutOfficer.id,
        points: 5,
        amount: 10,
        status: "PENDING",
      },
    });
    const deleteBeneficiary = await apiRequest(`/admin/users/${referredMember.id}`, {
      method: "DELETE",
      token: superAdminToken,
    });
    assert.equal(deleteBeneficiary.status, 409, JSON.stringify(deleteBeneficiary.payload));
    assert.ok(
      (deleteBeneficiary.payload.dependencyCounts as Record<string, number>).payoutAssignments > 0,
      "the delete guard must see payout assignments",
    );

    // The redemption path is the second money-out transition and had no test at
    // all: deleting its kill-switch check broke nothing. Both states are proved
    // here, and the block is enforced at the transition, not only by the route.
    setPayoutExecutionEnabledForTests(false);
    const paidRedemption = await prisma.rewardRedemption.create({
      data: {
        voterUserId: referredMember.id,
        pointsRequested: 30,
        // Deliberately not the authoritative value (30 points x rate 2 = 60),
        // standing in for a row raised before the payout authority existed.
        amountRequested: 999_999,
        status: "APPROVED",
      },
    });
    const blockedRedemption = await apiRequest(`/admin/redemptions/${paidRedemption.id}/paid`, {
      method: "PATCH",
      token: superAdminToken,
      body: { paymentReference: "REDEMPTION-BLOCKED-REF" },
    });
    assert.equal(blockedRedemption.status, 409, JSON.stringify(blockedRedemption.payload));
    assert.equal(blockedRedemption.payload.payoutExecutionEnabled, false);
    assert.notEqual(
      (await prisma.rewardRedemption.findUniqueOrThrow({ where: { id: paidRedemption.id } })).status,
      "PAID",
      "the kill switch must prevent the redemption money-out transition",
    );
    assert.equal(
      await prisma.payoutExecution.count({ where: { rewardRedemptionId: paidRedemption.id } }),
      0,
      "a refused redemption must write neither PAID nor an execution record",
    );

    setPayoutExecutionEnabledForTests(true);
    const allowedRedemption = await apiRequest(`/admin/redemptions/${paidRedemption.id}/paid`, {
      method: "PATCH",
      token: superAdminToken,
      body: { paymentReference: "REDEMPTION-PAID-REF-001" },
    });
    assert.equal(allowedRedemption.status, 200, JSON.stringify(allowedRedemption.payload));
    assert.equal(
      (await prisma.rewardRedemption.findUniqueOrThrow({ where: { id: paidRedemption.id } })).status,
      "PAID",
      "an operator who enables execution must be able to complete the payment",
    );

    // The redemption path now leaves an execution record too. Before this there
    // was none: after a redemption was paid, the only monetary figure in the
    // system was the redemption's own stored amount.
    const redemptionExecution = await prisma.payoutExecution.findUniqueOrThrow({
      where: { rewardRedemptionId: paidRedemption.id },
    });
    assert.equal(redemptionExecution.kind, "REDEMPTION");
    assert.equal(redemptionExecution.paymentReference, "REDEMPTION-PAID-REF-001");

    // The stored amount was deliberately wrong. The authoritative valuation —
    // 30 points at the configured rate of 2 — is what was actually paid, and
    // the stored figure was corrected to match rather than being honoured.
    assert.equal(
      Number(redemptionExecution.amount),
      60,
      "the execution must record the authoritative valuation, not the stored amount",
    );
    assert.equal(
      (await prisma.rewardRedemption.findUniqueOrThrow({ where: { id: paidRedemption.id } })).amountRequested,
      60,
      "the authoritative value must overwrite a stored amount nothing computed",
    );

    // A redemption raised BEFORE the cutover is a claim on preserved legacy
    // value. The gate found that such a row was both spendable and payable:
    // the legacy offset removed its reservation, then re-valuation added the
    // same points back, so the member's eligible balance became their earnings
    // plus the pre-cutover claim — surplus funded entirely by carryover no
    // approved ratio had converted.
    const preCutoverBatch = await prisma.legacyMigrationBatch.create({
      data: {
        memberCount: 1,
        beforeTotalPoints: 500,
        migratedTotalPoints: 500,
        pendingTotalPoints: 500,
        snapshotChecksum: "pre-cutover-leak-checksum",
      },
    });
    const leakMember = await registerMember("902", null, "d".repeat(64));
    const preCutoverRedemption = await prisma.rewardRedemption.create({
      data: {
        voterUserId: leakMember.id,
        pointsRequested: 400,
        amountRequested: null,
        status: "APPROVED",
        createdAt: new Date(preCutoverBatch.executedAt.getTime() - 60_000),
      },
    });
    await prisma.legacyBalanceCarryover.create({
      data: {
        userId: leakMember.id,
        migrationBatchId: preCutoverBatch.id,
        sourceRowIdsJson: ["legacy-row-leak"],
        legacyPointBalance: 500,
        legacyReservedPoints: 400,
        rowChecksum: "pre-cutover-leak-row",
        status: "LEGACY_CARRYOVER_PENDING",
      },
    });

    // The member earned nothing in the authoritative ledger, so nothing is
    // spendable — the 500 preserved points are visible but not payable, and the
    // pre-cutover claim is reported rather than released.
    const leakBalance = await apiRequest(`/pre-election/rewards/balance?userId=${leakMember.id}`, {
      token: superAdminToken,
    });
    assert.equal(
      (leakBalance.payload as { availablePoints: number }).availablePoints,
      0,
      "a pre-cutover claim must not turn preserved carryover into a spendable balance",
    );
    assert.equal((leakBalance.payload as { legacyCarryoverPendingPoints: number }).legacyCarryoverPendingPoints, 500);
    assert.equal(
      (leakBalance.payload as { preCutoverReservedPoints: number }).preCutoverReservedPoints,
      400,
      "a legacy-era claim must be reported, and must stay fully reserved",
    );

    // The decisive assertion: the preserved balance must not change what is
    // spendable. Releasing a reservation because a carryover exists would price
    // that carryover at parity, which no approved ratio has authorised.
    const beforeCarryoverRemoval = (leakBalance.payload as { availablePoints: number }).availablePoints;
    await prisma.legacyBalanceCarryover.updateMany({
      where: { userId: leakMember.id },
      data: { status: "LEGACY_CARRYOVER_VOID" },
    });
    const withoutCarryover = await apiRequest(`/pre-election/rewards/balance?userId=${leakMember.id}`, {
      token: superAdminToken,
    });
    assert.equal(
      (withoutCarryover.payload as { availablePoints: number }).availablePoints,
      beforeCarryoverRemoval,
      "the spendable balance must not be a function of a pending carryover",
    );
    await prisma.legacyBalanceCarryover.updateMany({
      where: { userId: leakMember.id },
      data: { status: "LEGACY_CARRYOVER_PENDING" },
    });

    // And it cannot be paid, at the chokepoint, whatever the routes allow.
    await assert.rejects(
      () =>
        executePayout(prisma, {
          kind: "REDEMPTION",
          redemptionId: preCutoverRedemption.id,
          actorUserId: payoutOfficer.id,
          paymentReference: "PRE-CUTOVER-CLAIM-REF",
        }),
      (error: unknown) =>
        error instanceof PayoutExecutionError &&
        error.code === "AMOUNT_NOT_AUTHORITATIVE" &&
        /preserved legacy balance that has not been reconciled/.test(error.message),
      "an unreconciled legacy claim must be refused as a legacy claim, not as an incidental balance shortfall",
    );
    assert.equal(
      await prisma.payoutExecution.count({ where: { rewardRedemptionId: preCutoverRedemption.id } }),
      0,
      "a refused legacy claim must leave no execution record",
    );

    // Paying the same redemption twice pays once.
    const doubleRedemption = await apiRequest(`/admin/redemptions/${paidRedemption.id}/paid`, {
      method: "PATCH",
      token: superAdminToken,
      body: { paymentReference: "REDEMPTION-PAID-REF-002" },
    });
    assert.equal(doubleRedemption.status, 409, JSON.stringify(doubleRedemption.payload));
    assert.equal(
      await prisma.payoutExecution.count({ where: { rewardRedemptionId: paidRedemption.id } }),
      1,
      "a repeated redemption payment must not create a second execution record",
    );

    // The configured default is disabled in every environment; the override
    // above is a test affordance, not a change to that default.
    assert.equal(env.PAYOUT_EXECUTION_ENABLED, false, "payout execution must default to disabled in every environment");
    setPayoutExecutionEnabledForTests(null);


    /* ---- Voter-document private storage (feature 029) ----------------
     * These documents are identity evidence. Before this the record named a
     * storage key the client chose and a hash the client computed, and no
     * bytes were ever uploaded — so the assertions below are about who is
     * authoritative, not merely about whether an upload succeeds.
     */
    // ---- a voter document is stored privately and every authoritative field is derived by the server ----
    {
    const member = await registerMember("910", null, "private-storage");
    const document = await prisma.voterVerificationDocument.findFirstOrThrow({
      where: { verification: { memberUserId: member.id } },
      orderBy: { uploadedAt: "desc" },
    });

    // The stub is gone: a provider that stored nothing while reading as
    // private storage.
    assert.notEqual(document.storageProvider, "PRIVATE_OBJECT_STORAGE_STUB");
    assert.ok(document.storageBucket, "a stored document must record the bucket that holds it");
    assert.ok(document.serverReceivedAt, "a stored document must record when the server took custody");

    // The key is server-owned and namespaced, never the client's choice.
    assert.match(document.originalStorageKey, /^voter-verification\/\d{4}\/\d{2}\//);
    assert.equal(document.originalStorageKey.includes("client"), false);

    // The bytes are really there, and hash to what was recorded.
    const expected = Buffer.from(pdfDocument("private-storage"), "base64");
    const expectedSha256 = createHash("sha256").update(expected).digest("hex");
    assert.equal(document.sha256, expectedSha256, "the recorded hash must be the server's hash of the stored bytes");
    assert.equal(document.fileSize, expected.byteLength, "the recorded size must be the size of the stored bytes");

    const stored = await getPrivateObjectStorage().getObject(document.originalStorageKey);
    assert.ok(stored, "the document bytes must actually exist in private storage");
    assert.equal(stored.sha256, expectedSha256);
    }

    // ---- a client cannot choose the storage key, the size, or the hash of its own document ----
    {
    const token = await login(testEmail("member-910"));
    const forged = await apiRequest("/pre-election/verifications/me/documents", {
      method: "POST",
      token,
      body: {
        documentProcessingConsent: true,
        voterDocument: {
          originalFileName: "forged.pdf",
          mimeType: "application/pdf",
          content: pdfDocument("forgery-attempt"),
          // Everything below is what a client used to be able to assert.
          originalStorageKey: "voter-verification/client/attacker-chosen-key-000000",
          fileSize: 999999,
          sha256: "f".repeat(64),
        },
      },
    });
    assert.equal(forged.status, 201, JSON.stringify(forged.payload));

    const document = await prisma.voterVerificationDocument.findFirstOrThrow({
      where: { verification: { memberUserId: { not: undefined } }, originalFileName: "forged.pdf" },
      orderBy: { uploadedAt: "desc" },
    });

    const bytes = Buffer.from(pdfDocument("forgery-attempt"), "base64");
    assert.equal(document.originalStorageKey.includes("attacker-chosen-key"), false, "the client chose the storage key");
    assert.equal(document.fileSize, bytes.byteLength, "the client's stated size was believed");
    assert.equal(document.sha256, createHash("sha256").update(bytes).digest("hex"), "the client's stated hash was believed");
    assert.notEqual(document.sha256, "f".repeat(64));
    }

    // ---- content that does not match its declared type is refused rather than stored ----
    {
    const token = await login(testEmail("member-910"));
    const before = await prisma.voterVerificationDocument.count();

    const mislabelled = await apiRequest("/pre-election/verifications/me/documents", {
      method: "POST",
      token,
      body: {
        documentProcessingConsent: true,
        voterDocument: {
          originalFileName: "not-really.pdf",
          mimeType: "application/pdf",
          // A PNG header declared as a PDF.
          content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]).toString("base64"),
        },
      },
    });
    assert.equal(mislabelled.status, 400, JSON.stringify(mislabelled.payload));
    assert.equal(await prisma.voterVerificationDocument.count(), before, "a refused document must not be recorded");
    }

    // ---- the duplicate-document check compares hashes the server computed ----
    {
    // Two different members submitting the identical file. Neither of them
    // states a hash, so the match can only come from the bytes.
    const first = await registerMember("911", null, "shared-document");
    const second = await registerMember("912", null, "shared-document");

    const secondVerification = await prisma.voterVerification.findFirstOrThrow({
      where: { memberUserId: second.id },
    });
    assert.equal(secondVerification.isFlagged, true, "an identical document must be flagged");
    assert.equal(secondVerification.fraudReason, "DUPLICATE_DOCUMENT_HASH");

    const firstVerification = await prisma.voterVerification.findFirstOrThrow({
      where: { memberUserId: first.id },
    });
    assert.equal(firstVerification.isFlagged, false, "the first submitter must not be flagged by the second");
    }

    // ---- document access issues a short-lived signed URL, verifies the stored bytes, and is audited ----
    {
    const member = await registerMember("913", null, "access-check");
    const document = await prisma.voterVerificationDocument.findFirstOrThrow({
      where: { verification: { memberUserId: member.id } },
    });
    const verification = await prisma.voterVerification.findFirstOrThrow({
      where: { memberUserId: member.id },
    });

    const access = await apiRequest(
      `/pre-election/verifications/${verification.id}/documents/${document.id}/access`,
      { token: validatorToken },
    );
    assert.equal(access.status, 200, JSON.stringify(access.payload));
    const granted = access.payload as { url: string; expiresAt: string; verifiedSha256: string };

    assert.ok(granted.url, "access must return a URL to the document");
    assert.equal(granted.verifiedSha256, document.sha256, "access must verify the stored bytes against the record");

    // Short-lived by construction, and never a permanent public URL.
    const lifetimeMs = new Date(granted.expiresAt).getTime() - Date.now();
    assert.ok(lifetimeMs > 0, "the signed URL must not already be expired");
    assert.ok(lifetimeMs <= 6 * 60 * 1000, `the signed URL must be short lived, got ${lifetimeMs}ms`);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "VERIFICATION_DOCUMENT_ACCESS_GRANTED", targetId: document.id },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audit, "granting access to an identity document must be audited");
    }

    // ---- access is refused when the stored document no longer matches its recorded hash ----
    {
    const member = await registerMember("914", null, "tamper-check");
    const document = await prisma.voterVerificationDocument.findFirstOrThrow({
      where: { verification: { memberUserId: member.id } },
    });
    const verification = await prisma.voterVerification.findFirstOrThrow({
      where: { memberUserId: member.id },
    });

    // The record now claims a hash the stored object does not have, which is
    // what a replaced or corrupted object looks like.
    await prisma.voterVerificationDocument.update({
      where: { id: document.id },
      data: { sha256: "a".repeat(64) },
    });

    const access = await apiRequest(
      `/pre-election/verifications/${verification.id}/documents/${document.id}/access`,
      { token: validatorToken },
    );
    assert.equal(access.status, 409, JSON.stringify(access.payload));
    assert.equal((access.payload as { code: string }).code, "STORED_HASH_MISMATCH");

    const refusal = await prisma.auditLog.findFirst({
      where: { action: "VERIFICATION_DOCUMENT_ACCESS_REFUSED", targetId: document.id },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(refusal, "a refused access to an identity document must also be audited");
    }

    // ---- only a validator or super admin may open a voter document ----
    {
    const member = await registerMember("915", null, "authz-check");
    const document = await prisma.voterVerificationDocument.findFirstOrThrow({
      where: { verification: { memberUserId: member.id } },
    });
    const verification = await prisma.voterVerification.findFirstOrThrow({
      where: { memberUserId: member.id },
    });

    // The member the document is about cannot mint an access URL for it.
    const memberToken = await login(testEmail("member-915"));
    const asMember = await apiRequest(
      `/pre-election/verifications/${verification.id}/documents/${document.id}/access`,
      { token: memberToken },
    );
    assert.equal(asMember.status === 401 || asMember.status === 403, true, `member got ${asMember.status}`);

    const anonymous = await apiRequest(
      `/pre-election/verifications/${verification.id}/documents/${document.id}/access`,
    );
    assert.equal(anonymous.status === 401 || anonymous.status === 403, true, `anonymous got ${anonymous.status}`);
    }

    /* ---- Pending-object custody (rollback leaves no identity bytes) --------
     * The bytes must be written before the row exists, or a row could name an
     * object that is not there. That creates the opposite risk: a rolled-back
     * submission retaining someone's identity document with no database owner.
     * These assertions are about which of the two states the system ends in.
     */
    {
      const bucket = getPrivateObjectStorage() as unknown as { keys(): string[] };
      const pendingPrefix = "voter-verification/pending/";
      const pendingKeys = () => bucket.keys().filter((key) => key.startsWith(pendingPrefix));
      const committedKeys = () =>
        bucket.keys().filter((key) => key.startsWith("voter-verification/") && !key.startsWith(pendingPrefix));

      // B: a successful submission commits exactly one object, in the committed
      // namespace, and leaves nothing pending.
      const custodyMember = await registerMember("920", null, "custody-success");
      const committedAfter = committedKeys();
      assert.equal(pendingKeys().length, 0, "a committed submission must leave no pending object");

      const committedDocument = await prisma.voterVerificationDocument.findFirstOrThrow({
        where: { verification: { memberUserId: custodyMember.id } },
      });
      assert.equal(
        committedAfter.includes(committedDocument.originalStorageKey),
        true,
        "the committed row must name an object that exists in the committed namespace",
      );
      assert.equal(
        committedDocument.originalStorageKey.startsWith(pendingPrefix),
        false,
        "a committed document must never live in the pending namespace, where cleanup could delete it",
      );
      const committedObject = await getPrivateObjectStorage().getObject(committedDocument.originalStorageKey);
      assert.ok(committedObject, "the promoted object must exist at the committed key");
      assert.equal(committedObject.sha256, committedDocument.sha256);

      // A + F: a submission the transaction refuses leaves no pending bytes.
      // Approving the verification makes any resubmission fail inside the
      // transaction, after the document has already been written to storage.
      const custodyVerification = await prisma.voterVerification.findFirstOrThrow({
        where: { memberUserId: custodyMember.id },
      });
      await prisma.voterVerification.update({
        where: { id: custodyVerification.id },
        data: { status: "VERIFIED" },
      });

      const pendingBefore = pendingKeys().length;
      const documentsBefore = await prisma.voterVerificationDocument.count();
      const custodyToken = await login(testEmail("member-920"));
      const refused = await apiRequest("/pre-election/verifications/me/documents", {
        method: "POST",
        token: custodyToken,
        body: {
          documentProcessingConsent: true,
          voterDocument: {
            originalFileName: "rejected.pdf",
            mimeType: "application/pdf",
            content: pdfDocument("custody-rollback"),
          },
        },
      });
      assert.equal(refused.status === 409 || refused.status === 400, true, JSON.stringify(refused.payload));
      assert.equal(
        await prisma.voterVerificationDocument.count(),
        documentsBefore,
        "a refused submission must not write a document row",
      );
      assert.equal(
        pendingKeys().length,
        pendingBefore,
        "a refused submission must not retain identity-document bytes in the pending namespace",
      );

      // D: the cleanup path cannot reach a committed object.
      await assert.rejects(
        () => discardPendingObject(committedDocument.originalStorageKey),
        (error: unknown) => error instanceof CommittedObjectDeletionRefused,
        "committed identity documents must not be deletable through pending cleanup",
      );
      assert.ok(
        await getPrivateObjectStorage().getObject(committedDocument.originalStorageKey),
        "the committed object must survive an attempted cleanup",
      );

      // G: the same refusal protects committed evidence, which shares the bucket.
      await assert.rejects(
        () => discardPendingObject("evidence/2026/09/some-evidence-object.jpg"),
        (error: unknown) => error instanceof CommittedObjectDeletionRefused,
        "committed evidence must not be deletable through pending cleanup",
      );

      // And a promotion may not move a document *into* the deletable namespace.
      await assert.rejects(
        () =>
          promotePendingObject({
            pendingKey: `${pendingPrefix}probe-object.pdf`,
            committedKey: `${pendingPrefix}still-pending.pdf`,
          }),
        "promoting into the pending namespace must be refused",
      );

      await prisma.voterVerification.update({
        where: { id: custodyVerification.id },
        data: { status: "PENDING" },
      });
    }

    /* ---- Rollback / roll-forward custody ------------------------------------
     * The database no longer refuses an incomplete document row: migration
     * 20260906180000 dropped those CHECK constraints so the previous
     * application image stays a valid rollback target. That image writes the
     * historical shape, so rows in that shape can be created *after* the
     * migration, by an older image, during a rollback window.
     *
     * Nothing incomplete may be mistaken for a stored identity document. The
     * read path judges custody completeness rather than a provider label,
     * because the set of labels is open — an image nobody anticipated could
     * write a third one.
     */
    {
      const rollbackMember = await registerMember("930", null, "rollback-custody");
      const rollbackVerification = await prisma.voterVerification.findFirstOrThrow({
        where: { memberUserId: rollbackMember.id },
      });
      const rollbackDocument = await prisma.voterVerificationDocument.findFirstOrThrow({
        where: { verificationId: rollbackVerification.id },
      });

      const accessAttempt = () =>
        apiRequest(
          `/pre-election/verifications/${rollbackVerification.id}/documents/${rollbackDocument.id}/access`,
          { token: validatorToken },
        );

      // Baseline: complete custody is servable, so a later refusal is caused by
      // the incompleteness rather than by something else about this fixture.
      const servable = await accessAttempt();
      assert.equal(servable.status, 200, `complete custody must be servable: ${JSON.stringify(servable.payload)}`);

      const incompleteShapes: Array<{ label: string; provider: string }> = [
        // A: exactly what a rolled-back previous image writes.
        { label: "A historical stub provider", provider: "PRIVATE_OBJECT_STORAGE_STUB" },
        // B: what migration 20260906120000 relabelled those rows to.
        { label: "B normalized legacy provider", provider: "UNSTORED_LEGACY_STUB" },
        // C: an image nobody anticipated. The point of not testing a literal.
        { label: "C unexpected provider", provider: "SOME_FUTURE_UNKNOWN_PROVIDER" },
        // D: a provider that looks like real storage, with custody missing.
        { label: "D plausible provider, incomplete custody", provider: "s3-compatible" },
      ];

      for (const shape of incompleteShapes) {
        await prisma.voterVerificationDocument.update({
          where: { id: rollbackDocument.id },
          data: { storageProvider: shape.provider, storageBucket: null, serverReceivedAt: null },
        });

        const refused = await accessAttempt();
        assert.equal(
          refused.status,
          409,
          `${shape.label}: incomplete custody must be refused, got ${refused.status} ${JSON.stringify(refused.payload)}`,
        );
        assert.equal((refused.payload as { code: string }).code, "DOCUMENT_WAS_NEVER_STORED", shape.label);
        assert.equal(
          Object.prototype.hasOwnProperty.call(refused.payload, "url"),
          false,
          `${shape.label}: no signed URL may be issued for incomplete custody`,
        );
      }

      // Partial completeness is still incompleteness: a bucket without a
      // receipt time, and a receipt time without a bucket.
      await prisma.voterVerificationDocument.update({
        where: { id: rollbackDocument.id },
        data: { storageProvider: "s3-compatible", storageBucket: "some-bucket", serverReceivedAt: null },
      });
      assert.equal((await accessAttempt()).status, 409, "a bucket without a receipt time is not custody");

      await prisma.voterVerificationDocument.update({
        where: { id: rollbackDocument.id },
        data: { storageBucket: null, serverReceivedAt: new Date() },
      });
      assert.equal((await accessAttempt()).status, 409, "a receipt time without a bucket is not custody");

      // An object still sitting in the pending namespace is owned by no
      // committed row and may be swept at any moment.
      await prisma.voterVerificationDocument.update({
        where: { id: rollbackDocument.id },
        data: {
          storageProvider: "memory",
          storageBucket: "evidence-test-bucket",
          serverReceivedAt: new Date(),
          originalStorageKey: "voter-verification/pending/never-promoted.pdf",
        },
      });
      assert.equal(
        (await accessAttempt()).status,
        409,
        "a document that never left pending custody must not be servable",
      );

      // Every refusal is audited, so an operator can see why a validator was
      // shown nothing.
      const refusals = await prisma.auditLog.count({
        where: { action: "VERIFICATION_DOCUMENT_ACCESS_REFUSED", targetId: rollbackDocument.id },
      });
      assert.ok(refusals >= incompleteShapes.length, `expected an audit per refusal, saw ${refusals}`);

      await prisma.voterVerificationDocument.update({
        where: { id: rollbackDocument.id },
        data: {
          storageProvider: "memory",
          storageBucket: "evidence-test-bucket",
          serverReceivedAt: new Date(),
          originalStorageKey: rollbackDocument.originalStorageKey,
        },
      });
    }

    console.log("pre_election_tests=passed");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = null;
    await cleanup();
  }
}
