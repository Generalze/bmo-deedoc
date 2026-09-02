import type { Prisma } from "@prisma/client";

/**
 * The one definition of "which members are in this territory".
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
 * So there is one helper, and both consumers call it.
 */

/**
 * A ward's State Constituency edge may be used for constituency-level reporting
 * when it was sourced, or when a human has since reviewed the inference.
 *
 * 55 of the 236 ward edges in the Ogun identity release were inferred rather
 * than sourced. Registration already refuses to build ancestry on an unreviewed
 * one, and the backfill refuses to repair such a member. Counting that member at
 * State/Federal/Senatorial Constituency level anyway would have the read path
 * assert exactly what the write path declined to: that we know which
 * constituency they are in.
 */
export const OPERATIONAL_WARD_EDGE: Prisma.WardWhereInput = {
  OR: [{ stateConstituencyEdgeInferred: false }, { stateConstituencyEdgeReviewedAt: { not: null } }],
};

export type MemberTerritoryLevel =
  | "STATE"
  | "SENATORIAL_DISTRICT"
  | "FEDERAL_CONSTITUENCY"
  | "STATE_CONSTITUENCY"
  | "WARD"
  | "POLLING_UNIT";

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
  level: MemberTerritoryLevel,
  territoryId: string,
): Prisma.VoterProfileWhereInput {
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
        ward: {
          is: {
            ...OPERATIONAL_WARD_EDGE,
            stateConstituency: { is: { federalConstituencyId: territoryId } },
          },
        },
      };
    case "STATE_CONSTITUENCY":
      return {
        ward: {
          is: {
            ...OPERATIONAL_WARD_EDGE,
            stateConstituencyId: territoryId,
          },
        },
      };
    case "WARD":
      return { wardId: territoryId };
    case "POLLING_UNIT":
      return { pollingUnitId: territoryId };
  }
}

/**
 * Identifies the scope semantics a strength snapshot was calculated under.
 *
 * Snapshots outlive the code that produced them, and the dashboard prefers a
 * snapshot over its own live count. Without this, a snapshot calculated by the
 * old denormalised scope — scoring 0 because the columns were null — would keep
 * overriding a correct live count indefinitely, and the backfill would not
 * dislodge it. Snapshots that do not carry this version are ignored rather than
 * rewritten: they are a record of what was calculated at the time, and editing
 * them would be a lie about the past.
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
