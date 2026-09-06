/**
 * Read-only preflight for the voter-document storage migration.
 *
 * Migration 20260906120000 normalizes historical rows by an exact string —
 * every VoterVerificationDocument whose `storageProvider` is
 * 'PRIVATE_OBJECT_STORAGE_STUB' becomes 'UNSTORED_LEGACY_STUB' — and then adds
 * constraints that assume the normalization covered everything.
 *
 * That assumption is true of the code that wrote those rows: all three write
 * sites used the stub literal. It is not enforced by the schema, so it is not
 * true by construction. A row carrying any other provider with a NULL bucket
 * would survive the UPDATE and then fail the constraint, and the migration
 * would abort partway through a deployment.
 *
 * This proves the assumption against the actual target database before Prisma
 * runs, while the schema is still the pre-migration one.
 *
 * It deliberately does not fix anything. An unexpected provider means the
 * database contains history this migration was not written for, and guessing
 * what it meant — folding it into "legacy stub" — would assign a meaning to
 * someone's identity-document record that nobody established. It fails the
 * deployment and says what it found.
 *
 *   node scripts/preflight-voter-document-migration.mjs
 *
 * Exit 0: safe to migrate. Exit 1: do not migrate.
 *
 * No document content, file name, hash or storage key is read or printed. Only
 * provider values and counts.
 */
import { PrismaClient } from "@prisma/client";

const MIGRATION = "20260906120000_voter_document_private_storage";
const HISTORICAL_PROVIDER = "PRIVATE_OBJECT_STORAGE_STUB";
/** Written by the migration itself, so it is expected on a re-run. */
const NORMALIZED_PROVIDER = "UNSTORED_LEGACY_STUB";

const prisma = new PrismaClient();

function fail(message) {
  console.error(`FAIL ${message}`);
  console.error("voter_document_migration_preflight=failed");
  process.exitCode = 1;
}

async function main() {
  /**
   * Whether the migration has already run decides what "expected" means. Before
   * it, only the historical provider may exist. After it, the normalized value
   * is expected too, and the real providers of genuinely stored documents.
   */
  const applied = await prisma.$queryRaw`
    SELECT 1 FROM "_prisma_migrations"
    WHERE migration_name = ${MIGRATION} AND finished_at IS NOT NULL
    LIMIT 1
  `.catch(() => []);
  const alreadyApplied = Array.isArray(applied) && applied.length > 0;

  /**
   * PREFLIGHT_FORCE_PRE_MIGRATION re-runs the historical check against a
   * database where the migration has already applied. It can only make this
   * stricter — there is no path by which it lets a failing database through —
   * and it exists so the rehearsal can exercise the pre-migration branch.
   */
  if (alreadyApplied && !process.env.PREFLIGHT_FORCE_PRE_MIGRATION) {
    console.log(`voter_document_migration_state=already_applied migration=${MIGRATION}`);
    console.log("voter_document_migration_preflight=ok");
    return;
  }

  // The table may not exist yet on a fresh database. That is a pass: there is
  // no history to be incompatible with.
  const tableExists = await prisma.$queryRaw`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'VoterVerificationDocument'
    LIMIT 1
  `.catch(() => []);
  if (!Array.isArray(tableExists) || tableExists.length === 0) {
    console.log("voter_document_rows=0 (table not present)");
    console.log("voter_document_migration_preflight=ok");
    return;
  }

  const rows = await prisma.$queryRaw`
    SELECT "storageProvider" AS provider, COUNT(*)::int AS count
    FROM "VoterVerificationDocument"
    GROUP BY "storageProvider"
    ORDER BY "storageProvider"
  `;

  const counts = new Map(rows.map((row) => [row.provider, Number(row.count)]));
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  const known = (counts.get(HISTORICAL_PROVIDER) || 0) + (counts.get(NORMALIZED_PROVIDER) || 0);
  const unexpected = [...counts.entries()].filter(
    ([provider]) => provider !== HISTORICAL_PROVIDER && provider !== NORMALIZED_PROVIDER,
  );
  const unexpectedRows = unexpected.reduce((sum, [, count]) => sum + count, 0);

  console.log(`voter_document_rows=${total}`);
  console.log(`voter_document_known_stub_rows=${known}`);
  console.log(`voter_document_unexpected_rows=${unexpectedRows}`);

  if (total === 0) {
    console.log("voter_document_migration_preflight=ok");
    return;
  }

  if (unexpected.length > 0) {
    // Provider values only. They are configuration strings the server wrote,
    // never anything belonging to the member.
    for (const [provider, count] of unexpected) {
      console.error(`  unexpected provider ${JSON.stringify(provider)} on ${count} row(s)`);
    }
    fail(
      `${unexpectedRows} VoterVerificationDocument row(s) carry a provider that ${MIGRATION} does not normalize. ` +
        "That migration rewrites only 'PRIVATE_OBJECT_STORAGE_STUB' and then adds constraints assuming nothing else " +
        "was left behind, so it would abort partway through the deployment. These rows describe history this " +
        "migration was not written for; decide what they mean before migrating rather than letting a rewrite decide " +
        "for them.",
    );
    return;
  }

  console.log("voter_document_migration_preflight=ok");
}

main()
  .catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  })
  .finally(() => prisma.$disconnect());
