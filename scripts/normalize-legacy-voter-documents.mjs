/**
 * Tidies rows a previous application image wrote during a rollback window.
 *
 * Migration 20260906180000 drops the voter-document CHECK constraints so the
 * previous image stays a valid rollback target. That image writes the
 * historical shape — `storageProvider = 'PRIVATE_OBJECT_STORAGE_STUB'`, no
 * bucket, no receipt time — and if a rollback happens and is later rolled
 * forward, rows in that shape exist having been created *after* the migration
 * that was supposed to have retired it.
 *
 * Those rows are already handled correctly at read time: the access route
 * judges custody completeness rather than a provider label, so nothing
 * incomplete is ever served. This is housekeeping, not a safety control. It
 * relabels them to match what the migration established, so the two populations
 * read the same way in the audit trail and in any later contract migration.
 *
 * It recovers nothing. There are no bytes: the old image never uploaded any.
 * The record continues to describe a document that does not exist, and the
 * member still has to resubmit.
 *
 * The one rewrite it performs is the one migration 20260906120000 already
 * established as correct, on exactly the same input:
 *
 *   PRIVATE_OBJECT_STORAGE_STUB + NULL bucket + NULL serverReceivedAt
 *     -> UNSTORED_LEGACY_STUB
 *
 * It will not touch any other provider. An unfamiliar value means history this
 * script was not written for, and deciding what it meant is not a decision a
 * maintenance script should make about someone's identity-document record.
 *
 *   node scripts/normalize-legacy-voter-documents.mjs           # report only
 *   node scripts/normalize-legacy-voter-documents.mjs --apply   # relabel
 *
 * Idempotent: a second run finds nothing to do. Content-blind: no file name,
 * hash, storage key or document body is read or printed.
 */
import { PrismaClient } from "@prisma/client";

const HISTORICAL_PROVIDER = "PRIVATE_OBJECT_STORAGE_STUB";
const NORMALIZED_PROVIDER = "UNSTORED_LEGACY_STUB";

const apply = process.argv.includes("--apply");
const prisma = new PrismaClient();

async function main() {
  /**
   * Only rows that are both the historical provider *and* incomplete. A row
   * with that provider but a recorded bucket would be something else entirely,
   * and is left alone rather than assumed.
   */
  const target = {
    storageProvider: HISTORICAL_PROVIDER,
    storageBucket: null,
    serverReceivedAt: null,
  };

  const eligible = await prisma.voterVerificationDocument.count({ where: target });

  const strandedWithProvider = await prisma.voterVerificationDocument.count({
    where: { storageProvider: HISTORICAL_PROVIDER, NOT: { AND: [{ storageBucket: null }, { serverReceivedAt: null }] } },
  });

  const otherIncomplete = await prisma.voterVerificationDocument.groupBy({
    by: ["storageProvider"],
    where: {
      OR: [{ storageBucket: null }, { serverReceivedAt: null }],
      storageProvider: { notIn: [HISTORICAL_PROVIDER, NORMALIZED_PROVIDER] },
    },
    _count: { _all: true },
  });

  console.log(`legacy_stub_rows_eligible=${eligible}`);
  console.log(`already_normalized=${await prisma.voterVerificationDocument.count({ where: { storageProvider: NORMALIZED_PROVIDER } })}`);

  if (strandedWithProvider > 0) {
    console.log(
      `unchanged_historical_provider_with_partial_custody=${strandedWithProvider} (not relabelled: the shape is not the one the migration established)`,
    );
  }

  for (const row of otherIncomplete) {
    console.log(
      `unchanged_unexpected_provider=${JSON.stringify(row.storageProvider)} rows=${row._count._all} (not reinterpreted)`,
    );
  }

  if (!apply) {
    console.log("mode=report_only (pass --apply to relabel)");
    console.log("legacy_voter_document_normalization=ok");
    return;
  }

  if (eligible === 0) {
    console.log("relabelled=0");
    console.log("legacy_voter_document_normalization=ok");
    return;
  }

  const result = await prisma.voterVerificationDocument.updateMany({
    where: target,
    data: { storageProvider: NORMALIZED_PROVIDER },
  });
  console.log(`relabelled=${result.count}`);
  console.log("note=no document bytes were recovered; these records still describe documents that were never stored");
  console.log("legacy_voter_document_normalization=ok");
}

main()
  .catch((error) => {
    console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    console.error("legacy_voter_document_normalization=failed");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
