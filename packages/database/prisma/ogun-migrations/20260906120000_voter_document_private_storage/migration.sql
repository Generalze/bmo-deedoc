-- Voter-registration documents move into real private object storage.
--
-- Before this, VoterVerificationDocument recorded a storage key the client
-- chose, a file size the client stated, and a SHA-256 the client computed, with
-- storageProvider set to the literal 'PRIVATE_OBJECT_STORAGE_STUB'. No bytes
-- were ever uploaded, so the key referred to nothing, and the duplicate-document
-- fraud check compared hashes that the submitting client was free to invent.
--
-- Additive only. Existing rows are preserved and marked, because they describe
-- documents that do not exist: they must not be readable as though they do.

-- The bucket that actually holds the object, recorded alongside the key so a
-- later bucket migration cannot silently orphan a record.
ALTER TABLE "VoterVerificationDocument" ADD COLUMN "storageBucket" TEXT;

-- Server-authoritative fields. serverReceivedAt is when the API took custody of
-- the bytes, which is distinct from an uploadedAt the client could influence.
ALTER TABLE "VoterVerificationDocument" ADD COLUMN "serverReceivedAt" TIMESTAMP(3);

-- Any pre-existing row describes a document that was never stored. Marking them
-- keeps them auditable while making them unmistakable, and the access route
-- refuses them rather than issuing a URL for an object that is not there.
UPDATE "VoterVerificationDocument"
SET "storageProvider" = 'UNSTORED_LEGACY_STUB'
WHERE "storageProvider" = 'PRIVATE_OBJECT_STORAGE_STUB';

-- A document is either stored or explicitly marked as never having been.
-- 'PRIVATE_OBJECT_STORAGE_STUB' must not reappear: it named a provider that
-- stored nothing while reading as though it stored something privately.
ALTER TABLE "VoterVerificationDocument"
  ADD CONSTRAINT "VoterVerificationDocument_storage_provider_check" CHECK (
    "storageProvider" <> 'PRIVATE_OBJECT_STORAGE_STUB'
  );

-- A stored document must name its bucket and its receipt time; an unstored
-- legacy row must not claim either.
ALTER TABLE "VoterVerificationDocument"
  ADD CONSTRAINT "VoterVerificationDocument_stored_object_complete_check" CHECK (
    ("storageProvider" = 'UNSTORED_LEGACY_STUB' AND "storageBucket" IS NULL AND "serverReceivedAt" IS NULL)
    OR ("storageProvider" <> 'UNSTORED_LEGACY_STUB' AND "storageBucket" IS NOT NULL AND "serverReceivedAt" IS NOT NULL)
  );
