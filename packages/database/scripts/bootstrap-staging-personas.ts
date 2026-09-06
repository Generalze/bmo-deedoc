import path from "node:path";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import { PrismaClient, UserRole } from "@prisma/client";
import { OGUN_STATE_ID } from "@pics-nigeria/shared";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

/**
 * Synthetic operators for staging UAT.
 *
 * The seed deliberately creates no people: an empty platform is honest, and the
 * super admin can provision everyone through the product. That is right for a
 * developer database and wrong for staging, where a tester needs one of each
 * role to exercise a flow end to end and cannot be expected to hand-build six
 * accounts before every round.
 *
 * Two rules govern what this may invent.
 *
 * It never invents territory. Ogun's structure is a verified fact — twenty
 * LGAs, twenty-six state constituencies, two hundred and thirty-six wards — and
 * a persona is attached to real reference data or is not created at all. This
 * is the same rule the seed follows, for the same reason: a fabricated ward
 * inside Ogun corrupts the reference set rather than adding a fixture.
 *
 * And it never creates anything that could be mistaken for a real person. Every
 * account carries the STAGING_MARKER in its name and address, which is what
 * makes them safely removable and what the refusal below detects. Real voter
 * records are personal data belonging to real Nigerians; none are created here,
 * and no voter-registration document is fabricated, because a synthetic
 * identity document is exactly the thing the validator queue must never be
 * trained to accept.
 */

const prisma = new PrismaClient();

/** Present in every synthetic name and address, and never in a real one. */
const STAGING_MARKER = "staging-persona";
const STAGING_EMAIL_DOMAIN = "staging.invalid";

const personas = [
  { label: "state-officer", role: UserRole.STATE_OFFICER, name: "Staging State Officer" },
  { label: "validator", role: UserRole.VALIDATOR, name: "Staging Validator" },
  { label: "payout-officer", role: UserRole.PAYOUT_OFFICER, name: "Staging Payout Officer" },
  { label: "coordinator-ward", role: UserRole.COORDINATOR, name: "Staging Ward Coordinator", coordinatorLevel: "WARD" },
  { label: "agent", role: UserRole.AGENT, name: "Staging Field Agent" },
  { label: "member", role: UserRole.MEMBER, name: "Staging Member" },
] as const;

function personaEmail(label: string) {
  return `${STAGING_MARKER}-${label}@${STAGING_EMAIL_DOMAIN}`;
}

async function main() {
  const password = process.env.STAGING_PERSONA_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error(
      "STAGING_PERSONA_PASSWORD must be set to at least 12 characters. There is no default: a well-known password on an internet-reachable staging host is a real account takeover.",
    );
  }

  /**
   * The refusal that makes this safe to have in the repository.
   *
   * Any account that is not one of ours means this is not a staging database.
   * Creating test operators inside a system holding real members would give a
   * UAT tester a working session in it.
   */
  const foreignUsers = await prisma.user.count({
    where: {
      email: { not: { contains: STAGING_MARKER } },
      role: { notIn: [UserRole.SUPER_ADMIN] },
    },
  });
  if (foreignUsers > 0 && process.env.STAGING_PERSONA_FORCE !== "i-understand-this-is-not-production") {
    throw new Error(
      `Refusing to run: this database holds ${foreignUsers} account(s) that are not staging personas. ` +
        "Point at a staging database. If this really is staging and the accounts are expected, set " +
        "STAGING_PERSONA_FORCE=i-understand-this-is-not-production.",
    );
  }

  /**
   * Real reference data, resolved rather than created. A ward whose State
   * Constituency edge is still an unreviewed inference is skipped, because
   * registration refuses such a ward — a persona placed there would be one the
   * product itself would turn away.
   */
  const ward = await prisma.ward.findFirst({
    where: {
      stateId: OGUN_STATE_ID,
      stateConstituencyEdgeInferred: false,
      stateConstituency: { is: { federalConstituencyId: { not: null } } },
      pollingUnits: { some: {} },
    },
    include: { stateConstituency: { include: { federalConstituency: true } }, pollingUnits: { take: 1 } },
    orderBy: { name: "asc" },
  });

  if (!ward || !ward.stateConstituency?.federalConstituency) {
    throw new Error(
      "No Ogun ward with a reviewed constituency edge is loaded. Import the reference release first: " +
        "npm run import:reference:ogun -- --release-dir reference/ogun/<release> --apply",
    );
  }

  const pollingUnit = ward.pollingUnits[0];
  const territory = {
    stateId: OGUN_STATE_ID,
    lgaId: ward.lgaId,
    wardId: ward.id,
    stateConstituencyId: ward.stateConstituencyId,
    federalConstituencyId: ward.stateConstituency.federalConstituencyId,
    senatorialDistrictId: ward.stateConstituency.federalConstituency.senatorialDistrictId,
  };

  const passwordHash = await bcrypt.hash(password, 12);
  const created: string[] = [];

  for (const persona of personas) {
    const email = personaEmail(persona.label);
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      await prisma.user.update({ where: { email }, data: { passwordHash, isActive: true } });
      created.push(`${persona.label} (updated)`);
      continue;
    }

    await prisma.user.create({
      data: {
        name: `${persona.name} (${STAGING_MARKER})`,
        email,
        passwordHash,
        role: persona.role,
        ...(persona.role === UserRole.COORDINATOR
          ? {
              coordinatorProfile: {
                create: {
                  level: "WARD",
                  stateId: territory.stateId,
                  senatorialDistrictId: territory.senatorialDistrictId,
                  federalConstituencyId: territory.federalConstituencyId,
                  stateConstituencyId: territory.stateConstituencyId,
                  wardId: territory.wardId,
                },
              },
            }
          : {}),
        ...(persona.role === UserRole.AGENT && pollingUnit
          ? {
              agentProfile: {
                create: {
                  stateId: territory.stateId,
                  lgaId: territory.lgaId,
                  wardId: territory.wardId,
                  pollingUnitId: pollingUnit.id,
                },
              },
            }
          : {}),
        ...(persona.role === UserRole.MEMBER && pollingUnit
          ? {
              voterProfile: {
                create: {
                  // Marked as synthetic in the identifier itself, so it can
                  // never be mistaken for a real Voter Identification Number.
                  voterCardNumber: `STAGING-PERSONA-${persona.label.toUpperCase()}`,
                  referralCode: `STG${persona.label.slice(0, 4).toUpperCase()}`,
                  stateId: territory.stateId,
                  senatorialDistrictId: territory.senatorialDistrictId,
                  federalConstituencyId: territory.federalConstituencyId,
                  stateConstituencyId: territory.stateConstituencyId,
                  lgaId: territory.lgaId,
                  wardId: territory.wardId,
                  pollingUnitId: pollingUnit.id,
                },
              },
            }
          : {}),
      },
    });
    created.push(persona.label);
  }

  console.log(`staging_personas=${created.length}`);
  console.log(`staging_persona_ward=${ward.name}`);
  console.log(`staging_persona_emails=${personas.map((persona) => personaEmail(persona.label)).join(",")}`);
  console.log("staging_persona_documents=none_fabricated");
  console.log("staging_personas=ok");
}

main()
  .catch((error) => {
    console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
