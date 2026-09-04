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

- `INFERRED-EDGES.csv` is now a checksummed manifest file **produced by the
  release builder**, so the set cannot be quietly shrunk to make unreviewed edges
  look sourced. It is **required** for an identity release: a missing file means
  the provenance is unknown, not that nothing was inferred, and the import
  refuses it rather than marking 55 guesses as sourced.
- `Ward.stateConstituencyEdgeInferred` and `stateConstituencyEdgeInferenceBasis`
  record the inference. **Owned by the import.**
- `Ward.stateConstituencyEdgeReviewedAt` and `stateConstituencyEdgeReviewedBy`
  record human review. **Owned by governance, never written by the importer**,
  so re-importing a release cannot silently revoke a completed review.

An edge is **operational** when it is not inferred, or has been reviewed.
Registration on a ward failing that test is refused with
`ANCESTRY_EDGE_UNREVIEWED` and writes nothing.

Provenance is initialised **during the database upgrade**, not only by the
importer. The column-adding migration defaults `stateConstituencyEdgeInferred` to
`false`, and no deploy path runs the importer — so on a database that imported
the release before the columns existed, migrating forward would have left all 236
wards reading "sourced" and the gate would have had nothing to refuse. A second
additive migration,
`20260902120000_backfill_ward_constituency_edge_provenance`, sets the 55 wards
from data inlined at generation time, keyed on ward identity **and** the
constituency actually loaded for it. It asserts 236 wards / 55 inferred / 181
sourced and that no review was created, and fails closed if the database does not
match the canonical release. It never writes the review columns, and it skips
entirely on a database with no Ogun wards, where the importer will set provenance
instead.

**No edge is reviewed by this work.** Reviewing them is a data-governance
action, not an engineering one. Until it happens, those 55 wards cannot register
members and existing members on them are reported but never repaired.

### The review itself

`POST /governance/inferred-edges/:wardId/approve` and `.../reject`, Super Admin
only, one edge at a time. There is deliberately no bulk decision: approving 55
inferences in one action is indistinguishable from not reviewing them.

A decision names the exact State Constituency the reviewer was shown, and the
server compares it against the ward's current edge before recording anything —
if a release re-points the ward between the screen loading and the button being
pressed, the submission is refused with `EDGE_CHANGED_RELOAD` rather than
applied to a mapping nobody looked at. An approval is stored as
`Ward.stateConstituencyEdgeApprovedForId`, and the importer clears it whenever
it moves the edge, so an approval can never follow a ward to a constituency
nobody approved.

**A review timestamp is not permission.** A rejection is a decision too and
stamps `stateConstituencyEdgeReviewedAt` like an approval does, so
`isWardConstituencyEdgeOperational` keys on the approved constituency id and
nothing may read the timestamp as authority:

| State | Operational |
|---|---|
| Sourced edge | Yes |
| Inferred, approved for this exact edge | Yes |
| Inferred, approved for a different edge | No |
| Inferred, rejected | No |
| Inferred, undecided | No |

**The database refuses a projection that names an edge the ward does not have.**
`Ward_edge_approval_matches_current_edge_check` requires a non-null approval to
sit on an inferred edge, with a non-null current constituency, equal to it. The
inferred and non-null tests are spelled out rather than relying on
`approvedForId IS NULL OR approvedForId = stateConstituencyId`, because a CHECK
admits a row whose predicate evaluates to NULL — the short form would accept
exactly the state it exists to forbid. That constraint is what makes the
null-checking scope filter provably equivalent to the row rule instead of
equivalent by argument: **the application transaction tries to preserve the
invariant; the database makes violating it impossible.**

Decisions are taken against a `SELECT … FOR UPDATE` on the ward, so an import
re-pointing the edge mid-review is seen before the write rather than after it,
and two reviewers deciding at once serialize on the same row. Decision time is
assigned under that lock and forced past the previous decision, so "newest" is a
fact rather than a race between two timestamps.

**A decision governs only its own review subject** — ward, constituency,
reference release and inference basis. A ward moved away and later moved back is
offered for review again rather than inheriting the earlier verdict, and an
approval whose projection has since been cleared reads as `PENDING`, not
`APPROVED`, so a blocked ward can never hide from the queue. The earlier
decision stays visible as history.

Rejection records that a human looked and said no. It never writes
`Ward.stateConstituencyId`: correcting a wrong mapping is a reference-data
change, and the importer owns that column. Every decision writes an `AuditLog`
entry carrying the edge, the reason, the inference basis and the member and
coordinator counts at the time. Coordinators are reported for decision impact
and are never modified — coordinator territory provenance is separate work.

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

### One member-territory scope

`apps/api/src/lib/member-territory-scope.ts` owns
`buildOperationalVoterProfileTerritoryWhere`, and both consumers call it: the
command dashboard's member counts and the pre-election strength engine's snapshot
calculation. They previously defined member territory separately — the dashboard
on the ward graph, the strength engine on the nullable columns — and because the
dashboard prefers a snapshot over its own live count, a strength score of zero
could be printed beside a tile counting hundreds.

**Constituency-level counts exclude unreviewed inferred edges.** If the write
path declines to say which constituency a member is in, the read path must not
answer anyway. A member whose ward edge is unreviewed is still counted at STATE,
WARD and POLLING_UNIT — those do not depend on the disputed edge — and is counted
at STATE_CONSTITUENCY, FEDERAL_CONSTITUENCY and SENATORIAL_DISTRICT only once the
edge is reviewed.

**Polling units follow the same rule.** `buildOperationalPollingUnitTerritoryWhere`
applies the identical predicate, so a constituency cannot show polling units it
will not place a member in. That matters beyond tidiness: the derived strength
score divides coverage by polling units, so counting the two halves under
different scopes produced a non-zero strength for a constituency with no
placeable members.

**Strength snapshots are scope-versioned.** New snapshots record
`memberTerritoryScopeVersion` in their breakdown JSON, and
`selectCurrentMemberTerritorySnapshots` is the single rule every strength
surface uses — the command dashboard, `GET /pre-election/strength/snapshots/latest`,
`GET /pre-election/strength/dashboard` and its child roll-ups. A snapshot from an
older generation is ignored and the surface falls back to its live calculation.
Old snapshots are not rewritten: they record what was calculated at the time.

**Trend compares like with like.** Trend is derived only from snapshots of the
current generation. Comparing the first correct score against a pre-version zero
would report `IMPROVING` for what is only a change in how the number is derived.

**An unknown territory type fails closed.** Both helpers raise
`UnsupportedMemberTerritoryType` rather than falling off the end of their switch.
A scoping authority that returns `undefined` reaches Prisma as
`count({ where: undefined })` — every row in the table — so an unrecognised level
must refuse to answer rather than answer "everywhere".

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
| Constituency-level counts | **Exclude unreviewed inferred edges** |
| Strength snapshots | **Scope-versioned; obsolete ones cannot override live truth** |
| Operational completeness | **Pending human review of the 55 inferred edges** |
| Production readiness | **Not claimed** |
