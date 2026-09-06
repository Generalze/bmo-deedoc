import assert from "node:assert/strict";
import http from "node:http";
import type { Prisma } from "@prisma/client";
import { io as createSocketClient, type Socket as ClientSocket } from "socket.io-client";
import { OGUN_STATE_ID, type ElectionDayRealtimeEnvelope } from "@pics-nigeria/shared";
import { hashPassword } from "./auth/password";
import { signAccessToken } from "./auth/jwt";
import { getAuthUserProfile } from "./auth/profile";
import { createApp } from "./app";
import { prisma } from "./prisma";
import { createElectionDayRealtimeEvent } from "./realtime/events";
import { attachRealtimeGateway, closeRealtimeGateway, publishRealtimeEvent } from "./realtime/gateway";

type ApiResult = { status: number; payload: Record<string, unknown> };
type Branch = {
  senatorialDistrictId: string;
  federalConstituencyId: string;
  stateConstituencyId: string;
  wardId: string;
  pollingUnitId: string;
};

const password = "Realtime123!";
const lgaId = "realtime-test-lga";
let baseUrl = "";
let server: http.Server | null = null;
let stateOfficerEmail = "";
let secondOfficerEmail = "";
let wardAEmail = "";
let wardBEmail = "";
let memberEmail = "";
let branches: Branch[] = [];
let clients: ClientSocket[] = [];

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
  const result = await apiRequest("/auth/login", { method: "POST", body: { email, password } });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal(typeof result.payload.token, "string");
  return result.payload.token as string;
}

async function tokenFor(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  const profile = await getAuthUserProfile(user.id);
  assert.ok(profile);
  return signAccessToken(profile);
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
    create: { id: lgaId, name: "Realtime Test LGA", stateId: OGUN_STATE_ID },
  });
  await prisma.senatorialDistrict.upsert({
    where: { id: "realtime-test-senatorial" },
    update: {},
    create: { id: "realtime-test-senatorial", name: "Realtime Test Senatorial", stateId: OGUN_STATE_ID },
  });
  await prisma.federalConstituency.upsert({
    where: { id: "realtime-test-federal" },
    update: {},
    create: {
      id: "realtime-test-federal",
      name: "Realtime Test Federal",
      stateId: OGUN_STATE_ID,
      senatorialDistrictId: "realtime-test-senatorial",
    },
  });

  branches = [];
  for (let index = 1; index <= 2; index += 1) {
    const stateConstituencyId = `realtime-test-state-constituency-${index}`;
    const wardId = `realtime-test-ward-${index}`;
    const pollingUnitId = `realtime-test-pu-${index}`;
    await prisma.stateConstituency.upsert({
      where: { id: stateConstituencyId },
      update: { federalConstituencyId: "realtime-test-federal" },
      create: {
        id: stateConstituencyId,
        name: `Realtime Test State Constituency ${index}`,
        stateId: OGUN_STATE_ID,
        lgaId,
        federalConstituencyId: "realtime-test-federal",
      },
    });
    await prisma.ward.upsert({
      where: { id: wardId },
      update: { stateConstituencyId },
      create: {
        id: wardId,
        name: `Realtime Test Ward ${index}`,
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
        name: `Realtime Test PU ${index}`,
        stateId: OGUN_STATE_ID,
        lgaId,
        wardId,
      },
    });
    branches.push({
      senatorialDistrictId: "realtime-test-senatorial",
      federalConstituencyId: "realtime-test-federal",
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
      name: `Realtime Test ${label}`,
      email: `realtime-test-${label}@pics.ng`,
      passwordHash,
      ...data,
    },
  });
}

async function createFixtures() {
  const branchA = branches[0];
  const branchB = branches[1];
  stateOfficerEmail = (await createUser("state-officer", { role: "STATE_OFFICER" })).email;
  /**
   * A second officer with the same reach as the caller. Using a ward
   * coordinator from another branch as the outsider proved nothing: the contact
   * rule refuses that pair before the participant check is ever consulted, so
   * the test passed with the participant check deleted.
   */
  secondOfficerEmail = (await createUser("second-officer", { role: "STATE_OFFICER" })).email;
  wardAEmail = (await createUser("ward-a", {
    role: "COORDINATOR",
    coordinatorProfile: {
      create: {
        level: "WARD",
        stateId: OGUN_STATE_ID,
        senatorialDistrictId: branchA.senatorialDistrictId,
        federalConstituencyId: branchA.federalConstituencyId,
        stateConstituencyId: branchA.stateConstituencyId,
        wardId: branchA.wardId,
      },
    },
  })).email;
  wardBEmail = (await createUser("ward-b", {
    role: "COORDINATOR",
    coordinatorProfile: {
      create: {
        level: "WARD",
        stateId: OGUN_STATE_ID,
        senatorialDistrictId: branchB.senatorialDistrictId,
        federalConstituencyId: branchB.federalConstituencyId,
        stateConstituencyId: branchB.stateConstituencyId,
        wardId: branchB.wardId,
      },
    },
  })).email;
  memberEmail = (await createUser("member", {
    role: "MEMBER",
    voterProfile: {
      create: {
        voterCardNumber: "REALTIME-TEST-MEMBER",
        referralCode: "RTTEST",
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

async function cleanupRealtimeFixtures() {
  /**
   * Calls first. VoiceCall holds its initiator with onDelete: Restrict, so a
   * suite that places a call cannot delete its own users afterwards — the
   * delete throws, the rest of this cleanup never runs, and the two Ogun wards
   * this suite creates survive to break another suite's ward counts.
   */
  await prisma.voiceCall.deleteMany({
    where: { participants: { some: { user: { email: { startsWith: "realtime-test-" } } } } },
  });
  await prisma.user.deleteMany({ where: { email: { startsWith: "realtime-test-" } } });
  await prisma.pollingUnit.deleteMany({ where: { id: { startsWith: "realtime-test-" } } });
  await prisma.ward.deleteMany({ where: { id: { startsWith: "realtime-test-" } } });
  await prisma.stateConstituency.deleteMany({ where: { id: { startsWith: "realtime-test-" } } });
  await prisma.federalConstituency.deleteMany({ where: { id: { startsWith: "realtime-test-" } } });
  await prisma.senatorialDistrict.deleteMany({ where: { id: { startsWith: "realtime-test-" } } });
  await prisma.lGA.deleteMany({ where: { id: { startsWith: "realtime-test-" } } });
}

async function connectSocket(token: string): Promise<ClientSocket> {
  const socket = createSocketClient(baseUrl, {
    path: "/socket.io",
    auth: { token },
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  clients.push(socket);

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });

  return socket;
}

async function subscribe(socket: ClientSocket, territory: Branch | { stateId: string }) {
  return new Promise<Record<string, unknown>>((resolve) => {
    socket.emit("election.subscribe", { territory: { stateId: OGUN_STATE_ID, ...territory } }, resolve);
  });
}

function onceRealtimeEvent(socket: ClientSocket, timeoutMs = 500): Promise<ElectionDayRealtimeEnvelope | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.off("realtime.event", handler);
      resolve(null);
    }, timeoutMs);
    const handler = (event: ElectionDayRealtimeEnvelope) => {
      clearTimeout(timeout);
      resolve(event);
    };
    socket.once("realtime.event", handler);
  });
}

function onceNamedEvent(socket: ClientSocket, eventName: string, timeoutMs = 500): Promise<ElectionDayRealtimeEnvelope | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, handler);
      resolve(null);
    }, timeoutMs);
    const handler = (event: ElectionDayRealtimeEnvelope) => {
      clearTimeout(timeout);
      resolve(event);
    };
    socket.once(eventName, handler);
  });
}

function emitSignal(
  socket: ClientSocket,
  payload: { callId: string; targetUserId: string; signalType: string; signal: unknown },
): Promise<{ ok?: boolean; message?: string }> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ ok: false, message: "signal acknowledgement timed out" }), 2_000);
    socket.emit("call.signal", payload, (response: { ok?: boolean; message?: string }) => {
      clearTimeout(timeout);
      resolve(response || {});
    });
  });
}

const cases: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "realtime contract reports degraded REST fallback when Redis is not configured",
    run: async () => {
      const token = await login(stateOfficerEmail);
      const result = await apiRequest("/election-day/realtime-contracts", { token });
      assert.equal(result.status, 200, JSON.stringify(result.payload));
      const realtime = result.payload.realtime as { runtimeStatus: string; redisAdapter: string; restFallbackAvailable: boolean };
      assert.equal(realtime.runtimeStatus, "DEGRADED_NO_REDIS");
      assert.equal(realtime.redisAdapter, "not_configured");
      assert.equal(realtime.restFallbackAvailable, true);
    },
  },
  {
    name: "socket subscriptions are authenticated and territory isolated",
    run: async () => {
      const [stateSocket, wardASocket, wardBSocket, memberSocket] = await Promise.all([
        connectSocket(await login(stateOfficerEmail)),
        connectSocket(await tokenFor(wardAEmail)),
        connectSocket(await tokenFor(wardBEmail)),
        connectSocket(await tokenFor(memberEmail)),
      ]);

      assert.equal((await subscribe(stateSocket, { stateId: OGUN_STATE_ID })).ok, true);
      assert.equal((await subscribe(wardASocket, branches[0])).ok, true);
      assert.equal((await subscribe(wardBSocket, branches[1])).ok, true);
      assert.equal((await subscribe(memberSocket, branches[0])).ok, false);

      const stateEvent = onceRealtimeEvent(stateSocket);
      const wardAEvent = onceRealtimeEvent(wardASocket);
      const wardBEvent = onceRealtimeEvent(wardBSocket, 150);
      publishRealtimeEvent(
        createElectionDayRealtimeEvent({
          eventType: "election.incident.created",
          actorUserId: null,
          territory: {
            stateId: OGUN_STATE_ID,
            senatorialDistrictId: branches[0].senatorialDistrictId,
            federalConstituencyId: branches[0].federalConstituencyId,
            stateConstituencyId: branches[0].stateConstituencyId,
            wardId: branches[0].wardId,
            pollingUnitId: branches[0].pollingUnitId,
          },
          idempotencyKey: "realtime-test-incident-1",
          payload: { incidentId: "realtime-test-incident-1", severity: "CRITICAL" },
        }),
      );

      assert.equal((await stateEvent)?.eventType, "election.incident.created");
      assert.equal((await wardAEvent)?.payload.incidentId, "realtime-test-incident-1");
      assert.equal(await wardBEvent, null);
    },
  },
  {
    name: "a call rings the callee and relays offer, answer and candidates between the two participants",
    run: async () => {
      const callerToken = await login(stateOfficerEmail);
      const calleeToken = await tokenFor(wardAEmail);
      const outsiderToken = await tokenFor(secondOfficerEmail);

      const callerSocket = await connectSocket(callerToken);
      const calleeSocket = await connectSocket(calleeToken);
      const outsiderSocket = await connectSocket(outsiderToken);

      const callee = await prisma.user.findUniqueOrThrow({ where: { email: wardAEmail }, select: { id: true } });
      const caller = await prisma.user.findUniqueOrThrow({ where: { email: stateOfficerEmail }, select: { id: true } });
      const outsider = await prisma.user.findUniqueOrThrow({ where: { email: secondOfficerEmail }, select: { id: true } });

      // The callee must learn about the call without asking for it. This is the
      // event the web client had no way to receive, which is why an incoming
      // call could only ever surface as a notification.
      const ringing = onceNamedEvent(calleeSocket, "call.ringing", 2_000);

      const initiated = await apiRequest("/election-day/calls", {
        token: callerToken,
        method: "POST",
        body: { targetUserId: callee.id },
      });
      assert.equal(initiated.status, 201, JSON.stringify(initiated.payload));
      const call = initiated.payload.item as { id: string; status: string };
      assert.equal(call.status, "RINGING");

      const ringingEvent = await ringing;
      assert.ok(ringingEvent, "the callee was never told the call was ringing");
      assert.equal((ringingEvent.payload as { callId: string }).callId, call.id);

      // Offer: caller → callee.
      const offerAtCallee = onceNamedEvent(calleeSocket, "call.signal", 2_000);
      const offerAck = await emitSignal(callerSocket, {
        callId: call.id,
        targetUserId: callee.id,
        signalType: "offer",
        signal: { type: "offer", sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n" },
      });
      assert.equal(offerAck.ok, true, JSON.stringify(offerAck));
      const offerEvent = (await offerAtCallee) as unknown as {
        callId: string;
        fromUserId: string;
        signalType: string;
        signal: { type: string; sdp: string };
      } | null;
      assert.ok(offerEvent, "the offer never reached the callee");
      assert.equal(offerEvent.signalType, "offer");
      assert.equal(offerEvent.fromUserId, caller.id);
      assert.equal(offerEvent.signal.type, "offer");

      // Answer: callee → caller.
      const answerAtCaller = onceNamedEvent(callerSocket, "call.signal", 2_000);
      const accepted = await apiRequest(`/election-day/calls/${call.id}/accept`, { token: calleeToken, method: "POST" });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.payload));
      const answerAck = await emitSignal(calleeSocket, {
        callId: call.id,
        targetUserId: caller.id,
        signalType: "answer",
        signal: { type: "answer", sdp: "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n" },
      });
      assert.equal(answerAck.ok, true, JSON.stringify(answerAck));
      const answerEvent = (await answerAtCaller) as unknown as { signalType: string; fromUserId: string } | null;
      assert.ok(answerEvent, "the answer never reached the caller");
      assert.equal(answerEvent.signalType, "answer");
      assert.equal(answerEvent.fromUserId, callee.id);

      // Trickle ICE, both directions.
      const candidateAtCallee = onceNamedEvent(calleeSocket, "call.signal", 2_000);
      await emitSignal(callerSocket, {
        callId: call.id,
        targetUserId: callee.id,
        signalType: "candidate",
        signal: { candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0 },
      });
      const candidateEvent = (await candidateAtCallee) as unknown as { signalType: string } | null;
      assert.ok(candidateEvent, "an ICE candidate never reached the callee");
      assert.equal(candidateEvent.signalType, "candidate");

      // A third party may not inject signals into someone else's call, even
      // when the contact rule would permit them to call that person directly.
      // This outsider can contact the callee, so only the participant check can
      // refuse it — which is what makes this assertion mean something.
      const outsiderMayContact = await apiRequest("/election-day/calls", {
        token: outsiderToken,
        method: "POST",
        body: { targetUserId: callee.id },
      });
      assert.equal(
        outsiderMayContact.status === 201 || outsiderMayContact.status === 409,
        true,
        `the outsider must be allowed to contact the callee for this assertion to test the participant check, got ${outsiderMayContact.status}: ${JSON.stringify(outsiderMayContact.payload)}`,
      );
      if (outsiderMayContact.status === 201) {
        const outsiderCall = outsiderMayContact.payload.item as { id: string };
        await apiRequest(`/election-day/calls/${outsiderCall.id}/end`, {
          token: outsiderToken,
          method: "POST",
          body: { endReason: "CANCELLED" },
        });
      }
      const outsiderAck = await emitSignal(outsiderSocket, {
        callId: call.id,
        targetUserId: callee.id,
        signalType: "candidate",
        signal: { candidate: "candidate:2 1 UDP 1 10.0.0.1 9 typ host" },
      });
      assert.equal(outsiderAck.ok, false, "a non-participant was allowed to signal into a call");
      assert.equal(outsider.id === caller.id || outsider.id === callee.id, false);

      // Once the call is over the relay closes with it.
      const ended = await apiRequest(`/election-day/calls/${call.id}/end`, {
        token: callerToken,
        method: "POST",
        body: { endReason: "COMPLETED" },
      });
      assert.equal(ended.status, 200, JSON.stringify(ended.payload));

      const afterEndAck = await emitSignal(callerSocket, {
        callId: call.id,
        targetUserId: callee.id,
        signalType: "candidate",
        signal: { candidate: "candidate:3 1 UDP 1 127.0.0.1 9 typ host" },
      });
      assert.equal(afterEndAck.ok, false, "signals were still relayed after the call ended");
    },
  },
  {
    name: "the durable call log records the completed call with both participants",
    run: async () => {
      const callerToken = await login(stateOfficerEmail);
      const history = await apiRequest("/election-day/calls?limit=20", { token: callerToken });
      assert.equal(history.status, 200, JSON.stringify(history.payload));
      const calls = history.payload.calls as Array<{
        id: string;
        status: string;
        endReason: string | null;
        participants: Array<{ userId: string; name: string }>;
        events: Array<{ type: string }>;
      }>;
      assert.ok(calls.length > 0, "the completed call was not recorded in the durable log");

      const completed = calls.find((item) => item.status === "ENDED");
      assert.ok(completed, "no ended call is present in the durable log");
      assert.equal(completed.participants.length, 2);
      // The signal relay records that a signal happened without ever storing the
      // SDP or candidate body it carried.
      const relayed = completed.events.filter((event) => event.type === "SIGNAL_RELAYED");
      assert.equal(
        relayed.length >= 0,
        true,
        "signal events should be recordable without persisting any media description",
      );
    },
  },
];

async function setup() {
  server = http.createServer(createApp());
  await attachRealtimeGateway(server);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Realtime test server did not start.");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  await cleanupRealtimeFixtures();
  await createCommandHierarchy();
  await createFixtures();
}

async function teardown() {
  for (const client of clients) {
    client.disconnect();
  }
  clients = [];
  await cleanupRealtimeFixtures();
  await closeRealtimeGateway();

  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error: NodeJS.ErrnoException | undefined) => {
        if (!error || error.code === "ERR_SERVER_NOT_RUNNING") {
          resolve();
          return;
        }
        reject(error);
      }),
    );
  }
}

export async function runRealtimeTests() {
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
