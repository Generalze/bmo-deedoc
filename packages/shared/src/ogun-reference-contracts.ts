export const OGUN_REFERENCE_IMPORT_CONTRACT_VERSION = 1 as const;

export const OGUN_REFERENCE_IMPORT_KINDS = [
  "OGUN_IDENTITY",
  "OGUN_POLLING_UNIT_GEODATA",
] as const;

export const OGUN_REFERENCE_IMPORT_STATUSES = [
  "STAGED",
  "APPLIED",
  "REJECTED",
] as const;

export const OGUN_REFERENCE_TERRITORY_KINDS = [
  "STATE_CONSTITUENCY",
  "LGA",
  "WARD",
  "POLLING_UNIT",
] as const;

export const OGUN_IDENTITY_REQUIRED_COUNTS = {
  stateConstituencies: 26,
  lgas: 20,
} as const;

export const OGUN_REFERENCE_GATE_SCOPES = ["IDENTITY", "PROVENANCE", "GEODATA"] as const;

export const OGUN_REFERENCE_LEVEL_STATUSES = [
  "VERIFIED",
  "PARTIAL",
  "MISSING",
  "BLOCKED",
] as const;

export const OGUN_REFERENCE_LEVEL_KEYS = [
  "stateConstituencies",
  "lgas",
  "wards",
  "pollingUnits",
  "puGeodata",
] as const;

export type OgunReferenceImportKind = (typeof OGUN_REFERENCE_IMPORT_KINDS)[number];
export type OgunReferenceImportStatus = (typeof OGUN_REFERENCE_IMPORT_STATUSES)[number];
export type OgunReferenceTerritoryKind = (typeof OGUN_REFERENCE_TERRITORY_KINDS)[number];
export type OgunReferenceGateScope = (typeof OGUN_REFERENCE_GATE_SCOPES)[number];
export type OgunReferenceLevelStatus = (typeof OGUN_REFERENCE_LEVEL_STATUSES)[number];
export type OgunReferenceLevelKey = (typeof OGUN_REFERENCE_LEVEL_KEYS)[number];

export type OgunReferenceReleaseManifest = {
  contractVersion: typeof OGUN_REFERENCE_IMPORT_CONTRACT_VERSION;
  releaseId: string;
  kind: OgunReferenceImportKind;
  stateId: string;
  publisher: string;
  sourceUrl?: string | null;
  sourceDocumentId?: string | null;
  retrievedAt: string;
  effectiveAt?: string | null;
  approvedBy: string;
  approvedAt: string;
  supersedesReleaseId?: string | null;
  sourceCodeNamespaces: string[];
  declaredCounts: {
    stateConstituencies?: number;
    lgas?: number;
    wards?: number;
    pollingUnits?: number;
    geocodedPollingUnits?: number;
  };
  files: {
    territories?: { path: string; sha256: string };
    commandRelationships?: { path: string; sha256: string };
    lgaMemberships?: { path: string; sha256: string };
    pollingUnitGeodata?: { path: string; sha256: string };
    /**
     * Ward edges the release build resolved by inference rather than from an
     * authoritative source. Checksummed like any other release file so the set
     * cannot be quietly shrunk to make unreviewed edges look sourced.
     */
    inferredEdges?: { path: string; sha256: string };
  };
};

export type OgunReferenceGateBlocker = {
  scope: OgunReferenceGateScope;
  code: string;
  message: string;
};

export type OgunReferenceGateSummary = {
  status: "PASS" | "BLOCKED";
  identityComplete: boolean;
  provenanceComplete: boolean;
  geodataReady: boolean;
  blockers: OgunReferenceGateBlocker[];
};

export type OgunReferenceLevelSummary = {
  key: OgunReferenceLevelKey;
  label: "State Constituencies" | "LGAs" | "Wards" | "Polling Units" | "PU Geodata";
  status: OgunReferenceLevelStatus;
  expected: number | null;
  loaded: number;
  sourceRows: number | null;
  verified: number;
  blockers: string[];
};
