import { OGUN_STATE_ID } from "@pics-nigeria/shared";

import { isWardConstituencyEdgeOperational } from "./member-territory-scope";

import {
  resolveOperationalTerritory,
  TerritoryAuthorizationError,
  type TerritoryGraphClient,
} from "../authorization";

/**
 * Feature 059-065, 077: where a member sits in the constituency hierarchy.
 *
 * The client selects the territory it can legitimately see on a form — State,
 * LGA, Ward, Polling Unit. It has no business naming a Senatorial District, a
 * Federal Constituency or a State Constituency, because it cannot be held to
 * them: those are properties of the reference graph, not of the registration.
 * Before this module the public registration endpoint accepted all three as
 * optional request fields and stored whatever arrived, defaulting to null, so
 * every member registered through the product was invisible at three of the six
 * dashboard levels and a caller could have placed itself in someone else's
 * constituency by typing one.
 *
 * The server derives them instead, from the ward it has already validated.
 */

export const MEMBER_ANCESTRY_ERROR_CODES = [
  "ANCESTRY_OUTSIDE_OGUN",
  "ANCESTRY_INVALID_TERRITORY",
  "ANCESTRY_INCOMPLETE",
  "ANCESTRY_EDGE_UNREVIEWED",
] as const;

export type MemberAncestryErrorCode = (typeof MEMBER_ANCESTRY_ERROR_CODES)[number];

export class MemberAncestryError extends Error {
  constructor(
    message: string,
    readonly code: MemberAncestryErrorCode,
  ) {
    super(message);
    this.name = "MemberAncestryError";
  }
}

/** The territory a registration may legitimately assert. */
export type MemberAncestryInput = {
  stateId: string;
  lgaId: string;
  wardId: string;
  pollingUnitId: string;
};

/** The full chain, every level resolved and none of it caller-supplied. */
export type MemberAncestry = {
  stateId: string;
  senatorialDistrictId: string;
  federalConstituencyId: string;
  stateConstituencyId: string;
  lgaId: string;
  wardId: string;
  pollingUnitId: string;
};

/**
 * Derives State -> Senatorial District -> Federal Constituency -> State
 * Constituency -> Ward -> Polling Unit from the canonical Ogun graph.
 *
 * Throws rather than returning a partial result, so a caller inside a
 * transaction rolls the whole registration back instead of writing a profile
 * with half an ancestry. There is no fallback to caller-supplied values and no
 * substitution of a plausible parent: an ancestry that cannot be proved is an
 * error, not a null column.
 */
export async function deriveMemberAncestryFromWard(
  client: TerritoryGraphClient,
  input: MemberAncestryInput,
): Promise<MemberAncestry> {
  if (input.stateId !== OGUN_STATE_ID) {
    throw new MemberAncestryError(
      "This platform operates in Ogun State only. Select a territory within Ogun State.",
      "ANCESTRY_OUTSIDE_OGUN",
    );
  }

  const ward = await client.ward.findUnique({
    where: { id: input.wardId },
    select: {
      id: true,
      stateId: true,
      lgaId: true,
      stateConstituencyId: true,
      stateConstituencyEdgeInferred: true,
      stateConstituencyEdgeApprovedForId: true,
      lga: { select: { stateId: true } },
    },
  });

  if (!ward) {
    throw new MemberAncestryError("Selected ward does not exist.", "ANCESTRY_INVALID_TERRITORY");
  }

  if (ward.lgaId !== input.lgaId) {
    throw new MemberAncestryError("Ward does not belong to the selected LGA.", "ANCESTRY_INVALID_TERRITORY");
  }

  if (ward.stateId !== OGUN_STATE_ID || ward.lga.stateId !== OGUN_STATE_ID) {
    throw new MemberAncestryError("Territory selection is inconsistent.", "ANCESTRY_INVALID_TERRITORY");
  }

  const pollingUnit = await client.pollingUnit.findUnique({
    where: { id: input.pollingUnitId },
    select: { id: true, stateId: true, lgaId: true, wardId: true, ward: { select: { lgaId: true } } },
  });

  if (!pollingUnit) {
    throw new MemberAncestryError("Selected polling unit does not exist.", "ANCESTRY_INVALID_TERRITORY");
  }

  /**
   * A polling unit from a neighbouring ward would otherwise derive that ward's
   * constituency chain and quietly file the member in the wrong constituency.
   */
  if (
    pollingUnit.wardId !== input.wardId ||
    pollingUnit.lgaId !== input.lgaId ||
    pollingUnit.stateId !== OGUN_STATE_ID ||
    pollingUnit.ward.lgaId !== input.lgaId
  ) {
    throw new MemberAncestryError(
      "Polling unit does not belong to the selected ward.",
      "ANCESTRY_INVALID_TERRITORY",
    );
  }

  /**
   * 56 of the 236 ward edges in the Ogun identity release were resolved by
   * inference — name-token overlap, or the structural fact that a ward in a
   * single-constituency LGA can only belong to that constituency — and are
   * recorded in the release's INFERRED-EDGES.csv. Loading one into the database
   * did not make it true. Until a human confirms the edge, a member registered
   * on such a ward would be filed into a constituency nobody has stood behind,
   * and the record would be indistinguishable from a sourced one afterwards.
   *
   * So this fails closed. Refusing a registration is recoverable; a wrongly
   * filed member who looks correctly filed is not.
   */
  if (!isWardConstituencyEdgeOperational(ward)) {
    throw new MemberAncestryError(
      "This ward's State Constituency mapping is still awaiting review and cannot yet be used for registration. Contact the platform administrator.",
      "ANCESTRY_EDGE_UNREVIEWED",
    );
  }

  /**
   * The graph walk itself is the one in `authorization.ts` that already governs
   * operator scope. Only the ward and polling unit are handed to it — no higher
   * id is passed in, so there is nothing for a caller to have influenced and
   * every constituency in the result was read from the graph.
   */
  let resolved;
  try {
    resolved = await resolveOperationalTerritory(client, {
      stateId: OGUN_STATE_ID,
      wardId: input.wardId,
      pollingUnitId: input.pollingUnitId,
    });
  } catch (error) {
    if (error instanceof TerritoryAuthorizationError) {
      throw new MemberAncestryError(
        error.message,
        error.code === "INCOMPLETE_COMMAND_HIERARCHY"
          ? "ANCESTRY_INCOMPLETE"
          : error.code === "OUTSIDE_OGUN"
            ? "ANCESTRY_OUTSIDE_OGUN"
            : "ANCESTRY_INVALID_TERRITORY",
      );
    }
    throw error;
  }

  /**
   * The walk already refuses a missing State or Federal Constituency parent, so
   * reaching here with a null is not expected. It is still checked, because the
   * alternative to an explicit failure is a profile written with a null column
   * that later reads as "not in any constituency" rather than as a bug.
   */
  if (!resolved.stateConstituencyId || !resolved.federalConstituencyId || !resolved.senatorialDistrictId) {
    throw new MemberAncestryError(
      "Ward does not resolve to a complete constituency hierarchy.",
      "ANCESTRY_INCOMPLETE",
    );
  }

  return {
    stateId: OGUN_STATE_ID,
    senatorialDistrictId: resolved.senatorialDistrictId,
    federalConstituencyId: resolved.federalConstituencyId,
    stateConstituencyId: resolved.stateConstituencyId,
    lgaId: input.lgaId,
    wardId: input.wardId,
    pollingUnitId: input.pollingUnitId,
  };
}
