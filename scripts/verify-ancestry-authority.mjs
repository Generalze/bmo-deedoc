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

/**
 * Checked on code, never on prose.
 *
 * This used to assert the file merely *mentioned* `stateConstituencyEdgeReviewedAt`,
 * which after the governance work was true only inside a comment — so deleting a
 * paragraph would have failed CI while gutting the predicate would not. The
 * facts below are structural: which column the filter permits on, and that the
 * row rule compares the approval to the ward's current edge. What those rules
 * *do* at runtime is proven by the integration suite and by a database
 * constraint, not by reading source with a regular expression.
 */
const scopeAuthorityCode = scopeAuthority.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
if (!/OPERATIONAL_WARD_EDGE[\s\S]{0,400}stateConstituencyEdgeApprovedForId/.test(scopeAuthorityCode)) {
  failures.push(
    `${SCOPE_AUTHORITY}: OPERATIONAL_WARD_EDGE must permit on stateConstituencyEdgeApprovedForId. A review timestamp is stamped by a rejection too.`,
  );
}
if (/OPERATIONAL_WARD_EDGE[\s\S]{0,400}stateConstituencyEdgeReviewedAt/.test(scopeAuthorityCode)) {
  failures.push(
    `${SCOPE_AUTHORITY}: OPERATIONAL_WARD_EDGE reads a review timestamp; a rejected edge would become operational.`,
  );
}
if (
  !/isWardConstituencyEdgeOperational[\s\S]{0,900}stateConstituencyEdgeApprovedForId\s*===\s*ward\.stateConstituencyId/.test(
    scopeAuthorityCode,
  )
) {
  failures.push(
    `${SCOPE_AUTHORITY}: the row rule must compare the approval to the ward's current State Constituency.`,
  );
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
 * Every strength surface must select snapshots through that one authority, and
 * must then use what it selected.
 *
 * This check used to compare a count of snapshot reads against a count of
 * `selectCurrentMemberTerritorySnapshots` occurrences. That is a cardinality
 * test standing in for a dataflow test, and the import statement itself counted
 * toward the threshold — so it passed a file that filtered a snapshot list and
 * then handed the *raw* list to the trend calculation. Counting occurrences
 * proves nothing about which value is used, so it is gone.
 *
 * What is checked instead is architectural and specific: the raw result of a
 * snapshot query must never be indexed into. Naming the filtered list is the
 * only way to reach a snapshot, so a regression has to be written in a form
 * this can see.
 */
const SNAPSHOT_CONSUMERS = [
  join("apps", "api", "src", "routes", "dashboard.ts"),
  join("apps", "api", "src", "routes", "pre-election.ts"),
];

/** Variables holding an unfiltered snapshot query result. */
const RAW_SNAPSHOT_BINDINGS = ["latestSnapshots", "snapshotCandidates", "previousCandidates", "candidateSnapshots"];

for (const consumer of SNAPSHOT_CONSUMERS) {
  const source = readFileSync(join(repoRoot, consumer), "utf8");
  const readsSnapshots = /territoryStrengthSnapshot\s*\n?\s*\.(findMany|findFirst)/.test(source);
  if (!readsSnapshots) {
    continue;
  }
  if (!source.includes("selectCurrentMemberTerritorySnapshots")) {
    failures.push(`${consumer} reads TerritoryStrengthSnapshot without the shared compatibility authority.`);
    continue;
  }
  for (const binding of RAW_SNAPSHOT_BINDINGS) {
    if (source.includes(`${binding}[`)) {
      failures.push(
        `${consumer} indexes into the raw snapshot list '${binding}'. Score and trend must both come from the filtered result, ` +
          "or an obsolete snapshot becomes the previous score and a change of calculation generation reads as a trend.",
      );
    }
  }
}

/**
 * And no route may keep its own constituency polling-unit scope. The strength
 * snapshot's coverage denominator walked the ward graph without the
 * reviewed-edge predicate while the dashboard applied it, so a snapshot could
 * be stamped with the current scope version having not used it.
 */
for (const consumer of SNAPSHOT_CONSUMERS) {
  const source = readFileSync(join(repoRoot, consumer), "utf8");
  const normalised = source.replace(/\s+/g, " ");
  if (normalised.includes("ward: { stateConstituency")) {
    failures.push(
      `${consumer} walks ward -> stateConstituency directly; constituency polling-unit scope belongs to buildOperationalPollingUnitTerritoryWhere.`,
    );
  }
}

const PRE_ELECTION = join("apps", "api", "src", "routes", "pre-election.ts");
const preElectionSource = readFileSync(join(repoRoot, PRE_ELECTION), "utf8");
if (!preElectionSource.includes("buildOperationalPollingUnitTerritoryWhere")) {
  failures.push(
    `${PRE_ELECTION} does not scope polling units through the shared authority; a snapshot could be stamped with the current scope version without using it.`,
  );
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

/**
 * A review timestamp is not permission.
 *
 * Once a rejection also stamps `stateConstituencyEdgeReviewedAt`, anything
 * reading that column as authority treats "a human said this mapping is wrong"
 * as the thing that makes it usable. Authority is the approved constituency id.
 */
const EDGE_AUTHORITY_CONSUMERS = [
  join("apps", "api", "src", "lib", "member-territory-scope.ts"),
  join("apps", "api", "src", "lib", "member-ancestry.ts"),
  join("packages", "database", "scripts", "backfill-member-ancestry.ts"),
];
for (const consumer of EDGE_AUTHORITY_CONSUMERS) {
  const code = readFileSync(join(repoRoot, consumer), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  if (!code.includes("stateConstituencyEdgeApprovedForId")) {
    failures.push(`${consumer} does not consult the approved-edge id, so it cannot be applying the operational rule.`);
  }
}

/** Governance decides; it never rewrites the mapping, and never in bulk. */
const GOVERNANCE_ROUTE = join("apps", "api", "src", "routes", "edge-governance.ts");
const governanceSource = readFileSync(join(repoRoot, GOVERNANCE_ROUTE), "utf8");
if (!governanceSource.includes('requireRole("SUPER_ADMIN")')) {
  failures.push(`${GOVERNANCE_ROUTE} does not restrict decisions to SUPER_ADMIN on the server.`);
}
if (/ward\.update\([^)]*stateConstituencyId:/s.test(governanceSource.replace(/\s+/g, " "))) {
  failures.push(
    `${GOVERNANCE_ROUTE} writes Ward.stateConstituencyId; correcting a mapping is a reference-data action, not a governance one.`,
  );
}
for (const forbidden of ["approve-all", "bulkApprove", "updateMany"]) {
  if (governanceSource.includes(forbidden)) {
    failures.push(`${GOVERNANCE_ROUTE} contains '${forbidden}'; every inferred edge needs an individual decision.`);
  }
}
if (!governanceSource.includes("EDGE_CHANGED_RELOAD")) {
  failures.push(`${GOVERNANCE_ROUTE} no longer refuses a decision submitted against a stale edge.`);
}

/**
 * The invariant the application can only try to preserve, the database
 * guarantees. Without this constraint the projection the scope filters read
 * could name an edge the ward does not have, and no amount of care in the route
 * would make the two encodings provably equivalent.
 */
const GOVERNANCE_MIGRATION = join(
  "packages", "database", "prisma", "ogun-migrations",
  "20260903090000_ward_constituency_edge_governance", "migration.sql",
);
const governanceMigration = readFileSync(join(repoRoot, GOVERNANCE_MIGRATION), "utf8");
if (!governanceMigration.includes("Ward_edge_approval_matches_current_edge_check")) {
  failures.push(`${GOVERNANCE_MIGRATION} no longer creates the approval/current-edge CHECK constraint.`);
}
for (const clause of [
  '"stateConstituencyEdgeInferred" = TRUE',
  '"stateConstituencyId" IS NOT NULL',
  '"stateConstituencyEdgeApprovedForId" = "stateConstituencyId"',
]) {
  if (!governanceMigration.includes(clause)) {
    failures.push(`${GOVERNANCE_MIGRATION}: the CHECK constraint is missing \`${clause}\`; a NULL edge would satisfy it.`);
  }
}

/** The decision must be taken against a locked row, not a stale read. */
if (!governanceSource.includes("FOR UPDATE")) {
  failures.push(
    `${GOVERNANCE_ROUTE} does not lock the ward row; the stale-edge check would be check-then-act.`,
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
console.log(`edge_authority_consumers=${EDGE_AUTHORITY_CONSUMERS.length}`);
console.log("ancestry_authority_integrity=ok");
