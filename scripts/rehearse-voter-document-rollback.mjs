/**
 * Rehearses the voter-document migrations against a target that has neither.
 *
 * `rehearse:migration` asks "what does this branch add on top of the shipped
 * main?", which is the right question for an incremental deploy and the wrong
 * one here. Migration 20260906120000 is already on main, so it sits in that
 * rehearsal's baseline and stops being examined. But no environment has ever
 * run it: the first real deployment applies 20260906120000 and 20260906180000
 * together, against a database holding the historical document shape.
 *
 * This rehearses that. Two things have to hold, and they pull in opposite
 * directions:
 *
 *   A. Application safety. The migration pair must apply to a populated
 *      pre-migration database without aborting partway through a deployment.
 *
 *   B. Rollback compatibility. Afterwards, the previous application image must
 *      still be able to write its historical document shape — it remains a
 *      valid rollback target until the contract migration retires it.
 *
 * B is what the added CHECK constraints broke, and why the relaxation exists.
 * ADD CONSTRAINT ... NOT VALID would not have helped: it skips existing rows
 * but still rejects new writes, and the problem is the old writer, not the old
 * rows.
 *
 * Its own disposable database. Never touches a real one.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dockerCommand = process.platform === "win32" ? "docker.exe" : "docker";
const project = `bmo-voterdoc-rehearsal-${process.pid}`;
const port = process.env.REHEARSAL_PORT || "55471";
const databaseUrl = `postgresql://ogun_test:ogun_test_local_only@127.0.0.1:${port}/ogun_phase0_test?schema=public`;
const composeFile = path.join(repoRoot, "docker-compose.dev.yml");
const migrationsDir = path.join(repoRoot, "packages/database/prisma/ogun-migrations");

const STORAGE_MIGRATION = "20260906120000_voter_document_private_storage";
const RELAXATION_MIGRATION = "20260906180000_voter_document_rollback_compatibility";
const HISTORICAL_PROVIDER = "PRIVATE_OBJECT_STORAGE_STUB";

const env = { ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl, OGUN_POSTGRES_PORT: port };
const failures = [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env,
    stdio: options.quiet ? "pipe" : "inherit",
  });
  if (result.status !== 0 && !options.tolerateFailure) {
    const detail = options.quiet ? String(result.stderr || "").trim() : "";
    throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? 1}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

/** Runs SQL and returns stdout. `expectFailure` inverts the verdict. */
function psql(sql, options = {}) {
  const result = spawnSync(
    dockerCommand,
    [
      "compose", "-p", project, "-f", composeFile, "exec", "-T", "postgres",
      "psql", "-U", "ogun_test", "-d", "ogun_phase0_test", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql,
    ],
    { cwd: repoRoot, env, encoding: "utf8" },
  );
  if (options.expectFailure) {
    return { ok: result.status === 0, stderr: String(result.stderr || "") };
  }
  if (result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr}`);
  }
  return { ok: true, stdout: String(result.stdout || "").trim() };
}

function migrationNames() {
  return readdirSync(migrationsDir)
    .filter((entry) => existsSync(path.join(migrationsDir, entry, "migration.sql")))
    .sort();
}

/**
 * Applies one migration by name.
 *
 * Piped over stdin rather than read from a path: the repository is not mounted
 * into the database container, so the file does not exist there.
 */
function applyMigration(name) {
  const sql = readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8");
  const result = spawnSync(
    dockerCommand,
    [
      "compose", "-p", project, "-f", composeFile, "exec", "-T", "postgres",
      "psql", "-U", "ogun_test", "-d", "ogun_phase0_test", "-v", "ON_ERROR_STOP=1",
    ],
    { cwd: repoRoot, env, encoding: "utf8", input: sql },
  );
  return { ok: result.status === 0, stderr: String(result.stderr || "") };
}

let started = false;
try {
  console.log(`voterdoc_rehearsal_port=${port}`);
  run(dockerCommand, ["compose", "-p", project, "-f", composeFile, "up", "-d", "--wait", "postgres"], { quiet: true });
  started = true;

  const all = migrationNames();
  const storageIndex = all.indexOf(STORAGE_MIGRATION);
  const relaxationIndex = all.indexOf(RELAXATION_MIGRATION);
  if (storageIndex === -1) throw new Error(`${STORAGE_MIGRATION} is missing.`);
  if (relaxationIndex === -1) throw new Error(`${RELAXATION_MIGRATION} is missing.`);

  const baseline = all.slice(0, storageIndex);
  console.log(`voterdoc_rehearsal_baseline=${baseline.length}`);

  for (const name of baseline) {
    const applied = applyMigration(name);
    if (!applied.ok) throw new Error(`baseline migration ${name} failed: ${applied.stderr}`);
  }

  /**
   * The historical shape, exactly as the previous image wrote it: the stub
   * provider, and — before the storage migration adds them — no bucket and no
   * receipt time columns at all.
   */
  psql(`
    INSERT INTO "User" (id, name, email, "passwordHash", role, "isActive", "createdAt", "updatedAt")
    VALUES ('rehearsal-member', 'Rehearsal Member', 'rehearsal@voterdoc.invalid', 'x', 'MEMBER', true, NOW(), NOW());
    INSERT INTO "VoterVerification" (id, "memberUserId", "voterIdentifier", status, "createdAt", "updatedAt")
    VALUES ('rehearsal-verification', 'rehearsal-member', 'REHEARSAL-VIN', 'PENDING', NOW(), NOW());
    INSERT INTO "VoterVerificationDocument"
      (id, "verificationId", "originalStorageKey", "originalFileName", "mimeType", "fileSize", sha256, "storageProvider", "uploadedAt")
    VALUES
      ('rehearsal-doc-1', 'rehearsal-verification', 'voter-verification/client/legacy-1.pdf', 'legacy-1.pdf', 'application/pdf', 100, '${"a".repeat(64)}', '${HISTORICAL_PROVIDER}', NOW()),
      ('rehearsal-doc-2', 'rehearsal-verification', 'voter-verification/client/legacy-2.pdf', 'legacy-2.pdf', 'application/pdf', 200, '${"b".repeat(64)}', '${HISTORICAL_PROVIDER}', NOW());
  `);
  const seeded = psql(`SELECT COUNT(*) FROM "VoterVerificationDocument";`).stdout;
  console.log(`voterdoc_rehearsal_seeded_legacy_rows=${seeded}`);

  /* ---- A: the pair applies to a populated pre-migration database ---------- */

  const preflight = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts/preflight-voter-document-migration.mjs")],
    { cwd: repoRoot, env: { ...env, PREFLIGHT_FORCE_PRE_MIGRATION: "1" }, encoding: "utf8" },
  );
  if (preflight.status !== 0) {
    failures.push(`the preflight refused a database holding only legitimate historical rows:\n${preflight.stdout}${preflight.stderr}`);
  } else {
    console.log("voterdoc_rehearsal_preflight=ok");
  }

  const storageApplied = applyMigration(STORAGE_MIGRATION);
  if (!storageApplied.ok) {
    failures.push(`${STORAGE_MIGRATION} failed against a populated pre-migration database: ${storageApplied.stderr}`);
  } else {
    console.log(`voterdoc_rehearsal_applied=${STORAGE_MIGRATION}`);
  }

  const relaxationApplied = applyMigration(RELAXATION_MIGRATION);
  if (!relaxationApplied.ok) {
    failures.push(`${RELAXATION_MIGRATION} failed: ${relaxationApplied.stderr}`);
  } else {
    console.log(`voterdoc_rehearsal_applied=${RELAXATION_MIGRATION}`);
  }

  const normalized = psql(
    `SELECT COUNT(*) FROM "VoterVerificationDocument" WHERE "storageProvider" = 'UNSTORED_LEGACY_STUB';`,
  ).stdout;
  console.log(`voterdoc_rehearsal_normalized_rows=${normalized}`);
  if (normalized !== String(seeded)) {
    failures.push(`the storage migration normalized ${normalized} of ${seeded} historical rows.`);
  }

  /* ---- B: the previous image can still write its shape -------------------- */

  const oldImageWrite = psql(
    `INSERT INTO "VoterVerificationDocument"
       (id, "verificationId", "originalStorageKey", "originalFileName", "mimeType", "fileSize", sha256, "storageProvider", "uploadedAt")
     VALUES
       ('rehearsal-rollback-doc', 'rehearsal-verification', 'voter-verification/client/rolled-back.pdf', 'rolled-back.pdf', 'application/pdf', 300, '${"c".repeat(64)}', '${HISTORICAL_PROVIDER}', NOW());`,
    { expectFailure: true },
  );
  if (!oldImageWrite.ok) {
    failures.push(
      "the previous application image can no longer write its document shape after the migrations. " +
        "It remains a valid rollback target until the contract migration retires it, so a rollback would " +
        `fail at INSERT time:\n${oldImageWrite.stderr.trim()}`,
    );
  } else {
    console.log("voterdoc_rehearsal_rollback_write=accepted");
  }

  /* ---- And the new image's complete shape is still accepted --------------- */

  const newImageWrite = psql(
    `INSERT INTO "VoterVerificationDocument"
       (id, "verificationId", "originalStorageKey", "originalFileName", "mimeType", "fileSize", sha256, "storageProvider", "storageBucket", "serverReceivedAt", "uploadedAt")
     VALUES
       ('rehearsal-forward-doc', 'rehearsal-verification', 'voter-verification/2026/09/forward.pdf', 'forward.pdf', 'application/pdf', 400, '${"d".repeat(64)}', 's3-compatible', 'ogun-private', NOW(), NOW());`,
    { expectFailure: true },
  );
  if (!newImageWrite.ok) {
    failures.push(`the new application image cannot write complete custody:\n${newImageWrite.stderr.trim()}`);
  } else {
    console.log("voterdoc_rehearsal_forward_write=accepted");
  }

  /* ---- The bounded normalization is idempotent ---------------------------- */

  for (const pass of [1, 2]) {
    const normalize = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts/normalize-legacy-voter-documents.mjs"), "--apply"],
      { cwd: repoRoot, env, encoding: "utf8" },
    );
    if (normalize.status !== 0) {
      failures.push(`the roll-forward normalization failed on pass ${pass}:\n${normalize.stdout}${normalize.stderr}`);
      break;
    }
    const relabelled = (normalize.stdout.match(/relabelled=(\d+)/) || [])[1];
    console.log(`voterdoc_rehearsal_normalization_pass_${pass}_relabelled=${relabelled}`);
    if (pass === 2 && relabelled !== "0") {
      failures.push(`the roll-forward normalization is not idempotent: pass 2 relabelled ${relabelled} rows.`);
    }
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  if (started) {
    run(dockerCommand, ["compose", "-p", project, "-f", composeFile, "down", "--volumes", "--remove-orphans"], {
      quiet: true,
      tolerateFailure: true,
    });
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`voter_document_rollback_rehearsal=failed checks=${failures.length}`);
  process.exit(1);
}

console.log("voter_document_rollback_rehearsal=ok");
