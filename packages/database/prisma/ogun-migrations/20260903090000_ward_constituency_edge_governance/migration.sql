-- Human governance for inferred Ward -> State Constituency edges.
--
-- PR #12 made an inferred edge refuse to carry member ancestry until a human
-- reviews it, and then left no way to review one: the only writer of the review
-- columns was a test. 55 of Ogun's 236 wards were therefore closed with no
-- application path out of it.
--
-- A decision is recorded about an *edge*, not a ward. An approval names the
-- exact State Constituency that was reviewed, so it cannot follow the ward if a
-- later release re-points it, and `Ward.stateConstituencyEdgeApprovedForId`
-- carries that same id forward as the projection the scope filters read --
-- cleared by the importer whenever the edge changes, so a non-null value always
-- describes the edge the ward currently has.
--
-- Rejection is recorded and the ward stays blocked. It never writes
-- `Ward.stateConstituencyId`: correcting a wrong mapping is a reference-data
-- action, and the importer owns that column.
--
-- Nothing here approves anything. The 55 edges remain unreviewed after this
-- migration; only a human decision through the governance route can change that.

-- CreateEnum
CREATE TYPE "WardConstituencyEdgeReviewOutcome" AS ENUM ('APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Ward" ADD COLUMN     "stateConstituencyEdgeApprovedForId" TEXT;

-- CreateTable
CREATE TABLE "WardConstituencyEdgeReview" (
    "id" TEXT NOT NULL,
    "wardId" TEXT NOT NULL,
    "stateConstituencyId" TEXT NOT NULL,
    "outcome" "WardConstituencyEdgeReviewOutcome" NOT NULL,
    "reason" TEXT NOT NULL,
    "inferenceBasis" TEXT,
    "referenceReleaseId" TEXT,
    "reviewerUserId" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "affectedMemberCount" INTEGER NOT NULL DEFAULT 0,
    "affectedCoordinatorCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WardConstituencyEdgeReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WardConstituencyEdgeReview_wardId_decidedAt_idx" ON "WardConstituencyEdgeReview"("wardId", "decidedAt");

-- CreateIndex
CREATE INDEX "WardConstituencyEdgeReview_wardId_stateConstituencyId_idx" ON "WardConstituencyEdgeReview"("wardId", "stateConstituencyId");

-- CreateIndex
CREATE INDEX "WardConstituencyEdgeReview_outcome_idx" ON "WardConstituencyEdgeReview"("outcome");

-- CreateIndex
CREATE INDEX "Ward_stateConstituencyEdgeApprovedForId_idx" ON "Ward"("stateConstituencyEdgeApprovedForId");

-- AddForeignKey
ALTER TABLE "WardConstituencyEdgeReview" ADD CONSTRAINT "WardConstituencyEdgeReview_wardId_fkey" FOREIGN KEY ("wardId") REFERENCES "Ward"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WardConstituencyEdgeReview" ADD CONSTRAINT "WardConstituencyEdgeReview_reviewerUserId_fkey" FOREIGN KEY ("reviewerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- The projection cannot describe an edge the ward does not have.
--
-- `stateConstituencyEdgeApprovedForId` is what every bulk scope filter reads,
-- because Prisma cannot compare two columns of a row inside a relation filter.
-- That only equals the real rule -- "approved for the edge this ward currently
-- has" -- while the two stay in step, and application code kept in step by
-- argument is application code that drifts under concurrency. So the database
-- refuses the divergence instead.
--
-- Written with the inferred and non-null tests spelled out rather than as the
-- shorter `approvedForId IS NULL OR approvedForId = stateConstituencyId`: a
-- CHECK admits a row whose predicate evaluates to NULL, so with a NULL
-- `stateConstituencyId` the short form would accept exactly the state it exists
-- to forbid. An approval also has no meaning on a sourced edge, so carrying one
-- there is refused too.
ALTER TABLE "Ward" ADD CONSTRAINT "Ward_edge_approval_matches_current_edge_check" CHECK (
  "stateConstituencyEdgeApprovedForId" IS NULL
  OR (
    "stateConstituencyEdgeInferred" = TRUE
    AND "stateConstituencyId" IS NOT NULL
    AND "stateConstituencyEdgeApprovedForId" = "stateConstituencyId"
  )
);
