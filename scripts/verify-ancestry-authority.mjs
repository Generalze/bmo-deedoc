import { readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Member constituency ancestry has one author: the server.
 *
 * The public registration endpoint used to accept `senatorialDistrictId`,
 * `federalConstituencyId` and `stateConstituencyId` as optional request fields
 * and store them verbatim, defaulting to null. That made a caller the author of
 * its own place in the command hierarchy, and made every member registered
 * through the product invisible at three of the six dashboard levels.
 *
 * This guard fails the build if that arrangement returns.
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const ANCESTRY_AUTHORITY = join("apps", "api", "src", "lib", "member-ancestry.ts");
const REGISTRATION_ROUTE = join("apps", "api", "src", "routes", "auth.ts");

const ANCESTRY_FIELDS = ["senatorialDistrictId", "federalConstituencyId", "stateConstituencyId"];

const failures = [];

const authority = readFileSync(join(repoRoot, ANCESTRY_AUTHORITY), "utf8");
const route = readFileSync(join(repoRoot, REGISTRATION_ROUTE), "utf8");

/**
 * Anti-vacuity, first.
 *
 * Every check below is an absence check, and an absence check passes trivially
 * once the thing it guards has been deleted. So the presence of the derivation
 * is asserted before its misuse is looked for: if the authority stops deriving,
 * or the route stops calling it, this fails rather than reporting a clean scan
 * of code that no longer does the right thing.
 */
if (!authority.includes("resolveOperationalTerritory")) {
  failures.push(
    `${ANCESTRY_AUTHORITY} no longer walks the canonical territory graph; this check would pass vacuously.`,
  );
}
for (const field of ANCESTRY_FIELDS) {
  if (!authority.includes(field)) {
    failures.push(`${ANCESTRY_AUTHORITY} no longer derives ${field}; this check would pass vacuously.`);
  }
}
if (!route.includes("deriveMemberAncestryFromWard")) {
  failures.push(
    `${REGISTRATION_ROUTE} no longer calls deriveMemberAncestryFromWard; registration is not deriving ancestry.`,
  );
}
for (const field of ANCESTRY_FIELDS) {
  if (!route.includes(`${field}: ancestry.`)) {
    failures.push(`${REGISTRATION_ROUTE} no longer writes ${field} from the derived ancestry.`);
  }
}

/**
 * Then the misuse itself: a profile field assigned straight from the request.
 * Whitespace is normalised so reformatting cannot slip a write past the check.
 */
const normalisedRoute = route.replace(/\s+/g, " ");
for (const field of ANCESTRY_FIELDS) {
  for (const source of ["parsed.data.", "request.body", "req.body"]) {
    if (normalisedRoute.includes(`${field}: ${source}`)) {
      failures.push(`${REGISTRATION_ROUTE} writes ${field} directly from ${source}; ancestry must be server-derived.`);
    }
  }
}

/** The retired request contract must not come back. */
const schemaMatch = route.match(/const registerVoterSchema = z\.object\(\{([\s\S]*?)\n\}\)/);
if (!schemaMatch) {
  failures.push(`${REGISTRATION_ROUTE}: could not locate registerVoterSchema; this check would pass vacuously.`);
} else {
  for (const field of ANCESTRY_FIELDS) {
    if (schemaMatch[1].includes(field)) {
      failures.push(
        `${REGISTRATION_ROUTE}: registerVoterSchema accepts ${field}; constituency ancestry is not caller-supplied.`,
      );
    }
  }
}

/**
 * One member-territory scope, used by both consumers.
 *
 * The dashboard's member counts and the strength engine's snapshot calculation
 * once defined member territory separately, and the dashboard prefers a snapshot
 * over its own count — so the two disagreeing produced a score of zero printed
 * beside a tile reading four hundred. Checking that both *import the authority*
 * is robust in a way that pattern-matching every Prisma filter shape is not.
 */
const SCOPE_AUTHORITY = join("apps", "api", "src", "lib", "member-territory-scope.ts");
const SCOPE_CONSUMERS = [
  join("apps", "api", "src", "routes", "dashboard.ts"),
  join("apps", "api", "src", "routes", "pre-election.ts"),
];

const scopeAuthority = readFileSync(join(repoRoot, SCOPE_AUTHORITY), "utf8");
if (!scopeAuthority.includes("stateConstituencyEdgeReviewedAt")) {
  failures.push(`${SCOPE_AUTHORITY} no longer applies the reviewed-edge predicate; this check would pass vacuously.`);
}
if (!scopeAuthority.includes("MEMBER_TERRITORY_SCOPE_VERSION")) {
  failures.push(`${SCOPE_AUTHORITY} no longer declares a scope version; stale snapshots could not be rejected.`);
}

/**
 * The scope authority must refuse an unrecognised level rather than returning
 * an unrestricted filter. `count({ where: undefined })` counts every row, so a
 * scoping authority that falls through the end of a switch broadens access
 * instead of narrowing it.
 */
if (!scopeAuthority.includes("UnsupportedMemberTerritoryType")) {
  failures.push(`${SCOPE_AUTHORITY} has no fail-closed path for an unknown territory type.`);
}
if (!scopeAuthority.includes("buildOperationalPollingUnitTerritoryWhere")) {
  failures.push(`${SCOPE_AUTHORITY} does not own polling-unit territory scope.`);
}
if (!scopeAuthority.includes("selectCurrentMemberTerritorySnapshots")) {
  failures.push(`${SCOPE_AUTHORITY} does not own snapshot compatibility; each consumer would test the JSON itself.`);
}

/**
 * Every strength surface must select snapshots through that one authority. The
 * dashboard rejecting obsolete snapshots while the pre-election surfaces
 * displayed them is exactly how the same territory came to show two different
 * scores at the same moment.
 */
const SNAPSHOT_CONSUMERS = [
  join("apps", "api", "src", "routes", "dashboard.ts"),
  join("apps", "api", "src", "routes", "pre-election.ts"),
];
for (const consumer of SNAPSHOT_CONSUMERS) {
  const source = readFileSync(join(repoRoot, consumer), "utf8");
  const reads = (source.match(/territoryStrengthSnapshot\s*\.?\s*\n?\s*\.(findMany|findFirst)/g) || []).length;
  const selections = (source.match(/selectCurrentMemberTerritorySnapshots/g) || []).length;
  if (reads > 0 && selections < reads) {
    failures.push(
      `${consumer} reads TerritoryStrengthSnapshot ${reads} time(s) but routes only ${selections} through the shared compatibility authority.`,
    );
  }
}

for (const consumer of SCOPE_CONSUMERS) {
  const source = readFileSync(join(repoRoot, consumer), "utf8");
  if (!source.includes("buildOperationalVoterProfileTerritoryWhere")) {
    failures.push(`${consumer} does not use the shared member territory scope authority.`);
  }
  /**
   * And must not have grown a private one again. Only VoterProfile-shaped
   * constituency filters are rejected: the coordinator and polling-unit scopes
   * in these files legitimately filter on their own columns.
   */
  const normalised = source.replace(/\s+/g, " ");
  for (const field of ANCESTRY_FIELDS) {
    if (normalised.includes(`VoterProfileWhereInput { if`) && normalised.includes(`return { ${field}: territoryId };`)) {
      failures.push(`${consumer} builds a private VoterProfile constituency scope on ${field}.`);
    }
  }
}

const DASHBOARD = join("apps", "api", "src", "routes", "dashboard.ts");
const dashboardSource = readFileSync(join(repoRoot, DASHBOARD), "utf8");
if (!dashboardSource.includes("buildOperationalPollingUnitTerritoryWhere")) {
  failures.push(
    `${DASHBOARD} does not scope polling units through the shared authority; its member and polling-unit counts could disagree about the same constituency.`,
  );
}

/** The active identity release must carry inferred-edge provenance. */
const RELEASE_MANIFEST = join(
  "packages", "database", "reference", "ogun", "ogun-identity-2026-08-12", "manifest.json",
);
const manifest = JSON.parse(readFileSync(join(repoRoot, RELEASE_MANIFEST), "utf8"));
if (!manifest.files?.inferredEdges?.sha256) {
  failures.push(
    `${RELEASE_MANIFEST} does not checksum INFERRED-EDGES.csv; a release without it asserts nothing about which edges were inferred.`,
  );
}

if (failures.length > 0) {
  console.error("FAIL member constituency ancestry must be derived by the server:");
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log(`ancestry_authority=${ANCESTRY_AUTHORITY.split(sep).join("/")}`);
console.log(`ancestry_fields_guarded=${ANCESTRY_FIELDS.length}`);
console.log(`ancestry_scope_consumers=${SCOPE_CONSUMERS.length}`);
console.log(`ancestry_snapshot_consumers=${SNAPSHOT_CONSUMERS.length}`);
console.log("ancestry_authority_integrity=ok");
