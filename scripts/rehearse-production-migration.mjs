/**
 * Schema additivity rehearsal for the production migration stream.
 *
 * Rehearses against a disposable PostgreSQL container, never a real database.
 *
 *   node scripts/rehearse-production-migration.mjs
 *   node scripts/rehearse-production-migration.mjs --from-dump backup.dump
 *
 * WHAT THIS PROVES
 *   - the pending migrations actually applied to a populated database, verified
 *     by counting newly applied rows in _prisma_migrations rather than trusting
 *     an exit code that is also 0 when nothing was pending
 *   - no existing application table was removed
 *   - no existing column was removed
 *   - no existing column changed data type
 *   - no existing column became more restrictive (nullable -> NOT NULL)
 *   - no existing column lost a default
 *   - no existing column was narrowed in length, precision or scale
 *   - no enum label was removed
 *   - no UNIQUE / CHECK / FOREIGN KEY constraint or unique index was added over
 *     existing data
 *   - re-running `migrate deploy` is idempotent, compared in both directions
 *
 * WHAT THIS DOES NOT PROVE
 *   It does not prove the previous application image can continue serving after
 *   the migration. That depends on runtime behaviour — queries, Prisma client
 *   expectations, enum handling, constraint interactions — which no schema
 *   comparison can establish. Additivity is a necessary condition for rollback,
 *   not a sufficient one.
 *
 *   Previous-image runtime compatibility is verified separately during VPS
 *   staging rollback testing. See docs/DEPLOYMENT_VPS.md.
 *
 * Phases:
 *   1. Baseline   — apply every migration except the new ones, so the starting
 *                   point matches what production is running today.
 *   2. Seed       — load a dump if supplied, otherwise generate representative
 *                   rows so the forward migration runs against non-empty tables.
 *   3. Forward    — apply the pending migrations and time them.
 *   4. Additivity — compare the column contract before and after.
 *   5. Rerun      — apply again to prove the stream is idempotent.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databaseWorkspace = path.join(repoRoot, "packages", "database");
const migrationRoot = path.join(databaseWorkspace, "prisma", "ogun-migrations");
const require = createRequire(import.meta.url);
const prismaCli = require.resolve("prisma/build/index.js");
const dockerCommand = process.platform === "win32" ? "docker.exe" : "docker";

const fromDumpIndex = process.argv.indexOf("--from-dump");
const fromDump = fromDumpIndex >= 0 ? process.argv[fromDumpIndex + 1] : null;
const project = `bmo-migration-rehearsal-${process.pid}`;
const port = process.env.REHEARSAL_PORT || "55470";
const databaseUrl = `postgresql://ogun_test:ogun_test_local_only@127.0.0.1:${port}/ogun_phase0_test?schema=public`;
const composeFile = path.join(repoRoot, "docker-compose.dev.yml");

const env = { ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl, OGUN_POSTGRES_PORT: port };

/**
 * Runs a subprocess and throws on any non-zero status.
 *
 * `tolerateFailure` exists only for teardown, where a failure is reported but
 * must not decide the verdict. No validation step may use it: swallowing a
 * migration or restore error is precisely how a broken rehearsal reports PASS.
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd || repoRoot, env, stdio: options.quiet ? "pipe" : "inherit", input: options.input });
  if (result.status !== 0 && !options.tolerateFailure) {
    const detail = options.quiet ? String(result.stderr || "").trim() : "";
    throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? 1}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function psql(sql) {
  const result = spawnSync(
    dockerCommand,
    ["compose", "-p", project, "-f", composeFile, "exec", "-T", "postgres", "psql", "-U", "ogun_test", "-d", "ogun_phase0_test", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { cwd: repoRoot, env, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * Column contract of every application table.
 *
 * Captures type, nullability and default, because a migration can break a
 * previous image without dropping anything: tightening a nullable column to
 * NOT NULL, or removing a default, makes inserts from older code fail even
 * though every column still exists.
 */
function columnContract() {
  const rows = psql(
    "SELECT table_name||'.'||column_name" +
      "||E'	'||'type='||data_type" +
      "||E'	'||'udt='||udt_name" +
      "||E'	'||'nullable='||is_nullable" +
      "||E'	'||'default='||coalesce(column_default,'<none>')" +
      // Length and precision matter: narrowing varchar(255) to varchar(50), or
      // numeric(12,2) to numeric(6,2), rejects or truncates existing values
      // without changing data_type or udt_name.
      "||E'	'||'maxlen='||coalesce(character_maximum_length::text,'-')" +
      "||E'	'||'precision='||coalesce(numeric_precision::text,'-')" +
      "||E'	'||'scale='||coalesce(numeric_scale::text,'-') " +
      "FROM information_schema.columns " +
      "WHERE table_schema='public' AND table_name NOT LIKE '\\_prisma%' ORDER BY 1;",
  );

  const contract = new Map();
  for (const line of rows.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const [identity, ...attributes] = line.split("	");
    const parsed = Object.fromEntries(attributes.map((attribute) => attribute.split("=")).map(([key, ...rest]) => [key, rest.join("=")]));
    contract.set(identity, parsed);
  }
  return contract;
}

/** Tables present, so a dropped table is reported distinctly from dropped columns. */
function tableSet() {
  const rows = psql(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' " +
      "AND table_type='BASE TABLE' AND table_name NOT LIKE '\\_prisma%' ORDER BY 1;",
  );
  return new Set(rows.split("\n").map((entry) => entry.trim()).filter(Boolean));
}

/**
 * Constraints that restrict what an existing writer may store. A UNIQUE or
 * CHECK constraint added over existing data changes no column attribute, so the
 * column contract alone is blind to it — yet it can reject writes a previous
 * image performs happily.
 */
function constraintSet() {
  const rows = psql(
    "SELECT c.conrelid::regclass::text||' '||c.conname||' '||pg_get_constraintdef(c.oid) " +
      "FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace " +
      "WHERE n.nspname='public' AND c.contype IN ('p','f','u','c') " +
      "AND c.conrelid::regclass::text NOT LIKE '%_prisma%' ORDER BY 1;",
  );
  return new Set(rows.split("\n").map((entry) => entry.trim()).filter(Boolean));
}

/**
 * The table a constraint or index line belongs to. Both snapshots put the table
 * first; `conrelid::regclass` quotes mixed-case identifiers, information_schema
 * does not, so the quotes are stripped to compare against the table set.
 *
 * Returns null when the line cannot be parsed, and callers treat null as
 * restrictive. An unparseable line must never be mistaken for a new table and
 * waved through — the gate fails closed.
 */
function ownerTable(line) {
  const first = line.trim().split(/\s+/)[0];
  if (!first) {
    return null;
  }
  const stripped = first.replace(/^public\./, "").replace(/^"|"$/g, "");
  return stripped.length > 0 ? stripped : null;
}

/**
 * The referencing columns of a FOREIGN KEY definition — the `(a, b)` in
 * `FOREIGN KEY ("a", "b") REFERENCES ...`, not the referenced side. Returns an
 * empty array when the shape is not recognised, so an unparseable definition is
 * never mistaken for an exempt one.
 */
function referencingColumns(constraint) {
  const match = /FOREIGN KEY\s*\(([^)]*)\)/.exec(constraint);
  if (!match) {
    return [];
  }
  return match[1]
    .split(",")
    .map((column) => column.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/**
 * The column a CHECK short-circuits on, when it has the shape
 * `CHECK ((("col" IS NULL) OR (...)))`.
 *
 * That shape means the whole predicate is satisfied whenever `col` is NULL. If
 * `col` is also added by the same migration and nullable, a previous image —
 * which does not know the column exists and therefore writes NULL into it —
 * cannot produce a row the constraint rejects. Returns null for any other
 * shape, so an unrecognised CHECK is treated as restrictive.
 */
function checkNullGuardColumn(constraint) {
  const match = /CHECK\s*\(+\s*\(*\s*"([^"]+)"\s+IS NULL\s*\)*\s+OR\s/i.exec(constraint);
  return match ? match[1] : null;
}

/** Unique indexes, which restrict writes exactly as a unique constraint does. */
function uniqueIndexSet() {
  const rows = psql(
    "SELECT tablename||' '||indexname||' '||indexdef FROM pg_indexes " +
      "WHERE schemaname='public' AND indexdef LIKE 'CREATE UNIQUE%' " +
      "AND tablename NOT LIKE '%_prisma%' ORDER BY 1;",
  );
  return new Set(rows.split("\n").map((entry) => entry.trim()).filter(Boolean));
}

/**
 * Enum labels per type. Removing a label breaks a previous image that still
 * writes it, and information_schema hides this completely: the column keeps
 * data_type='USER-DEFINED' and the same udt_name.
 */
function enumLabels() {
  const rows = psql(
    "SELECT t.typname||'.'||e.enumlabel FROM pg_enum e " +
      "JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace " +
      "WHERE n.nspname='public' ORDER BY 1;",
  );
  return new Set(rows.split("\n").map((entry) => entry.trim()).filter(Boolean));
}

function narrowed(previousValue, currentValue) {
  if (previousValue === "-" || currentValue === "-") {
    return false;
  }
  const previousNumber = Number(previousValue);
  const currentNumber = Number(currentValue);
  return Number.isFinite(previousNumber) && Number.isFinite(currentNumber) && currentNumber < previousNumber;
}

/** Full schema snapshot used for the additivity comparison. */
function schemaSnapshot() {
  return {
    columns: columnContract(),
    tables: tableSet(),
    constraints: constraintSet(),
    uniqueIndexes: uniqueIndexSet(),
    enumLabels: enumLabels(),
  };
}

/** Migrations Prisma records as applied, used to detect a no-op forward step. */
function appliedMigrationCount() {
  return Number(psql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;'));
}

/**
 * Every backward-incompatible schema change between two snapshots.
 *
 * Additions are ignored: a new column, a relaxed constraint, or a new enum
 * label cannot break code that predates it. What is reported is anything that
 * removes or restricts what an existing writer could previously do.
 */
function backwardIncompatibleChanges(before, after) {
  const problems = [];
  const notes = [];

  for (const [identity, previous] of before.columns) {
    const current = after.columns.get(identity);
    if (!current) {
      problems.push(`column removed: ${identity}`);
      continue;
    }
    if (current.type !== previous.type || current.udt !== previous.udt) {
      problems.push(`column type changed: ${identity} ${previous.type}/${previous.udt} -> ${current.type}/${current.udt}`);
    }
    if (previous.nullable === "YES" && current.nullable === "NO") {
      problems.push(`column tightened to NOT NULL: ${identity} (inserts from a previous image would fail)`);
    }
    if (previous.default !== "<none>" && current.default === "<none>") {
      problems.push(`column default removed: ${identity} (was ${previous.default})`);
    }
    if (narrowed(previous.maxlen, current.maxlen)) {
      problems.push(`column length narrowed: ${identity} ${previous.maxlen} -> ${current.maxlen}`);
    }
    if (narrowed(previous.precision, current.precision) || narrowed(previous.scale, current.scale)) {
      problems.push(
        `column numeric range narrowed: ${identity} ${previous.precision},${previous.scale} -> ${current.precision},${current.scale}`,
      );
    }
  }

  for (const table of before.tables) {
    if (!after.tables.has(table)) {
      problems.push(`table removed: ${table}`);
    }
  }

  for (const label of before.enumLabels) {
    if (!after.enumLabels.has(label)) {
      problems.push(`enum label removed: ${label} (a previous image may still write it)`);
    }
  }

  // Newly restrictive constraints are reported; newly relaxed ones are not.
  //
  // A constraint is only restrictive if it lands on a table that ALREADY
  // existed: that table holds rows a previous image wrote, and writers of it are
  // live. A table created by this same migration has no existing data and no
  // existing writer, so its primary key, unique indexes and foreign keys cannot
  // reject anything that used to succeed. Reporting those as violations would
  // make every new-table migration unmergeable, which is the pressure that gets
  // an additivity gate switched off. Scoping by table keeps the gate credible
  // without loosening what it detects on live tables.
  for (const constraint of after.constraints) {
    if (before.constraints.has(constraint) || !/UNIQUE|CHECK|FOREIGN KEY/.test(constraint)) {
      continue;
    }
    const owner = ownerTable(constraint);
    if (owner === null) {
      problems.push(`constraint added over existing data: ${constraint}`);
      continue;
    }
    if (before.tables.has(owner)) {
      // One exemption, and only one: a foreign key whose every referencing
      // column is added by this same migration and is nullable. A previous
      // image does not know those columns exist, so it writes NULL into them,
      // and NULL satisfies a foreign key. Nothing it can insert or update is
      // rejected. Any other constraint on a live table stays a violation,
      // including a foreign key over a column that already held data.
      const referencing = referencingColumns(constraint);
      const newAndNullable = (column) => {
        const identity = `${owner}.${column}`;
        return !before.columns.has(identity) && after.columns.get(identity)?.nullable === "YES";
      };
      const foreignKeyExempt =
        constraint.includes("FOREIGN KEY") && referencing.length > 0 && referencing.every(newAndNullable);

      /**
       * The second exemption, on the same reasoning as the first and no wider.
       *
       * A CHECK of the form `("newcol" IS NULL) OR (...)` is satisfied outright
       * whenever `newcol` is NULL. If `newcol` is added by this migration and
       * nullable, a previous image writes NULL into it — it cannot do otherwise,
       * not knowing the column — so every row that image can insert or update
       * takes the first branch and passes. Nothing that used to succeed is
       * rejected.
       *
       * The narrowness is the point: only this exact shape qualifies, only when
       * the guard column is new and nullable. A CHECK over a column that already
       * held data, or one whose predicate does not short-circuit on a new
       * column, remains a violation.
       */
      const guard = checkNullGuardColumn(constraint);
      const checkExempt = constraint.includes("CHECK") && guard !== null && newAndNullable(guard);

      if (!foreignKeyExempt && !checkExempt) {
        problems.push(`constraint added over existing data: ${constraint}`);
        continue;
      }
      notes.push(
        checkExempt
          ? `new nullable column CHECK on pre-existing ${owner}, unreachable by a previous image: ${constraint}`
          : `nullable new-column foreign key on pre-existing ${owner}: ${constraint}`,
      );
      continue;
    }
    // The constraint sits on a new table, but a foreign key still reaches back
    // into the parent: with RESTRICT / NO ACTION, deleting a parent row that a
    // new child references now fails where it previously succeeded. No existing
    // row can be affected until the new code writes children, so this is not an
    // additivity failure — but it is a real change to an existing delete path
    // and is surfaced rather than swallowed.
    const referenced = /REFERENCES\s+"?([A-Za-z0-9_]+)"?/.exec(constraint);
    if (
      constraint.includes("FOREIGN KEY") &&
      referenced &&
      before.tables.has(referenced[1]) &&
      !/ON DELETE (CASCADE|SET NULL|SET DEFAULT)/.test(constraint)
    ) {
      notes.push(`new table ${owner} restricts deletes on pre-existing ${referenced[1]}: ${constraint}`);
    }
  }
  for (const index of after.uniqueIndexes) {
    if (before.uniqueIndexes.has(index)) {
      continue;
    }
    const owner = ownerTable(index);
    if (owner === null || before.tables.has(owner)) {
      problems.push(`unique index added over existing data: ${index}`);
    }
  }

  return { problems, notes };
}

const allMigrations = readdirSync(migrationRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

// "Pending" means migrations not yet present on the shipped base ref.
//
// A failure to read that ref must abort. An unreadable ref produces empty
// stdout, which is indistinguishable from "the base has no migrations" — and
// that would make every migration "pending", leave the baseline empty, and turn
// the whole additivity comparison into a vacuous pass. A shallow or
// single-branch checkout (the default for many CI providers) has no
// refs/remotes/origin/main, so this is a realistic condition, not a theoretical
// one.
const baseRef = process.env.REHEARSAL_BASE_REF || "origin/main";
const mergedBase = spawnSync("git", ["ls-tree", "--name-only", baseRef, "packages/database/prisma/ogun-migrations/"], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (mergedBase.error || mergedBase.status !== 0) {
  const detail = mergedBase.error
    ? mergedBase.error.message
    : String(mergedBase.stderr || "").trim() || `git exited ${mergedBase.status}`;
  console.error(
    `FAIL could not read the shipped migration set from ${baseRef}: ${detail}\n` +
      "Refusing to rehearse against an unknown baseline. Run `git fetch origin main`, " +
      "or set REHEARSAL_BASE_REF to a ref that exists locally.",
  );
  process.exit(1);
}
const baseNames = new Set(
  (mergedBase.stdout || "")
    .split("\n")
    .map((line) => line.trim().replace(/\/$/, "").split("/").pop())
    .filter(Boolean),
);
if (baseNames.size === 0) {
  console.error(
    `FAIL ${baseRef} reports no migrations under packages/database/prisma/ogun-migrations/. ` +
      "An empty baseline would make the additivity comparison vacuous.",
  );
  process.exit(1);
}
const pending = allMigrations.filter((name) => !baseNames.has(name));
const rehearsed = pending.length > 0 ? pending : allMigrations.slice(-1);
const baseline = allMigrations.filter((name) => !rehearsed.includes(name));

if (baseline.length === 0) {
  console.error(
    "FAIL the rehearsal baseline is empty, so there is no prior schema to compare against. " +
      "Every migration was classified as pending; check the base ref.",
  );
  process.exit(1);
}

console.log(`rehearsal_migrations_total=${allMigrations.length}`);
console.log(`rehearsal_baseline=${baseline.length}`);
console.log(`rehearsal_forward=${rehearsed.length} (${rehearsed.join(", ")})`);

const holdingArea = mkdtempSync(path.join(os.tmpdir(), "bmo-rehearsal-"));
const movedAside = [];
let started = false;
try {
  run(dockerCommand, ["compose", "-p", project, "-f", composeFile, "up", "-d", "--wait", "postgres"]);
  started = true;

  // ---- Phase 1: baseline ---------------------------------------------------
  // Apply only the already-shipped migrations. The pending directories are moved
  // aside rather than stashed, because git stash cannot hide files that are
  // already committed on this branch — which would silently turn the forward
  // step into a no-op re-apply and make the rehearsal prove nothing.
  for (const name of rehearsed) {
    const from = path.join(migrationRoot, name);
    if (existsSync(from)) {
      renameSync(from, path.join(holdingArea, name));
      movedAside.push(name);
    }
  }
  if (movedAside.length !== rehearsed.length) {
    throw new Error("Could not isolate the pending migrations; refusing to report a rehearsal that did not run.");
  }

  run(process.execPath, [prismaCli, "migrate", "deploy", "--config", "prisma.config.ts"], { cwd: databaseWorkspace });

  // ---- Phase 2: representative data ---------------------------------------
  if (fromDump) {
    console.log(`rehearsal_seed=dump:${fromDump}`);
    run(dockerCommand, ["compose", "-p", project, "-f", composeFile, "exec", "-T", "postgres", "pg_restore", "-U", "ogun_test", "-d", "ogun_phase0_test", "--clean", "--if-exists", "--exit-on-error", "--no-owner", "--no-privileges"], {
      input: readFileSync(fromDump),
    });
  } else {
    // A migration that applies to empty tables proves very little: rewrites,
    // NOT NULL additions, and unique indexes only fail with rows present.
    psql(
      "INSERT INTO \"State\" (id,name,\"createdAt\",\"updatedAt\") VALUES ('ng-state-ogun','Ogun',now(),now()) ON CONFLICT (id) DO NOTHING; " +
        "INSERT INTO \"User\" (id,name,email,\"passwordHash\",role,\"isActive\",\"accountStatus\",\"createdAt\",\"updatedAt\") " +
        "SELECT 'rehearse-'||g, 'Rehearsal '||g, 'rehearse-'||g||'@example.test','x','MEMBER',true,'ACTIVE',now(),now() " +
        "FROM generate_series(1,500) g ON CONFLICT (id) DO NOTHING;",
    );
    console.log(`rehearsal_seed=synthetic rows=${psql('SELECT count(*) FROM "User";')}`);
  }

  // The baseline snapshot is taken AFTER seeding, not before. With --from-dump,
  // pg_restore --clean replaces the schema wholesale, so a snapshot taken
  // earlier would describe a schema that no longer exists and the comparison
  // would be against the wrong starting point.
  const before = schemaSnapshot();
  const appliedBefore = appliedMigrationCount();
  console.log(`rehearsal_baseline_columns=${before.columns.size}`);
  console.log(`rehearsal_baseline_tables=${before.tables.size}`);
  console.log(`rehearsal_baseline_constraints=${before.constraints.size}`);
  console.log(`rehearsal_baseline_enum_labels=${before.enumLabels.size}`);
  console.log(`rehearsal_baseline_applied_migrations=${appliedBefore}`);

  // A degenerate baseline would make every comparison below vacuously true.
  if (before.columns.size === 0 || before.tables.size === 0) {
    throw new Error("Baseline schema snapshot is empty; the additivity comparison would prove nothing.");
  }

  // ---- Phase 3: forward ----------------------------------------------------
  for (const name of movedAside) {
    renameSync(path.join(holdingArea, name), path.join(migrationRoot, name));
  }
  movedAside.length = 0;
  const startedAt = Date.now();
  run(process.execPath, [prismaCli, "migrate", "deploy", "--config", "prisma.config.ts"], { cwd: databaseWorkspace });
  const elapsedMs = Date.now() - startedAt;
  console.log(`rehearsal_forward_ms=${elapsedMs}`);

  // `migrate deploy` exits 0 while printing "No pending migrations to apply",
  // so a forward step that did nothing must be detected explicitly. Without
  // this, every check below would pass while nothing was ever rehearsed.
  const appliedAfter = appliedMigrationCount();
  const newlyApplied = appliedAfter - appliedBefore;
  console.log(`rehearsal_forward_applied=${newlyApplied}`);
  if (newlyApplied !== rehearsed.length) {
    throw new Error(
      `Forward step applied ${newlyApplied} migrations but ${rehearsed.length} were pending. ` +
        "Refusing to report a rehearsal that did not exercise the migration under test.",
    );
  }

  // ---- Phase 4: schema additivity ------------------------------------------
  const after = schemaSnapshot();
  const { problems: incompatible, notes: additivityNotes } = backwardIncompatibleChanges(before, after);

  // Printed whether the gate passes or fails: a reviewer must see a changed
  // delete path even on a green run.
  for (const note of additivityNotes) {
    console.log(`rehearsal_note=${note}`);
  }

  if (incompatible.length > 0) {
    console.error("FAIL migration is not schema-additive:");
    for (const problem of incompatible) {
      console.error(`  ${problem}`);
    }
    process.exitCode = 1;
  } else {
    console.log("rehearsal_tables_removed=0");
    console.log("rehearsal_columns_removed=0");
    console.log("rehearsal_columns_retyped=0");
    console.log("rehearsal_columns_tightened=0");
    console.log("rehearsal_columns_narrowed=0");
    console.log("rehearsal_enum_labels_removed=0");
    console.log("rehearsal_restrictive_constraints_added=0");
    console.log(
      `rehearsal_additive=ok added_columns=${after.columns.size - before.columns.size} ` +
        `added_tables=${after.tables.size - before.tables.size}`,
    );
  }

  // ---- Phase 5: rerun ------------------------------------------------------
  run(process.execPath, [prismaCli, "migrate", "deploy", "--config", "prisma.config.ts"], { cwd: databaseWorkspace });
  const afterRerun = schemaSnapshot();
  // Compared in both directions: a one-way scan would miss a rerun that ADDED
  // something, which is equally a violation of idempotency.
  // Drift is compared against the post-migration snapshot, where every table
  // already exists, so the new-table exemption above cannot hide a rerun that
  // adds a constraint.
  const rerunDrift = [
    ...backwardIncompatibleChanges(after, afterRerun).problems,
    ...backwardIncompatibleChanges(afterRerun, after).problems,
  ];
  if (afterRerun.columns.size !== after.columns.size || afterRerun.tables.size !== after.tables.size || rerunDrift.length > 0) {
    console.error("FAIL re-running the migration stream changed the schema; it is not idempotent");
    for (const problem of rerunDrift) {
      console.error(`  ${problem}`);
    }
    process.exitCode = 1;
  } else {
    console.log("rehearsal_idempotent=ok");
  }

  if (!process.exitCode) {
    console.log("migration_schema_additivity_rehearsal=ok");
    // Stated explicitly so a green run is never read as a rollback guarantee.
    console.log("rehearsal_scope=schema-additivity-only");
    console.log("rehearsal_previous_image_runtime_compatibility=NOT_VERIFIED_HERE (see VPS staging rollback test)");
  }
} catch (error) {
  // Success markers are only printed on the happy path above, so a throw here
  // can never be mistaken for a pass.
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  // The repository must never be left missing a migration directory, even if
  // the rehearsal threw partway through.
  const restoreFailures = [];
  for (const name of movedAside) {
    const held = path.join(holdingArea, name);
    if (existsSync(held)) {
      try {
        renameSync(held, path.join(migrationRoot, name));
      } catch (error) {
        restoreFailures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (restoreFailures.length > 0) {
    console.error(`FAIL could not restore migration directories: ${restoreFailures.join("; ")}`);
    console.error(`They remain in ${holdingArea}; restore them before committing.`);
    process.exitCode = process.exitCode || 1;
  } else {
    rmSync(holdingArea, { recursive: true, force: true });
  }

  if (started) {
    // Teardown failure is reported but must never clear a verdict already set.
    const teardown = run(dockerCommand, ["compose", "-p", project, "-f", composeFile, "down", "--volumes", "--remove-orphans"], {
      tolerateFailure: true,
      quiet: true,
    });
    if (teardown.status !== 0) {
      console.error("WARN rehearsal teardown failed; inspect the Docker project manually.");
      process.exitCode = process.exitCode || 1;
    }
  }
}
