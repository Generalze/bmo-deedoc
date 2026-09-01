import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import {
  OGUN_IDENTITY_REQUIRED_COUNTS,
  OGUN_REFERENCE_IMPORT_CONTRACT_VERSION,
  OGUN_REFERENCE_TERRITORY_KINDS,
  OGUN_STATE_ID,
  type OgunReferenceReleaseManifest,
  type OgunReferenceTerritoryKind,
} from "@pics-nigeria/shared";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

type CsvRow = Record<string, string>;
type ValidationResult<T> = { value: T | null; failures: string[] };
type TerritoryRow = {
  kind: OgunReferenceTerritoryKind;
  canonicalId: string;
  stateId: string;
  name: string;
  sourceCodeNamespace: string;
  sourceCode: string;
  aliases: string[];
  lgaId: string | null;
  federalConstituencyId: string | null;
  stateConstituencyId: string | null;
  wardId: string | null;
};
type CommandRelationshipRow = {
  parentKind: string;
  parentId: string;
  childKind: string;
  childId: string;
};
type LgaMembershipRow = {
  territoryKind: string;
  territoryId: string;
  lgaId: string;
};
type PollingUnitGeodataRow = {
  pollingUnitId: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  captureMethod: string;
  capturedAt: Date;
  source: string;
  geofenceRadiusMeters: number;
};

const args = process.argv.slice(2);
const releaseDirArg = readArg("--release-dir") || readArg("--dir");
const apply = args.includes("--apply");
const validateOnly = args.includes("--validate-only") || !apply;
let prisma: PrismaClient | null = null;

function getPrisma() {
  prisma ??= new PrismaClient();
  return prisma;
}

function readArg(name: string) {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  return args[index + 1] || null;
}

function sha256(filePath: string) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function requireText(row: CsvRow, key: string) {
  return (row[key] || "").trim();
}

function optionalText(row: CsvRow, key: string) {
  const value = requireText(row, key);
  return value ? value : null;
}

function parseCsv(content: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(field.trim());
      field = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(field.trim());
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      field = "";
      continue;
    }
    field += char;
  }

  row.push(field.trim());
  if (row.some((cell) => cell.length > 0)) {
    rows.push(row);
  }

  const [headers, ...dataRows] = rows;
  if (!headers) {
    return [];
  }

  return dataRows.map((dataRow) => {
    const item: CsvRow = {};
    headers.forEach((header, index) => {
      item[header] = dataRow[index] || "";
    });
    return item;
  });
}

function readCsv(filePath: string) {
  return parseCsv(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function resolveReleaseFile(releaseDir: string, filePath: string) {
  const resolved = path.resolve(releaseDir, filePath);
  const relative = path.relative(releaseDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Release file escapes release directory: ${filePath}`);
  }
  return resolved;
}

function parseJson<T>(filePath: string): ValidationResult<T> {
  try {
    return { value: JSON.parse(readFileSync(filePath, "utf8")) as T, failures: [] };
  } catch (error) {
    return { value: null, failures: [`Could not parse JSON ${filePath}: ${(error as Error).message}`] };
  }
}

function assertDate(value: string | null | undefined, label: string, failures: string[]) {
  if (!value || Number.isNaN(Date.parse(value))) {
    failures.push(`${label} must be an ISO-8601 date/time.`);
    return null;
  }
  return new Date(value);
}

function assertCanonicalId(value: string, label: string, failures: string[]) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    failures.push(`${label} '${value}' must be lowercase ASCII kebab-case.`);
  }
}

function assertSha(filePath: string, expectedHash: string | undefined, label: string, failures: string[]) {
  if (!expectedHash) {
    failures.push(`${label} sha256 is required in manifest.`);
    return;
  }
  if (!existsSync(filePath)) {
    failures.push(`${label} is missing at ${filePath}.`);
    return;
  }
  const actual = sha256(filePath);
  if (actual !== expectedHash) {
    failures.push(`${label} sha256 mismatch: expected ${expectedHash}; found ${actual}.`);
  }
}

export function validateManifest(releaseDir: string): ValidationResult<{ manifest: OgunReferenceReleaseManifest; manifestPath: string }> {
  const manifestPath = path.join(releaseDir, "manifest.json");
  const parsed = parseJson<OgunReferenceReleaseManifest>(manifestPath);
  const failures = [...parsed.failures];
  const manifest = parsed.value;

  if (!manifest) {
    return { value: null, failures };
  }
  if (manifest.contractVersion !== OGUN_REFERENCE_IMPORT_CONTRACT_VERSION) {
    failures.push(`manifest.contractVersion must be ${OGUN_REFERENCE_IMPORT_CONTRACT_VERSION}.`);
  }
  if (!manifest.releaseId?.trim()) {
    failures.push("manifest.releaseId is required.");
  } else {
    assertCanonicalId(manifest.releaseId, "manifest.releaseId", failures);
  }
  if (manifest.stateId !== OGUN_STATE_ID) {
    failures.push(`manifest.stateId must be ${OGUN_STATE_ID}.`);
  }
  if (!["OGUN_IDENTITY", "OGUN_POLLING_UNIT_GEODATA"].includes(manifest.kind)) {
    failures.push("manifest.kind must be OGUN_IDENTITY or OGUN_POLLING_UNIT_GEODATA.");
  }
  if (!manifest.publisher?.trim()) {
    failures.push("manifest.publisher is required.");
  }
  if (!manifest.approvedBy?.trim()) {
    failures.push("manifest.approvedBy is required.");
  }
  assertDate(manifest.retrievedAt, "manifest.retrievedAt", failures);
  assertDate(manifest.approvedAt, "manifest.approvedAt", failures);
  if (!Array.isArray(manifest.sourceCodeNamespaces) || manifest.sourceCodeNamespaces.length === 0) {
    failures.push("manifest.sourceCodeNamespaces must list at least one namespace.");
  }

  if (manifest.kind === "OGUN_IDENTITY") {
    if (!manifest.files.territories || !manifest.files.commandRelationships || !manifest.files.lgaMemberships) {
      failures.push("Identity releases require territories, commandRelationships, and lgaMemberships files.");
    }
    if (manifest.declaredCounts.stateConstituencies !== OGUN_IDENTITY_REQUIRED_COUNTS.stateConstituencies) {
      failures.push(`Identity release must declare ${OGUN_IDENTITY_REQUIRED_COUNTS.stateConstituencies} State Constituencies.`);
    }
    if (manifest.declaredCounts.lgas !== OGUN_IDENTITY_REQUIRED_COUNTS.lgas) {
      failures.push(`Identity release must declare ${OGUN_IDENTITY_REQUIRED_COUNTS.lgas} LGAs.`);
    }
    if (!manifest.declaredCounts.wards || manifest.declaredCounts.wards < 1) {
      failures.push("Identity release must declare a positive Ward count from the approved source.");
    }
    if (!manifest.declaredCounts.pollingUnits || manifest.declaredCounts.pollingUnits < 1) {
      failures.push("Identity release must declare a positive Polling Unit count from the approved source.");
    }
  }

  if (manifest.kind === "OGUN_POLLING_UNIT_GEODATA" && !manifest.files.pollingUnitGeodata) {
    failures.push("Polling Unit geodata releases require pollingUnitGeodata.");
  }

  return failures.length > 0 ? { value: null, failures } : { value: { manifest, manifestPath }, failures: [] };
}

export function validateIdentityRelease(releaseDir: string, manifest: OgunReferenceReleaseManifest): ValidationResult<{
  territories: TerritoryRow[];
  commandRelationships: CommandRelationshipRow[];
  lgaMemberships: LgaMembershipRow[];
}> {
  const failures: string[] = [];
  const territoriesFile = resolveReleaseFile(releaseDir, manifest.files.territories!.path);
  const relationshipsFile = resolveReleaseFile(releaseDir, manifest.files.commandRelationships!.path);
  const membershipsFile = resolveReleaseFile(releaseDir, manifest.files.lgaMemberships!.path);

  assertSha(territoriesFile, manifest.files.territories!.sha256, "territories", failures);
  assertSha(relationshipsFile, manifest.files.commandRelationships!.sha256, "commandRelationships", failures);
  assertSha(membershipsFile, manifest.files.lgaMemberships!.sha256, "lgaMemberships", failures);
  if (failures.length > 0) {
    return { value: null, failures };
  }

  const territories: TerritoryRow[] = readCsv(territoriesFile).map((row, index) => {
    const kind = requireText(row, "kind") as OgunReferenceTerritoryKind;
    if (!OGUN_REFERENCE_TERRITORY_KINDS.includes(kind)) {
      failures.push(`territories.csv row ${index + 2}: unsupported kind '${kind}'.`);
    }
    const item = {
      kind,
      canonicalId: requireText(row, "canonicalId"),
      stateId: requireText(row, "stateId"),
      name: requireText(row, "name"),
      sourceCodeNamespace: requireText(row, "sourceCodeNamespace"),
      sourceCode: requireText(row, "sourceCode"),
      aliases: (optionalText(row, "aliases") || "")
        .split("|")
        .map((alias) => alias.trim())
        .filter(Boolean),
      lgaId: optionalText(row, "lgaId"),
      federalConstituencyId: optionalText(row, "federalConstituencyId"),
      stateConstituencyId: optionalText(row, "stateConstituencyId"),
      wardId: optionalText(row, "wardId"),
    };
    if (!item.canonicalId || !item.name || !item.sourceCodeNamespace || !item.sourceCode) {
      failures.push(`territories.csv row ${index + 2}: canonicalId, name, sourceCodeNamespace, and sourceCode are required.`);
    }
    if (item.stateId !== OGUN_STATE_ID) {
      failures.push(`territories.csv row ${index + 2}: stateId must be ${OGUN_STATE_ID}.`);
    }
    assertCanonicalId(item.canonicalId, `territories.csv row ${index + 2} canonicalId`, failures);
    if (!manifest.sourceCodeNamespaces.includes(item.sourceCodeNamespace)) {
      failures.push(`territories.csv row ${index + 2}: sourceCodeNamespace is not listed in manifest.`);
    }
    return item;
  });

  const byId = new Map<string, TerritoryRow>();
  const bySourceCode = new Set<string>();
  for (const territory of territories) {
    if (byId.has(territory.canonicalId)) {
      failures.push(`Duplicate canonical territory id: ${territory.canonicalId}.`);
    }
    byId.set(territory.canonicalId, territory);
    const sourceKey = `${territory.kind}:${territory.sourceCodeNamespace}:${territory.sourceCode}`;
    if (bySourceCode.has(sourceKey)) {
      failures.push(`Duplicate source code in namespace: ${sourceKey}.`);
    }
    bySourceCode.add(sourceKey);
  }

  const counts = {
    stateConstituencies: territories.filter((item) => item.kind === "STATE_CONSTITUENCY").length,
    lgas: territories.filter((item) => item.kind === "LGA").length,
    wards: territories.filter((item) => item.kind === "WARD").length,
    pollingUnits: territories.filter((item) => item.kind === "POLLING_UNIT").length,
  };
  for (const [key, actual] of Object.entries(counts)) {
    const expected = manifest.declaredCounts[key as keyof typeof counts];
    if (typeof expected === "number" && actual !== expected) {
      failures.push(`Declared ${key} count ${expected} does not match territories.csv count ${actual}.`);
    }
  }

  const commandRelationships = readCsv(relationshipsFile).map((row): CommandRelationshipRow => ({
    parentKind: requireText(row, "parentKind"),
    parentId: requireText(row, "parentId"),
    childKind: requireText(row, "childKind"),
    childId: requireText(row, "childId"),
  }));
  const relationshipKeys = new Set<string>();
  const relationshipsByChild = new Map<string, CommandRelationshipRow[]>();
  const allowedCommandRelationships = new Set([
    "FEDERAL_CONSTITUENCY->STATE_CONSTITUENCY",
    "STATE_CONSTITUENCY->WARD",
    "WARD->POLLING_UNIT",
  ]);

  commandRelationships.forEach((row, index) => {
    const rowNumber = index + 2;
    const relationshipKey = `${row.parentKind}:${row.parentId}->${row.childKind}:${row.childId}`;
    const relationshipKind = `${row.parentKind}->${row.childKind}`;
    if (!row.parentKind || !row.parentId || !row.childKind || !row.childId) {
      failures.push(`command-relationships.csv row ${rowNumber}: parentKind, parentId, childKind, and childId are required.`);
    }
    if (relationshipKeys.has(relationshipKey)) {
      failures.push(`Duplicate command relationship: ${relationshipKey}.`);
    }
    relationshipKeys.add(relationshipKey);
    if (!allowedCommandRelationships.has(relationshipKind)) {
      failures.push(
        `command-relationships.csv row ${rowNumber}: unsupported command relationship ${relationshipKind}; LGA is reference-only and cannot be a command parent.`,
      );
    }

    const child = byId.get(row.childId);
    if (!child) {
      failures.push(`command-relationships.csv row ${rowNumber}: unknown child territory ${row.childId}.`);
    } else if (child.kind !== row.childKind) {
      failures.push(`command-relationships.csv row ${rowNumber}: child ${row.childId} is ${child.kind}, not ${row.childKind}.`);
    }

    const parent = byId.get(row.parentId);
    if (parent && parent.kind !== row.parentKind) {
      failures.push(`command-relationships.csv row ${rowNumber}: parent ${row.parentId} is ${parent.kind}, not ${row.parentKind}.`);
    }
    if ((row.parentKind === "STATE_CONSTITUENCY" || row.parentKind === "WARD") && !parent) {
      failures.push(`command-relationships.csv row ${rowNumber}: unknown parent territory ${row.parentId}.`);
    }

    const childKey = `${row.childKind}:${row.childId}`;
    relationshipsByChild.set(childKey, [...(relationshipsByChild.get(childKey) || []), row]);
  });

  function requireSingleCommandParent(territory: TerritoryRow, parentKind: string, parentId: string | null) {
    const childKey = `${territory.kind}:${territory.canonicalId}`;
    const relationships = relationshipsByChild.get(childKey) || [];
    if (relationships.length !== 1) {
      failures.push(`${territory.canonicalId} must have exactly one ${parentKind} command parent; found ${relationships.length}.`);
      return;
    }
    const [relationship] = relationships;
    if (relationship.parentKind !== parentKind || relationship.parentId !== parentId) {
      failures.push(
        `${territory.canonicalId} command parent mismatch: territory field=${parentKind}:${parentId || "missing"}, relationship=${relationship.parentKind}:${relationship.parentId}.`,
      );
    }
  }

  for (const territory of territories) {
    if (territory.kind === "LGA") {
      if (territory.lgaId || territory.federalConstituencyId || territory.stateConstituencyId || territory.wardId) {
        failures.push(`${territory.canonicalId} is an LGA reference record and must not carry command-parent fields.`);
      }
    }
    if (territory.kind === "STATE_CONSTITUENCY") {
      if (!territory.lgaId || byId.get(territory.lgaId)?.kind !== "LGA") {
        failures.push(`${territory.canonicalId} requires an Ogun LGA primary reference.`);
      }
      if (!territory.federalConstituencyId) {
        failures.push(`${territory.canonicalId} requires a Federal Constituency command parent.`);
      } else {
        requireSingleCommandParent(territory, "FEDERAL_CONSTITUENCY", territory.federalConstituencyId);
      }
    }
    if (territory.kind === "WARD") {
      if (!territory.lgaId || byId.get(territory.lgaId)?.kind !== "LGA") {
        failures.push(`${territory.canonicalId} requires an Ogun LGA reference.`);
      }
      if (!territory.stateConstituencyId || byId.get(territory.stateConstituencyId)?.kind !== "STATE_CONSTITUENCY") {
        failures.push(`${territory.canonicalId} requires a staged State Constituency command parent.`);
      } else {
        requireSingleCommandParent(territory, "STATE_CONSTITUENCY", territory.stateConstituencyId);
      }
    }
    if (territory.kind === "POLLING_UNIT") {
      if (!territory.lgaId || byId.get(territory.lgaId)?.kind !== "LGA") {
        failures.push(`${territory.canonicalId} requires an Ogun LGA reference.`);
      }
      if (!territory.wardId || byId.get(territory.wardId)?.kind !== "WARD") {
        failures.push(`${territory.canonicalId} requires a staged Ward command parent.`);
      } else {
        requireSingleCommandParent(territory, "WARD", territory.wardId);
      }
    }
  }

  const lgaMemberships = readCsv(membershipsFile).map((row): LgaMembershipRow => ({
    territoryKind: requireText(row, "territoryKind"),
    territoryId: requireText(row, "territoryId"),
    lgaId: requireText(row, "lgaId"),
  }));
  const stateConstituencyMemberships = new Set<string>();
  const membershipKeys = new Set<string>();
  for (const membership of lgaMemberships) {
    const membershipKey = `${membership.territoryKind}:${membership.territoryId}:${membership.lgaId}`;
    if (membershipKeys.has(membershipKey)) {
      failures.push(`Duplicate LGA membership row: ${membershipKey}.`);
    }
    membershipKeys.add(membershipKey);
    const territory = byId.get(membership.territoryId);
    if (!territory) {
      failures.push(`lga-memberships.csv references unknown territory ${membership.territoryId}.`);
    } else if (territory.kind !== membership.territoryKind) {
      failures.push(`lga-memberships.csv territory kind mismatch for ${membership.territoryId}: expected ${territory.kind}, found ${membership.territoryKind}.`);
    }
    if (membership.territoryKind !== "STATE_CONSTITUENCY") {
      failures.push(`lga-memberships.csv only supports STATE_CONSTITUENCY memberships in this import contract.`);
    }
    if (!byId.has(membership.lgaId) || byId.get(membership.lgaId)?.kind !== "LGA") {
      failures.push(`lga-memberships.csv references unknown Ogun LGA ${membership.lgaId}.`);
    }
    if (membership.territoryKind === "STATE_CONSTITUENCY") {
      stateConstituencyMemberships.add(membership.territoryId);
    }
  }
  for (const territory of territories.filter((item) => item.kind === "STATE_CONSTITUENCY")) {
    if (!stateConstituencyMemberships.has(territory.canonicalId)) {
      failures.push(`${territory.canonicalId} requires at least one LGA membership row.`);
    }
  }

  return failures.length > 0 ? { value: null, failures } : { value: { territories, commandRelationships, lgaMemberships }, failures: [] };
}

export function validateGeodataRelease(releaseDir: string, manifest: OgunReferenceReleaseManifest): ValidationResult<PollingUnitGeodataRow[]> {
  const failures: string[] = [];
  const geodataFile = resolveReleaseFile(releaseDir, manifest.files.pollingUnitGeodata!.path);
  assertSha(geodataFile, manifest.files.pollingUnitGeodata!.sha256, "pollingUnitGeodata", failures);
  if (failures.length > 0) {
    return { value: null, failures };
  }

  const ids = new Set<string>();
  const rows = readCsv(geodataFile).map((row, index): PollingUnitGeodataRow => {
    const rowNumber = index + 2;
    const pollingUnitId = requireText(row, "pollingUnitId");
    const latitude = Number(requireText(row, "latitude"));
    const longitude = Number(requireText(row, "longitude"));
    const accuracyMeters = Number(requireText(row, "accuracyMeters"));
    const capturedAt = assertDate(requireText(row, "capturedAt"), `polling-unit-geodata.csv row ${rowNumber} capturedAt`, failures);
    const geofenceRadiusMeters = Number(requireText(row, "geofenceRadiusMeters"));

    if (ids.has(pollingUnitId)) {
      failures.push(`Duplicate geodata pollingUnitId: ${pollingUnitId}.`);
    }
    ids.add(pollingUnitId);
    assertCanonicalId(pollingUnitId, `polling-unit-geodata.csv row ${rowNumber} pollingUnitId`, failures);
    if (Number.isNaN(latitude) || latitude < -90 || latitude > 90) {
      failures.push(`polling-unit-geodata.csv row ${rowNumber}: latitude must be between -90 and 90.`);
    }
    if (Number.isNaN(longitude) || longitude < -180 || longitude > 180) {
      failures.push(`polling-unit-geodata.csv row ${rowNumber}: longitude must be between -180 and 180.`);
    }
    if (Number.isNaN(accuracyMeters) || accuracyMeters <= 0) {
      failures.push(`polling-unit-geodata.csv row ${rowNumber}: accuracyMeters must be positive.`);
    }
    if (Number.isNaN(geofenceRadiusMeters) || geofenceRadiusMeters <= 0) {
      failures.push(`polling-unit-geodata.csv row ${rowNumber}: geofenceRadiusMeters must be positive.`);
    }
    if (!requireText(row, "captureMethod") || !requireText(row, "source")) {
      failures.push(`polling-unit-geodata.csv row ${rowNumber}: captureMethod and source are required.`);
    }

    return {
      pollingUnitId,
      latitude,
      longitude,
      accuracyMeters,
      captureMethod: requireText(row, "captureMethod"),
      capturedAt: capturedAt || new Date(0),
      source: requireText(row, "source"),
      geofenceRadiusMeters,
    };
  });

  if (typeof manifest.declaredCounts.geocodedPollingUnits === "number" && rows.length !== manifest.declaredCounts.geocodedPollingUnits) {
    failures.push(`Declared geocodedPollingUnits count ${manifest.declaredCounts.geocodedPollingUnits} does not match CSV count ${rows.length}.`);
  }

  return failures.length > 0 ? { value: null, failures } : { value: rows, failures: [] };
}

async function upsertRelease(client: any, manifest: OgunReferenceReleaseManifest, manifestPath: string) {
  return client.referenceDataImportRelease.upsert({
    where: { releaseId: manifest.releaseId },
    update: {
      kind: manifest.kind,
      stateId: manifest.stateId,
      sourcePublisher: manifest.publisher,
      sourceUrl: manifest.sourceUrl || null,
      sourceDocumentId: manifest.sourceDocumentId || null,
      sourceRetrievedAt: new Date(manifest.retrievedAt),
      sourceEffectiveAt: manifest.effectiveAt ? new Date(manifest.effectiveAt) : null,
      approvedBy: manifest.approvedBy,
      approvedAt: new Date(manifest.approvedAt),
      manifestSha256: sha256(manifestPath),
      territoriesSha256: manifest.files.territories?.sha256 || null,
      commandRelationshipsSha256: manifest.files.commandRelationships?.sha256 || null,
      lgaMembershipsSha256: manifest.files.lgaMemberships?.sha256 || null,
      pollingUnitGeodataSha256: manifest.files.pollingUnitGeodata?.sha256 || null,
      declaredCountsJson: manifest.declaredCounts,
      sourceCodeNamespaces: manifest.sourceCodeNamespaces,
      supersedesReleaseId: manifest.supersedesReleaseId || null,
      status: "APPLIED",
      appliedAt: new Date(),
    },
    create: {
      releaseId: manifest.releaseId,
      kind: manifest.kind,
      stateId: manifest.stateId,
      sourcePublisher: manifest.publisher,
      sourceUrl: manifest.sourceUrl || null,
      sourceDocumentId: manifest.sourceDocumentId || null,
      sourceRetrievedAt: new Date(manifest.retrievedAt),
      sourceEffectiveAt: manifest.effectiveAt ? new Date(manifest.effectiveAt) : null,
      approvedBy: manifest.approvedBy,
      approvedAt: new Date(manifest.approvedAt),
      manifestSha256: sha256(manifestPath),
      territoriesSha256: manifest.files.territories?.sha256 || null,
      commandRelationshipsSha256: manifest.files.commandRelationships?.sha256 || null,
      lgaMembershipsSha256: manifest.files.lgaMemberships?.sha256 || null,
      pollingUnitGeodataSha256: manifest.files.pollingUnitGeodata?.sha256 || null,
      declaredCountsJson: manifest.declaredCounts,
      sourceCodeNamespaces: manifest.sourceCodeNamespaces,
      supersedesReleaseId: manifest.supersedesReleaseId || null,
      status: "APPLIED",
      appliedAt: new Date(),
    },
  });
}

async function applyIdentityRelease(
  manifest: OgunReferenceReleaseManifest,
  manifestPath: string,
  payload: NonNullable<ReturnType<typeof validateIdentityRelease>["value"]>,
) {
  // A full Ogun identity release is 20 LGAs, 236 wards and 5,042 polling units.
  // Prisma's 5s interactive default expires part-way through, which would leave
  // the import looking flaky rather than slow; the whole release must land in
  // one transaction or not at all.
  return getPrisma().$transaction(async (transaction) => {
    const transactionAny = transaction as any;
    const release = await upsertRelease(transactionAny, manifest, manifestPath);
    const importedAt = new Date();
    const counts = { lgas: 0, stateConstituencies: 0, wards: 0, pollingUnits: 0, lgaMemberships: 0 };

    for (const item of payload.territories.filter((territory) => territory.kind === "LGA")) {
      await transactionAny.lGA.upsert({
        where: { id: item.canonicalId },
        update: {
          name: item.name,
          stateId: item.stateId,
          sourceCode: item.sourceCode,
          sourceCodeNamespace: item.sourceCodeNamespace,
          sourceNameAliases: item.aliases,
          referenceImportReleaseId: release.id,
          referenceImportedAt: importedAt,
        },
        create: {
          id: item.canonicalId,
          name: item.name,
          stateId: item.stateId,
          sourceCode: item.sourceCode,
          sourceCodeNamespace: item.sourceCodeNamespace,
          sourceNameAliases: item.aliases,
          referenceImportReleaseId: release.id,
          referenceImportedAt: importedAt,
        },
      });
      counts.lgas += 1;
    }

    for (const item of payload.territories.filter((territory) => territory.kind === "STATE_CONSTITUENCY")) {
      await transactionAny.stateConstituency.upsert({
        where: { id: item.canonicalId },
        update: {
          name: item.name,
          stateId: item.stateId,
          lgaId: item.lgaId!,
          federalConstituencyId: item.federalConstituencyId,
          sourceCode: item.sourceCode,
          sourceCodeNamespace: item.sourceCodeNamespace,
          sourceNameAliases: item.aliases,
          referenceImportReleaseId: release.id,
          referenceImportedAt: importedAt,
        },
        create: {
          id: item.canonicalId,
          name: item.name,
          stateId: item.stateId,
          lgaId: item.lgaId!,
          federalConstituencyId: item.federalConstituencyId,
          sourceCode: item.sourceCode,
          sourceCodeNamespace: item.sourceCodeNamespace,
          sourceNameAliases: item.aliases,
          referenceImportReleaseId: release.id,
          referenceImportedAt: importedAt,
        },
      });
      counts.stateConstituencies += 1;
    }

    const stateConstituencyMemberships = payload.lgaMemberships.filter(
      (membership) => membership.territoryKind === "STATE_CONSTITUENCY",
    );
    if (stateConstituencyMemberships.length > 0) {
      await transactionAny.stateConstituencyLga.createMany({
        data: stateConstituencyMemberships.map((membership) => ({
          stateConstituencyId: membership.territoryId,
          lgaId: membership.lgaId,
        })),
        skipDuplicates: true,
      });
      counts.lgaMemberships = stateConstituencyMemberships.length;
    }

    for (const item of payload.territories.filter((territory) => territory.kind === "WARD")) {
      await transactionAny.ward.upsert({
        where: { id: item.canonicalId },
        update: {
          name: item.name,
          stateId: item.stateId,
          lgaId: item.lgaId!,
          stateConstituencyId: item.stateConstituencyId,
          sourceCode: item.sourceCode,
          sourceCodeNamespace: item.sourceCodeNamespace,
          sourceNameAliases: item.aliases,
          referenceImportReleaseId: release.id,
          referenceImportedAt: importedAt,
        },
        create: {
          id: item.canonicalId,
          name: item.name,
          stateId: item.stateId,
          lgaId: item.lgaId!,
          stateConstituencyId: item.stateConstituencyId,
          sourceCode: item.sourceCode,
          sourceCodeNamespace: item.sourceCodeNamespace,
          sourceNameAliases: item.aliases,
          referenceImportReleaseId: release.id,
          referenceImportedAt: importedAt,
        },
      });
      counts.wards += 1;
    }

    for (const item of payload.territories.filter((territory) => territory.kind === "POLLING_UNIT")) {
      await transactionAny.pollingUnit.upsert({
        where: { id: item.canonicalId },
        update: {
          name: item.name,
          stateId: item.stateId,
          lgaId: item.lgaId!,
          wardId: item.wardId!,
          sourceCode: item.sourceCode,
          sourceCodeNamespace: item.sourceCodeNamespace,
          sourceNameAliases: item.aliases,
          referenceImportReleaseId: release.id,
          referenceImportedAt: importedAt,
        },
        create: {
          id: item.canonicalId,
          name: item.name,
          stateId: item.stateId,
          lgaId: item.lgaId!,
          wardId: item.wardId!,
          sourceCode: item.sourceCode,
          sourceCodeNamespace: item.sourceCodeNamespace,
          sourceNameAliases: item.aliases,
          referenceImportReleaseId: release.id,
          referenceImportedAt: importedAt,
        },
      });
      counts.pollingUnits += 1;
    }

    return counts;
  }, { timeout: 600_000, maxWait: 30_000 });
}

async function applyGeodataRelease(
  manifest: OgunReferenceReleaseManifest,
  manifestPath: string,
  rows: PollingUnitGeodataRow[],
) {
  // A full Ogun identity release is 20 LGAs, 236 wards and 5,042 polling units.
  // Prisma's 5s interactive default expires part-way through, which would leave
  // the import looking flaky rather than slow; the whole release must land in
  // one transaction or not at all.
  return getPrisma().$transaction(async (transaction) => {
    const transactionAny = transaction as any;
    const release = await upsertRelease(transactionAny, manifest, manifestPath);
    const importedAt = new Date();
    let updated = 0;

    for (const row of rows) {
      const result = await transactionAny.pollingUnit.updateMany({
        where: { id: row.pollingUnitId, stateId: OGUN_STATE_ID },
        data: {
          latitude: row.latitude,
          longitude: row.longitude,
          geoAccuracyMeters: row.accuracyMeters,
          geoCaptureMethod: row.captureMethod,
          geoCapturedAt: row.capturedAt,
          geoSource: row.source,
          geofenceRadiusMeters: row.geofenceRadiusMeters,
          geodataImportReleaseId: release.id,
          geodataImportedAt: importedAt,
        },
      });
      if (result.count !== 1) {
        throw new Error(`Geodata references unknown Ogun Polling Unit: ${row.pollingUnitId}`);
      }
      updated += 1;
    }

    return { pollingUnitsWithGeodata: updated };
  });
}

async function validateIdentityDatabaseParents(payload: NonNullable<ReturnType<typeof validateIdentityRelease>["value"]>) {
  const failures: string[] = [];
  const federalConstituencyIds = Array.from(
    new Set(
      payload.territories
        .map((territory) => territory.federalConstituencyId)
        .filter((value): value is string => Boolean(value)),
    ),
  );
  if (federalConstituencyIds.length > 0) {
    const found = await getPrisma().federalConstituency.findMany({
      where: { id: { in: federalConstituencyIds }, stateId: OGUN_STATE_ID },
      select: { id: true },
    });
    const foundIds = new Set(found.map((item) => item.id));
    for (const id of federalConstituencyIds) {
      if (!foundIds.has(id)) {
        failures.push(`Unknown Ogun Federal Constituency command parent: ${id}.`);
      }
    }
  }
  return failures;
}

async function validateGeodataDatabaseParents(rows: PollingUnitGeodataRow[]) {
  const ids = rows.map((row) => row.pollingUnitId);
  const found = await getPrisma().pollingUnit.findMany({
    where: { id: { in: ids }, stateId: OGUN_STATE_ID },
    select: { id: true },
  });
  const foundIds = new Set(found.map((item) => item.id));
  return ids
    .filter((id) => !foundIds.has(id))
    .map((id) => `Geodata references unknown Ogun Polling Unit: ${id}.`);
}

async function main() {
  if (!releaseDirArg) {
    throw new Error("Usage: npm run import:reference:ogun -- --release-dir packages/database/reference/ogun/<release-id> --apply");
  }
  const releaseDir = path.resolve(process.cwd(), releaseDirArg);
  const manifestResult = validateManifest(releaseDir);
  if (!manifestResult.value) {
    for (const failure of manifestResult.failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  const { manifest, manifestPath } = manifestResult.value;
  const state = await getPrisma().state.findUnique({ where: { id: OGUN_STATE_ID }, select: { id: true } });
  if (!state) {
    console.error(`FAIL Ogun State must be bootstrapped before importing release ${manifest.releaseId}.`);
    process.exitCode = 1;
    return;
  }

  if (manifest.kind === "OGUN_IDENTITY") {
    const validation = validateIdentityRelease(releaseDir, manifest);
    if (!validation.value) {
      for (const failure of validation.failures) {
        console.error(`FAIL ${failure}`);
      }
      process.exitCode = 1;
      return;
    }
    const parentFailures = await validateIdentityDatabaseParents(validation.value);
    if (parentFailures.length > 0) {
      for (const failure of parentFailures) {
        console.error(`FAIL ${failure}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`ogun_identity_release_valid=${manifest.releaseId}`);
    if (!validateOnly) {
      const counts = await applyIdentityRelease(manifest, manifestPath, validation.value);
      console.log(`ogun_identity_release_applied=${manifest.releaseId}`);
      console.log(`applied_counts=${JSON.stringify(counts)}`);
    }
    return;
  }

  const validation = validateGeodataRelease(releaseDir, manifest);
  if (!validation.value) {
    for (const failure of validation.failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  const parentFailures = await validateGeodataDatabaseParents(validation.value);
  if (parentFailures.length > 0) {
    for (const failure of parentFailures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`ogun_geodata_release_valid=${manifest.releaseId}`);
  if (!validateOnly) {
    const counts = await applyGeodataRelease(manifest, manifestPath, validation.value);
    console.log(`ogun_geodata_release_applied=${manifest.releaseId}`);
    console.log(`applied_counts=${JSON.stringify(counts)}`);
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error("Ogun reference release import failed:", error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma?.$disconnect();
    });
}
