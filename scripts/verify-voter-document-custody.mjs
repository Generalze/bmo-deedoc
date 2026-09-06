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
 * "PRIVATE_OBJECT_STORAGE_STUB". Three routes wrote that record, each with its
 * own copy of the logic, and the access route answered with
 * `crypto.randomUUID()` as though it were an access grant.
 *
 * Storing the bytes created a second problem, which this also guards. They must
 * be written before the row exists — a row must never name an object that is
 * not there — so a transaction that then fails would strand an identity
 * document with no database owner and no lifecycle. Documents therefore land in
 * a pending namespace and are promoted only once the row is committed, and the
 * only deletion the application can perform is bounded to that namespace.
 *
 * This guards the shape of the fix: every write goes through one authority,
 * custody is attached to the transaction outcome, and committed evidence stays
 * undeletable by application credentials.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiSource = path.join(repoRoot, "apps/api/src");
const authorityRelative = "apps/api/src/lib/voter-document-storage.ts";
const storageRelative = "packages/object-storage/src/evidence-storage.ts";
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

function relativePath(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

/** The body of a top-level exported function, up to its closing brace. */
function functionBody(text, declaration) {
  const start = text.indexOf(declaration);
  if (start === -1) return null;
  // A closing brace alone on its line. A multi-line signature ends with
  // "}): Promise<void> {", which must not be mistaken for the end of the body.
  const match = text.slice(start).match(/^[\s\S]*?^\}$/m);
  return match ? match[0] : null;
}

const authorityPath = path.join(repoRoot, authorityRelative);
let authority;
try {
  authority = readFileSync(authorityPath, "utf8");
} catch {
  console.error(`FAIL The voter document custody authority is missing: ${authorityRelative}`);
  process.exit(1);
}

/* ---- The authority derives what only the server can know ----------------- */

for (const [needle, why] of [
  ['createHash("sha256")', "the authority must compute the document hash itself"],
  ["putObjectIfAbsent", "the authority must actually store the bytes"],
  ["getPrivateObjectStorage", "the authority must use private object storage"],
  ["withVoterDocumentCustody", "custody must be attached to the transaction outcome"],
  ["commitVoterDocument", "a committed row must promote its object"],
  ["discardVoterDocument", "a failed transaction must discard its object"],
  [
    "PRIVATE_STORAGE_PREFIXES.voterVerificationPending",
    "documents must land in the pending namespace first, or a failed transaction strands them where cleanup cannot reach",
  ],
]) {
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
  const relative = relativePath(file);
  if (relative === authorityRelative) continue;
  const text = readFileSync(file, "utf8");
  const isTest = relative.endsWith(".test.ts");

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
  if (!text.includes("withVoterDocumentCustody") && !text.includes("discardVoterDocument")) {
    failures.push(
      `${relative} writes a VoterVerificationDocument without attaching custody to the transaction outcome. A rolled-back submission would retain the bytes with no database owner.`,
    );
  }
}

notes.push(`voter_document_write_sites=${writeSites}`);

/* ---- The stub cannot return ---------------------------------------------- */

for (const file of files) {
  const relative = relativePath(file);
  const text = readFileSync(file, "utf8");
  const writesStub =
    /storageProvider:\s*"PRIVATE_OBJECT_STORAGE_STUB"/.test(text) ||
    /=\s*"PRIVATE_OBJECT_STORAGE_STUB"/.test(text) ||
    /return[^;]*"PRIVATE_OBJECT_STORAGE_STUB"/.test(text);
  if (writesStub && !relative.endsWith(".test.ts")) {
    failures.push(
      `${relative} still writes PRIVATE_OBJECT_STORAGE_STUB. That value named a provider which stored nothing while reading as private storage.`,
    );
  }
}

/* ---- Deletion authority stays narrow -------------------------------------
 * The application may remove an object that no committed row owns, and nothing
 * else. If this boundary widens, a cleanup becomes evidence destruction — and
 * the bucket policy alone should not be the only thing preventing it.
 */

const storageText = readFileSync(path.join(repoRoot, storageRelative), "utf8");

if (!storageText.includes("export function isPendingObjectKey")) {
  failures.push(`${storageRelative}: the pending-key predicate is gone; deletion is no longer namespace-bounded.`);
}

const discardBody = functionBody(storageText, "export async function discardPendingObject");
if (!discardBody) {
  failures.push(`${storageRelative}: discardPendingObject is missing.`);
} else {
  if (!discardBody.includes("isPendingObjectKey(key)")) {
    failures.push(
      `${storageRelative}: discardPendingObject no longer refuses keys outside the pending namespace. Committed evidence and identity documents would become deletable by the application.`,
    );
  }
  if (!discardBody.includes("CommittedObjectDeletionRefused")) {
    failures.push(`${storageRelative}: discardPendingObject no longer throws CommittedObjectDeletionRefused.`);
  }
}

const promoteBody = functionBody(storageText, "export async function promotePendingObject");
if (!promoteBody) {
  failures.push(`${storageRelative}: promotePendingObject is missing.`);
} else if (!promoteBody.includes("isPendingObjectKey(input.committedKey)")) {
  failures.push(
    `${storageRelative}: promotePendingObject no longer refuses promotion into the pending namespace. A committed document could land somewhere cleanup may delete it.`,
  );
}

/** Only the narrow wrappers may reach the raw delete. */
for (const file of files) {
  const relative = relativePath(file);
  if (relative.endsWith(".test.ts")) continue;
  if (readFileSync(file, "utf8").includes("deleteObjectUnchecked")) {
    failures.push(
      `${relative} calls deleteObjectUnchecked directly. Deletion must go through discardPendingObject, which refuses anything outside the pending namespace.`,
    );
  }
}

/* ---- Access is signed, verified and short lived -------------------------- */

const routeText = readFileSync(path.join(repoRoot, "apps/api/src/routes/pre-election.ts"), "utf8");
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

const migrationPath = path.join(
  repoRoot,
  "packages/database/prisma/ogun-migrations/20260906120000_voter_document_private_storage/migration.sql",
);
let migrationText = "";
try {
  migrationText = readFileSync(migrationPath, "utf8");
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

/* ---- Reads judge custody, not labels -------------------------------------
 * The database no longer refuses an incomplete row, so a previous image can
 * create one after the migration. A read path that tests for known legacy
 * provider strings would serve the next unanticipated one.
 */
if (!authority.includes("export function isServableCustody")) {
  failures.push(`${authorityRelative}: the custody-completeness predicate is missing.`);
} else {
  const servableBody = functionBody(authority, "export function isServableCustody");
  if (!servableBody) {
    failures.push(`${authorityRelative}: isServableCustody could not be read.`);
  } else {
    for (const [needle, why] of [
      ["document.storageBucket", "a servable document must have a recorded bucket"],
      ["document.serverReceivedAt", "a servable document must have a recorded server receipt time"],
      ["isPendingObjectKey", "a document still in pending custody must not be servable"],
    ]) {
      if (!servableBody.includes(needle)) {
        failures.push(`${authorityRelative}: isServableCustody no longer checks that ${why}.`);
      }
    }
    if (/storageProvider\s*===/.test(servableBody)) {
      failures.push(
        `${authorityRelative}: isServableCustody compares storageProvider against a literal. The set of historical labels is open — an image nobody anticipated writes a new one — so servability must be decided by custody completeness alone.`,
      );
    }
  }
}

/* ---- Legacy normalization stays bounded ----------------------------------
 * It may relabel exactly the shape migration 20260906120000 already
 * established, and must never reinterpret an unfamiliar provider.
 */
const normalizerRelative = "scripts/normalize-legacy-voter-documents.mjs";
let normalizer = "";
try {
  normalizer = readFileSync(path.join(repoRoot, normalizerRelative), "utf8");
} catch {
  failures.push(`${normalizerRelative} is missing.`);
}
if (normalizer) {
  const targetMatch = normalizer.match(/const target = \{[\s\S]*?\};/);
  if (!targetMatch) {
    failures.push(`${normalizerRelative}: the relabel target could not be read.`);
  } else {
    const target = targetMatch[0];
    for (const [needle, why] of [
      ["storageProvider: HISTORICAL_PROVIDER", "it must relabel only the historical provider"],
      ["storageBucket: null", "it must relabel only rows with no recorded bucket"],
      ["serverReceivedAt: null", "it must relabel only rows with no recorded receipt time"],
    ]) {
      if (!target.includes(needle)) {
        failures.push(
          `${normalizerRelative}: the relabel target has widened — ${why}. Reinterpreting an unfamiliar provider assigns a meaning to an identity-document record that nobody established.`,
        );
      }
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
