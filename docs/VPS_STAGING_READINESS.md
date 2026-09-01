# VPS Staging Readiness

- **Baseline:** `main @ c41d23ad87189331680723d4a30ef10a22d30717`
- **Assessment date:** 2026-08-10
- **Companion:** [`docs/SPRINT_4_FINAL_AUDIT.md`](SPRINT_4_FINAL_AUDIT.md) (feature status)
- **Nothing is deployed.** No VPS, no DNS, no TLS certificate, no object storage
  bucket, no running TURN server.

## Deployment asset audit

| Component | Result | Evidence |
|---|---|---|
| Dockerfiles (web, api, worker) | PASS | `deploy/docker/*.Dockerfile`, multi-stage, Node 22 Debian slim, non-root, no baked secrets. All three build locally. |
| Production Compose | PASS | `docker-compose.prod.yml`, internal-only network, resource ceilings, log rotation. Brought up locally with all 7 services healthy. |
| Caddy | PASS | `deploy/caddy/Caddyfile`; verified locally: `/healthz`, `/`, `/api/*` prefix strip, and Socket.IO handshake with `upgrades:["websocket"]`. |
| PostgreSQL persistence | PASS | Named volume, `pg_isready` healthcheck, no published port, deterministic `--locale=C` initdb. |
| Redis | PASS | AOF `everysec`, `maxmemory-policy noeviction` so queue state is never silently evicted, no published port. |
| BullMQ Worker | PASS | `apps/worker`, three queues, health endpoint reporting pending/processing/deadLetter, 60s stop grace. Verified processing jobs live. |
| S3 storage contract | PASS | `packages/object-storage`, SigV4, overwrite denial, presigned reads; production env validation rejects any driver but `s3`. **No bucket provisioned.** |
| Coturn configuration | PARTIAL | Config renders, listener accepts TCP, credentials 600, 20 deny ranges enforced (a relay to `172.20.0.4` was actively refused). **Relay data path unproven** — 100% packet loss through Docker Desktop bridge NAT, which is precisely why production uses host networking. |
| Health checks | PASS | All seven services define one; all reached healthy locally. |
| Graceful shutdown | PASS | API closes gateway then server; worker closes BullMQ workers before connections. Verified `shutdown.started` → `shutdown.complete` on restart. |
| Migration service | PASS | One-shot `migrate` target; every long-running service gates on `service_completed_successfully`, so containers cannot race the stream. |
| Migration checksum verification | PASS | `verify-migration-integrity.mjs` runs before `migrate deploy`; 17 legacy + 10 Ogun locked. |
| Backup procedure | PASS | `npm run verify:backup-restore` — dumps, **drops the database**, recreates empty, restores with `--exit-on-error`, requires exit 0, compares content **and** schema fingerprints (82 tables, 1803 schema objects). Fail-closed verified by fault injection. |
| Restore procedure | PASS | Same rehearsal; `pg_restore_exit=0`, both fingerprints match. |
| Load/recovery rehearsal | PASS | 500 jobs, 0 lost, 200/200 exclusive claims, 200/200 stranded recovered. |
| Secrets/env contract | PASS | `.env.production.example` complete, no secrets committed, `verify:deployment` guards against committed credentials and published data-tier ports. |
| Legacy auto-deploy removal | PASS | `render.yaml` (which carried `autoDeploy: true`) and `apps/web/vercel.json` deleted; `verify:deployment` fails if any such artifact reappears anywhere in the tree. |

**Overall: PASS with Coturn PARTIAL.**

## Tests that cannot honestly be completed without a Linux VPS

These are not code defects. Each requires a real host, real DNS, or a real
external service, and none can be settled on a Windows workstation.

| # | Outstanding test | Why it needs a VPS |
|---|---|---|
| 1 | DNS resolution to the host | No domain points anywhere yet |
| 2 | Caddy ACME certificate issuance | Requires public DNS + reachable :80 |
| 3 | Public HTTPS end-to-end | Depends on (1) and (2) |
| 4 | WebSocket upgrade through the public proxy | Local test used plain HTTP on a bridge |
| 5 | Redis restart under the Linux deployment | Verified locally; not on target topology |
| 6 | Worker restart under the Linux deployment | Verified locally; not on target topology |
| 7 | Private S3 bucket connectivity | No bucket exists |
| 8 | Evidence upload/download against real object storage | Covered locally only by the in-memory driver |
| 9 | Coturn allocation on Linux host networking | Bridge NAT invalidates the local result |
| 10 | ICE candidate of `type=relay` observed in a browser | Requires (9) **and** the client SDP/ICE gap in Feature 110 to be closed first |
| 11 | TURN-relayed audio actually flowing | Same as (10) |
| 12 | Previous-image rollback against the migrated schema | Requires two deployed image versions |
| 13 | Backup shipped to an off-host location | No off-host target configured |
| 14 | Restore rehearsal inside staging | Rehearsed locally; not on target |
| 15 | Resource usage under realistic load | Needs production-shaped hardware |
| 16 | Monitoring/logging behaviour | `ERROR_TRACKING_DSN` / OTLP endpoint unset |
| 17 | Firewall verification | Coturn binds the host directly; ufw rules are its only gate |

**Item 10 has a code prerequisite.** Feature 110's client never exchanges SDP or
ICE, so even a perfectly working TURN server would not produce a relay
candidate. That gap must be closed before the TURN relay path can be tested at
all.

## Security residual risk

`npm audit`: **0 critical**, 4 high, 0 moderate, 1 low.

| Package | Severity | Reachable? | Control | Residual risk | Future remediation |
|---|---|---|---|---|---|
| `sharp` (under `next`) | HIGH | **No** | The worker pins `sharp@0.35.3` with patched libvips and resolves it as a nested dependency. Next's own copy is unreachable: `images.unoptimized = true`, no `next/image` imports, evidence served by signed URLs. | Vulnerable code present but never invoked | Clears with the Next 16 upgrade |
| `next` | HIGH | Partially | Aggregate finding over `postcss` and `sharp`; no separate Next code path reported | Build-time CSS processing of first-party stylesheets only | Dedicated Next 16 migration |
| `postcss` | HIGH | **No** | Affects CSS stringify of our own stylesheets; no untrusted CSS input exists | Build-time only, no request path | Clears with Next 16 |
| `xlsx` | HIGH | **No** | Moved to `devDependencies`, so absent from API and worker runtime images (`--omit=dev`). Bootstrap runs in the `migrate` image. The INEC workbook SHA-256 is **verified before parsing**, so a swapped workbook fails closed. | Operator-invoked bootstrap only, on a checksum-pinned file | Replace parser before accepting any external workbook |
| `esbuild` (via `tsx`) | LOW | **No** | Windows dev-server read path; dev tooling only | Not request-reachable in any deployed runtime | Track upstream `tsx` |

No advisory is suppressed. Confirmed: reachable evidence image processing uses
patched sharp; `xlsx` is not in the production runtime; workbook hash
verification precedes parsing.

## Readiness decisions

**VPS infrastructure staging is ready. Product/UAT staging is not.** The
repository is ready to provision on a Linux VPS for infrastructure validation of
TLS, Docker networking, Redis/BullMQ, object storage, Coturn, backup/restore,
resource behaviour, and rollback. Known application defects that do not require a
VPS remain and must be closed before real-user or production-like UAT. Staging
must therefore use synthetic, non-sensitive data, and **payouts must remain
disabled**.

### READY FOR VPS STAGING: **YES — INFRASTRUCTURE VALIDATION ONLY**

Every repository engineering gate is green on this baseline: migration integrity
(17 + 10), 50/50 integration tests, lint, build, all three production rehearsals
(schema-additivity, backup/restore, load/recovery), and zero critical advisories.
The deployment topology is complete enough to launch — Dockerfiles build, the
full seven-service compose stack came up healthy locally with working reverse
proxy, Socket.IO upgrade, Redis-backed realtime and durable job processing, and
migrations are gated behind a one-shot service that cannot race.

The scope of this YES is deliberately narrow. It covers the infrastructure
questions a workstation cannot answer: TLS issuance, host-networked TURN relay,
real S3 connectivity, Linux restart behaviour, backup/restore on the target,
resource limits under load, observability, and image rollback.

It does **not** mean the product is ready to be exercised. This same audit found
defects that need no VPS at all — the payout bypass, missing SDP/ICE
negotiation, national/legacy authorization leakage, unpopulated constituency
ancestry, the broken voter-card upload path, and unreadable derivatives. Those
are ordinary engineering, and provisioning a host does not advance any of them.

On the staging host, therefore:

- use synthetic, non-sensitive data only;
- keep payouts disabled — the redemption path can pay a member holding 1 point;
- do not upload real voter documents;
- do not run field UAT or operational campaign workflows.

### READY FOR PRODUCT / UAT STAGING: **NO**

Two independent reasons. First, none of the seventeen infrastructure validations
has been performed, because no staging environment exists yet. Second, and
separately, the product is not usable end-to-end by its intended roles: 13 of 140
features survive an end-to-end test, voice calls carry no audio, and the command
hierarchy below Federal Constituency cannot be populated without authoritative
Ogun data. Putting real users in front of that would surface findings the team
has already catalogued below.

### READY FOR PRODUCTION: **NO**

Production requires infrastructure staging *and* product/UAT staging to have
passed, and neither has begun. Beyond that, four features are BLOCKED on external
inputs the project does not control — the Ogun reference release, PU geodata, and
an approved evidence retention policy — and the P0 backlog below is open,
including a financial-integrity defect that must be closed before any real payout
runs.

---

## P0 — must close before product/UAT staging

None of these requires a VPS. They are the actual closure backlog this audit
surfaced, and they gate real-user exposure independently of infrastructure work.

### 1. Financial integrity
- Retire or reconcile the legacy redemption ledger (`RewardLedger` vs `RewardLedgerEntry`)
- Forbid a client-supplied payout value (`amountRequested` is currently caller-controlled)
- Enforce the configured minimum threshold on every money-out path
- Enforce the point conversion rate server-side
- One authoritative payout balance

### 2. Ogun-only enforcement
- Registration must reject a non-Ogun `stateId`
- Remove or disable the national admin exposure (`/admin`, `GeoPoliticalZone`, `NATIONAL`/`STATE` admin levels)
- Remove LGA as command authority in the legacy layer
- No all-37-state operational endpoint

### 3. Voice
- SDP offer/answer exchange
- ICE candidate exchange
- Realtime ringing notification to the callee
- Callee receive/accept flow
- **Only then** perform TURN relay validation — items 10 and 11 of the staging
  list cannot pass before this

### 4. Member ancestry — CODE PATH CLOSED, OPERATIONALLY BLOCKED
- ~~Derive State → Senatorial District → Federal Constituency → State Constituency → Ward → Polling Unit~~ — `apps/api/src/lib/member-ancestry.ts`
- ~~Populate ancestry on the real registration/write path~~ — derived inside the registration transaction; the three constituency ids were removed from the public request contract
- ~~Repair or backfill existing compatible records~~ — `npm run backfill:member-ancestry` (dry-run / apply, idempotent)
- ~~Dashboards must read real ancestry, not nullable denormalised columns~~ — the command dashboard scopes members by joining through the ward graph

**This does not make member ancestry operationally complete.** 55 of the 236
ward → State Constituency edges in the Ogun identity release are inferred and
still unreviewed (recorded as 56 rows; one ward is listed twice, the earlier
row superseded). Registration on those wards fails closed with
`ANCESTRY_EDGE_UNREVIEWED`, and the backfill reports but never repairs members
sitting on them. Those wards cannot register members until the edges are
reviewed, which is a data-governance action and not an engineering one.

See [`docs/MEMBER_ANCESTRY.md`](MEMBER_ANCESTRY.md).

| Aspect | Status |
|---|---|
| Code path | Implemented |
| Registration derivation | Server-owned |
| Compatible reviewed records | Backfillable |
| Unreviewed inferred mappings | Fail-closed / operationally blocked |
| Operational completeness | Pending human review of the 56 inferred edges |
| Production readiness | Not claimed |

### 5. Voter-card upload
- Perform an actual private-object-storage upload
- No fabricated client-side storage key
- Server-owned metadata, hash, and access path

### 6. Evidence derivatives
- Signed/private derivative read endpoint
- Originals remain authoritative
- Video stays PARTIAL until a transcoding runtime exists

---

## Sequencing after this audit

The two workstreams are independent and should run in parallel rather than
serially. Spending the next sprint only on the seventeen infrastructure tests
would leave the product backlog untouched, and closing the product backlog
without a host would leave the infrastructure unproven.

| Track A — VPS infrastructure staging | Track B — product closure |
|---|---|
| TLS / Caddy | Financial ledger |
| Redis | Ogun-only enforcement |
| Worker | Voice SDP/ICE |
| S3 | Territory ancestry |
| Coturn | Voter-card storage |
| Backup/restore | Derivative access |
| Rollback | |
| Monitoring | |
| Resource/load | |

`READY FOR PRODUCT UAT: YES` may only be declared when **both** tracks converge.
