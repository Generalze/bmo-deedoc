import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { OGUN_STATE_ID } from "@pics-nigeria/shared";

import { createAuditLog } from "../lib/audit";
import { isWardConstituencyEdgeOperational } from "../lib/member-territory-scope";

/** Either the pooled client or a transaction, so reads can happen under the lock. */
type DecisionClient = Pick<typeof prisma, "wardConstituencyEdgeReview" | "voterProfile" | "coordinatorProfile">;
import { requireAuth, requireRole } from "../middleware/auth";
import { prisma } from "../prisma";

/**
 * Governance for inferred Ward -> State Constituency edges.
 *
 * The Ogun identity release resolved 55 of 236 ward edges by inference rather
 * than from an authoritative source. Member ancestry refuses to build on one
 * until a human confirms it, which is correct and also left those wards with no
 * way out: nothing in the product could record that a person had looked.
 *
 * This is that surface, and deliberately nothing more. It records a judgement
 * about one edge at a time. It does not correct the mapping — a wrong edge is a
 * reference-data problem, and the importer owns `Ward.stateConstituencyId`. It
 * does not touch coordinators. There is no bulk decision, because approving 55
 * inferences in one click is indistinguishable from not reviewing them.
 */

const router = Router();

const decisionSchema = z.object({
  /**
   * The constituency the reviewer was actually looking at. Required, and
   * compared against the ward's current edge before the decision is recorded:
   * if a release re-points the ward between the screen loading and the reviewer
   * pressing the button, the judgement was about a mapping that no longer
   * exists.
   */
  stateConstituencyId: z.string().trim().min(1),
  reason: z.string().trim().min(10).max(2000),
});

const listQuerySchema = z.object({
  state: z.enum(["ALL", "PENDING", "APPROVED", "REJECTED"]).optional(),
});

type ReviewState = "PENDING" | "APPROVED" | "REJECTED";

const wardSelection = {
  id: true,
  name: true,
  stateId: true,
  lgaId: true,
  stateConstituencyId: true,
  stateConstituencyEdgeInferred: true,
  stateConstituencyEdgeInferenceBasis: true,
  stateConstituencyEdgeApprovedForId: true,
  stateConstituencyEdgeReviewedAt: true,
  stateConstituencyEdgeReviewedBy: true,
  sourceCode: true,
  sourceCodeNamespace: true,
  sourceNameAliases: true,
  referenceImportReleaseId: true,
  lga: { select: { id: true, name: true, sourceCode: true } },
  stateConstituency: {
    select: {
      id: true,
      name: true,
      sourceCode: true,
      sourceCodeNamespace: true,
      federalConstituency: {
        select: { id: true, name: true, senatorialDistrict: { select: { id: true, name: true } } },
      },
    },
  },
} as const;

type GovernedWard = Awaited<ReturnType<typeof loadWard>>;

async function loadWard(wardId: string) {
  return prisma.ward.findUnique({ where: { id: wardId }, select: wardSelection });
}

/**
 * What a decision was *about*.
 *
 * A judgement is only current if it was made about the thing being looked at
 * now: this ward, this constituency, from this release, on this inference. A
 * ward moved from A to B and later back to A is not still approved because the
 * name matches — the evidence in between changed, and the reviewer never saw
 * that. Binding the subject this way is what stops an old approval reappearing
 * as the current verdict and quietly dropping the edge out of the queue.
 */
type ReviewSubject = {
  id: string;
  stateConstituencyId: string | null;
  referenceImportReleaseId: string | null;
  stateConstituencyEdgeInferenceBasis: string | null;
};

async function currentDecisionFor(ward: ReviewSubject, client: DecisionClient = prisma) {
  if (!ward.stateConstituencyId) return null;
  return client.wardConstituencyEdgeReview.findFirst({
    where: {
      wardId: ward.id,
      stateConstituencyId: ward.stateConstituencyId,
      referenceReleaseId: ward.referenceImportReleaseId,
      inferenceBasis: ward.stateConstituencyEdgeInferenceBasis,
    },
    // `decidedAt` is assigned under the row lock and forced to advance, so it
    // orders decisions; `id` only breaks a tie that cannot occur, so that the
    // query is deterministic rather than merely usually right.
    orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      outcome: true,
      reason: true,
      decidedAt: true,
      stateConstituencyId: true,
      inferenceBasis: true,
      referenceReleaseId: true,
      reviewer: { select: { id: true, name: true, email: true } },
    },
  });
}

/**
 * An edge is APPROVED only while the projection still says so.
 *
 * A historical approval whose projection the importer has since cleared is
 * history, not the current state — reporting it as APPROVED would hide a ward
 * that is actually blocked from the queue of things needing a decision, which
 * is the dead end this whole surface exists to remove.
 */
function reviewStateOf(
  ward: {
    stateConstituencyId: string | null;
    stateConstituencyEdgeInferred: boolean;
    stateConstituencyEdgeApprovedForId: string | null;
  },
  decision: { outcome: "APPROVED" | "REJECTED" } | null,
): ReviewState {
  if (!ward.stateConstituencyEdgeInferred) return "APPROVED";
  if (isWardConstituencyEdgeOperational(ward)) return "APPROVED";
  if (decision?.outcome === "REJECTED") return "REJECTED";
  return "PENDING";
}

/**
 * Impact is recomputed on every read.
 *
 * The counts stored on a decision record what the reviewer was shown at the
 * time; these are what is true now. Showing a stale number to someone about to
 * make an irreversible-feeling judgement would be worse than showing none.
 */
async function impactOf(ward: { id: string; stateConstituencyId: string | null }, client: DecisionClient = prisma) {
  const [members, coordinators] = await Promise.all([
    client.voterProfile.count({ where: { wardId: ward.id } }),
    client.coordinatorProfile.count({
      where: ward.stateConstituencyId
        ? { OR: [{ wardId: ward.id }, { stateConstituencyId: ward.stateConstituencyId }] }
        : { wardId: ward.id },
    }),
  ]);
  return { members, coordinators };
}

/**
 * What the release says about this ward, presented as evidence rather than as a
 * conclusion. Where a source carries nothing for a ward, that absence is stated
 * instead of being filled in — a reviewer needs to know the difference between
 * "the sources agree" and "only one source spoke".
 */
function sourceEvidenceOf(ward: NonNullable<GovernedWard>) {
  const workbookAliases = ward.sourceNameAliases.filter((alias) => alias && alias !== ward.name);
  return {
    inecDelimitation: ward.sourceCode
      ? { namespace: ward.sourceCodeNamespace, code: ward.sourceCode, name: ward.name }
      : null,
    constituencyWorkbook:
      workbookAliases.length > 0
        ? { aliases: workbookAliases }
        : null,
    constituencySourceCode: ward.stateConstituency?.sourceCode
      ? { namespace: ward.stateConstituency.sourceCodeNamespace, code: ward.stateConstituency.sourceCode }
      : null,
    note:
      workbookAliases.length > 0
        ? "The workbook and the delimitation API name this ward differently; the inference reconciled them."
        : "No differing workbook spelling is recorded for this ward. The inference did not rest on a name match.",
  };
}

async function serializeWard(ward: NonNullable<GovernedWard>) {
  const [decision, impact] = await Promise.all([currentDecisionFor(ward), impactOf(ward)]);
  return {
    wardId: ward.id,
    wardName: ward.name,
    lga: ward.lga,
    stateConstituency: ward.stateConstituency
      ? {
          id: ward.stateConstituency.id,
          name: ward.stateConstituency.name,
          federalConstituency: ward.stateConstituency.federalConstituency
            ? {
                id: ward.stateConstituency.federalConstituency.id,
                name: ward.stateConstituency.federalConstituency.name,
                senatorialDistrict: ward.stateConstituency.federalConstituency.senatorialDistrict,
              }
            : null,
        }
      : null,
    inferred: ward.stateConstituencyEdgeInferred,
    inferenceBasis: ward.stateConstituencyEdgeInferenceBasis,
    referenceReleaseId: ward.referenceImportReleaseId,
    reviewState: reviewStateOf(ward, decision),
    operational: isWardConstituencyEdgeOperational(ward),
    decision: decision
      ? {
          outcome: decision.outcome,
          reason: decision.reason,
          decidedAt: decision.decidedAt.toISOString(),
          stateConstituencyId: decision.stateConstituencyId,
          reviewer: decision.reviewer,
        }
      : null,
    impact,
    sourceEvidence: sourceEvidenceOf(ward),
  };
}

/** Every inferred edge in Ogun, decided or not. */
router.get("/inferred-edges", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const parsed = listQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid inferred edge query.", errors: parsed.error.flatten() });
  }

  const wards = await prisma.ward.findMany({
    where: { stateId: OGUN_STATE_ID, stateConstituencyEdgeInferred: true },
    orderBy: [{ lgaId: "asc" }, { name: "asc" }],
    select: wardSelection,
  });

  const serialized = await Promise.all(wards.map((ward) => serializeWard(ward)));
  const wanted = parsed.data.state && parsed.data.state !== "ALL" ? parsed.data.state : null;
  const edges = wanted ? serialized.filter((edge) => edge.reviewState === wanted) : serialized;

  return response.json({
    edges,
    summary: {
      total: serialized.length,
      pending: serialized.filter((edge) => edge.reviewState === "PENDING").length,
      approved: serialized.filter((edge) => edge.reviewState === "APPROVED").length,
      rejected: serialized.filter((edge) => edge.reviewState === "REJECTED").length,
      operational: serialized.filter((edge) => edge.operational).length,
    },
  });
});

router.get("/inferred-edges/:wardId", requireAuth, requireRole("SUPER_ADMIN"), async (request, response) => {
  const wardId = Array.isArray(request.params.wardId) ? request.params.wardId[0] : request.params.wardId;
  const ward = await loadWard(wardId);
  if (!ward || ward.stateId !== OGUN_STATE_ID) {
    return response.status(404).json({ message: "Ward not found." });
  }

  const history = await prisma.wardConstituencyEdgeReview.findMany({
    where: { wardId: ward.id },
    orderBy: { decidedAt: "desc" },
    select: {
      id: true,
      outcome: true,
      reason: true,
      decidedAt: true,
      stateConstituencyId: true,
      inferenceBasis: true,
      affectedMemberCount: true,
      affectedCoordinatorCount: true,
      reviewer: { select: { id: true, name: true, email: true } },
    },
  });

  return response.json({
    edge: await serializeWard(ward),
    /** Every decision ever taken on this ward, including ones about edges it no longer has. */
    history: history.map((entry) => ({ ...entry, decidedAt: entry.decidedAt.toISOString() })),
  });
});

/** A refusal the route turns into a status code, raised from inside the lock. */
class GovernanceRefusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.message === "string" ? body.message : "Governance decision refused.");
    this.name = "GovernanceRefusal";
  }
}

type LockedWard = {
  id: string;
  stateId: string;
  lgaId: string;
  stateConstituencyId: string | null;
  stateConstituencyEdgeInferred: boolean;
  stateConstituencyEdgeInferenceBasis: string | null;
  stateConstituencyEdgeApprovedForId: string | null;
  referenceImportReleaseId: string | null;
};

async function decide(request: Request, response: Response, outcome: "APPROVED" | "REJECTED") {
  const parsed = decisionSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ message: "Invalid governance decision.", errors: parsed.error.flatten() });
  }

  const wardId = Array.isArray(request.params.wardId) ? request.params.wardId[0] : request.params.wardId;
  const actorUserId = request.authUser!.id;

  try {
    const review = await prisma.$transaction(async (transaction) => {
      /**
       * Everything authoritative happens against a locked row.
       *
       * Reading the ward before the transaction and trusting it inside was a
       * check-then-act: an import re-pointing the edge in between would leave
       * an approval naming a constituency the ward no longer has — and the
       * scope filters, which can only test that column for null, would have
       * counted every member on the ward into a constituency nobody reviewed.
       * The lock removes the window; the CHECK constraint removes the state.
       */
      const locked = await transaction.$queryRaw<LockedWard[]>`
        SELECT "id",
               "stateId",
               "lgaId",
               "stateConstituencyId",
               "stateConstituencyEdgeInferred",
               "stateConstituencyEdgeInferenceBasis",
               "stateConstituencyEdgeApprovedForId",
               "referenceImportReleaseId"
          FROM "Ward"
         WHERE "id" = ${wardId}
           FOR UPDATE`;

      const ward = locked[0];
      if (!ward || ward.stateId !== OGUN_STATE_ID) {
        throw new GovernanceRefusal(404, { message: "Ward not found." });
      }

      if (!ward.stateConstituencyEdgeInferred) {
        throw new GovernanceRefusal(400, {
          message: "This ward's State Constituency edge came from the source and needs no review.",
          code: "EDGE_NOT_INFERRED",
        });
      }

      /**
       * The reviewer judged a specific mapping. If the ward now points
       * somewhere else, that judgement cannot be transferred to the new edge
       * without someone having looked at it, so the submission is refused
       * rather than reinterpreted. Checked against the locked row, so an
       * import that lands first is seen here rather than after the write.
       */
      if (ward.stateConstituencyId !== parsed.data.stateConstituencyId) {
        throw new GovernanceRefusal(409, {
          message:
            "This ward's State Constituency changed since the review was opened. Reload and review the current edge.",
          code: "EDGE_CHANGED_RELOAD",
          reviewedStateConstituencyId: parsed.data.stateConstituencyId,
          currentStateConstituencyId: ward.stateConstituencyId,
        });
      }

      const impact = await impactOf(ward, transaction);
      const previous = await currentDecisionFor(ward, transaction);

      /**
       * Decision time is taken after the lock, and forced past the previous
       * decision on this subject. Two reviewers deciding at once serialize
       * here, and "newest" is then a fact rather than a race between two
       * `new Date()` calls that may not differ.
       */
      const now = new Date();
      const decidedAt =
        previous && previous.decidedAt >= now ? new Date(previous.decidedAt.getTime() + 1) : now;

      const created = await transaction.wardConstituencyEdgeReview.create({
        data: {
          wardId: ward.id,
          stateConstituencyId: parsed.data.stateConstituencyId,
          outcome,
          reason: parsed.data.reason,
          inferenceBasis: ward.stateConstituencyEdgeInferenceBasis,
          referenceReleaseId: ward.referenceImportReleaseId,
          reviewerUserId: actorUserId,
          decidedAt,
          affectedMemberCount: impact.members,
          affectedCoordinatorCount: impact.coordinators,
        },
      });

      /**
       * Only an approval moves the projection the scope filters read. A
       * rejection records the judgement and stamps the display columns, and
       * the ward stays blocked — which is why nothing anywhere may treat a
       * review timestamp as permission.
       */
      await transaction.ward.update({
        where: { id: ward.id },
        data: {
          stateConstituencyEdgeApprovedForId: outcome === "APPROVED" ? parsed.data.stateConstituencyId : null,
          stateConstituencyEdgeReviewedAt: decidedAt,
          stateConstituencyEdgeReviewedBy: actorUserId,
        },
      });

      await createAuditLog(transaction, {
        actorUserId,
        action: outcome === "APPROVED" ? "WARD_EDGE_REVIEW_APPROVED" : "WARD_EDGE_REVIEW_REJECTED",
        targetType: "WARD_CONSTITUENCY_EDGE",
        targetId: `${ward.id}:${parsed.data.stateConstituencyId}`,
        metadata: {
          reviewId: created.id,
          outcome,
          reason: parsed.data.reason,
          inferenceBasis: ward.stateConstituencyEdgeInferenceBasis,
          referenceReleaseId: ward.referenceImportReleaseId,
          affectedMemberCount: impact.members,
          affectedCoordinatorCount: impact.coordinators,
          previousReviewState: reviewStateOf(ward, previous),
        },
        territory: {
          stateId: ward.stateId,
          lgaId: ward.lgaId,
          wardId: ward.id,
          stateConstituencyId: parsed.data.stateConstituencyId,
        },
      });

      return created;
    });

    const refreshed = await loadWard(wardId);
    return response.status(201).json({
      message:
        outcome === "APPROVED"
          ? "Edge approved. Member ancestry may now be derived through it."
          : "Edge rejected and recorded. The ward remains blocked until the reference data is corrected.",
      reviewId: review.id,
      edge: await serializeWard(refreshed!),
    });
  } catch (error) {
    if (error instanceof GovernanceRefusal) {
      // The transaction has already rolled back, so no review and no audit
      // entry exists for a decision that was not taken.
      return response.status(error.status).json(error.body);
    }
    throw error;
  }
}

router.post("/inferred-edges/:wardId/approve", requireAuth, requireRole("SUPER_ADMIN"), (request, response) =>
  decide(request, response, "APPROVED"),
);

router.post("/inferred-edges/:wardId/reject", requireAuth, requireRole("SUPER_ADMIN"), (request, response) =>
  decide(request, response, "REJECTED"),
);

export default router;
