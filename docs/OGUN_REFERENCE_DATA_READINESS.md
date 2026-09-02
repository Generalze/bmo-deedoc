# Ogun Reference Data Readiness

- **Assessment date:** 2026-08-09
- **Operational state:** Ogun
- **Scope:** Territory identity and relationship readiness; not Election Day geofence readiness

## Status Definitions

| Status | Meaning |
|---|---|
| `VERIFIED` | Present in the disposable database and reconciled with an approved checked-in project source. |
| `PARTIAL` | Some source or database records exist, but loading, provenance, currentness, or required relationships are incomplete. |
| `MISSING` | No usable records are loaded and no complete checked-in dataset exists. |
| `BLOCKED` | Records or release files are present but cannot be accepted because validation found duplicates, orphans, invalid relationships, missing provenance, cross-State links, or command/reference violations. |

`NEEDS_AUTHORITATIVE_SOURCE` is no longer used as a level status. Missing source approval is recorded as a blocker note while the level itself remains `MISSING` unless partial checked-in source evidence exists.

## Source Inventory

| Source | Contents | Assessment |
|---|---|---|
| `packages/shared/src/nigeria-reference-data.ts` | Ogun canonical ID `ng-state-ogun`, name, INEC code `28`, South West zone, and expected LGA count 20 | Approved checked-in project reference for State identity and expected LGA count. The current `State` model does not persist `inecCode`; it remains source metadata. |
| `packages/database/reference/inec-constituencies.xls` | National Senate, Federal Constituency, and State Constituency rows | Approved checked-in project source used by the bootstrap. SHA-256: `a094e8cadd3f7a47986ed546a1a6d9fb3707feaa879492f43f33fa9c116d751b`. Workbook metadata indicates modification on 2011-03-10, so currentness must be re-approved before production import. |
| `https://cvr.inecnigeria.org/PublicApi` | Existing code path for LGA, Ward, and Polling Unit options | Official-domain integration candidate, but the hostname did not resolve during closure testing. It is not a reproducible checked-in dataset and cannot currently satisfy the import gate. |
| [INEC Ogun Polling Unit Directory, revised January 2015](https://www.inecnigeria.org/wp-content/uploads/2019/02/PU_Directory_Revised_January_2015_Ogun.pdf) | Official historical Ward and Polling Unit directory | Authoritative-source candidate, not checked in or ingested. It predates later Polling Unit expansions and requires INEC/current-project approval before use. |
| [INEC Polling Unit Locator](https://inecnigeria.org/polling-units/) | Current official interactive lookup | Verification source candidate, not a versioned bulk dataset. It does not resolve the repository's missing provenance, relationship, and reproducibility fields by itself. |

The Lagos-only records in `packages/database/prisma/seed.ts` are test fixtures. They are not Ogun reference data and must never be promoted into an Ogun import.

## Readiness Summary

| Level | Expected | Source rows | Loaded after clean bootstrap | Verified | Status |
|---|---:|---:|---:|---:|---|
| Ogun State | 1 | 1 | 1 | 1 | `VERIFIED` |
| Senatorial Districts | 3 | 3 | 3 | 3 | `VERIFIED` |
| Federal Constituencies | 9 | 9 | 9 | 9 | `VERIFIED` |
| State Constituencies | 26 | 26 valid rows | 0 | 0 | `PARTIAL` |
| LGAs | 20 | Expected count only | 0 | 0 | `MISSING` |
| Wards | No approved repository total | 0 | 0 | 0 | `MISSING` |
| Polling Units | No approved repository total | 0 | 0 | 0 | `MISSING` |
| Polling Unit geodata | No approved repository total | 0 | 0 | 0 | `MISSING` |

The State Constituency sheet presents 27 rows to the generic parser because one numeric column-label row (`1`, `2`, `3`, `4`) appears under the Ogun section. The source contains 26 valid Ogun records with `SC/.../OG` codes. The invalid numeric header is excluded from the readiness count and does not load because it cannot resolve an LGA.

## Ogun State

- Record present: yes.
- Canonical ID: `ng-state-ogun`.
- INEC code: `28` in the checked-in shared reference; not persisted by the current `State` model.
- Clean-bootstrap status: `VERIFIED`.

## Senatorial Districts

- Expected count: 3.
- Source count: 3 (`OGUN CENTRAL`, `OGUN EAST`, `OGUN WEST`).
- Available database count: 3.
- Verified count: 3 against the checked-in workbook and same-State parent validation.
- Status: `VERIFIED` for repository development; workbook currentness remains a production import review item.

## Federal Constituencies

- Expected count: 9.
- Source count: 9.
- Available database count: 9.
- Verified count: 9 against workbook names/codes and same-State Senatorial parent validation.
- Status: `VERIFIED` for repository development.
- Caveat: the bootstrap derives each Senatorial parent from overlap in source composition text. The workbook does not provide a direct Federal-to-Senatorial foreign key, so this mapping requires production-data-owner review.

## State Constituencies

- Expected count: 26.
- Source count: 26 valid coded records.
- Available database count: 0 after clean bootstrap.
- Verified count: 0 loaded records.
- Status: `PARTIAL`.
- Blocker: the legacy `StateConstituency` model requires one `lgaId`. No authoritative Ogun LGA records are loaded, and the source composition largely lists Wards rather than a direct LGA key. The loader correctly skips these records instead of manufacturing an LGA.

## LGAs

- Expected count: 20.
- Available database count: 0.
- Verified count: 0.
- Status: `MISSING`.
- Blocker: authoritative checked-in LGA source approval is required before import.
- The project knows the expected count and constituency composition text contains LGA names, but composition text is not an approved identity dataset and must not mint LGA records.

## Wards

- Available: no Ogun records.
- Complete: no.
- Authoritative checked-in source: no.
- Status: `MISSING`.
- Blocker: authoritative checked-in Ward identity and relationship source approval is required before import.
- State Constituency composition text contains historical Ward labels, but it is not a complete, versioned Ward identity dataset and does not provide stable Ward IDs.

## Polling Units

- Available: no Ogun records.
- Complete: no.
- Authoritative checked-in source: no.
- Codes persisted by current model: no; current IDs may encode an external option ID, but there is no separate source-code/provenance field.
- Status: `MISSING`.
- Blocker: authoritative checked-in Polling Unit identity and relationship source approval is required before import.

## Polling Unit Geodata

- Coordinates available: no.
- Accuracy/source available: no.
- Geofence radius available: no.
- Provenance and capture date available: no.
- Status: `MISSING`.
- Blocker: authoritative checked-in coordinate, accuracy, capture, source, and geofence-radius approval is required before import.

Territory identity and GPS/geofence data are separate gates. Missing coordinates do not prevent the Platform Lead from designing Phase 1 roles, assignments, and territory contracts. Approved Polling Unit identity is required before Polling Unit assignments can be migrated deeply. Accurate coordinates, source, capture date, and geofence policy become mandatory before Election Day GPS/geofence implementation.

## Relationship Validation

| Relationship | Current result | Readiness |
|---|---|---|
| Ward -> LGA reference | Cannot validate; both Ogun datasets are absent. | `MISSING` |
| Ward -> State Constituency | Phase 1 schema supports a nullable direct command-parent link; no approved Ogun mapping dataset is loaded. | `MISSING`; source approval blocker |
| State Constituency -> Federal Constituency, where approved | Phase 1 schema supports a nullable direct command-parent link; the workbook does not define it directly. Do not infer it from names. | `MISSING`; source approval blocker |
| Federal Constituency -> Senatorial District, where approved | All 9 loaded Federal records reference an Ogun Senatorial District; parent selection is composition-derived. | `PARTIAL` relationship assurance |
| Polling Unit -> Ward | Cannot validate; both Ogun datasets are absent. | `MISSING` |
| Ward/Polling Unit -> State | Schema supports State and LGA parents, but no Ogun records are loaded. | `MISSING` |

## Command Versus Reference

The locked command hierarchy remains:

```text
STATE
-> SENATORIAL DISTRICT
-> FEDERAL CONSTITUENCY
-> STATE CONSTITUENCY
-> WARD
-> POLLING UNIT
```

LGA is reference geography for source reconciliation, search, mapping, filtering, and reporting. LGA membership must not grant command authority. Multiple reference relationships may support electoral mapping without changing authorization inheritance.

## Versioned Import Release

Each approved import must be immutable and checked in under a release-specific path such as:

```text
packages/database/reference/ogun/<release-id>/
  manifest.json
  territories.csv
  command-relationships.csv
  lga-memberships.csv
  polling-unit-geodata.csv  # optional, independently approved
```

## Inferred edge provenance

55 of the 236 ward → State Constituency edges in `ogun-identity-2026-08-12` were
resolved by inference rather than read from an authoritative source, and are
listed in the release's `INFERRED-EDGES.csv` with the basis for each. The file
holds 56 rows: ward `inec-ward-6511` appears twice because the build later moved
it to a constituency that would otherwise have had no ward, and the earlier row
was never retracted. The import uses the row matching the edge actually loaded.

That distinction did not previously survive the import: the file was not listed
in the manifest's checksummed `files` block, nothing read it at runtime, and
`territories.csv` carried no column marking an edge as inferred, so all 236
edges became indistinguishable once loaded.

It is now machine-enforceable:

- `INFERRED-EDGES.csv` is a checksummed manifest file, so the set cannot be
  quietly shrunk to make an unreviewed edge look sourced.
- `Ward.stateConstituencyEdgeInferred` / `stateConstituencyEdgeInferenceBasis`
  record the inference and are **owned by the import**.
- `Ward.stateConstituencyEdgeReviewedAt` / `stateConstituencyEdgeReviewedBy`
  record human review and are **never written by the importer**, so re-importing
  a release cannot revoke a completed review.

**None of these edges is reviewed.** Member registration on those wards fails
closed with `ANCESTRY_EDGE_UNREVIEWED`. Reviewing them is a data-governance
action; loading an edge into the database does not make it true.

Release file checksums are computed over LF-canonicalised bytes, matching the
migration integrity manifest, so a correct release verifies identically on a
Windows and a Linux checkout.

`manifest.json` must record the publisher, source URL or document identifier, retrieval and effective dates, license/usage basis, reviewer approval, file SHA-256 values, declared record counts, source-code namespaces, and any superseded release. The declared Ward and Polling Unit totals become acceptance counts for that release; repository code must not guess totals that the source does not declare.

The identity release contains stable canonical IDs, source codes, names and aliases, State ownership, reference LGA membership, and every direct command relationship. Canonical IDs remain unchanged across later releases; source renames become aliases or reviewed display-name changes. Duplicate canonical IDs, duplicate source codes within a namespace, unknown parents, cross-State links, orphan records, hierarchy cycles, and conflicting command parents fail the import.

The importer must stage and validate the complete release before writing. Apply uses transactional upserts keyed by canonical ID, records release provenance on each imported record, produces create/update/unchanged/blocked counts, and is idempotent on rerun. It performs no implicit deletes; records absent from a later release require an explicit reviewed retirement list and dependency report.

Implemented contract:

- Shared types and constants live in `packages/shared/src/ogun-reference-contracts.ts`.
- Import releases are recorded in `ReferenceDataImportRelease` with manifest/file hashes, declared counts, source-code namespaces, approval metadata, status, and supersession metadata.
- Lower-level Ogun identity rows persist `sourceCode`, `sourceCodeNamespace`, aliases, `referenceImportReleaseId`, and `referenceImportedAt` on `StateConstituency`, `LGA`, `Ward`, and `PollingUnit`.
- Polling Unit geodata is stored separately on `PollingUnit` with coordinates, accuracy, capture metadata, geofence radius, `geodataImportReleaseId`, and `geodataImportedAt`.
- `npm run validate:reference:ogun-release --workspace @pics-nigeria/database -- --release-dir <path>` validates a checked-in release without writing.
- `npm run import:reference:ogun --workspace @pics-nigeria/database -- --release-dir <path> --apply` applies a validated release transactionally. Without `--apply`, the script validates only.
- `npm run report:reference:ogun --workspace @pics-nigeria/database` reports each required Sprint 2 level as `VERIFIED`, `PARTIAL`, `MISSING`, or `BLOCKED`.
- `npm run verify:reference:ogun-contract --workspace @pics-nigeria/database` executes focused importer validation tests for duplicate, orphan, relationship, LGA-reference-only, and geodata duplicate failures.

The importer fails closed before writes when it finds duplicate canonical IDs, duplicate source codes, duplicate command relationships, duplicate LGA memberships, unknown child records, unknown staged parents, conflicting command parents, unsupported relationship kinds, LGA command parents, missing required direct parents, or geodata rows that do not resolve to existing Ogun Polling Units. It does not infer missing electoral mappings from names, composition text, LGA membership, or ID prefixes.

Identity release CSV contract:

| File | Required columns |
|---|---|
| `territories.csv` | `kind`, `canonicalId`, `stateId`, `name`, `sourceCodeNamespace`, `sourceCode`, `aliases`, `lgaId`, `federalConstituencyId`, `stateConstituencyId`, `wardId` |
| `command-relationships.csv` | `parentKind`, `parentId`, `childKind`, `childId` |
| `lga-memberships.csv` | `territoryKind`, `territoryId`, `lgaId` |

Geodata release CSV contract:

| File | Required columns |
|---|---|
| `polling-unit-geodata.csv` | `pollingUnitId`, `latitude`, `longitude`, `accuracyMeters`, `captureMethod`, `capturedAt`, `source`, `geofenceRadiusMeters` |

## Identity And Geodata Gates

Polling Unit identity and Polling Unit geodata are separate release tracks:

| Gate | Required fields | Blocks |
|---|---|---|
| Identity | Canonical ID, source code/namespace, approved name, State, LGA reference, Ward command parent, provenance | Polling Unit assignments and full Pre-Election territory operation |
| Geodata | Latitude, longitude, accuracy, capture method/date, source, approved geofence policy/radius | Election Day GPS, geofence and location-alert work only |

An identity import can be approved while geodata remains unavailable. Missing coordinates must not block Member registration, coordinator management, referrals, rewards, payouts, or other Pre-Election work that uses canonical Polling Unit identity.

## Import Execution Gate

1. Data owner approves a source release and its provenance manifest.
2. Platform Lead reviews canonical-ID reuse and the generated duplicate/orphan/conflict report.
3. The importer runs first in disposable PostgreSQL and runs twice to prove idempotency.
4. `npm run verify:reference:ogun` must pass the identity gate without `--allow-incomplete`; geodata readiness is reported separately.
5. `npm run verify:reference:ogun --workspace @pics-nigeria/database -- --require-geodata` is required before Election Day GPS/geofence features use Polling Unit location data.
6. Representative organization-tree and cross-territory authorization tests must pass against the imported release.
7. Production import requires backup, aggregate before/after counts, a no-delete assertion, and reviewer sign-off.

## Import Acceptance Gate

Before lower-level Ogun records are accepted, the data owner must provide or approve the versioned identity release above. Current repository data does not satisfy this gate, so real lower-level assignments and the production organization tree remain fail-closed. The historical PDF and interactive locator remain source candidates, not approved import releases.
