import type { Prisma } from "@prisma/client";

/**
 * The one definition of "which members are in this territory", and of which
 * ward-to-constituency edges may be used to answer that.
 *
 * There used to be two. The command dashboard filtered `VoterProfile` by its own
 * nullable `senatorialDistrictId` / `federalConstituencyId` /
 * `stateConstituencyId` columns, and the pre-election strength engine did the
 * same thing separately. Both were reading values the client used to supply and
 * that were, in practice, null — so every member registered through the product
 * was invisible at three of the six levels. Fixing one and not the other would
 * have left the dashboard's own tile disagreeing with the strength score printed
 * beside it.
 *
 * So there is one module, and every member-territory surface calls it.
 */

/**
 * A ward's State Constituency edge may be used for constituency-level reporting
 * when it was sourced, or when a human has since reviewed the inference.
 *
 * 55 of the 236 ward edges in the Ogun identity release were inferred rather
 * than sourced. Registration already refuses to build ancestry on an unreviewed
 * one, and the backfill refuses to repair such a member. Counting anything
 * through that edge at constituency level would have the read path assert
 * exactly what the write path declined to: that we know which constituency this
 * belongs to.
 */
export const OPERATIONAL_WARD_EDGE: Prisma.WardWhereInput = {
  OR: [{ stateConstituencyEdgeInferred: false }, { stateConstituencyEdgeReviewedAt: { not: null } }],
};

export const MEMBER_TERRITORY_LEVELS = [
  "STATE",
  "SENATORIAL_DISTRICT",
  "FEDERAL_CONSTITUENCY",
  "STATE_CONSTITUENCY",
  "WARD",
  "POLLING_UNIT",
] as const;

export type MemberTerritoryLevel = (typeof MEMBER_TERRITORY_LEVELS)[number];

/**
 * Refusing to answer, rather than answering "everywhere".
 *
 * These helpers build the `where` of a count that decides what an operator
 * sees. Returning `undefined` for a level outside the union would reach Prisma
 * as `count({ where: undefined })` — every member in the database — so an
 * unrecognised territory type must raise rather than fall through. The previous
 * hand-written scopes ended in a `return { pollingUnitId }` fallback, which
 * under-counted; that is a milder wrong answer than counting everything, and
 * neither is acceptable from a scoping authority.
 */
export class UnsupportedMemberTerritoryType extends Error {
  constructor(readonly territoryType: string) {
    super(
      `Unsupported member territory type '${territoryType}'. Territory scope must be one of: ${MEMBER_TERRITORY_LEVELS.join(", ")}.`,
    );
    this.name = "UnsupportedMemberTerritoryType";
  }
}

function assertMemberTerritoryLevel(level: string): asserts level is MemberTerritoryLevel {
  if (!(MEMBER_TERRITORY_LEVELS as readonly string[]).includes(level)) {
    throw new UnsupportedMemberTerritoryType(level);
  }
}

/**
 * Scopes members by walking the canonical territory graph from their ward,
 * rather than by reading the denormalised ancestry columns.
 *
 * The three constituency levels additionally require the ward's edge to be
 * operational. The other three deliberately do not: a member's State, Ward and
 * Polling Unit are known independently of the disputed ward-to-constituency
 * edge, so excluding them there would hide a member whose location is not in
 * question at all.
 */
export function buildOperationalVoterProfileTerritoryWhere(
  level: MemberTerritoryLevel | string,
  territoryId: string,
): Prisma.VoterProfileWhereInput {
  assertMemberTerritoryLevel(level);
  switch (level) {
    case "STATE":
      return { stateId: territoryId };
    case "SENATORIAL_DISTRICT":
      return {
        ward: {
          is: {
            ...OPERATIONAL_WARD_EDGE,
            stateConstituency: { is: { federalConstituency: { is: { senatorialDistrictId: territoryId } } } },
          },
        },
      };
    case "FEDERAL_CONSTITUENCY":
      return {
        ward: { is: { ...OPERATIONAL_WARD_EDGE, stateConstituency: { is: { federalConstituencyId: territoryId } } } },
      };
    case "STATE_CONSTITUENCY":
      return { ward: { is: { ...OPERATIONAL_WARD_EDGE, stateConstituencyId: territoryId } } };
    case "WARD":
      return { wardId: territoryId };
    case "POLLING_UNIT":
      return { pollingUnitId: territoryId };
  }
}

/**
 * The same rule for polling units.
 *
 * A dashboard that excluded a ward's members from a constituency while counting
 * that ward's polling units into it produced impossible tiles — "Registered
 * members: 0, Polling Units: 111" — and, because the derived strength score
 * divides one by the other, a non-zero strength for a constituency the system
 * will not place a single member in. Both halves of that score now answer to the
 * same predicate.
 */
export function buildOperationalPollingUnitTerritoryWhere(
  level: MemberTerritoryLevel | string,
  territoryId: string,
): Prisma.PollingUnitWhereInput {
  assertMemberTerritoryLevel(level);
  switch (level) {
    case "STATE":
      return { stateId: territoryId };
    case "SENATORIAL_DISTRICT":
      return {
        ward: {
          is: {
            ...OPERATIONAL_WARD_EDGE,
            stateConstituency: { is: { federalConstituency: { is: { senatorialDistrictId: territoryId } } } },
          },
        },
      };
    case "FEDERAL_CONSTITUENCY":
      return {
        ward: { is: { ...OPERATIONAL_WARD_EDGE, stateConstituency: { is: { federalConstituencyId: territoryId } } } },
      };
    case "STATE_CONSTITUENCY":
      return { ward: { is: { ...OPERATIONAL_WARD_EDGE, stateConstituencyId: territoryId } } };
    case "WARD":
      return { wardId: territoryId };
    case "POLLING_UNIT":
      return { id: territoryId };
  }
}

/**
 * Identifies the scope semantics a strength snapshot was calculated under.
 *
 * Snapshots outlive the code that produced them, and every strength surface
 * prefers a stored snapshot over a live calculation. Without this, a snapshot
 * calculated by the old denormalised scope — scoring 0 because the columns were
 * null — would keep overriding a correct live count indefinitely, and the
 * backfill would not dislodge it. Snapshots that do not carry this version are
 * ignored rather than rewritten: they are a record of what was calculated at the
 * time, and editing them would be a lie about the past.
 */
export const MEMBER_TERRITORY_SCOPE_VERSION = "WARD_GRAPH_REVIEWED_V1";

/** Reads the scope version out of a snapshot's stored breakdown JSON. */
export function snapshotScopeVersion(breakdown: unknown): string | null {
  if (!breakdown || typeof breakdown !== "object" || Array.isArray(breakdown)) {
    return null;
  }
  const value = (breakdown as Record<string, unknown>).memberTerritoryScopeVersion;
  return typeof value === "string" ? value : null;
}

/**
 * Whether a snapshot may influence the current picture of a territory.
 *
 * One rule, used by every consumer. Patching each read site with its own JSON
 * test is how the dashboard came to reject obsolete snapshots while the
 * pre-election surfaces still displayed them, printing two different scores for
 * the same territory at the same moment.
 */
export function isCurrentMemberTerritorySnapshot(snapshot: { breakdownJson?: unknown } | null | undefined): boolean {
  if (!snapshot) return false;
  return snapshotScopeVersion(snapshot.breakdownJson) === MEMBER_TERRITORY_SCOPE_VERSION;
}

/**
 * Narrows a newest-first snapshot list to the ones calculated under current
 * semantics, preserving order.
 *
 * Trend must be computed from this list rather than from the raw one. Comparing
 * the first correct score against a pre-version zero reports `IMPROVING` for
 * what is only a change in how the number is calculated — a fictional
 * improvement that would be read as campaign progress.
 */
export function selectCurrentMemberTerritorySnapshots<T extends { breakdownJson?: unknown }>(
  snapshots: readonly T[],
  limit?: number,
): T[] {
  const compatible = snapshots.filter((snapshot) => isCurrentMemberTerritorySnapshot(snapshot));
  return typeof limit === "number" ? compatible.slice(0, limit) : compatible;
}

/**
 * How many rows to read before filtering.
 *
 * Compatible snapshots are newest-first, but obsolete ones can sit on top of
 * them, so a `take: 2` would find nothing. This is deliberately generous and
 * still bounded; if every one of these is obsolete the surface falls back to a
 * live calculation, which is the correct answer anyway.
 */
export const SNAPSHOT_COMPATIBILITY_SCAN_LIMIT = 20;
