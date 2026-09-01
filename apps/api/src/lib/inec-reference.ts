import type { PrismaClient } from "@prisma/client";
import { NIGERIA_GEO_POLITICAL_ZONES, NIGERIA_STATE_REFERENCE } from "@pics-nigeria/shared";

const INEC_BASE_URL = "https://cvr.inecnigeria.org/PublicApi";

type InecOptionMap = Record<string, string>;

const lgaCodeCache = new Map<string, InecOptionMap>();
const wardCodeCache = new Map<string, InecOptionMap>();

function normalizeLabel(value: string): string {
  return value
    .replace(/^\d+\s*-\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function sanitizeInecName(value: string): string {
  return value.replace(/^\d+\s*-\s*/, "").replace(/\s+/g, " ").trim();
}

async function fetchInecOptions(path: "lgas" | "wards" | "pus", params: Record<string, string>): Promise<InecOptionMap> {
  const query = new URLSearchParams(params);
  const response = await fetch(`${INEC_BASE_URL}/${path}/1/Search?${query.toString()}`, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`INEC lookup failed for ${path}.`);
  }

  const payload = (await response.json()) as Array<Record<string, string>>;
  const first = payload[0] || {};
  const options: InecOptionMap = {};

  for (const [key, value] of Object.entries(first)) {
    if (key === "selected" || key === "0") {
      continue;
    }

    options[key] = value;
  }

  return options;
}

async function getLgaOptionsForStateCode(stateCode: string) {
  const cacheKey = stateCode;
  if (!lgaCodeCache.has(cacheKey)) {
    lgaCodeCache.set(cacheKey, await fetchInecOptions("lgas", { "data[Search][state_id]": stateCode }));
  }

  return lgaCodeCache.get(cacheKey)!;
}

async function getWardOptionsForLgaCode(lgaCode: string) {
  const cacheKey = lgaCode;
  if (!wardCodeCache.has(cacheKey)) {
    wardCodeCache.set(cacheKey, await fetchInecOptions("wards", { "data[Search][local_government_id]": lgaCode }));
  }

  return wardCodeCache.get(cacheKey)!;
}

function findStateReferenceByName(name: string) {
  const normalizedName = normalizeLabel(name);
  return NIGERIA_STATE_REFERENCE.find((state) => normalizeLabel(state.name) === normalizedName) || null;
}

export async function ensureNationalReferenceStates(prisma: PrismaClient) {
  const zoneIdByName = new Map<string, string>();

  for (const zone of NIGERIA_GEO_POLITICAL_ZONES) {
    const existingZone = await prisma.geoPoliticalZone.findUnique({
      where: { name: zone.name },
      select: { id: true },
    });

    if (existingZone) {
      zoneIdByName.set(zone.name, existingZone.id);
      continue;
    }

    // Read-then-create is not safe here: this runs from an unauthenticated
    // endpoint that a page can call twice concurrently (a dev double-render is
    // enough), and both callers then create the same id. The loser used to
    // raise P2002 out of an async handler with no catch, which took the whole
    // API process down. Resolve the race by re-reading instead of failing.
    const created = await prisma.geoPoliticalZone
      .create({ data: zone })
      .catch(async (error: unknown) => {
        if (isUniqueViolation(error)) {
          return prisma.geoPoliticalZone.findFirst({
            where: { OR: [{ id: zone.id }, { name: zone.name }] },
            select: { id: true },
          });
        }
        throw error;
      });
    zoneIdByName.set(zone.name, created?.id || zone.id);
  }

  for (const state of NIGERIA_STATE_REFERENCE) {
    const zoneName = NIGERIA_GEO_POLITICAL_ZONES.find((zone) => zone.id === state.geoPoliticalZoneId)?.name;
    const geoPoliticalZoneId = zoneName ? zoneIdByName.get(zoneName) || state.geoPoliticalZoneId : state.geoPoliticalZoneId;
    const existingState = await prisma.state.findUnique({
      where: { name: state.name },
      select: { id: true },
    });

    if (existingState) {
      await prisma.state.update({
        where: { id: existingState.id },
        data: { geoPoliticalZoneId },
      });
      continue;
    }

    await prisma.state
      .create({
        data: {
          id: state.id,
          name: state.name,
          geoPoliticalZoneId,
        },
      })
      // Same race as the zones above: a concurrent caller may have created it
      // between the read and the write. That is the expected outcome, not a
      // failure, so the reference set still ends up complete.
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          return null;
        }
        throw error;
      });
  }
}

/** A Prisma unique-constraint violation, which here means "someone else won the race". */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

export async function syncLgasForState(prisma: PrismaClient, stateId: string) {
  const state = await prisma.state.findUnique({
    where: { id: stateId },
    select: { id: true, name: true },
  });

  if (!state) {
    return;
  }

  const stateReference = findStateReferenceByName(state.name);
  if (!stateReference) {
    return;
  }

  const options = await getLgaOptionsForStateCode(stateReference.inecCode);

  for (const [inecId, label] of Object.entries(options)) {
    const name = sanitizeInecName(label);
    const existing = await prisma.lGA.findFirst({
      where: {
        stateId,
        name,
      },
      select: { id: true },
    });

    if (existing) {
      continue;
    }

    await prisma.lGA.create({
      data: {
        id: `inec-lga-${inecId}`,
        name,
        stateId,
      },
    });
  }
}

async function resolveInecLgaCode(prisma: PrismaClient, stateId: string, lgaId: string) {
  const lga = await prisma.lGA.findUnique({
    where: { id: lgaId },
    include: { state: true },
  });

  if (!lga || lga.stateId !== stateId) {
    return null;
  }

  const stateReference = findStateReferenceByName(lga.state.name);
  if (!stateReference) {
    return null;
  }

  const options = await getLgaOptionsForStateCode(stateReference.inecCode);
  const targetName = normalizeLabel(lga.name);

  for (const [inecId, label] of Object.entries(options)) {
    if (normalizeLabel(label) === targetName) {
      return { inecId, lga };
    }
  }

  return null;
}

export async function syncWardsForLga(prisma: PrismaClient, stateId: string, lgaId: string) {
  const resolved = await resolveInecLgaCode(prisma, stateId, lgaId);
  if (!resolved) {
    return;
  }

  const options = await getWardOptionsForLgaCode(resolved.inecId);

  for (const [inecId, label] of Object.entries(options)) {
    const name = sanitizeInecName(label);
    const existing = await prisma.ward.findFirst({
      where: {
        lgaId,
        name,
      },
      select: { id: true },
    });

    if (existing) {
      continue;
    }

    await prisma.ward.create({
      data: {
        id: `inec-ward-${inecId}`,
        name,
        stateId,
        lgaId,
      },
    });
  }
}

export async function syncPollingUnitsForWard(prisma: PrismaClient, stateId: string, lgaId: string, wardId: string) {
  const resolved = await resolveInecLgaCode(prisma, stateId, lgaId);
  if (!resolved) {
    return;
  }

  const ward = await prisma.ward.findUnique({
    where: { id: wardId },
    select: { id: true, name: true, lgaId: true, stateId: true },
  });

  if (!ward || ward.lgaId !== lgaId || ward.stateId !== stateId) {
    return;
  }

  const wardOptions = await getWardOptionsForLgaCode(resolved.inecId);
  const targetName = normalizeLabel(ward.name);
  let wardCode: string | null = null;

  for (const [inecId, label] of Object.entries(wardOptions)) {
    if (normalizeLabel(label) === targetName) {
      wardCode = inecId;
      break;
    }
  }

  if (!wardCode) {
    return;
  }

  const options = await fetchInecOptions("pus", { "data[Search][registration_area_id]": wardCode });

  for (const [inecId, label] of Object.entries(options)) {
    const name = label.replace(/\s+/g, " ").trim();
    const existing = await prisma.pollingUnit.findFirst({
      where: {
        wardId,
        name,
      },
      select: { id: true },
    });

    if (existing) {
      continue;
    }

    await prisma.pollingUnit.create({
      data: {
        id: `inec-pu-${inecId}`,
        name,
        stateId,
        lgaId,
        wardId,
      },
    });
  }
}
