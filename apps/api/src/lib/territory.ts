import { OGUN_STATE_ID, type CandidateOfficeType, type TerritoryScope } from "@pics-nigeria/shared";
import { prisma } from "../prisma";

export type TerritoryValidationInput = TerritoryScope;

export function toScopeFilter(scope: TerritoryScope) {
  const filter: Record<string, string> = {};

  if (scope.geoPoliticalZoneId) {
    filter.geoPoliticalZoneId = scope.geoPoliticalZoneId;
  }

  if (scope.stateId) {
    filter.stateId = scope.stateId;
  }

  if (scope.senatorialDistrictId) {
    filter.senatorialDistrictId = scope.senatorialDistrictId;
  }

  if (scope.federalConstituencyId) {
    filter.federalConstituencyId = scope.federalConstituencyId;
  }

  if (scope.lgaId) {
    filter.lgaId = scope.lgaId;
  }

  if (scope.wardId) {
    filter.wardId = scope.wardId;
  }

  if (scope.stateConstituencyId) {
    filter.stateConstituencyId = scope.stateConstituencyId;
  }

  if (scope.pollingUnitId) {
    filter.pollingUnitId = scope.pollingUnitId;
  }

  return filter;
}

/**
 * The geo-political zone Ogun belongs to, resolved from reference data rather
 * than hard-coded, and cached because it cannot change.
 */
let ogunZoneId: string | null | undefined;

async function getOgunZoneId(): Promise<string | null> {
  if (ogunZoneId === undefined) {
    const ogun = await prisma.state.findUnique({
      where: { id: OGUN_STATE_ID },
      select: { geoPoliticalZoneId: true },
    });
    ogunZoneId = ogun?.geoPoliticalZoneId ?? null;
  }
  return ogunZoneId;
}

/**
 * Feature 001: Ogun State and the territory beneath it, and nothing else.
 *
 * This is the one place a territory becomes legitimate, so it is where the
 * restriction belongs. The checks below already require every descendant to
 * belong to the named state, so pinning the state to Ogun makes the whole
 * hierarchy transitively Ogun's — a Lagos ward cannot be smuggled in under an
 * Ogun state id, and an Ogun ward cannot be attached to a Lagos state id.
 *
 * The national reference set still exists for reporting and INEC alignment
 * (feature 004). What it no longer does is describe somewhere an operator, a
 * candidate or a member can be placed.
 */
export async function validateTerritoryReferences(input: TerritoryValidationInput): Promise<string | null> {
  if (input.stateId && input.stateId !== OGUN_STATE_ID) {
    return "This platform operates in Ogun State only. Select a territory within Ogun State.";
  }

  if (input.geoPoliticalZoneId) {
    const ogunZone = await getOgunZoneId();
    if (ogunZone && input.geoPoliticalZoneId !== ogunZone) {
      return "This platform operates in Ogun State only. Select a territory within Ogun State.";
    }
  }

  if (input.geoPoliticalZoneId) {
    const zone = await prisma.geoPoliticalZone.findUnique({
      where: { id: input.geoPoliticalZoneId },
      select: { id: true },
    });

    if (!zone) {
      return "Selected geo-political zone does not exist.";
    }
  }

  if (input.stateId) {
    const state = await prisma.state.findUnique({
      where: { id: input.stateId },
      select: { id: true, geoPoliticalZoneId: true },
    });

    if (!state) {
      return "Selected state does not exist.";
    }

    if (input.geoPoliticalZoneId && state.geoPoliticalZoneId !== input.geoPoliticalZoneId) {
      return "Selected state does not belong to the selected geo-political zone.";
    }
  }

  if (input.senatorialDistrictId) {
    const district = await prisma.senatorialDistrict.findUnique({
      where: { id: input.senatorialDistrictId },
      select: { stateId: true },
    });

    if (!district || district.stateId !== input.stateId) {
      return "Selected senatorial district does not belong to the selected state.";
    }
  }

  if (input.federalConstituencyId) {
    const federalConstituency = await prisma.federalConstituency.findUnique({
      where: { id: input.federalConstituencyId },
      select: { stateId: true, senatorialDistrictId: true },
    });

    if (!federalConstituency || federalConstituency.stateId !== input.stateId) {
      return "Selected federal constituency does not belong to the selected state.";
    }

    if (input.senatorialDistrictId && federalConstituency.senatorialDistrictId !== input.senatorialDistrictId) {
      return "Selected federal constituency does not belong to the selected senatorial district.";
    }
  }

  if (input.lgaId) {
    const lga = await prisma.lGA.findUnique({
      where: { id: input.lgaId },
      select: { stateId: true },
    });

    if (!lga || lga.stateId !== input.stateId) {
      return "Selected LGA does not belong to the selected state.";
    }
  }

  if (input.wardId) {
    const ward = await prisma.ward.findUnique({
      where: { id: input.wardId },
      select: { stateId: true, lgaId: true },
    });

    if (!ward || ward.stateId !== input.stateId || (input.lgaId && ward.lgaId !== input.lgaId)) {
      return "Selected ward does not belong to the selected state and LGA.";
    }
  }

  if (input.stateConstituencyId) {
    const stateConstituency = await prisma.stateConstituency.findUnique({
      where: { id: input.stateConstituencyId },
      select: { stateId: true, lgaId: true },
    });

    if (!stateConstituency || stateConstituency.stateId !== input.stateId) {
      return "Selected state constituency does not belong to the selected state.";
    }

    if (input.lgaId && stateConstituency.lgaId !== input.lgaId) {
      return "Selected state constituency does not belong to the selected LGA.";
    }
  }

  if (input.pollingUnitId) {
    const pollingUnit = await prisma.pollingUnit.findUnique({
      where: { id: input.pollingUnitId },
      select: { stateId: true, lgaId: true, wardId: true },
    });

    if (!pollingUnit || pollingUnit.stateId !== input.stateId) {
      return "Selected polling unit does not belong to the selected state.";
    }

    if (input.lgaId && pollingUnit.lgaId !== input.lgaId) {
      return "Selected polling unit does not belong to the selected LGA.";
    }

    if (input.wardId && pollingUnit.wardId !== input.wardId) {
      return "Selected polling unit does not belong to the selected ward.";
    }
  }

  return null;
}

export function validateCandidateOfficeTerritory(
  officeType: CandidateOfficeType,
  input: TerritoryScope,
): string | null {
  const hasLowerThanState = Boolean(
    input.senatorialDistrictId ||
    input.federalConstituencyId ||
    input.lgaId ||
    input.wardId ||
    input.stateConstituencyId ||
    input.pollingUnitId,
  );

  if (officeType === "PRESIDENTIAL") {
    return input.geoPoliticalZoneId ||
      input.stateId ||
      input.senatorialDistrictId ||
      input.federalConstituencyId ||
      input.lgaId ||
      input.wardId ||
      input.stateConstituencyId ||
      input.pollingUnitId
      ? "PRESIDENTIAL candidate must not include lower territory ids."
      : null;
  }

  if (officeType === "GOVERNORSHIP" && input.geoPoliticalZoneId && !input.stateId) {
    return "GOVERNORSHIP candidate requires stateId, not only geo-political zone.";
  }

  if (officeType === "GOVERNORSHIP" && !input.stateId) {
    return "GOVERNORSHIP candidate requires stateId.";
  }

  if (officeType === "GOVERNORSHIP" && hasLowerThanState) {
    return "GOVERNORSHIP candidate must not include lower territory ids.";
  }

  if (officeType === "SENATE" && (!input.stateId || !input.senatorialDistrictId)) {
    return "SENATE candidate requires stateId and senatorialDistrictId.";
  }

  if (officeType === "SENATE" && (input.federalConstituencyId || input.lgaId || input.wardId || input.stateConstituencyId || input.pollingUnitId)) {
    return "SENATE candidate must not include lower territory ids.";
  }

  if (officeType === "HOUSE_OF_REP" && (!input.stateId || !input.federalConstituencyId)) {
    return "HOUSE_OF_REP candidate requires stateId and federalConstituencyId.";
  }

  if (officeType === "HOUSE_OF_REP" && (input.lgaId || input.wardId || input.stateConstituencyId || input.pollingUnitId)) {
    return "HOUSE_OF_REP candidate must not include lower territory ids.";
  }

  if (officeType === "STATE_ASSEMBLY" && (!input.stateId || !input.stateConstituencyId)) {
    return "STATE_ASSEMBLY candidate requires stateId and stateConstituencyId.";
  }

  if (officeType === "STATE_ASSEMBLY" && (input.lgaId || input.wardId || input.pollingUnitId)) {
    return "STATE_ASSEMBLY candidate must not include lower territory ids.";
  }

  if (officeType === "CHAIRMANSHIP" && (!input.stateId || !input.lgaId)) {
    return "CHAIRMANSHIP candidate requires stateId and lgaId.";
  }

  if (officeType === "CHAIRMANSHIP" && (input.wardId || input.pollingUnitId)) {
    return "CHAIRMANSHIP candidate must not include lower territory ids.";
  }

  if (officeType === "COUNCILLOR" && (!input.stateId || !input.lgaId || !input.wardId)) {
    return "COUNCILLOR candidate requires stateId, lgaId, and wardId.";
  }

  if (officeType === "COUNCILLOR" && input.pollingUnitId) {
    return "COUNCILLOR candidate must not include lower territory ids.";
  }

  return null;
}
