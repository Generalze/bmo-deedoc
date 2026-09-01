# Member Constituency Ancestry

- **Closes:** P0 #4 in [`docs/VPS_STAGING_READINESS.md`](VPS_STAGING_READINESS.md)
- **Affects features:** 059-065, 077
- **Status:** code path implemented; **operational completeness pending human
  review of the 55 inferred constituency edges**

## What was wrong

`VoterProfile.senatorialDistrictId`, `federalConstituencyId` and
`stateConstituencyId` are nullable. The public registration form collects only
State -> LGA -> Ward -> Polling Unit, and `apps/api/src/routes/auth.ts` stored
`parsed.data.X || null` for all three without deriving anything from the ward it
had already validated.

Two consequences, both reachable:

1. Every member registered through the product was invisible at three of the six
   dashboard levels, which banded `CRITICAL` regardless of real strength.
2. The endpoint is public and unauthenticated. Because the three fields were
   accepted from the request body, a caller could file itself into any
   constituency in Ogun by typing one.

## The rule now

> A member's higher constituency ancestry is derived by the server from the
> validated ward, and may be persisted only when the Ward -> State Constituency
> edge is approved for operational use.

The client sends only what it legitimately selects — `stateId`, `lgaId`,
`wardId`, `pollingUnitId`. The three constituency ids were **removed from the
request contract**, and a request that still supplies one is rejected with
`ANCESTRY_NOT_CALLER_SUPPLIED` rather than silently ignored: a client working
from the old contract believed it was choosing its constituency, and should be
told that changed.

## Where the authority lives

`apps/api/src/lib/member-ancestry.ts` — `deriveMemberAncestryFromWard`.

It delegates the graph walk to `resolveOperationalTerritory` in
`apps/api/src/authorization.ts`, which already governed operator scope, rather
than adding a second implementation of the same hierarchy. Only `wardId` and
`pollingUnitId` are passed in, so no higher id can have been influenced by a
caller and every constituency in the result was read from the graph.

It verifies, and fails closed on each:

| # | Check | Failure code |
|---|---|---|
| 1 | State is Ogun | `ANCESTRY_OUTSIDE_OGUN` |
| 2 | Ward exists | `ANCESTRY_INVALID_TERRITORY` |
| 3 | Ward belongs to the supplied LGA | `ANCESTRY_INVALID_TERRITORY` |
| 4 | Polling unit belongs to that ward, LGA and state | `ANCESTRY_INVALID_TERRITORY` |
| 5 | Ward -> State Constituency edge is approved for operational use | `ANCESTRY_EDGE_UNREVIEWED` |
| 6 | Ward has a State Constituency | `ANCESTRY_INCOMPLETE` |
| 7 | State Constituency has a Federal Constituency | `ANCESTRY_INCOMPLETE` |
| 8 | Federal Constituency has a Senatorial District | `ANCESTRY_INCOMPLETE` |
| 9 | Every ancestor is an Ogun record | `ANCESTRY_INVALID_TERRITORY` |
| 10 | No null ancestor is accepted | `ANCESTRY_INCOMPLETE` |

There is no fallback to caller-supplied values and no substitution of a
plausible parent. An ancestry that cannot be proved is an error, not a null
column.

## Atomicity

Derivation runs **inside** the registration transaction and reads the graph
through that transaction. If it throws, the transaction rolls back: no user, no
voter profile, no verification record, no referral. A registration either exists
with a proven ancestry or does not exist.

## The inferred edges

The Ogun identity release resolved ward edges by inference where it could not
source them — name token overlap, or the structural fact that a ward in a
single-constituency LGA can only belong to that constituency — and recorded them
in the release's `INFERRED-EDGES.csv`.

The file holds **56 rows covering 55 distinct wards.** Ward `inec-ward-6511`
(IFO / SUNREN) appears twice: once for its original inference onto
`state-assembly-sc-728-og`, and again when the build moved it to
`state-assembly-sc-729-og` to give a constituency that would otherwise have had
no ward. The first row is superseded and is not retracted in the file. The
import takes the row matching the edge `territories.csv` actually records, and
refuses if no row matches it.

**Before this work that distinction did not survive the import.** The file was
written by the release build, was not listed in the manifest's checksummed
`files` block, was read by nothing at runtime, and `territories.csv` carried no
column marking an edge as inferred. Once loaded, all 236 edges were
indistinguishable.

Made machine-enforceable additively:

- `INFERRED-EDGES.csv` is now a checksummed manifest file, so the set cannot be
  quietly shrunk to make unreviewed edges look sourced.
- `Ward.stateConstituencyEdgeInferred` and `stateConstituencyEdgeInferenceBasis`
  record the inference. **Owned by the import.**
- `Ward.stateConstituencyEdgeReviewedAt` and `stateConstituencyEdgeReviewedBy`
  record human review. **Owned by governance, never written by the importer**,
  so re-importing a release cannot silently revoke a completed review.

An edge is usable when it is not inferred, or has been reviewed. Registration on
a ward failing that test is refused with `ANCESTRY_EDGE_UNREVIEWED` and writes
nothing.

**No edge is reviewed by this work.** Reviewing them is a data-governance
action, not an engineering one. Until it happens, those 55 wards cannot register
members and existing members on them are reported but never repaired.

## Backfill

`npm run backfill:member-ancestry -- --dry-run`
`npm run backfill:member-ancestry -- --apply`

Neither mode reads the existing ancestry columns as input; ancestry is
recomputed from `wardId` every time, because the columns are the thing being
repaired. Dry run reports: total examined, already correct, null ancestry
eligible for derivation, stale/conflicting ancestry, incomplete territory graph,
unreviewed inferred-edge records, outside-Ogun records, and how many rows would
change. It writes nothing.

Apply updates only rows whose ancestry can be proved from the graph, skips and
reports unreviewed inferred-edge rows, deletes nothing, and is idempotent — a
second run changes zero rows.

Where stored ancestry **conflicts** with the ward, the canonical ward ancestry
wins, because a disagreement is by definition the client-era value. Every such
correction is listed individually before it is made.

## The denormalised columns

The three columns on `VoterProfile` remain, and are useful for indexing. After
this work they are **materialised server-derived projections, not client-owned
truth.** The authoritative relationship is the territory graph rooted in the
validated Ward and Polling Unit. Anything writing them must derive them from the
graph.

The command dashboard (`apps/api/src/routes/dashboard.ts`) now scopes members by
joining through `ward` to the constituency graph, mirroring what
`pollingUnitWhereFor` already did. That is correct for rows the backfill has not
reached, because a member's ward is not nullable.

`scripts/verify-ancestry-authority.mjs` fails the build if the registration path
regains a direct client-to-profile ancestry write, if the request contract
regains the fields, or if the derivation is removed. It asserts the derivation is
present before checking for its misuse, so it cannot pass vacuously.

## Status

| Aspect | Status |
|---|---|
| Code path | **Implemented** |
| Registration derivation | **Server-owned** |
| Compatible reviewed records | **Backfillable** |
| Unreviewed inferred mappings | **Fail-closed / operationally blocked** |
| Operational completeness | **Pending human review of the 55 inferred edges** |
| Production readiness | **Not claimed** |
