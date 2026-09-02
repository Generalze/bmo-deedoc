import type { CoordinatorLevel, PrismaClient } from "@prisma/client";
import {
  OGUN_STATE_ID,
  type AuthUserProfile,
  type OperationalTerritory,
  type Phase1AuthAction,
} from "@pics-nigeria/shared";

export type ResolvedOperationalTerritory = {
  stateId: string;
  senatorialDistrictId: string | null;
  federalConstituencyId: string | null;
  stateConstituencyId: string | null;
  wardId: string | null;
  pollingUnitId: string | null;
};

export class TerritoryAuthorizationError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_TERRITORY" | "INCOMPLETE_COMMAND_HIERARCHY" | "OUTSIDE_OGUN",
  ) {
    super(message);
  }
}

const coordinatorLevelRank: Record<CoordinatorLevel, number> = {
  SENATORIAL_DISTRICT: 5,
  FEDERAL_CONSTITUENCY: 4,
  STATE_CONSTITUENCY: 3,
  WARD: 2,
  POLLING_UNIT: 1,
};

function claimParent(
  resolved: ResolvedOperationalTerritory,
  key: Exclude<keyof ResolvedOperationalTerritory, "stateId">,
  value: string,
  label: string,
) {
  const existing = resolved[key];
  if (existing && existing !== value) {
    throw new TerritoryAuthorizationError(`${label} does not match the locked command hierarchy.`, "INVALID_TERRITORY");
  }
  resolved[key] = value;
}

/**
 * The delegates the territory walk actually touches.
 *
 * Structural rather than `PrismaClient` so the same walk runs inside a
 * transaction — member registration derives ancestry and writes the profile in
 * one transaction, and it must read the graph through that transaction rather
 * than around it.
 */
export type TerritoryGraphClient = Pick<
  PrismaClient,
  "pollingUnit" | "ward" | "stateConstituency" | "federalConstituency" | "senatorialDistrict" | "state"
>;

export async function resolveOperationalTerritory(
  database: TerritoryGraphClient,
  input: OperationalTerritory,
): Promise<ResolvedOperationalTerritory> {
  if (input.stateId !== OGUN_STATE_ID) {
    throw new TerritoryAuthorizationError("Operational authorization is restricted to Ogun State.", "OUTSIDE_OGUN");
  }

  const resolved: ResolvedOperationalTerritory = {
    stateId: input.stateId,
    senatorialDistrictId: input.senatorialDistrictId || null,
    federalConstituencyId: input.federalConstituencyId || null,
    stateConstituencyId: input.stateConstituencyId || null,
    wardId: input.wardId || null,
    pollingUnitId: input.pollingUnitId || null,
  };

  if (resolved.pollingUnitId) {
    const pollingUnit = await database.pollingUnit.findUnique({
      where: { id: resolved.pollingUnitId },
      select: { stateId: true, wardId: true },
    });
    if (!pollingUnit || pollingUnit.stateId !== OGUN_STATE_ID) {
      throw new TerritoryAuthorizationError("Polling Unit is not a canonical Ogun record.", "INVALID_TERRITORY");
    }
    claimParent(resolved, "wardId", pollingUnit.wardId, "Polling Unit parent Ward");
  }

  if (resolved.wardId) {
    const ward = await database.ward.findUnique({
      where: { id: resolved.wardId },
      select: { stateId: true, stateConstituencyId: true },
    });
    if (!ward || ward.stateId !== OGUN_STATE_ID) {
      throw new TerritoryAuthorizationError("Ward is not a canonical Ogun record.", "INVALID_TERRITORY");
    }
    if (!ward.stateConstituencyId) {
      throw new TerritoryAuthorizationError(
        "Ward has no approved State Constituency command parent.",
        "INCOMPLETE_COMMAND_HIERARCHY",
      );
    }
    claimParent(resolved, "stateConstituencyId", ward.stateConstituencyId, "Ward parent State Constituency");
  }

  if (resolved.stateConstituencyId) {
    const stateConstituency = await database.stateConstituency.findUnique({
      where: { id: resolved.stateConstituencyId },
      select: { stateId: true, federalConstituencyId: true },
    });
    if (!stateConstituency || stateConstituency.stateId !== OGUN_STATE_ID) {
      throw new TerritoryAuthorizationError("State Constituency is not a canonical Ogun record.", "INVALID_TERRITORY");
    }
    if (!stateConstituency.federalConstituencyId) {
      throw new TerritoryAuthorizationError(
        "State Constituency has no approved Federal Constituency command parent.",
        "INCOMPLETE_COMMAND_HIERARCHY",
      );
    }
    claimParent(
      resolved,
      "federalConstituencyId",
      stateConstituency.federalConstituencyId,
      "State Constituency parent Federal Constituency",
    );
  }

  if (resolved.federalConstituencyId) {
    const federalConstituency = await database.federalConstituency.findUnique({
      where: { id: resolved.federalConstituencyId },
      select: { stateId: true, senatorialDistrictId: true },
    });
    if (!federalConstituency || federalConstituency.stateId !== OGUN_STATE_ID) {
      throw new TerritoryAuthorizationError("Federal Constituency is not a canonical Ogun record.", "INVALID_TERRITORY");
    }
    claimParent(
      resolved,
      "senatorialDistrictId",
      federalConstituency.senatorialDistrictId,
      "Federal Constituency parent Senatorial District",
    );
  }

  if (resolved.senatorialDistrictId) {
    const senatorialDistrict = await database.senatorialDistrict.findUnique({
      where: { id: resolved.senatorialDistrictId },
      select: { stateId: true },
    });
    if (!senatorialDistrict || senatorialDistrict.stateId !== OGUN_STATE_ID) {
      throw new TerritoryAuthorizationError("Senatorial District is not a canonical Ogun record.", "INVALID_TERRITORY");
    }
  }

  const stateExists = await database.state.count({ where: { id: OGUN_STATE_ID } });
  if (stateExists !== 1) {
    throw new TerritoryAuthorizationError("Canonical Ogun State reference is unavailable.", "INVALID_TERRITORY");
  }

  return resolved;
}

function hasInput(input: OperationalTerritory, keys: Array<keyof OperationalTerritory>) {
  return keys.some((key) => Boolean(input[key]));
}

export async function validateCoordinatorAssignment(
  database: PrismaClient,
  level: CoordinatorLevel,
  input: OperationalTerritory,
) {
  const resolved = await resolveOperationalTerritory(database, input);
  const invalidDepth =
    (level === "SENATORIAL_DISTRICT" &&
      hasInput(input, ["federalConstituencyId", "stateConstituencyId", "wardId", "pollingUnitId"])) ||
    (level === "FEDERAL_CONSTITUENCY" && hasInput(input, ["stateConstituencyId", "wardId", "pollingUnitId"])) ||
    (level === "STATE_CONSTITUENCY" && hasInput(input, ["wardId", "pollingUnitId"])) ||
    (level === "WARD" && hasInput(input, ["pollingUnitId"]));

  const requiredId = {
    SENATORIAL_DISTRICT: resolved.senatorialDistrictId,
    FEDERAL_CONSTITUENCY: resolved.federalConstituencyId,
    STATE_CONSTITUENCY: resolved.stateConstituencyId,
    WARD: resolved.wardId,
    POLLING_UNIT: resolved.pollingUnitId,
  }[level];

  if (!requiredId || invalidDepth) {
    throw new TerritoryAuthorizationError(
      `Territory does not define exactly one ${level} coordinator scope.`,
      "INVALID_TERRITORY",
    );
  }

  return {
    level,
    stateId: resolved.stateId,
    senatorialDistrictId: resolved.senatorialDistrictId,
    federalConstituencyId: level === "SENATORIAL_DISTRICT" ? null : resolved.federalConstituencyId,
    stateConstituencyId:
      level === "SENATORIAL_DISTRICT" || level === "FEDERAL_CONSTITUENCY"
        ? null
        : resolved.stateConstituencyId,
    wardId: level === "WARD" || level === "POLLING_UNIT" ? resolved.wardId : null,
    pollingUnitId: level === "POLLING_UNIT" ? resolved.pollingUnitId : null,
  };
}

export function isTerritoryDescendant(
  coordinator: NonNullable<AuthUserProfile["coordinatorProfile"]>,
  resource: ResolvedOperationalTerritory,
) {
  if (coordinator.stateId !== OGUN_STATE_ID || resource.stateId !== OGUN_STATE_ID) {
    return false;
  }

  const keyByLevel: Record<CoordinatorLevel, keyof ResolvedOperationalTerritory> = {
    SENATORIAL_DISTRICT: "senatorialDistrictId",
    FEDERAL_CONSTITUENCY: "federalConstituencyId",
    STATE_CONSTITUENCY: "stateConstituencyId",
    WARD: "wardId",
    POLLING_UNIT: "pollingUnitId",
  };
  const key = keyByLevel[coordinator.level];
  return Boolean(coordinator[key]) && coordinator[key] === resource[key];
}

export function authorizeAction(
  actor: AuthUserProfile,
  action: Phase1AuthAction,
  resource: ResolvedOperationalTerritory,
) {
  if (!actor.isActive || actor.accountStatus !== "ACTIVE" || resource.stateId !== OGUN_STATE_ID) {
    return false;
  }
  if (actor.role === "SUPER_ADMIN") {
    return true;
  }
  if (actor.role === "STATE_OFFICER") {
    return true;
  }
  if (actor.role !== "COORDINATOR" || !actor.coordinatorProfile) {
    return false;
  }

  return (
    action === "VIEW_TERRITORY" ||
    action === "MANAGE_USERS" ||
    action === "ASSIGN_TERRITORY" ||
    action === "MANAGE_CANDIDATES"
  ) && isTerritoryDescendant(actor.coordinatorProfile, resource);
}

export function canManageTargetUser(
  actor: AuthUserProfile,
  target: AuthUserProfile,
  targetTerritory: ResolvedOperationalTerritory | null,
) {
  if (actor.id === target.id || !actor.isActive || actor.accountStatus !== "ACTIVE") {
    return false;
  }
  if (target.role === "SUPER_ADMIN" || target.role === "STATE_OFFICER") {
    return false;
  }
  if (target.role === "VALIDATOR" || target.role === "PAYOUT_OFFICER") {
    return actor.role === "SUPER_ADMIN";
  }
  if (actor.role === "SUPER_ADMIN") {
    return true;
  }
  if (actor.role === "STATE_OFFICER") {
    return (
      (target.role === "COORDINATOR" || target.role === "MEMBER") &&
      targetTerritory?.stateId === OGUN_STATE_ID
    );
  }
  if (actor.role !== "COORDINATOR" || !actor.coordinatorProfile || !targetTerritory) {
    return false;
  }
  if (!isTerritoryDescendant(actor.coordinatorProfile, targetTerritory)) {
    return false;
  }
  if (target.role === "MEMBER") {
    return true;
  }
  return (
    target.role === "COORDINATOR" &&
    Boolean(target.coordinatorProfile) &&
    coordinatorLevelRank[actor.coordinatorProfile.level] > coordinatorLevelRank[target.coordinatorProfile!.level]
  );
}

export function canAssignTerritory(
  actor: AuthUserProfile,
  target: AuthUserProfile,
  currentTerritory: ResolvedOperationalTerritory,
  proposedTerritory: ResolvedOperationalTerritory,
  proposedLevel: CoordinatorLevel,
) {
  if (target.role !== "COORDINATOR" || !canManageTargetUser(actor, target, currentTerritory)) {
    return false;
  }
  if (actor.role === "SUPER_ADMIN" || actor.role === "STATE_OFFICER") {
    return proposedTerritory.stateId === OGUN_STATE_ID;
  }
  if (actor.role !== "COORDINATOR" || !actor.coordinatorProfile) {
    return false;
  }
  return (
    coordinatorLevelRank[actor.coordinatorProfile.level] > coordinatorLevelRank[proposedLevel] &&
    isTerritoryDescendant(actor.coordinatorProfile, proposedTerritory)
  );
}

export function canCreateCoordinator(
  actor: AuthUserProfile,
  proposedTerritory: ResolvedOperationalTerritory,
  proposedLevel: CoordinatorLevel,
) {
  if (!actor.isActive || actor.accountStatus !== "ACTIVE" || proposedTerritory.stateId !== OGUN_STATE_ID) {
    return false;
  }
  if (actor.role === "SUPER_ADMIN" || actor.role === "STATE_OFFICER") {
    return true;
  }
  if (actor.role !== "COORDINATOR" || !actor.coordinatorProfile) {
    return false;
  }
  return (
    coordinatorLevelRank[actor.coordinatorProfile.level] > coordinatorLevelRank[proposedLevel] &&
    isTerritoryDescendant(actor.coordinatorProfile, proposedTerritory)
  );
}
