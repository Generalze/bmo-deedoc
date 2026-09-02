import { PrismaClient } from "@prisma/client";

/**
 * Member constituency ancestry repair.
 *
 * Registration now derives State -> Senatorial District -> Federal
 * Constituency -> State Constituency from the ward, but every member who
 * registered before that stored whatever the form sent, which in practice was
 * nothing. This repairs those rows from the same canonical graph the
 * registration path derives from.
 *
 *   npm run backfill:member-ancestry -- --dry-run
 *   npm run backfill:member-ancestry -- --apply
 *
 * Neither mode reads the existing ancestry columns as input. They are the thing
 * being repaired, so trusting them to repair themselves would preserve exactly
 * the values in question. Ancestry is recomputed from `wardId` every time.
 *
 * Re-running is safe: a row already holding the derived ancestry is counted as
 * correct and not written.
 */

const OGUN_STATE_ID = "ng-state-ogun";

type Bucket =
  | "alreadyCorrect"
  | "eligibleNullAncestry"
  | "conflictingAncestry"
  | "incompleteGraph"
  | "inferredEdgeUnreviewed"
  | "outsideOgun";

type Finding = {
  profileId: string;
  userId: string;
  wardId: string;
  bucket: Bucket;
  detail?: string;
};

export type MemberAncestryBackfillReport = {
  mode: "dry-run" | "apply";
  totalExamined: number;
  alreadyCorrect: number;
  eligibleNullAncestry: number;
  conflictingAncestry: number;
  incompleteGraph: number;
  inferredEdgeUnreviewed: number;
  outsideOgun: number;
  wouldChange: number;
  changed: number;
};

/**
 * Exported so the integration suite drives the same code the CLI runs, rather
 * than a reimplementation of it that could agree with the tests and disagree
 * with production.
 */
export async function runMemberAncestryBackfill(
  prisma: Pick<PrismaClient, "ward" | "voterProfile">,
  options: { apply: boolean },
): Promise<{ report: MemberAncestryBackfillReport; findings: Finding[] }> {
  const apply = options.apply;
  const dryRun = !apply;

  /**
   * The ward carries the whole answer, so the graph is read once through the
   * ward rather than per profile. `stateConstituency` and its parents are the
   * canonical edges; the review columns decide whether an inferred one may be
   * used at all.
   */
  const wards = await prisma.ward.findMany({
    select: {
      id: true,
      stateId: true,
      lgaId: true,
      stateConstituencyId: true,
      stateConstituencyEdgeInferred: true,
      stateConstituencyEdgeReviewedAt: true,
      stateConstituency: {
        select: {
          id: true,
          stateId: true,
          federalConstituencyId: true,
          federalConstituency: { select: { id: true, stateId: true, senatorialDistrictId: true } },
        },
      },
    },
  });

  const wardById = new Map(wards.map((ward) => [ward.id, ward]));

  const profiles = await prisma.voterProfile.findMany({
    select: {
      id: true,
      userId: true,
      stateId: true,
      lgaId: true,
      wardId: true,
      senatorialDistrictId: true,
      federalConstituencyId: true,
      stateConstituencyId: true,
    },
    orderBy: { id: "asc" },
  });

  const findings: Finding[] = [];
  const changes: Array<{
    profileId: string;
    senatorialDistrictId: string;
    federalConstituencyId: string;
    stateConstituencyId: string;
  }> = [];

  for (const profile of profiles) {
    const base = { profileId: profile.id, userId: profile.userId, wardId: profile.wardId };

    if (profile.stateId !== OGUN_STATE_ID) {
      findings.push({ ...base, bucket: "outsideOgun", detail: `stateId=${profile.stateId}` });
      continue;
    }

    const ward = wardById.get(profile.wardId);
    if (!ward || ward.stateId !== OGUN_STATE_ID) {
      findings.push({ ...base, bucket: "incompleteGraph", detail: "ward missing or not an Ogun ward" });
      continue;
    }

    if (ward.lgaId !== profile.lgaId) {
      findings.push({
        ...base,
        bucket: "incompleteGraph",
        detail: `profile lgaId=${profile.lgaId} but ward belongs to ${ward.lgaId}`,
      });
      continue;
    }

    /**
     * An unreviewed inferred edge is reported, never repaired. Writing it would
     * turn a mapping nobody has confirmed into a stored fact indistinguishable
     * from a sourced one — which is the whole reason the provenance columns
     * exist.
     */
    if (ward.stateConstituencyEdgeInferred && !ward.stateConstituencyEdgeReviewedAt) {
      findings.push({
        ...base,
        bucket: "inferredEdgeUnreviewed",
        detail: `ward ${ward.id} awaits human review of its State Constituency edge`,
      });
      continue;
    }

    const stateConstituency = ward.stateConstituency;
    const federalConstituency = stateConstituency?.federalConstituency;
    if (
      !stateConstituency ||
      stateConstituency.stateId !== OGUN_STATE_ID ||
      !federalConstituency ||
      federalConstituency.stateId !== OGUN_STATE_ID ||
      !federalConstituency.senatorialDistrictId
    ) {
      findings.push({ ...base, bucket: "incompleteGraph", detail: "ward has no complete constituency chain" });
      continue;
    }

    const derived = {
      stateConstituencyId: stateConstituency.id,
      federalConstituencyId: federalConstituency.id,
      senatorialDistrictId: federalConstituency.senatorialDistrictId,
    };

    const matches =
      profile.stateConstituencyId === derived.stateConstituencyId &&
      profile.federalConstituencyId === derived.federalConstituencyId &&
      profile.senatorialDistrictId === derived.senatorialDistrictId;

    if (matches) {
      findings.push({ ...base, bucket: "alreadyCorrect" });
      continue;
    }

    const anySet =
      profile.stateConstituencyId !== null ||
      profile.federalConstituencyId !== null ||
      profile.senatorialDistrictId !== null;

    /**
     * A row holding a *different* ancestry is separated from one holding none.
     * Both are corrected to the graph — the ward is the authority and a stored
     * disagreement is by definition the client-era value — but a silent
     * overwrite of a non-null value is exactly the kind of change that should
     * be visible before it happens, so it is counted and listed separately.
     */
    findings.push({
      ...base,
      bucket: anySet ? "conflictingAncestry" : "eligibleNullAncestry",
      detail: anySet
        ? `stored sc=${profile.stateConstituencyId ?? "null"} fc=${profile.federalConstituencyId ?? "null"} sd=${profile.senatorialDistrictId ?? "null"} -> derived sc=${derived.stateConstituencyId} fc=${derived.federalConstituencyId} sd=${derived.senatorialDistrictId}`
        : undefined,
    });
    changes.push({ profileId: profile.id, ...derived });
  }

  const tally = (bucket: Bucket) => findings.filter((finding) => finding.bucket === bucket).length;

  const report = {
    mode: (dryRun ? "dry-run" : "apply") as "dry-run" | "apply",
    totalExamined: profiles.length,
    alreadyCorrect: tally("alreadyCorrect"),
    eligibleNullAncestry: tally("eligibleNullAncestry"),
    conflictingAncestry: tally("conflictingAncestry"),
    incompleteGraph: tally("incompleteGraph"),
    inferredEdgeUnreviewed: tally("inferredEdgeUnreviewed"),
    outsideOgun: tally("outsideOgun"),
    wouldChange: changes.length,
  };

  const conflicts = findings.filter((finding) => finding.bucket === "conflictingAncestry");
  if (conflicts.length > 0) {
    console.log("Conflicting ancestry (canonical ward ancestry wins, listed so the correction is visible):");
    for (const conflict of conflicts) {
      console.log(`  ${conflict.profileId} ward=${conflict.wardId} ${conflict.detail}`);
    }
  }

  const blocked = findings.filter((finding) => finding.bucket === "inferredEdgeUnreviewed");
  if (blocked.length > 0) {
    console.log(`Blocked by unreviewed inferred edges (${blocked.length}); these are NOT repaired:`);
    for (const record of blocked.slice(0, 20)) {
      console.log(`  ${record.profileId} ward=${record.wardId}`);
    }
    if (blocked.length > 20) {
      console.log(`  ... and ${blocked.length - 20} more`);
    }
  }

  if (dryRun) {
    return { report: { ...report, mode: "dry-run", changed: 0 }, findings };
  }

  let changed = 0;
  /**
   * Chunked rather than one transaction per row, and each update is keyed by
   * primary key with the derived values, so a re-run of the same input is a
   * no-op rather than a second correction.
   */
  for (const change of changes) {
    await prisma.voterProfile.update({
      where: { id: change.profileId },
      data: {
        senatorialDistrictId: change.senatorialDistrictId,
        federalConstituencyId: change.federalConstituencyId,
        stateConstituencyId: change.stateConstituencyId,
      },
    });
    changed += 1;
  }

  return { report: { ...report, mode: "apply", changed }, findings };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply");
  if (dryRun === apply) {
    throw new Error("Pass exactly one of --dry-run or --apply.");
  }

  const prisma = new PrismaClient();
  try {
    const { report } = await runMemberAncestryBackfill(prisma, { apply });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

/** Only self-executes as a CLI; importing it for tests must not run a backfill. */
if (process.argv[1] && /backfill-member-ancestry\.[cm]?[jt]s$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
