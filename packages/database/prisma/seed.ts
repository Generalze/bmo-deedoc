import path from "node:path";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import {
  AgentActivityType,
  AssignmentPermissionType,
  CandidateOfficeType,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  NotificationType,
  Prisma,
  PrismaClient,
  RewardRedemptionStatus,
  RewardType,
  UserRole,
} from "@prisma/client";
import { OGUN_STATE_ID, normalizeEmail } from "@pics-nigeria/shared";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl?.startsWith("file:")) {
  const relativePath = databaseUrl.slice("file:".length);
  if (!path.isAbsolute(relativePath)) {
    process.env.DATABASE_URL = `file:${path.resolve(__dirname, relativePath)}`;
  }
}

const prisma = new PrismaClient();

/**
 * Seed territory, resolved from the real Ogun reference data.
 *
 * The platform operates in Ogun only (feature 001) and Ogun's structure is a
 * fixed, verified fact — nine federal constituencies, twenty LGAs and so on,
 * asserted by the reference-completeness checks. Inventing a seed constituency
 * inside Ogun therefore does not add convenience, it corrupts the reference
 * contract. So the seed attaches to territory that already exists rather than
 * fabricating its own, and only falls back to creating rows when the Ogun
 * reference set has not been imported yet.
 */
type SeedTerritory = {
  stateId: string;
  senatorialDistrictId: string;
  federalConstituencyId: string;
  stateConstituencyId: string;
  lgaId: string;
  wardIds: string[];
  pollingUnitId: string;
};

/**
 * Sample accounts need a place to stand, and in Ogun that place is defined by
 * authoritative reference data. When it has not been loaded the seed creates
 * users without territory-bound profiles rather than inventing an LGA or a
 * state constituency — those counts are verified, and an invented row fails the
 * command-hierarchy check for the entire platform.
 */

/** Ogun's own geo-political zone, read from reference data rather than assumed. */
async function ogunZoneId(): Promise<string | undefined> {
  const ogun = await prisma.state.findUnique({
    where: { id: OGUN_STATE_ID },
    select: { geoPoliticalZoneId: true },
  });
  return ogun?.geoPoliticalZoneId || undefined;
}

async function resolveSeedTerritory(): Promise<SeedTerritory | null> {
  await prisma.state.upsert({
    where: { id: OGUN_STATE_ID },
    update: {},
    create: { id: OGUN_STATE_ID, name: "Ogun" },
  });

  const [district, federal, lga, stateConstituency] = await Promise.all([
    prisma.senatorialDistrict.findFirst({ where: { stateId: OGUN_STATE_ID }, orderBy: { name: "asc" } }),
    prisma.federalConstituency.findFirst({ where: { stateId: OGUN_STATE_ID }, orderBy: { name: "asc" } }),
    prisma.lGA.findFirst({ where: { stateId: OGUN_STATE_ID }, orderBy: { name: "asc" } }),
    prisma.stateConstituency.findFirst({ where: { stateId: OGUN_STATE_ID }, orderBy: { name: "asc" } }),
  ]);
  if (!district || !federal || !lga || !stateConstituency) {
    return null;
  }

  const wards = await prisma.ward.findMany({
    where: { stateId: OGUN_STATE_ID, lgaId: lga.id },
    orderBy: { name: "asc" },
    take: 2,
  });
  if (wards.length === 0) {
    return null;
  }

  const pollingUnit = await prisma.pollingUnit.findFirst({
    where: { stateId: OGUN_STATE_ID, wardId: wards[0].id },
    orderBy: { name: "asc" },
  });
  if (!pollingUnit) {
    return null;
  }

  return {
    stateId: OGUN_STATE_ID,
    senatorialDistrictId: district.id,
    federalConstituencyId: federal.id,
    stateConstituencyId: stateConstituency.id,
    lgaId: lga.id,
    wardIds: wards.map((ward) => ward.id),
    pollingUnitId: pollingUnit.id,
  };
}


const sampleAccounts = {
  stateAdmin: {
    email: "state.admin@pics.ng",
    password: "StateAdmin123!",
    name: "Ogun State Admin",
  },
  candidate: {
    email: "candidate@pics.ng",
    password: "Candidate123!",
    name: "Kemi Adeyemi",
  },
  agent: {
    email: "agent@pics.ng",
    password: "Agent123!",
    name: "Bola Yusuf",
    phone: "08032222222",
  },
  voter: {
    email: "voter@pics.ng",
    password: "Voter123!",
    name: "Ada Okafor",
    phone: "08030000000",
    voterCardNumber: "VIN-SEEDED-0001",
    referralCode: "PICSSEED01",
  },
};

const sampleParty = {
  id: "seed-party-independent-alliance",
  code: "PIA",
  name: "Progressive Independent Alliance",
};

function getBootstrapConfig() {
  const fallback = {
    email: "superadmin@pics.ng",
    password: "ChangeMe123!",
    name: "PICS Nigeria Super Admin",
  };

  if (process.env.SUPER_ADMIN_EMAIL && process.env.SUPER_ADMIN_PASSWORD) {
    return {
      email: normalizeEmail(process.env.SUPER_ADMIN_EMAIL),
      password: process.env.SUPER_ADMIN_PASSWORD,
      name: process.env.SUPER_ADMIN_NAME?.trim() || fallback.name,
    };
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD are required in production.");
  }

  return fallback;
}

async function hash(password: string) {
  return bcrypt.hash(password, 10);
}

async function main() {
  const territory = await resolveSeedTerritory();

  await prisma.politicalParty.upsert({
    where: { id: sampleParty.id },
    update: sampleParty,
    create: sampleParty,
  });

  const bootstrap = getBootstrapConfig();
  const hashedBootstrapPassword = await hash(bootstrap.password);
  const existingSuperAdmin = await prisma.user.findFirst({
    where: { role: UserRole.SUPER_ADMIN },
    select: { id: true, email: true },
  });

  const superAdmin = existingSuperAdmin
    ? await prisma.user.update({
        where: { id: existingSuperAdmin.id },
        data: {
          name: bootstrap.name,
          email: normalizeEmail(bootstrap.email),
          passwordHash: hashedBootstrapPassword,
          role: UserRole.SUPER_ADMIN,
        },
      })
    : await prisma.user.create({
        data: {
          name: bootstrap.name,
          email: normalizeEmail(bootstrap.email),
          passwordHash: hashedBootstrapPassword,
          role: UserRole.SUPER_ADMIN,
        },
      });

  // Sample personas are deliberately not seeded.
  //
  // The state admin, candidate, agent and member accounts existed to make a
  // fresh database feel populated, but they are fabricated people with known
  // passwords carrying real-looking territory inside Ogun — and one of them was
  // a CANDIDATE, a role that no longer signs in at all. A product that has not
  // shipped is the right moment to stop creating them: an empty platform is
  // honest, and every operator can be provisioned through the product.
  //
  // The super admin above is the bootstrap account and is the only way in.
  // Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD to control it; without them
  // it falls back to a well-known local password, which is fine for a developer
  // database and must never be used anywhere else.
  console.log("seed=ok reference-linked, no sample personas created");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
