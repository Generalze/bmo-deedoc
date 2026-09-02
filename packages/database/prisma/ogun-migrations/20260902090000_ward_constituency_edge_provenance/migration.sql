-- Ward -> State Constituency edge provenance.
--
-- The Ogun identity release resolves 56 of 236 ward edges by inference rather
-- than from an authoritative source, and records them in INFERRED-EDGES.csv.
-- Once imported those edges were indistinguishable from sourced ones, so
-- nothing could refuse to build member ancestry on an unreviewed guess.
--
-- The inference fact is owned by the import; the review fact is owned by
-- human governance. They are separate columns so re-importing a release can
-- never silently revoke a completed review.

-- AlterTable
ALTER TABLE "Ward" ADD COLUMN     "stateConstituencyEdgeInferred" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stateConstituencyEdgeInferenceBasis" TEXT,
ADD COLUMN     "stateConstituencyEdgeReviewedAt" TIMESTAMP(3),
ADD COLUMN     "stateConstituencyEdgeReviewedBy" TEXT;

-- CreateIndex
CREATE INDEX "Ward_stateConstituencyEdgeInferred_idx" ON "Ward"("stateConstituencyEdgeInferred");
