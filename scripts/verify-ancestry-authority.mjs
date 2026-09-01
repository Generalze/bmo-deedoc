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

if (failures.length > 0) {
  console.error("FAIL member constituency ancestry must be derived by the server:");
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log(`ancestry_authority=${ANCESTRY_AUTHORITY.split(sep).join("/")}`);
console.log(`ancestry_fields_guarded=${ANCESTRY_FIELDS.length}`);
console.log("ancestry_authority_integrity=ok");
