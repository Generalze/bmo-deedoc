import assert from "node:assert/strict";
import http from "node:http";
import type { Prisma } from "@prisma/client";
import { OGUN_STATE_ID } from "@pics-nigeria/shared";
import { hashPassword } from "./auth/password";
import { getAuthUserProfile } from "./auth/profile";
import { signAccessToken } from "./auth/jwt";
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

const password = "ElectionDay123!";
const lgaId = "election-day-test-lga";
const today = new Date().toISOString().slice(0, 10);
let baseUrl = "";
let server: http.Server | null = null;
let stateOfficerEmail = "";
let pucEmail = "";
let noConsentPucEmail = "";
let memberEmail = "";
let branches: Branch[] = [];

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

async function tokenWithoutGpsConsent(email: string, sessionNonce: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  await prisma.agentProfile.update({
    where: { userId: user.id },
    data: { gpsTrackingConsentAt: null, activeSessionNonce: sessionNonce },
  });
  const profile = await getAuthUserProfile(user.id);
  assert.ok(profile);
  return signAccessToken(profile, { sessionNonce });
}

async function createCommandHierarchy() {
  await prisma.state.upsert({
    where: { id: OGUN_STATE_ID },
    update: {},
    create: { id: OGUN_STATE_ID, name: "Ogun" },
  });
  await prisma.lGA.upsert({
    where: { id: lgaId },
    update: { stateId: OGUN_STATE_ID },
    create: { id: lgaId, name: "Election Day Test LGA", stateId: OGUN_STATE_ID },
  });
  await prisma.senatorialDistrict.upsert({
    where: { id: "election-day-test-senatorial" },
    update: {},
    create: {
      id: "election-day-test-senatorial",
      name: "Election Day Test Senatorial",
      stateId: OGUN_STATE_ID,
    },
  });
  await prisma.federalConstituency.upsert({
    where: { id: "election-day-test-federal" },
    update: {},
    create: {
      id: "election-day-test-federal",
      name: "Election Day Test Federal",
      stateId: OGUN_STATE_ID,
      senatorialDistrictId: "election-day-test-senatorial",
    },
  });

  branches = [];
  for (let index = 1; index <= 2; index += 1) {
    const stateConstituencyId = `election-day-test-state-constituency-${index}`;
    const wardId = `election-day-test-ward-${index}`;
    const pollingUnitId = `election-day-test-pu-${index}`;
    await prisma.stateConstituency.upsert({
      where: { id: stateConstituencyId },
      update: { federalConstituencyId: "election-day-test-federal" },
      create: {
        id: stateConstituencyId,
        name: `Election Day Test State Constituency ${index}`,
        stateId: OGUN_STATE_ID,
        lgaId,
        federalConstituencyId: "election-day-test-federal",
      },
    });
    await prisma.ward.upsert({
      where: { id: wardId },
      update: { stateConstituencyId },
      create: {
        id: wardId,
        name: `Election Day Test Ward ${index}`,
        stateId: OGUN_STATE_ID,
        lgaId,
        stateConstituencyId,
      },
    });
    await prisma.pollingUnit.upsert({
      where: { id: pollingUnitId },
      update: {},
      create: {
        id: pollingUnitId,
        name: `Election Day Test PU ${index}`,
        stateId: OGUN_STATE_ID,
        lgaId,
        wardId,
      },
    });
    branches.push({
      senatorialDistrictId: "election-day-test-senatorial",
      federalConstituencyId: "election-day-test-federal",
      stateConstituencyId,
      wardId,
      pollingUnitId,
    });
  }
}

async function createUser(label: string, data: Omit<Prisma.UserCreateInput, "name" | "email" | "passwordHash">) {
  const passwordHash = await hashPassword(password);
  return prisma.user.create({
    data: {
      name: `Election Day Test ${label}`,
      email: `election-day-test-${label}@pics.ng`,
      passwordHash,
      ...data,
    },
  });
}

function coordinatorProfile(branch: Branch) {
  return {
    level: "POLLING_UNIT" as const,
    stateId: OGUN_STATE_ID,
    senatorialDistrictId: branch.senatorialDistrictId,
    federalConstituencyId: branch.federalConstituencyId,
    stateConstituencyId: branch.stateConstituencyId,
    wardId: branch.wardId,
    pollingUnitId: branch.pollingUnitId,
  };
}

function agentProfile(branch: Branch, gpsTrackingConsentAt: Date | null) {
  return {
    stateId: OGUN_STATE_ID,
    senatorialDistrictId: branch.senatorialDistrictId,
    federalConstituencyId: branch.federalConstituencyId,
    stateConstituencyId: branch.stateConstituencyId,
    lgaId,
    wardId: branch.wardId,
    pollingUnitId: branch.pollingUnitId,
    gpsTrackingConsentAt,
  };
}

async function createFixtures() {
  const branchA = branches[0];
  const branchB = branches[1];

  stateOfficerEmail = (await createUser("state-officer", { role: "STATE_OFFICER" })).email;
  pucEmail = (await createUser("puc", {
    role: "COORDINATOR",
    coordinatorProfile: { create: coordinatorProfile(branchA) },
    agentProfile: { create: agentProfile(branchA, new Date()) },
  })).email;
  noConsentPucEmail = (await createUser("no-consent-puc", {
    role: "COORDINATOR",
    coordinatorProfile: { create: coordinatorProfile(branchB) },
    agentProfile: { create: agentProfile(branchB, null) },
  })).email;
  memberEmail = (await createUser("member", {
    role: "MEMBER",
    voterProfile: {
      create: {
        voterCardNumber: "ELECTION-DAY-TEST-MEMBER",
        referralCode: "EDAYTEST",
        stateId: OGUN_STATE_ID,
        senatorialDistrictId: branchA.senatorialDistrictId,
        federalConstituencyId: branchA.federalConstituencyId,
        stateConstituencyId: branchA.stateConstituencyId,
        lgaId,
        wardId: branchA.wardId,
        pollingUnitId: branchA.pollingUnitId,
      },
    },
  })).email;
}

const cases: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "PUC check-in is idempotent and geofence evaluation remains gated without authoritative PU geodata",
    run: async () => {
      const token = await login(pucEmail);
      const first = await apiRequest("/election-day/check-in", {
        token,
        method: "POST",
        body: { latitude: 7.1601, longitude: 3.3483, accuracyMeters: 15, idempotencyKey: "eday-checkin-1" },
      });
      assert.equal(first.status, 201, JSON.stringify(first.payload));
      assert.equal((first.payload.geofence as { status: string }).status, "GATED_AUTHORITATIVE_PU_GEODATA_REQUIRED");

      const duplicate = await apiRequest("/election-day/check-in", {
        token,
        method: "POST",
        body: { latitude: 7.1601, longitude: 3.3483, accuracyMeters: 15, idempotencyKey: "eday-checkin-1" },
      });
      assert.equal(duplicate.status, 200, JSON.stringify(duplicate.payload));
      assert.equal(duplicate.payload.alreadyRecorded, true);

      const status = await apiRequest(`/election-day/my-status?reportDate=${today}`, { token });
      assert.equal(status.status, 200, JSON.stringify(status.payload));
      const pollingUnitStatus = status.payload.status as { checkedInAt: string | null; geofence: { status: string } };
      assert.ok(pollingUnitStatus.checkedInAt);
      assert.equal(pollingUnitStatus.geofence.status, "GATED_AUTHORITATIVE_PU_GEODATA_REQUIRED");
    },
  },
  {
    name: "location pings fail closed without GPS tracking consent",
    run: async () => {
      const token = await tokenWithoutGpsConsent(noConsentPucEmail, "election-day-no-consent-session");
      const result = await apiRequest("/election-day/location-pings", {
        token,
        method: "POST",
        body: { latitude: 7.1601, longitude: 3.3483, accuracyMeters: 20 },
      });
      assert.equal(result.status, 400);
      assert.match(String(result.payload.message), /GPS tracking consent is required/);
    },
  },
  {
    name: "Situation Room status is durable, territory scoped, and denies members",
    run: async () => {
      const stateToken = await login(stateOfficerEmail);
      const status = await apiRequest(`/election-day/situation-room/status?reportDate=${today}`, { token: stateToken });
      assert.equal(status.status, 200, JSON.stringify(status.payload));
      const situation = status.payload.status as {
        totals: { expectedPollingUnits: number; assignedPollingUnits: number; checkedInPollingUnits: number; missingCheckIns: number };
        alerts: Array<{ type: string }>;
        realtime: { runtimeStatus: string; restFallbackAvailable: boolean };
      };
      // The situation room is state-scoped, and every polling unit in Ogun now
      // counts toward it — including the one the sample seed attaches to. This
      // assertion previously read as an absolute only because the seed sat in
      // Lagos and fell outside the state entirely. What this test owns is its
      // own two assigned units, so that is what it asserts.
      assert.ok(
        situation.totals.expectedPollingUnits >= 2,
        `expected at least the two fixture polling units, saw ${situation.totals.expectedPollingUnits}`,
      );
      assert.ok(
        situation.totals.assignedPollingUnits >= 2,
        `expected at least the two fixture assignments, saw ${situation.totals.assignedPollingUnits}`,
      );
      assert.ok(
        situation.totals.checkedInPollingUnits >= 1,
        `expected the checked-in fixture unit to be counted, saw ${situation.totals.checkedInPollingUnits}`,
      );
      // The invariant that actually matters, and the one an operator reads:
      // every assigned unit is either checked in or counted as missing.
      assert.equal(
        situation.totals.missingCheckIns,
        situation.totals.assignedPollingUnits - situation.totals.checkedInPollingUnits,
        "every assigned polling unit must be either checked in or reported missing",
      );
      assert.ok(situation.alerts.some((alert) => alert.type === "NO_CHECK_IN"));
      assert.equal(situation.realtime.runtimeStatus, "TARGET_NOT_RUNNING");
      assert.equal(situation.realtime.restFallbackAvailable, true);

      const memberToken = await login(memberEmail);
      const denied = await apiRequest("/election-day/situation-room/status", { token: memberToken });
      assert.equal(denied.status, 403);
    },
  },
  {
    name: "territory messaging foundation persists REST fallback messages for PUC recipients",
    run: async () => {
      const stateToken = await login(stateOfficerEmail);
      const created = await apiRequest("/election-day/messages/territory", {
        token: stateToken,
        method: "POST",
        body: { title: "Missing reports", message: "Submit Election Day status updates immediately." },
      });
      assert.equal(created.status, 201, JSON.stringify(created.payload));

      const pucToken = await login(pucEmail);
      const messages = await apiRequest("/election-day/messages", { token: pucToken });
      assert.equal(messages.status, 200, JSON.stringify(messages.payload));
      const broadcasts = messages.payload.broadcasts as Array<{ title: string }>;
      assert.ok(broadcasts.some((broadcast) => broadcast.title === "Missing reports"));
    },
  },
  {
    name: "alert reconciliation creates durable alert lifecycle events",
    run: async () => {
      const stateToken = await login(stateOfficerEmail);
      const reconciled = await apiRequest("/election-day/alerts/reconcile", {
        token: stateToken,
        method: "POST",
        body: { reportDate: today },
      });
      assert.equal(reconciled.status, 201, JSON.stringify(reconciled.payload));

      const alerts = await apiRequest(`/election-day/alerts?reportDate=${today}`, { token: stateToken });
      assert.equal(alerts.status, 200, JSON.stringify(alerts.payload));
      const visibleAlerts = alerts.payload.alerts as Array<{ id: string; type: string; status: string }>;
      const noCheckIn = visibleAlerts.find((alert) => alert.type === "NO_CHECK_IN");
      assert.ok(noCheckIn);

      const updated = await apiRequest(`/election-day/alerts/${noCheckIn.id}`, {
        token: stateToken,
        method: "PATCH",
        body: { status: "ACKNOWLEDGED", note: "Calling coordinator now." },
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.payload));
      assert.equal((updated.payload.alert as { status: string }).status, "ACKNOWLEDGED");

      const outboxCount = await prisma.realtimeEventOutbox.count({
        where: { eventType: { in: ["election.alert.created", "election.alert.updated"] } },
      });
      assert.ok(outboxCount >= 2);
    },
  },
  {
    name: "direct Election Operations messaging is permission scoped and durable",
    run: async () => {
      const stateToken = await login(stateOfficerEmail);
      const puc = await prisma.user.findUniqueOrThrow({ where: { email: pucEmail }, select: { id: true } });
      const created = await apiRequest("/election-day/conversations", {
        token: stateToken,
        method: "POST",
        body: { type: "DIRECT", recipientUserId: puc.id, title: "PU check-in desk" },
      });
      assert.equal(created.status, 201, JSON.stringify(created.payload));
      const conversationId = created.payload.conversationId as string;

      const sent = await apiRequest(`/election-day/conversations/${conversationId}/messages`, {
        token: stateToken,
        method: "POST",
        body: { body: "Confirm PU status and report ETA." },
      });
      assert.equal(sent.status, 201, JSON.stringify(sent.payload));

      const pucToken = await login(pucEmail);
      const conversations = await apiRequest("/election-day/conversations", { token: pucToken });
      assert.equal(conversations.status, 200, JSON.stringify(conversations.payload));
      assert.ok((conversations.payload.conversations as Array<{ id: string }>).some((item) => item.id === conversationId));

      const messages = await apiRequest(`/election-day/conversations/${conversationId}/messages`, { token: pucToken });
      assert.equal(messages.status, 200, JSON.stringify(messages.payload));
      assert.equal((messages.payload.messages as Array<{ body: string }>)[0].body, "Confirm PU status and report ETA.");

      const memberToken = await login(memberEmail);
      const denied = await apiRequest(`/election-day/conversations/${conversationId}/messages`, {
        token: memberToken,
        method: "POST",
        body: { body: "Unauthorized message" },
      });
      assert.equal(denied.status, 403);
    },
  },
  {
    name: "realtime replay rebuilds missed events from the durable outbox and stays territory scoped",
    run: async () => {
      const stateToken = await login(stateOfficerEmail);

      // Earlier suites committed durable events (check-in, alerts, messages). A
      // reconnecting client asks for everything since a cursor rather than
      // trusting that every live socket frame arrived.
      const replay = await apiRequest("/election-day/realtime/replay?since=1970-01-01T00:00:00.000Z", { token: stateToken });
      assert.equal(replay.status, 200, JSON.stringify(replay.payload));
      const body = replay.payload as {
        events: Array<{ eventId: string; eventType: string; committedAt: string }>;
        cursor: string;
        snapshotPath: string;
      };
      assert.ok(body.events.length > 0, "durable outbox should contain committed events");
      assert.equal(body.snapshotPath, "/election-day/situation-room/status");

      // Ordering lets a client apply events and advance its cursor safely.
      const timestamps = body.events.map((event) => new Date(event.committedAt).getTime());
      assert.deepEqual(timestamps, [...timestamps].sort((left, right) => left - right));
      assert.equal(body.cursor, body.events[body.events.length - 1].committedAt);

      // Replaying from the returned cursor yields nothing new, so repeated
      // reconnects do not reprocess the same events.
      const empty = await apiRequest(`/election-day/realtime/replay?since=${encodeURIComponent(body.cursor)}`, { token: stateToken });
      assert.equal(empty.status, 200, JSON.stringify(empty.payload));
      assert.equal((empty.payload.events as unknown[]).length, 0);

      // Replay must not become a way to read another territory's events.
      const memberToken = await login(memberEmail);
      const denied = await apiRequest("/election-day/realtime/replay", { token: memberToken });
      assert.equal(denied.status, 403, JSON.stringify(denied.payload));

      const pucToken = await login(pucEmail);
      const scoped = await apiRequest("/election-day/realtime/replay?since=1970-01-01T00:00:00.000Z", { token: pucToken });
      assert.equal(scoped.status, 200, JSON.stringify(scoped.payload));
      const scopedEvents = scoped.payload.events as Array<{ territory: { pollingUnitId: string | null } | null }>;
      const otherBranchPollingUnitId = branches[1].pollingUnitId;
      assert.ok(
        scopedEvents.every((event) => event.territory?.pollingUnitId !== otherBranchPollingUnitId),
        "a Polling Unit coordinator must not replay another Polling Unit's events",
      );
    },
  },
  {
    name: "WebRTC config exposes STUN/TURN readiness, durable history, and never enables recording",
    run: async () => {
      const token = await login(stateOfficerEmail);
      const result = await apiRequest("/election-day/webrtc/config", { token });
      assert.equal(result.status, 200, JSON.stringify(result.payload));
      const config = result.payload.config as {
        signalling: { transport: string; events: string[]; restLifecyclePath: string };
        iceServers: Array<{ urls: string | string[] }>;
        turnConfigured: boolean;
        recording: string;
        durableCallHistory: string;
      };
      assert.equal(config.signalling.transport, "socket.io");
      assert.equal(config.signalling.restLifecyclePath, "/election-day/calls");
      assert.ok(config.signalling.events.includes("call.ringing"));
      assert.ok(config.signalling.events.includes("call.signal"));
      assert.ok(config.iceServers.length >= 1, "at least one STUN server must be configured");
      // TURN is unset in the test environment; the contract must report that honestly
      // rather than implying field devices behind carrier NAT are reachable.
      assert.equal(config.turnConfigured, false);
      assert.equal(config.recording, "DISABLED");
      assert.equal(config.durableCallHistory, "AVAILABLE");

      // A half-configured or malformed relay must never be advertised as
      // working. Browsers discard invalid ICE server entries silently, so
      // reporting turnConfigured=true would claim relay coverage that does not
      // exist. Only a well-formed turn:/turns: URI with both credentials counts.
      const turnUriPattern = /^turns?:[^\s:]+(:\d{1,5})?(\?transport=(udp|tcp))?$/i;
      const turnShapes = [
        { url: "turn:relay.example.org:3478", username: "u", credential: "c", expected: true },
        { url: "turns:relay.example.org:5349", username: "u", credential: "c", expected: true },
        { url: "turn:relay.example.org:3478?transport=udp", username: "u", credential: "c", expected: true },
        { url: "turn:relay.example.org:3478", username: "", credential: "c", expected: false },
        { url: "turn:relay.example.org:3478", username: "u", credential: "", expected: false },
        { url: "relay.example.org:3478", username: "u", credential: "c", expected: false },
        { url: "https://relay.example.org", username: "u", credential: "c", expected: false },
        { url: "", username: "u", credential: "c", expected: false },
      ];
      for (const shape of turnShapes) {
        const evaluated =
          turnUriPattern.test(shape.url.trim()) && Boolean(shape.username.trim()) && Boolean(shape.credential.trim());
        assert.equal(evaluated, shape.expected, `TURN shape misjudged: ${JSON.stringify(shape)}`);
      }
    },
  },
  {
    name: "voice call lifecycle initiates, rings, connects, ends, and is durably recorded in PostgreSQL",
    run: async () => {
      const stateToken = await login(stateOfficerEmail);
      const pucToken = await login(pucEmail);
      const puc = await prisma.user.findUniqueOrThrow({ where: { email: pucEmail }, select: { id: true } });
      const officer = await prisma.user.findUniqueOrThrow({ where: { email: stateOfficerEmail }, select: { id: true } });

      const initiated = await apiRequest("/election-day/calls", {
        token: stateToken,
        method: "POST",
        body: { targetUserId: puc.id },
      });
      assert.equal(initiated.status, 201, JSON.stringify(initiated.payload));
      const call = initiated.payload.item as {
        id: string;
        status: string;
        recording: string;
        ringingAt: string | null;
        participants: Array<{ userId: string; status: string; isInitiator: boolean }>;
      };
      assert.equal(call.status, "RINGING");
      assert.equal(call.recording, "DISABLED");
      assert.ok(call.ringingAt);
      assert.equal(call.participants.length, 2);
      assert.equal(call.participants.find((entry) => entry.userId === puc.id)?.status, "RINGING");
      assert.equal(call.participants.find((entry) => entry.userId === officer.id)?.isInitiator, true);

      // A second concurrent call between the same pair must be refused so the
      // durable lifecycle stays unambiguous.
      const duplicate = await apiRequest("/election-day/calls", {
        token: stateToken,
        method: "POST",
        body: { targetUserId: puc.id },
      });
      assert.equal(duplicate.status, 409, JSON.stringify(duplicate.payload));

      // The initiator cannot accept their own call.
      const selfAccept = await apiRequest(`/election-day/calls/${call.id}/accept`, { token: stateToken, method: "POST" });
      assert.equal(selfAccept.status, 403, JSON.stringify(selfAccept.payload));

      const accepted = await apiRequest(`/election-day/calls/${call.id}/accept`, { token: pucToken, method: "POST" });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.payload));
      const connected = accepted.payload.item as { status: string; connectedAt: string | null };
      assert.equal(connected.status, "CONNECTED");
      assert.ok(connected.connectedAt);

      const ended = await apiRequest(`/election-day/calls/${call.id}/end`, {
        token: stateToken,
        method: "POST",
        body: { reason: "COMPLETED" },
      });
      assert.equal(ended.status, 200, JSON.stringify(ended.payload));
      const finished = ended.payload.item as {
        status: string;
        endReason: string;
        durationSeconds: number | null;
        events: Array<{ type: string }>;
      };
      assert.equal(finished.status, "ENDED");
      assert.equal(finished.endReason, "COMPLETED");
      assert.ok(typeof finished.durationSeconds === "number" && finished.durationSeconds >= 0);
      for (const expected of ["INITIATED", "RINGING", "ACCEPTED", "CONNECTED", "ENDED"]) {
        assert.ok(finished.events.some((event) => event.type === expected), `missing lifecycle event ${expected}`);
      }

      // PostgreSQL is authoritative: the durable record must match the response.
      const durable = await prisma.voiceCall.findUniqueOrThrow({
        where: { id: call.id },
        include: { participants: true, events: true },
      });
      assert.equal(durable.status, "ENDED");
      assert.equal(durable.endReason, "COMPLETED");
      assert.equal(durable.recordingPolicy, "DISABLED");
      assert.equal(durable.participants.length, 2);
      assert.ok(durable.events.length >= 5);

      const history = await apiRequest("/election-day/calls", { token: pucToken });
      assert.equal(history.status, 200, JSON.stringify(history.payload));
      assert.ok((history.payload.calls as Array<{ id: string }>).some((entry) => entry.id === call.id));

      // A terminal call cannot be reopened.
      const reAccept = await apiRequest(`/election-day/calls/${call.id}/accept`, { token: pucToken, method: "POST" });
      assert.equal(reAccept.status, 409, JSON.stringify(reAccept.payload));
    },
  },
  {
    name: "voice call rejection and missed-call outcomes are distinguished and durable",
    run: async () => {
      const stateToken = await login(stateOfficerEmail);
      const pucToken = await login(pucEmail);
      const puc = await prisma.user.findUniqueOrThrow({ where: { email: pucEmail }, select: { id: true } });

      const rejectedCall = await apiRequest("/election-day/calls", {
        token: stateToken,
        method: "POST",
        body: { targetUserId: puc.id },
      });
      assert.equal(rejectedCall.status, 201, JSON.stringify(rejectedCall.payload));
      const rejectedId = (rejectedCall.payload.item as { id: string }).id;

      const rejected = await apiRequest(`/election-day/calls/${rejectedId}/reject`, { token: pucToken, method: "POST" });
      assert.equal(rejected.status, 200, JSON.stringify(rejected.payload));
      const rejectedItem = rejected.payload.item as {
        status: string;
        endReason: string;
        participants: Array<{ userId: string; status: string }>;
      };
      assert.equal(rejectedItem.status, "ENDED");
      assert.equal(rejectedItem.endReason, "REJECTED");
      assert.equal(rejectedItem.participants.find((entry) => entry.userId === puc.id)?.status, "REJECTED");

      // Initiator hanging up before the recipient answers is a missed call, not a
      // completed one; the distinction matters for operational follow-up.
      const missedCall = await apiRequest("/election-day/calls", {
        token: stateToken,
        method: "POST",
        body: { targetUserId: puc.id },
      });
      assert.equal(missedCall.status, 201, JSON.stringify(missedCall.payload));
      const missedId = (missedCall.payload.item as { id: string }).id;

      const missed = await apiRequest(`/election-day/calls/${missedId}/end`, { token: stateToken, method: "POST" });
      assert.equal(missed.status, 200, JSON.stringify(missed.payload));
      const missedItem = missed.payload.item as { status: string; endReason: string; durationSeconds: number | null };
      assert.equal(missedItem.status, "ENDED");
      assert.equal(missedItem.endReason, "MISSED");
      assert.equal(missedItem.durationSeconds, 0);

      const durableMissed = await prisma.voiceCall.findUniqueOrThrow({ where: { id: missedId }, include: { events: true } });
      assert.ok(durableMissed.events.some((event) => event.type === "MISSED"));
    },
  },
  {
    name: "voice call permissions deny cross-territory, member, and non-participant access",
    run: async () => {
      const pucToken = await login(pucEmail);
      const memberToken = await login(memberEmail);
      const stateToken = await login(stateOfficerEmail);
      const puc = await prisma.user.findUniqueOrThrow({ where: { email: pucEmail }, select: { id: true } });
      const otherPuc = await prisma.user.findUniqueOrThrow({ where: { email: noConsentPucEmail }, select: { id: true } });

      // Two Polling Unit coordinators in different State Constituencies have no
      // command relationship in either direction.
      const crossTerritory = await apiRequest("/election-day/calls", {
        token: pucToken,
        method: "POST",
        body: { targetUserId: otherPuc.id },
      });
      assert.equal(crossTerritory.status, 403, JSON.stringify(crossTerritory.payload));

      // A member has no operational command scope and cannot place calls.
      const memberCall = await apiRequest("/election-day/calls", {
        token: memberToken,
        method: "POST",
        body: { targetUserId: puc.id },
      });
      assert.equal(memberCall.status, 403, JSON.stringify(memberCall.payload));

      // Self-calls are rejected before any durable state is created.
      const selfCall = await apiRequest("/election-day/calls", {
        token: pucToken,
        method: "POST",
        body: { targetUserId: puc.id },
      });
      assert.equal(selfCall.status, 400, JSON.stringify(selfCall.payload));

      const live = await apiRequest("/election-day/calls", {
        token: stateToken,
        method: "POST",
        body: { targetUserId: puc.id },
      });
      assert.equal(live.status, 201, JSON.stringify(live.payload));
      const liveId = (live.payload.item as { id: string }).id;

      // A non-participant must not be able to read, signal on, or end the call.
      const memberRead = await apiRequest(`/election-day/calls/${liveId}`, { token: memberToken });
      assert.equal(memberRead.status, 404, JSON.stringify(memberRead.payload));
      const memberSignal = await apiRequest(`/election-day/calls/${liveId}/signal`, {
        token: memberToken,
        method: "POST",
        body: { signalType: "offer", targetUserId: puc.id, signal: { sdp: "fake" } },
      });
      assert.equal(memberSignal.status, 404, JSON.stringify(memberSignal.payload));
      const memberEnd = await apiRequest(`/election-day/calls/${liveId}/end`, { token: memberToken, method: "POST" });
      assert.equal(memberEnd.status, 404, JSON.stringify(memberEnd.payload));

      // A participant may relay signalling, and only the signal type is retained.
      const signal = await apiRequest(`/election-day/calls/${liveId}/signal`, {
        token: stateToken,
        method: "POST",
        body: { signalType: "offer", targetUserId: puc.id, signal: { sdp: "v=0 test-offer" } },
      });
      assert.equal(signal.status, 202, JSON.stringify(signal.payload));
      const signalEvent = await prisma.voiceCallEvent.findFirstOrThrow({
        where: { callId: liveId, type: "SIGNAL_RELAYED" },
      });
      assert.equal(signalEvent.signalType, "offer");
      assert.equal(signalEvent.metadataJson, null, "signal bodies must never be persisted");

      const cleanup = await apiRequest(`/election-day/calls/${liveId}/end`, { token: stateToken, method: "POST" });
      assert.equal(cleanup.status, 200, JSON.stringify(cleanup.payload));

      // Signalling on an ended call is refused.
      const lateSignal = await apiRequest(`/election-day/calls/${liveId}/signal`, {
        token: stateToken,
        method: "POST",
        body: { signalType: "candidate", targetUserId: puc.id, signal: {} },
      });
      assert.equal(lateSignal.status, 409, JSON.stringify(lateSignal.payload));
    },
  },
];

async function setup() {
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Election Day test server did not start.");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  await createCommandHierarchy();
  await createFixtures();
}

async function teardown() {
  await prisma.auditLog.deleteMany({ where: { actorUser: { email: { startsWith: "election-day-test-" } } } });
  await prisma.notification.deleteMany({ where: { user: { email: { startsWith: "election-day-test-" } } } });
  await prisma.voiceCallEvent.deleteMany({ where: { call: { initiatorUser: { email: { startsWith: "election-day-test-" } } } } });
  await prisma.voiceCallParticipant.deleteMany({ where: { user: { email: { startsWith: "election-day-test-" } } } });
  await prisma.voiceCall.deleteMany({ where: { initiatorUser: { email: { startsWith: "election-day-test-" } } } });
  await prisma.messageReceipt.deleteMany({ where: { user: { email: { startsWith: "election-day-test-" } } } });
  await prisma.message.deleteMany({ where: { senderUser: { email: { startsWith: "election-day-test-" } } } });
  await prisma.conversationMember.deleteMany({ where: { user: { email: { startsWith: "election-day-test-" } } } });
  await prisma.conversation.deleteMany({ where: { createdByUser: { email: { startsWith: "election-day-test-" } } } });
  await prisma.operationalAlert.deleteMany({ where: { pollingUnitId: { startsWith: "election-day-test-" } } });
  await prisma.realtimeEventOutbox.deleteMany({ where: { OR: [{ idempotencyKey: { startsWith: "alert:" } }, { idempotencyKey: { startsWith: "alert-updated:" } }, { idempotencyKey: { startsWith: "message:" } }, { idempotencyKey: { startsWith: "call:" } }] } });
  await prisma.broadcastMessage.deleteMany({ where: { createdByUser: { email: { startsWith: "election-day-test-" } } } });
  await prisma.agentActivity.deleteMany({ where: { agentUser: { email: { startsWith: "election-day-test-" } } } });
  await prisma.incident.deleteMany({ where: { reportedByUser: { email: { startsWith: "election-day-test-" } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "election-day-test-" } } });
  await prisma.pollingUnit.deleteMany({ where: { id: { startsWith: "election-day-test-" } } });
  await prisma.ward.deleteMany({ where: { id: { startsWith: "election-day-test-" } } });
  await prisma.stateConstituency.deleteMany({ where: { id: { startsWith: "election-day-test-" } } });
  await prisma.federalConstituency.deleteMany({ where: { id: { startsWith: "election-day-test-" } } });
  await prisma.senatorialDistrict.deleteMany({ where: { id: { startsWith: "election-day-test-" } } });
  await prisma.lGA.deleteMany({ where: { id: { startsWith: "election-day-test-" } } });

  if (server) {
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  }
}

export async function runElectionDayTests() {
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
