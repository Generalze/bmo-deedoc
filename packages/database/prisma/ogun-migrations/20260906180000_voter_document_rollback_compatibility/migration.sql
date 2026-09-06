-- Relax the voter-document CHECK constraints for the rollback window.
--
-- Migration 20260906120000 added two CHECK constraints to the already-existing
-- VoterVerificationDocument table. They describe the new storage contract
-- correctly, and they break the deployment rollback contract: a previous
-- application image is still a legitimate rollback target for a while, and it
-- writes the historical document shape —
--
--   storageProvider = 'PRIVATE_OBJECT_STORAGE_STUB', storageBucket NULL,
--   serverReceivedAt NULL
--
-- — which those constraints reject. The rehearsal calls this out as
-- backward-incompatible, and it is right to.
--
-- ADD CONSTRAINT ... NOT VALID does not solve it. NOT VALID skips the check
-- against rows that already exist; it still enforces the constraint on every
-- subsequent write. A rolled-back previous image would therefore still fail at
-- INSERT time. The problem is not the old rows, it is the old writer.
--
-- So this is the expand half of expand/contract: drop the constraints while
-- both images must coexist. Dropping a restrictive CHECK is a relaxation, not a
-- tightening, so it is additive in the sense the rehearsal cares about.
--
-- Nothing else from the previous migration is undone. storageBucket,
-- serverReceivedAt and the normalization it performed all stay.
--
-- The guarantee does not weaken, it moves. The application remains the sole
-- authority for document custody: it generates the key, measures the size,
-- computes the hash, records the bucket and the receipt time, and refuses to
-- serve a document whose custody is incomplete. A database that tolerates the
-- old shape is not a database that produces it.
--
-- A later CONTRACT migration reintroduces strict constraints once the previous
-- image is no longer an allowed rollback target. See docs/DEPLOYMENT_VPS.md.

ALTER TABLE "VoterVerificationDocument"
  DROP CONSTRAINT IF EXISTS "VoterVerificationDocument_storage_provider_check";

ALTER TABLE "VoterVerificationDocument"
  DROP CONSTRAINT IF EXISTS "VoterVerificationDocument_stored_object_complete_check";
