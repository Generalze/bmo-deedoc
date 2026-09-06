# VPS Deployment and Operations

- **Production target:** single Linux VPS running Docker Compose
- **Status:** runtime topology implemented and validated locally. **Nothing is deployed.** No VPS has been provisioned, no bucket exists, no TURN server is running.

```text
Internet
   ↓
Caddy (TLS, :80 :443)
   ↓
Docker Compose (internal network)
   ├── Next.js Web          :3000
   ├── Express API + Socket.IO  :4000
   ├── BullMQ Worker        :4100 (health only)
   ├── PostgreSQL           :5432  (never published)
   └── Redis                :6379  (never published)

Coturn (host network, TURN relay)
Private S3-compatible object storage (external service)
```

**Two services are internet-facing: Caddy and Coturn.**

Caddy publishes 80/443 through Docker port mappings. Coturn is *not* behind a
port mapping — it runs with host networking, so it binds the VPS's interfaces
directly and is exposed on whatever ports the firewall permits. Both must be
treated as public attack surface.

Web, API, and worker are reachable only through Caddy. PostgreSQL and Redis
publish no ports at all and exist only on the internal compose network.

Because Coturn binds the host directly, the firewall rules in §3 are the only
thing limiting its exposure — there is no Docker port mapping acting as a second
gate. Coturn also relays to arbitrary peer addresses by design, so its
`denied-peer-ip` list is what stops an authenticated client using the relay to
reach PostgreSQL, Redis, the Docker bridge networks, the host, or the cloud
metadata endpoint.

---

## 1. Initial VPS setup

Minimum practical sizing: 4 vCPU, 8 GB RAM, 80 GB SSD. The worker generates image derivatives, which is memory-hungry in bursts.

```bash
# Docker Engine + Compose plugin
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # re-login afterwards

# Confirm
docker --version && docker compose version
```

Create a deploy user, disable password SSH login, and enable unattended security updates before exposing anything.

## 2. DNS

Point an A record at the VPS public IP **before** first start. Caddy performs an ACME HTTP challenge on first boot and will fail if DNS does not resolve.

```text
ops.example.org.   A   203.0.113.10
```

If TURN is served from the same host, its realm should be the same name.

## 3. Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp                  # SSH — restrict to your admin IP if possible
sudo ufw allow 80/tcp                  # ACME challenge + HTTP→HTTPS redirect
sudo ufw allow 443/tcp                 # HTTPS
sudo ufw allow 443/udp                 # HTTP/3
sudo ufw allow 3478/tcp                # TURN listener
sudo ufw allow 3478/udp                # TURN listener
sudo ufw allow 5349/tcp                # TURN over TLS — only if TURN TLS is enabled (§5a)
sudo ufw allow 5349/udp                # TURN over DTLS — only if TURN TLS is enabled (§5a)
sudo ufw allow 49160:49200/udp         # TURN relay range — must match TURN_MIN_PORT/TURN_MAX_PORT
sudo ufw enable
```

The relay range is the one most often forgotten. Without it, calls negotiate and then carry no audio.

Do **not** open 5432 or 6379. They are internal to the compose network.

## 4. Environment and secrets

```bash
git clone https://github.com/masterzee001/bmo-deedoc.git
cd bmo-deedoc
cp .env.production.example .env.production
chmod 600 .env.production
$EDITOR .env.production
```

Generate real secrets:

```bash
openssl rand -base64 48    # JWT_SECRET
openssl rand -base64 32    # POSTGRES_PASSWORD
openssl rand -base64 32    # TURN_CREDENTIAL
```

`.env*` is gitignored. Never commit it, and never bake it into an image.

**Object storage must be provisioned separately.** Create a private, versioned S3-compatible bucket with no public read, then set `STORAGE_*`. The API refuses to start in production with any driver other than `s3`. Nothing in this repository creates the bucket.

## 4a. TURN TLS policy (explicit)

TURN-over-TLS is **opt-in and off by default**, and the container fails to start
rather than serving a broken TLS listener.

| `TURN_TLS_CERT` / `TURN_TLS_KEY` | Result |
|---|---|
| Both set and readable | `turns:` enabled on `TURN_TLS_PORT`, TLS 1.2+ with modern ciphers |
| Neither set | `no-tls` and `no-dtls` — listeners explicitly disabled |
| Only one set, or unreadable | **Container refuses to start** |

Why off by default: declaring a TLS port without a certificate is worse than no
TLS at all, because coturn would advertise an endpoint that cannot complete a
handshake — a client configured with a `turns:` URI fails while looking correctly
configured.

Turning it off does not weaken call confidentiality. **WebRTC media is already
end-to-end encrypted with DTLS-SRTP** no matter how it is relayed. TURN-over-TLS
buys traversal of firewalls that only allow 443, and conceals that the traffic is
TURN — real benefits, but not media secrecy.

Enable it when field devices sit behind restrictive corporate or carrier
firewalls. Mount a certificate into the container and set both variables:

```yaml
# docker-compose.prod.yml, coturn service
volumes:
  - /etc/letsencrypt/live/ops.example.org:/etc/coturn/tls:ro
environment:
  TURN_TLS_CERT: /etc/coturn/tls/fullchain.pem
  TURN_TLS_KEY: /etc/coturn/tls/privkey.pem
```

Then set `TURN_URL=turns:ops.example.org:5349` and open 5349/tcp and 5349/udp.
With TLS disabled, leave those ports closed.

## 5. Database migration

Migrations are run by a dedicated one-shot `migrate` service. Every long-running service declares `depends_on: migrate: service_completed_successfully`, so **containers cannot race the migration stream** — a restarting API replica will never apply migrations concurrently with another.

The migrate service verifies checksums before applying anything and refuses to deploy if an existing migration was modified.

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm migrate
```

`packages/database/prisma.config.ts` disables dotenv loading, so Prisma reads `DATABASE_URL` from the **process environment only**. Any manual invocation must pass it explicitly:

```bash
DATABASE_URL="postgresql://..." npx prisma migrate deploy --config packages/database/prisma.config.ts
```

## 6. First-deploy bootstrap (once, never on restart)

Reference data and the Super Admin are seeded by an explicit one-off command, deliberately **not** part of container startup. A restart never re-seeds and never mutates existing records.

Run it in the **`migrate` image, not `api`**. Bootstrap needs the reference-data
scripts and their tooling — `tsx`, the Prisma CLI, and the spreadsheet parser —
all of which are development dependencies deliberately excluded from the API
runtime image. Pointing this at `api` fails with missing modules.

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm \
  -e SUPER_ADMIN_EMAIL=... -e SUPER_ADMIN_PASSWORD=... \
  migrate npm run deploy:bootstrap
```

The reference import refuses to parse an INEC workbook whose SHA-256 does not
match the approved file, so a swapped or corrupted source fails closed rather
than silently importing altered electoral boundaries.

There is no demo or fixture seeding path in production.

## 7. Start

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml ps
```

Startup order is enforced by health conditions: postgres and redis become healthy → migrate runs to completion → api and worker start → web starts → caddy starts.

## 8. Health checks

| Service | Check |
|---|---|
| Edge | `curl -fsS https://ops.example.org/healthz` |
| Web | `curl -fsS https://ops.example.org/health` |
| API | `docker compose -f docker-compose.prod.yml exec api wget -qO- http://127.0.0.1:4000/health` |
| Worker | `docker compose -f docker-compose.prod.yml exec worker wget -qO- http://127.0.0.1:4100/health` |
| Postgres | `docker compose -f docker-compose.prod.yml exec postgres pg_isready -U "$POSTGRES_USER"` |
| Redis | `docker compose -f docker-compose.prod.yml exec redis redis-cli ping` |

The worker health payload also reports `pending`, `processing`, and `deadLetter` job counts. A climbing `deadLetter` count is the signal that jobs are failing permanently and need operator attention.

Realtime readiness is reported at `GET /election-day/realtime-contracts`. In production it must read `AVAILABLE`; `DEGRADED_NO_REDIS` means the adapter never connected.

## 9. Logs

```bash
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml logs -f worker --since 15m
```

Logs are JSON, capped at 10 MB × 5 files per service so a chatty container cannot fill the disk.

## 10. Restart and graceful shutdown

```bash
docker compose -f docker-compose.prod.yml restart api
```

The API closes its realtime gateway and HTTP server on SIGTERM. The worker closes its BullMQ workers before its connections, so an in-flight job records its outcome instead of being stranded — it gets a 60 s grace period for that reason.

If a worker is killed anyway, jobs left in `PROCESSING` beyond `WORKER_STALE_PROCESSING_MINUTES` are automatically swept back to `PENDING` and retried.

## 11. PostgreSQL backup

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom \
  > "backup-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Schedule daily, ship off-host, and **test the restore** — an untested backup is not a backup. Evidence originals live in object storage and are covered by that provider's versioning, not by `pg_dump`.

## 12. Restore

```bash
docker compose -f docker-compose.prod.yml stop api worker web
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists < backup.dump
docker compose -f docker-compose.prod.yml start api worker web
```

Stop the application tier first so nothing writes during the restore.

## 13. Redis recovery

Redis holds queues, realtime fan-out, and presence — never business truth. A total Redis loss is recoverable:

```bash
docker compose -f docker-compose.prod.yml restart redis
```

Accepted background work survives, because the API records every job as a durable `BackgroundJob` row in PostgreSQL and never requires Redis to accept it. The worker sweeps `PENDING` rows back into BullMQ on its next poll. **Losing Redis delays work; it does not lose accepted work.**

Undelivered realtime events survive in `RealtimeEventOutbox` and are replayed. Clients additionally reconcile through `GET /election-day/realtime/replay`.

`maxmemory-policy` is `noeviction` on purpose: silently evicting queue state would lose jobs. If Redis fills, writes fail loudly instead.

## 14. Worker recovery

```bash
docker compose -f docker-compose.prod.yml restart worker
docker compose -f docker-compose.prod.yml exec worker wget -qO- http://127.0.0.1:4100/health
```

Inspect dead letters before clearing them:

```sql
SELECT "jobName", "attempts", "lastError", "updatedAt"
FROM "BackgroundJob" WHERE status = 'DEAD_LETTER' ORDER BY "updatedAt" DESC LIMIT 50;
```

## 15. Coturn verification

Config parsing is not proof of function. Verify an actual relay allocation:

```bash
docker compose -f docker-compose.prod.yml logs coturn | tail -30

# Requires coturn-utils locally
turnutils_uclient -v -u "$TURN_USERNAME" -w "$TURN_CREDENTIAL" ops.example.org
```

Then confirm the application agrees: `GET /election-day/webrtc/config` must report `turnConfigured: true`. It reports `false` unless `TURN_URL` is a valid `turn:`/`turns:` URI **and** both credentials are set, so a half-configured relay is never advertised as working.

Browser-side check: open the call panel, start a call, and confirm an ICE candidate of type `relay` appears. Candidates of type `srflx` only mean STUN worked, not TURN.

`recording` is always `DISABLED`. No call media is captured or persisted anywhere in this topology.

## 15a. Pre-deploy rehearsals

Run these before any production deploy. Each spins its own disposable PostgreSQL
container and never touches a real database.

```bash
npm run rehearse:production      # all three
```

| Rehearsal | What it proves |
|---|---|
| `npm run rehearse:migration` | **Schema additivity only.** Pending migrations apply to a **populated** database; no table or column removed, no type changed, no column tightened to `NOT NULL`, no default removed; idempotent on re-apply. Reports forward duration. Does **not** prove the previous image still serves — see §16a. |
| `npm run verify:backup-restore` | The documented `pg_dump`/`pg_restore` commands recreate the database after **total loss**. Seeds data, dumps, **drops the database**, creates an empty one, restores into it, requires `pg_restore` exit 0 under `--exit-on-error`, then compares both content and schema fingerprints. |
| `npm run verify:load-recovery` | Under concurrency: no job lost on enqueue, replaying every idempotency key creates nothing new, contended claims are exclusive (exactly one winner per row), and stranded jobs all return to `PENDING`. |

The migration rehearsal accepts a real dump for the highest-fidelity run:

```bash
npm run rehearse:migration -- --from-dump backup-20260810.dump
```

Rehearsing against empty tables proves very little — table rewrites, `NOT NULL`
additions, and unique-index creation only fail with rows present.

## 15b. Staging

Staging runs the same topology with the same settings. An environment that is
relaxed is not testing what you are about to ship.

Three things separate it from production, and they are the reason
`.env.staging.example` exists rather than a copy of the production contract:

1. **It never touches production data.** Different database, different bucket,
   different Redis, different JWT secret. A staging instance pointed at the
   production bucket lets a UAT tester open a real member's identity document,
   and a shared JWT secret means a token minted on staging is valid in
   production.
2. **It carries synthetic people only.** Real voter records are personal data
   belonging to real Nigerians and do not belong in a test system.
3. **Payouts stay off.** Staging proves the payout path refuses correctly. It is
   not where money moves.

### Bringing staging up

```bash
cp .env.staging.example .env.staging          # then fill it in
npm run verify:repository                     # includes the TURN cross-check
npm run verify:turn -- --env-file .env.staging

docker compose -f docker-compose.prod.yml --env-file .env.staging up -d --wait
npm run deploy:migrate
npm run deploy:bootstrap
npm run import:reference:ogun -- --release-dir reference/ogun/<release-id> --apply
```

### Synthetic operators for UAT

The seed creates no people on purpose. Staging needs one of each role so a
tester can exercise a flow end to end:

```bash
STAGING_PERSONA_PASSWORD='<at least 12 characters>' npm run bootstrap:staging-personas
```

It resolves a real Ogun ward — one whose State Constituency edge has been
reviewed, because registration refuses an unreviewed one — and attaches every
persona to it. It invents no territory, and it fabricates no
voter-registration document: a synthetic identity document is exactly what the
validator queue must never be trained to accept.

It refuses to run against a database holding accounts that are not staging
personas, which is what stops it being pointed at production by accident.

### Post-deploy verification

```bash
npm run smoke:deployment -- --api https://staging.ops.example.org/api                             --web https://staging.ops.example.org
```

Read-only, unauthenticated, creates nothing. It checks that the deployment is
**correct and safe**, not merely that it answers:

| Check | Why it is here |
|---|---|
| `/readyz` returns 200 | `/health` answers `ok` unconditionally, so a deployment can report healthy with no database behind it. |
| Database and Ogun reference data reachable | Without reference data a member cannot register at all: the server derives their constituency chain from the ward. |
| `PAYOUT_EXECUTION_ENABLED` is false | The single most consequential thing to get wrong on a fresh deployment. Pass `--expect-payouts-enabled` only when it was deliberate. |
| Only Ogun is offered publicly | A deployment offering more than Ogun is serving the wrong product. |
| Protected routes refuse anonymous callers | |
| Security headers present | |
| The site root forwards to the single sign-in door | |

A non-zero exit is a failed deployment. It must never be converted into a pass.

---

## 16. Rollback

Images are tagged by `IMAGE_TAG`. To roll back application code:

```bash
IMAGE_TAG=<previous-tag> docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

**Migrations do not roll back automatically.** The stream is additive by policy — new tables, columns, and enum values only — so a previous application image is *expected* to keep running against a newer schema. That is the intended rollback path.

If a migration itself must be reversed, restore the database from backup (§12) and redeploy the matching image. Never hand-edit an applied migration: checksums are locked and `verify:migrations` will fail the next deploy.

### 16a. Previous-image rollback test — required before production

`npm run rehearse:migration` proves **schema additivity only**: nothing removed,
nothing retyped, nothing tightened, idempotent on re-apply. That is a *necessary*
condition for rollback, not a sufficient one.

It cannot prove the previous image still serves correctly. Runtime compatibility
depends on query shapes, Prisma client expectations, enum handling, and
constraint interactions — none of which a schema comparison can establish. A
migration can be perfectly additive and still break the previous image, for
example by adding a `NOT NULL` column with a default that older insert paths do
not supply, or by adding a unique constraint that older write paths violate.

The real test runs on staging, against a production-shaped database, and is
**outstanding** — no VPS exists yet:

```text
1. Restore a production-shaped dump into the staging database.
2. Deploy the NEW image and run the migration stream against it.
3. Smoke-test the NEW image: login, verification decision, referral/reward,
   payout assignment, PU check-in, incident, evidence upload, dashboard,
   Situation Room, and a voice call.
4. Switch the application containers to the PREVIOUS image, leaving the
   migrated schema in place:
       IMAGE_TAG=<previous> docker compose -f docker-compose.prod.yml \
         --env-file .env.production up -d web api worker
   Do NOT re-run migrations.
5. Re-run the same smoke tests against the PREVIOUS image on the NEW schema.
   Any failure here means the migration is not truly rollback-safe, regardless
   of what the additivity rehearsal reported.
6. Switch back to the NEW image and confirm the smoke tests pass again.
```

Record the result against the specific migration range tested. Until step 5 has
passed on staging, rollback safety for that release is **unverified**, and the
additivity rehearsal must not be cited as evidence of it.

---

## What is not covered here

- Multi-host scale-out. The topology is intentionally single-VPS; service boundaries allow later separation without application redesign.
- Off-host log shipping, metrics, and alerting (`ERROR_TRACKING_DSN` and `OTEL_EXPORTER_OTLP_ENDPOINT` are wired but unset). Staging is the right place to find out whether a trace tells you anything.
- Automated backup scheduling. §11 gives the command; cron or a systemd timer is an operator decision.
