/**
 * One authority takes custody of a voter-registration document.
 *
 * These are identity documents — a PVC image, a registration slip — and feature
 * 029 requires them to be stored privately, reachable only through
 * authentication, authorization and controlled short-lived access, with
 * permanent public URLs prohibited.
 *
 * They were not stored at all. `VoterVerificationDocument` recorded a storage
 * key the client chose, a size the client stated and a SHA-256 the client
 * computed, with `storageProvider` set to the literal string
 * "PRIVATE_OBJECT_STORAGE_STUB". Two routes wrote that record, each with its own
 * copy of the logic, and the access route answered with `crypto.randomUUID()`
 * as though it were an access grant.
 *
 * This guards the shape of the fix rather than the fix itself: every write of a
 * voter document must come from `storeVoterDocument`, so a third route added
 * later cannot quietly reintroduce a client-authoritative path. It is the same
 * check the money-out chokepoint gets, for the same reason — a second way in is
 * how the first guarantee is lost.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiSource = path.join(repoRoot, "apps/api/src");
const authorityRelative = "apps/api/src/lib/voter-document-storage.ts";
const failures = [];
const notes = [];

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

const authorityPath = path.join(repoRoot, authorityRelative);
let authority;
try {
  authority = readFileSync(authorityPath, "utf8");
} catch {
  console.error(`FAIL The voter document custody authority is missing: ${authorityRelative}`);
  process.exit(1);
}

/* ---- The authority still derives what it must ---------------------------- */

const requiredInAuthority = [
  ["createHash(\"sha256\")", "the authority must compute the document hash itself"],
  ["putObjectIfAbsent", "the authority must actually store the bytes"],
  ["getPrivateObjectStorage", "the authority must use private object storage"],
];
for (const [needle, why] of requiredInAuthority) {
  if (!authority.includes(needle)) {
    failures.push(`${authorityRelative}: ${why}.`);
  }
}

/**
 * A client may describe its document, never locate or fingerprint it. If these
 * appear in the submission schema again, the server is being told something it
 * is supposed to establish.
 */
const schemaStart = authority.indexOf("voterDocumentSubmissionSchema");
const schemaEnd = authority.indexOf("});", schemaStart);
if (schemaStart === -1 || schemaEnd === -1) {
  failures.push(`${authorityRelative}: the voter document submission schema could not be located.`);
} else {
  const schema = authority.slice(schemaStart, schemaEnd);
  for (const forbidden of ["originalStorageKey", "sha256", "fileSize", "previewStorageKey"]) {
    if (schema.includes(forbidden)) {
      failures.push(
        `${authorityRelative}: the submission schema accepts "${forbidden}" from the client. That is a fact about the stored object which only the server can establish.`,
      );
    }
  }
}

/* ---- Nothing else writes a voter document -------------------------------- */

const files = sourceFiles(apiSource);
let writeSites = 0;

for (const file of files) {
  const relative = path.relative(repoRoot, file).replace(/\\/g, "/");
  if (relative === authorityRelative) continue;
  const text = readFileSync(file, "utf8");
  const isTest = relative.endsWith(".test.ts");

  // A create against the document table anywhere other than through the
  // authority's returned fields.
  const creates = text.match(/voterVerificationDocument\.create\s*\(/g) || [];
  const nestedCreates = text.match(/documents:\s*\w+\s*\n?\s*\?\s*\{\s*\n?\s*create:/g) || [];
  const total = creates.length + nestedCreates.length;
  if (total === 0) continue;

  writeSites += total;
  if (isTest) continue;

  if (!text.includes("storeVoterDocument")) {
    failures.push(
      `${relative} writes a VoterVerificationDocument without importing storeVoterDocument. Every document write must take custody of the bytes through the single authority.`,
    );
  }
}

notes.push(`voter_document_write_sites=${writeSites}`);

/* ---- The stub cannot return ---------------------------------------------- */

for (const file of files) {
  const relative = path.relative(repoRoot, file).replace(/\\/g, "/");
  const text = readFileSync(file, "utf8");
  // The authority documents the history in prose; what matters is that no code
  // path still writes the value.
  const mentionsInCode = /storageProvider:\s*"PRIVATE_OBJECT_STORAGE_STUB"|=\s*"PRIVATE_OBJECT_STORAGE_STUB"|return[^;]*"PRIVATE_OBJECT_STORAGE_STUB"/.test(text);
  if (mentionsInCode && !relative.endsWith(".test.ts")) {
    failures.push(
      `${relative} still references PRIVATE_OBJECT_STORAGE_STUB. That value named a provider which stored nothing while reading as private storage.`,
    );
  }
}

/* ---- Access is signed and short lived ------------------------------------ */

const preElectionRoute = path.join(repoRoot, "apps/api/src/routes/pre-election.ts");
const routeText = readFileSync(preElectionRoute, "utf8");
const accessIndex = routeText.indexOf("VERIFICATION_DOCUMENT_ACCESS_GRANTED");
if (accessIndex === -1) {
  failures.push("apps/api/src/routes/pre-election.ts no longer audits voter document access.");
} else {
  const around = routeText.slice(Math.max(0, accessIndex - 4000), accessIndex + 2000);
  if (!around.includes("createSignedGetUrl")) {
    failures.push(
      "Voter document access must issue a signed URL. It previously answered with crypto.randomUUID(), which granted nothing and verified nothing.",
    );
  }
  if (!around.includes("stored.sha256 !== document.sha256")) {
    failures.push(
      "Voter document access must verify the stored bytes against the hash recorded at upload before showing them to a validator.",
    );
  }
}

/* ---- The migration keeps the constraints --------------------------------- */

const migration = path.join(
  repoRoot,
  "packages/database/prisma/ogun-migrations/20260906120000_voter_document_private_storage/migration.sql",
);
let migrationText = "";
try {
  migrationText = readFileSync(migration, "utf8");
} catch {
  failures.push("The voter document private storage migration is missing.");
}
if (migrationText) {
  for (const constraint of [
    "VoterVerificationDocument_storage_provider_check",
    "VoterVerificationDocument_stored_object_complete_check",
  ]) {
    if (!migrationText.includes(constraint)) {
      failures.push(`The migration no longer defines ${constraint}.`);
    }
  }
}

/* ---- Report --------------------------------------------------------------- */

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`voter_document_custody_integrity=failed checks=${failures.length}`);
  process.exit(1);
}

console.log(`voter_document_authority=${authorityRelative}`);
for (const note of notes) console.log(note);
console.log("voter_document_custody_integrity=ok");
