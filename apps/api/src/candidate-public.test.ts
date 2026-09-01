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
const createdUserEmails = new Set<string>();

async function login(email: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  const payload = (await response.json()) as { token?: string; message?: string };
  assert.equal(response.status, 200, payload.message || "Login failed.");
  assert.ok(payload.token, "Login response did not include a token.");
  return payload.token;
}

async function apiRequest(
  path: string,
  options?: {
    method?: string;
    token?: string;
    body?: Record<string, unknown>;
  },
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options?.method || "GET",
    headers: {
      ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = (await response.json()) as Record<string, unknown>;
  return { status: response.status, payload };
}

function readUserId(payload: Record<string, unknown>): string {
  const user = payload.user as { id?: string } | undefined;
  assert.ok(user?.id, "Response payload did not include a user id.");
  return user.id;
}

function readProfileUserId(payload: Record<string, unknown>): string {
  const profile = payload.profile as { userId?: string } | undefined;
  assert.ok(profile?.userId, "Response payload did not include a candidate profile user id.");
  return profile.userId;
}

async function createCandidateFixture(token: string, suffix: string, officeType: string) {
  const email = `candidate-public-${suffix}@pics.ng`;
  createdUserEmails.add(email);
  const created = await apiRequest("/admin/candidates", {
    method: "POST",
    token,
    body: {
      name: `Public Candidate ${suffix}`,
      email,
      password: "TestCandidate123!",
      officeType,
      stateId: "ng-state-ogun",
      ...(officeType === "CHAIRMANSHIP" ? { lgaId: ogunLgaId } : {}),
      ...(officeType === "COUNCILLOR" ? { lgaId: ogunLgaId, wardId: ogunWardId } : {}),
    },
  });
  assert.equal(created.status, 201);
  return { email, userId: readUserId(created.payload) };
}

const cases: Case[] = [
  {
    name: "candidate can update own public profile",
    run: async () => {
      const token = await login(SUITE_CANDIDATE.email, SUITE_CANDIDATE.password);
      const updated = await apiRequest("/candidate/profile", {
        method: "PATCH",
        token,
        body: {
          portraitUrl: "https://example.com/portrait.jpg",
          campaignSlogan: "Forward with Lagos.",
          bio: "A practical manifesto for public service.",
          websiteUrl: "https://example.com",
          isProfilePublished: true,
        },
      });

      assert.equal(updated.status, 200);
      assert.equal(updated.payload.message, "Candidate profile updated successfully.");
    },
  },
  {
    name: "candidate cannot edit another candidates materials",
    run: async () => {
      const adminToken = await login("superadmin@pics.ng", "ChangeMe123!");
      const first = await createCandidateFixture(adminToken, `${Date.now()}-a`, "GOVERNORSHIP");
      const second = await createCandidateFixture(adminToken, `${Date.now()}-b`, "GOVERNORSHIP");
      const firstToken = await login(first.email, "TestCandidate123!");
      const secondToken = await login(second.email, "TestCandidate123!");

      const createdPost = await apiRequest("/candidate/posts", {
        method: "POST",
        token: firstToken,
        body: {
          title: "Campaign launch",
          content: "We are launching a disciplined statewide campaign.",
          isPublished: true,
        },
      });
      assert.equal(createdPost.status, 201);
      const created = createdPost.payload.post as { id?: string } | undefined;
      assert.ok(created?.id);

      const denied = await apiRequest(`/candidate/posts/${created.id}`, {
        method: "PATCH",
        token: secondToken,
        body: {
          title: "Unauthorized edit",
        },
      });
      assert.equal(denied.status, 403);
    },
  },
  {
    name: "public candidate profile shows only published materials",
    run: async () => {
      const token = await login(SUITE_CANDIDATE.email, SUITE_CANDIDATE.password);

      const profile = await apiRequest("/candidate/profile", {
        method: "PATCH",
        token,
        body: {
          campaignSlogan: "Working for every ward.",
          bio: "Published profile for public discovery tests.",
          isProfilePublished: true,
        },
      });
      assert.equal(profile.status, 200, JSON.stringify(profile.payload));
      const candidateUserId = readProfileUserId(profile.payload);

      const published = await apiRequest("/candidate/posts", {
        method: "POST",
        token,
        body: {
          title: `Published material ${Date.now()}`,
          content: "This material should be visible publicly.",
          isPublished: true,
          mediaType: "IMAGE",
          mediaUrl: "https://example.com/banner.jpg",
        },
      });
      assert.equal(published.status, 201);

      const draft = await apiRequest("/candidate/posts", {
        method: "POST",
        token,
        body: {
          title: `Draft material ${Date.now()}`,
          content: "This material should stay private.",
          isPublished: false,
        },
      });
      assert.equal(draft.status, 201);

      const publicProfile = await apiRequest(`/candidate/public/${candidateUserId}`);
      assert.equal(publicProfile.status, 200, JSON.stringify(publicProfile.payload));
      const candidate = publicProfile.payload.candidate as { materials?: Array<{ title?: string }> };
      assert.ok(candidate.materials?.some((item) => item.title?.startsWith("Published material")));
      assert.ok(!candidate.materials?.some((item) => item.title?.startsWith("Draft material")));
    },
  },
  {
    name: "public candidate filters return matching candidates",
    run: async () => {
      const adminToken = await login("superadmin@pics.ng", "ChangeMe123!");
      const governorship = await createCandidateFixture(adminToken, `${Date.now()}-gov`, "GOVERNORSHIP");
      const chairmanship = await createCandidateFixture(adminToken, `${Date.now()}-chair`, "CHAIRMANSHIP");
      const governorshipToken = await login(governorship.email, "TestCandidate123!");
      const chairmanshipToken = await login(chairmanship.email, "TestCandidate123!");

      await apiRequest("/candidate/profile", {
        method: "PATCH",
        token: governorshipToken,
        body: {
          campaignSlogan: "Statewide reform",
          bio: "Governorship candidate",
          isProfilePublished: true,
        },
      });
      await apiRequest("/candidate/profile", {
        method: "PATCH",
        token: chairmanshipToken,
        body: {
          campaignSlogan: "Local accountability",
          bio: "Chairmanship candidate",
          isProfilePublished: true,
        },
      });

      const filtered = await apiRequest("/candidate/public?officeType=CHAIRMANSHIP&stateId=ng-state-ogun&search=Public");
      assert.equal(filtered.status, 200);
      const candidates = filtered.payload.candidates as Array<{ officeType?: string }>;
      assert.ok(candidates.length >= 1);
      assert.ok(candidates.every((candidate) => candidate.officeType === "CHAIRMANSHIP"));
    },
  },
  {
    name: "public candidate profile shows only published upcoming events",
    run: async () => {
      const token = await login(SUITE_CANDIDATE.email, SUITE_CANDIDATE.password);
      const profile = await apiRequest("/candidate/profile", { token });
      assert.equal(profile.status, 200, JSON.stringify(profile.payload));
      const candidateUserId = readProfileUserId(profile.payload);

      const published = await apiRequest("/candidate/events", {
        method: "POST",
        token,
        body: {
          title: `Town hall ${Date.now()}`,
          description: "A published statewide town hall.",
          venue: "Ikeja Civic Centre",
          startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          isPublished: true,
        },
      });
      assert.equal(published.status, 201);

      const draft = await apiRequest("/candidate/events", {
        method: "POST",
        token,
        body: {
          title: `Draft strategy meeting ${Date.now()}`,
          description: "This event should stay private.",
          venue: "Campaign office",
          startsAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
          isPublished: false,
        },
      });
      assert.equal(draft.status, 201);

      const publicProfile = await apiRequest(`/candidate/public/${candidateUserId}`);
      assert.equal(publicProfile.status, 200, JSON.stringify(publicProfile.payload));
      const candidate = publicProfile.payload.candidate as { upcomingEvents?: Array<{ title?: string }> };
      assert.ok(candidate.upcomingEvents?.some((item) => item.title?.startsWith("Town hall")));
      assert.ok(!candidate.upcomingEvents?.some((item) => item.title?.startsWith("Draft strategy meeting")));
    },
  },
  {
    name: "voter sees only published in-scope events and can RSVP",
    run: async () => {
      const token = await login(SUITE_CANDIDATE.email, SUITE_CANDIDATE.password);
      const voterToken = await login(SUITE_MEMBER.email, SUITE_MEMBER.password);

      const event = await apiRequest("/candidate/events", {
        method: "POST",
        token,
        body: {
          title: `Ward rally ${Date.now()}`,
          description: "A published rally visible to in-scope voters.",
          venue: "Ward field office",
          startsAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
          isPublished: true,
        },
      });
      assert.equal(event.status, 201);
      const created = event.payload.event as { id?: string } | undefined;
      assert.ok(created?.id);

      const visible = await apiRequest("/voter/events", {
        token: voterToken,
      });
      assert.equal(visible.status, 200);
      const events = visible.payload.events as Array<{ id?: string }>;
      assert.ok(events.some((item) => item.id === created.id));

      const rsvp = await apiRequest(`/voter/events/${created.id}/rsvp`, {
        method: "POST",
        token: voterToken,
        body: { status: "GOING" },
      });
      assert.equal(rsvp.status, 201);
      assert.equal(rsvp.payload.message, "Campaign event RSVP saved as going.");
    },
  },
];

/**
 * Resolved from reference data rather than hardcoded. Ogun's LGAs and wards come
 * from the authoritative import, so a fixed id here is a guess about what the
 * import produced — and it broke the moment the seed stopped inventing its own.
 */
let ogunLgaId = "";
let ogunWardId = "";
let ogunPollingUnitId = "";

async function resolveOgunTerritory() {
  const lga = await prisma.lGA.findFirst({ where: { stateId: "ng-state-ogun" }, orderBy: { name: "asc" } });
  if (!lga) {
    throw new Error("No Ogun LGA is present; reference data must be loaded before this suite.");
  }
  ogunLgaId = lga.id;
  const ward = await prisma.ward.findFirst({
    where: { stateId: "ng-state-ogun", lgaId: lga.id },
    orderBy: { name: "asc" },
  });
  if (!ward) {
    throw new Error("No Ogun ward is present; reference data must be loaded before this suite.");
  }
  ogunWardId = ward.id;
  const pollingUnit = await prisma.pollingUnit.findFirst({
    where: { stateId: "ng-state-ogun", wardId: ward.id },
    orderBy: { name: "asc" },
  });
  if (!pollingUnit) {
    throw new Error("No Ogun polling unit is present; reference data must be loaded before this suite.");
  }
  ogunPollingUnitId = pollingUnit.id;
}

const SUITE_CANDIDATE = { email: "candidate-public-owner@pics.ng", password: "Candidate123!" };
const SUITE_MEMBER = { email: "candidate-public-member@pics.ng", password: "Voter123!" };

/**
 * The suite provisions the candidate and member it signs in as.
 *
 * These were seeded personas until the product stopped fabricating people. The
 * candidate is created through the admin API — which is how a candidate is
 * actually created — and the member through public registration, so both follow
 * the paths the platform really uses.
 */
async function createSuitePersonas() {
  const adminToken = await login("superadmin@pics.ng", "ChangeMe123!");
  createdUserEmails.add(SUITE_CANDIDATE.email);
  const candidate = await apiRequest("/admin/candidates", {
    method: "POST",
    token: adminToken,
    body: {
      name: "Candidate Public Owner",
      email: SUITE_CANDIDATE.email,
      password: SUITE_CANDIDATE.password,
      officeType: "GOVERNORSHIP",
      politicalPartyId: "seed-party-independent-alliance",
      stateId: "ng-state-ogun",
    },
  });
  assert.equal(candidate.status, 201, JSON.stringify(candidate.payload));

  createdUserEmails.add(SUITE_MEMBER.email);
  const member = await apiRequest("/auth/register-voter", {
    method: "POST",
    body: {
      fullName: "Candidate Public Member",
      email: SUITE_MEMBER.email,
      phone: "08039990101",
      password: SUITE_MEMBER.password,
      voterCardNumber: `VIN-CANDIDATE-PUBLIC-${Date.now()}`,
      stateId: "ng-state-ogun",
      lgaId: ogunLgaId,
      wardId: ogunWardId,
      pollingUnitId: ogunPollingUnitId,
      acceptTerms: true,
      acceptPrivacy: true,
      contactConsent: true,
      confirmAdult: true,
    },
  });
  assert.equal(member.status, 201, JSON.stringify(member.payload));
}

async function setup() {
  await resolveOgunTerritory();
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not start.");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
  await createSuitePersonas();
}

async function teardown() {
  if (createdUserEmails.size > 0) {
    await prisma.user.deleteMany({
      where: { email: { in: Array.from(createdUserEmails) } },
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

export async function runCandidatePublicTests() {
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
