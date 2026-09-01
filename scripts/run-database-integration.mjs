import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databaseWorkspace = path.join(repoRoot, "packages", "database");
const require = createRequire(import.meta.url);
const prismaCliPath = require.resolve("prisma/build/index.js");
const useExistingDatabase = process.argv.includes("--existing-database");
const dockerCommand = process.platform === "win32" ? "docker.exe" : "docker";
const npmCli = process.env.npm_execpath;
const composeFile = path.join(repoRoot, "docker-compose.dev.yml");
const composeProject = `bmo-deedoc-integration-${process.pid}`;
const postgresPort = process.env.OGUN_TEST_POSTGRES_PORT || "55433";
const dockerDatabaseUrl = `postgresql://ogun_test:ogun_test_local_only@127.0.0.1:${postgresPort}/ogun_phase0_test?schema=public`;
const databaseUrl = useExistingDatabase ? process.env.DATABASE_URL : dockerDatabaseUrl;
const migrationRoot = path.join(databaseWorkspace, "prisma", "ogun-migrations");
const baselineName = readdirSync(migrationRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()[0];
const baselineMigrationPath = baselineName ? path.join(migrationRoot, baselineName, "migration.sql") : null;

function run(command, args, env, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env,
    input: options.input,
    stdio: options.input ? ["pipe", "inherit", "inherit"] : "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}.`);
  }
}

function runNpm(args, env) {
  if (!npmCli) {
    throw new Error("npm_execpath is unavailable; run this workflow through npm.");
  }

  run(process.execPath, [npmCli, ...args], env);
}

function runPrisma(args, env, input) {
  run(process.execPath, [prismaCliPath, ...args], env, { cwd: databaseWorkspace, input });
}

function assertDisposableDatabase(urlValue) {
  if (!urlValue) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }

  const url = new URL(urlValue);
  const allowedHosts = new Set(["127.0.0.1", "localhost", "postgres"]);
  const databaseName = url.pathname.replace(/^\//, "").toLowerCase();

  if (!allowedHosts.has(url.hostname) || (!databaseName.includes("test") && !databaseName.includes("ci"))) {
    throw new Error("Integration tests require a local/CI PostgreSQL database whose name contains 'test' or 'ci'.");
  }
}

function databaseAdminUrl(urlValue) {
  const url = new URL(urlValue);
  url.pathname = "/postgres";
  url.searchParams.delete("schema");
  return url.toString();
}

function prepareBaselineShadowDatabase(env) {
  const liveUrl = new URL(databaseUrl);
  const liveName = liveUrl.pathname.replace(/^\//, "").replace(/[^a-zA-Z0-9_]/g, "_");
  const databaseName = `${liveName}_baseline_shadow_${process.pid}`.slice(0, 63);
  const adminUrl = databaseAdminUrl(databaseUrl);
  runPrisma(["db", "execute", "--stdin", "--url", adminUrl], env, `CREATE DATABASE "${databaseName}";`);

  const shadowUrl = new URL(databaseUrl);
  shadowUrl.pathname = `/${databaseName}`;
  shadowUrl.searchParams.set("schema", "public");
  return { adminUrl, databaseName, url: shadowUrl.toString() };
}

function resetToUntrackedBaseline(env) {
  if (!baselineMigrationPath) {
    throw new Error("The Ogun PostgreSQL baseline migration is missing.");
  }
  runPrisma(
    ["db", "execute", "--stdin", "--url", databaseUrl],
    env,
    'DROP SCHEMA IF EXISTS "public" CASCADE; CREATE SCHEMA "public";',
  );
  runPrisma(["db", "execute", "--file", baselineMigrationPath, "--url", databaseUrl], env);
}

function destroyBaselineShadowDatabase(shadow, env) {
  runPrisma(
    ["db", "execute", "--stdin", "--url", shadow.adminUrl],
    env,
    `DROP DATABASE IF EXISTS "${shadow.databaseName}" WITH (FORCE);`,
  );
}

assertDisposableDatabase(databaseUrl);

const testEnv = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  JWT_SECRET: "phase0-integration-only-jwt-secret-64-characters-minimum-value",
  JWT_EXPIRES_IN: "15m",
  JWT_ISSUER: "ogun-election-operations-api-test",
  JWT_AUDIENCE: "ogun-election-operations-web-test",
  CORS_ALLOWED_ORIGINS: "http://localhost:3000",
  AUTH_RATE_LIMIT_MAX: "1000",
  REGISTRATION_RATE_LIMIT_MAX: "1000",
  OGUN_POSTGRES_PORT: postgresPort,
};
let baselineShadow = null;

try {
  if (!useExistingDatabase) {
    run(dockerCommand, ["compose", "-p", composeProject, "-f", composeFile, "up", "-d", "--wait", "postgres"], testEnv);
  }

  baselineShadow = prepareBaselineShadowDatabase(testEnv);
  testEnv.BASELINE_SHADOW_DATABASE_URL = baselineShadow.url;
  runNpm(["run", "verify:migrations"], testEnv);
  runNpm(["run", "prisma:generate"], testEnv);
  runNpm(["run", "prisma:migrate:deploy"], testEnv);
  runNpm(["run", "prisma:ensure-production"], testEnv);
  resetToUntrackedBaseline(testEnv);
  runNpm(["run", "prisma:ensure-production"], testEnv);
  // Reference data first: the seed now attaches its sample accounts to the real
  // Ogun structure rather than inventing territory inside it. Seeding first made
  // the seed fabricate a senatorial district and a federal constituency that the
  // reference import then duplicated, breaking Ogun's verified counts.
  runNpm(["run", "bootstrap:reference-data"], testEnv);
  // Ogun's own structure — 20 LGAs, 236 wards, 5,042 polling units and the 26
  // state constituencies with their command parents. bootstrap:reference-data
  // stops at the national constituency set, so without this the state has no
  // LGAs at all and the seed has nowhere legitimate to place a sample account.
  runNpm(
    ["run", "import:reference:ogun", "--", "--release-dir", "reference/ogun/ogun-identity-2026-08-12", "--apply"],
    testEnv,
  );
  runNpm(["run", "seed"], testEnv);
  runNpm(["run", "verify:reference:ogun:allow-incomplete"], testEnv);
  runNpm(["run", "report:reference:ogun"], testEnv);
  runNpm(["test", "--workspace", "@pics-nigeria/api"], testEnv);
  // The worker suite exercises the derivative pipeline against the same
  // disposable database. It imports the job modules directly and never starts
  // the BullMQ runtime, so it does not require Redis.
  runNpm(["test", "--workspace", "@pics-nigeria/worker"], testEnv);
  console.log("database_integration=ok");
} finally {
  if (baselineShadow) {
    try {
      destroyBaselineShadowDatabase(baselineShadow, testEnv);
    } catch (error) {
      console.error("Integration shadow database cleanup failed:", error);
      process.exitCode = 1;
    }
  }
  if (!useExistingDatabase && process.env.KEEP_TEST_DATABASE !== "1") {
    const result = spawnSync(
      dockerCommand,
      ["compose", "-p", composeProject, "-f", composeFile, "down", "--volumes", "--remove-orphans"],
      { cwd: repoRoot, env: testEnv, stdio: "inherit" },
    );

    if (result.status !== 0) {
      console.error("Integration database cleanup failed; inspect the Docker project manually.");
      process.exitCode = 1;
    }
  }
}
