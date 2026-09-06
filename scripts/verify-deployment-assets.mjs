/**
 * Static checks on the production deployment assets.
 *
 * These guard the invariants that are easy to break silently in a compose file
 * and expensive to discover on a live VPS: a database port accidentally
 * published, migrations racing application containers, a credential committed
 * into a config template, or a legacy auto-deploy path reappearing.
 *
 * This validates configuration only. It does not prove any service runs.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function read(relativePath) {
  const full = path.join(repoRoot, relativePath);
  if (!existsSync(full)) {
    failures.push(`Missing deployment asset: ${relativePath}`);
    return null;
  }
  return readFileSync(full, "utf8");
}

const requiredAssets = [
  "docker-compose.prod.yml",
  "deploy/docker/api.Dockerfile",
  "deploy/docker/web.Dockerfile",
  "deploy/docker/worker.Dockerfile",
  "deploy/caddy/Caddyfile",
  "deploy/coturn/turnserver.conf.template",
  "deploy/coturn/entrypoint.sh",
  ".env.production.example",
  ".env.staging.example",
  "deploy/storage/bucket-policy.json",
  "deploy/storage/README.md",
  "docs/DEPLOYMENT_VPS.md",
  ".dockerignore",
];

const contents = new Map();
for (const asset of requiredAssets) {
  const body = read(asset);
  if (body !== null) {
    contents.set(asset, body);
  }
}

const compose = contents.get("docker-compose.prod.yml") || "";

// The data tier must never be reachable from the host. A published 5432 or
// 6379 on a public VPS is an immediate compromise path.
for (const forbidden of ['"5432:5432"', '"6379:6379"', "5432:5432", "6379:6379"]) {
  if (compose.includes(forbidden)) {
    failures.push(`Production compose publishes a data-tier port (${forbidden}); postgres and redis must stay internal.`);
  }
}

// Application containers must wait for the one-shot migrator, so two replicas
// can never apply the migration stream concurrently.
for (const service of ["api:", "worker:"]) {
  const block = compose.slice(compose.indexOf(`\n  ${service}`));
  const nextService = block.slice(1).search(/\n {2}[a-z][a-z-]*:\n/);
  const scoped = nextService > 0 ? block.slice(0, nextService) : block;
  if (!scoped.includes("service_completed_successfully")) {
    failures.push(`Service ${service.replace(":", "")} does not depend on the migrate job completing; migrations could race.`);
  }
}

// Checksum verification may live either in the compose command or in the
// migrate image's own entrypoint. What matters is that the migration path
// cannot apply a modified migration, not where the guard is declared.
const apiDockerfile = contents.get("deploy/docker/api.Dockerfile") || "";
const migratePathVerifies =
  compose.includes("verify-migration-integrity.mjs") || apiDockerfile.includes("verify-migration-integrity.mjs");
if (!migratePathVerifies) {
  failures.push("The migrate path must verify migration checksums before applying the stream.");
}
if (!/FROM\s+\S+\s+AS\s+migrate/.test(apiDockerfile)) {
  failures.push("The api Dockerfile must define a dedicated migrate stage; the runtime image has no Prisma CLI.");
}
if (!/target:\s*migrate/.test(compose)) {
  failures.push("The compose migrate service must build the dedicated migrate target.");
}

// Seeding must be an explicit operator action, never part of container start.
if (/command:[\s\S]{0,400}bootstrap-super-admin|deploy:bootstrap/.test(compose)) {
  failures.push("Production compose must not run bootstrap/seed on container start.");
}

for (const service of ["postgres:", "redis:", "api:", "worker:", "web:", "caddy:", "coturn:"]) {
  if (!compose.includes(`\n  ${service}`)) {
    failures.push(`Production compose is missing the ${service.replace(":", "")} service.`);
  }
}

if (!compose.includes("restart: unless-stopped")) {
  failures.push("Production compose services must declare a restart policy.");
}

// Evidence originals live in external object storage. A bind mount or named
// volume presented as evidence storage would put authoritative records on
// ephemeral container disk.
if (/evidence[-_]?(data|store|storage)\s*:/i.test(compose)) {
  failures.push("Production compose appears to define local evidence storage; evidence originals must use external S3-compatible storage.");
}

const caddyfile = contents.get("deploy/caddy/Caddyfile") || "";
if (!caddyfile.includes("/socket.io/")) {
  failures.push("Caddy must proxy the Socket.IO path for realtime WebSocket upgrades.");
}
if (!caddyfile.includes("handle_path /api/*")) {
  failures.push("Caddy must expose the API under /api for the current frontend contract.");
}

const turnTemplate = contents.get("deploy/coturn/turnserver.conf.template") || "";
if (!turnTemplate.includes("__TURN_CREDENTIAL__") || !turnTemplate.includes("__TURN_USERNAME__")) {
  failures.push("Coturn template must take credentials from the environment via placeholders.");
}
if (!turnTemplate.includes("lt-cred-mech")) {
  failures.push("Coturn must require long-term credentials; an open relay is abused quickly.");
}
for (const placeholder of ["__TURN_REALM__", "__TURN_EXTERNAL_IP__", "__TURN_MIN_PORT__", "__TURN_MAX_PORT__", "__TURN_PORT__"]) {
  if (!turnTemplate.includes(placeholder)) {
    failures.push(`Coturn template is missing the ${placeholder} placeholder.`);
  }
}

// A TURN server relays to any peer address a client names. Without these denies
// an authenticated client can reach PostgreSQL, Redis, the Docker bridge, the
// host, or the cloud metadata endpoint through the relay.
const requiredDeniedRanges = [
  { label: "loopback", pattern: "denied-peer-ip=127.0.0.0-127.255.255.255" },
  { label: "RFC1918 10/8", pattern: "denied-peer-ip=10.0.0.0-10.255.255.255" },
  { label: "RFC1918 172.16/12 (Docker bridge)", pattern: "denied-peer-ip=172.16.0.0-172.31.255.255" },
  { label: "RFC1918 192.168/16", pattern: "denied-peer-ip=192.168.0.0-192.168.255.255" },
  { label: "carrier-grade NAT 100.64/10", pattern: "denied-peer-ip=100.64.0.0-100.127.255.255" },
  { label: "link-local / cloud metadata 169.254/16", pattern: "denied-peer-ip=169.254.0.0-169.254.255.255" },
  { label: "IPv4-mapped IPv6", pattern: "denied-peer-ip=::ffff:0.0.0.0-::ffff:255.255.255.255" },
  { label: "IPv6 unique local fc00::/7", pattern: "denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" },
  { label: "IPv6 link-local", pattern: "denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff" },
];
for (const range of requiredDeniedRanges) {
  if (!turnTemplate.includes(range.pattern)) {
    failures.push(`Coturn must deny relaying to ${range.label}; a relay to private space is an SSRF primitive.`);
  }
}

// TLS must be an explicit decision made at render time, never a bare port
// declaration that would advertise an endpoint with no usable certificate.
const turnEntrypoint = contents.get("deploy/coturn/entrypoint.sh") || "";
if (/^\s*tls-listening-port=/m.test(turnTemplate)) {
  failures.push("Coturn template declares tls-listening-port unconditionally; TLS must be resolved by the entrypoint.");
}
if (!turnTemplate.includes("__TLS_SECTION__")) {
  failures.push("Coturn template must delegate the TLS decision to the rendered __TLS_SECTION__ block.");
}
for (const marker of ["no-tls", "no-dtls", "TURN_TLS_CERT", "TURN_TLS_KEY"]) {
  if (!turnEntrypoint.includes(marker)) {
    failures.push(`Coturn entrypoint must implement an explicit TLS policy (missing ${marker}).`);
  }
}

// No committed secrets anywhere in the deployment assets.
const secretPattern = /(password|secret|credential|access[-_]?key)\s*[:=]\s*(?!.*(replace-me|replace-with|__|\$\{|\$[A-Z]|""|''|<|REQUIRED))\S{8,}/i;
for (const [asset, body] of contents) {
  if (asset === "docs/DEPLOYMENT_VPS.md") {
    continue;
  }
  for (const [index, line] of body.split("\n").entries()) {
    if (line.trim().startsWith("#") || line.trim().startsWith("//")) {
      continue;
    }
    if (secretPattern.test(line)) {
      failures.push(`Possible committed secret in ${asset}:${index + 1}`);
    }
  }
}

const exampleEnv = contents.get(".env.production.example") || "";
for (const key of [
  "DATABASE_URL",
  "REDIS_URL",
  "JWT_SECRET",
  "JWT_ISSUER",
  "JWT_AUDIENCE",
  "CORS_ALLOWED_ORIGINS",
  "NEXT_PUBLIC_API_BASE_URL",
  "NEXT_PUBLIC_REALTIME_URL",
  "STORAGE_ENDPOINT",
  "STORAGE_REGION",
  "STORAGE_BUCKET",
  "STORAGE_ACCESS_KEY",
  "STORAGE_SECRET_KEY",
  "TURN_REALM",
  "TURN_EXTERNAL_IP",
  "TURN_USERNAME",
  "TURN_CREDENTIAL",
  "TURN_PORT",
  "TURN_MIN_PORT",
  "TURN_MAX_PORT",
  "WORKER_CONCURRENCY",
  "TRUST_PROXY_HOPS",
]) {
  if (!new RegExp(`^${key}=`, "m").test(exampleEnv)) {
    failures.push(`.env.production.example is missing the ${key} contract entry.`);
  }
}

if (!/STORAGE_DRIVER=s3/.test(exampleEnv)) {
  failures.push("Production storage driver must be s3; evidence must not use container-local storage.");
}

// Legacy auto-deploy paths must not reappear anywhere in the tree: an active
// autoDeploy could push to a provider that is no longer the production target.
// Scanned recursively, because these files also live under apps/*.
const legacyNames = new Set(["render.yaml", "render.yml", "vercel.json", "netlify.toml", "fly.toml", "Procfile", "app.yaml"]);
const skipDirectories = new Set(["node_modules", ".git", ".next", "dist", "deploy"]);

function scanForLegacyArtifacts(directory, relative = "") {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!skipDirectories.has(entry.name)) {
        scanForLegacyArtifacts(path.join(directory, entry.name), relativePath);
      }
      continue;
    }
    if (legacyNames.has(entry.name)) {
      failures.push(`Legacy deployment artifact present: ${relativePath}. VPS is the locked production target.`);
    }
  }
}

scanForLegacyArtifacts(repoRoot);

const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const apiPackage = JSON.parse(readFileSync(path.join(repoRoot, "apps", "api", "package.json"), "utf8"));
for (const [name, scripts] of [
  ["root", rootPackage.scripts || {}],
  ["api", apiPackage.scripts || {}],
]) {
  for (const scriptName of Object.keys(scripts)) {
    if (/render/i.test(scriptName)) {
      failures.push(`Legacy deployment script ${name}:${scriptName} still present.`);
    }
  }
}

for (const required of ["deploy:migrate", "deploy:bootstrap"]) {
  if (!rootPackage.scripts?.[required]) {
    failures.push(`Missing controlled deployment script: ${required}`);
  }
}

// The Dockerfiles must not bake secrets and should drop root.
for (const dockerfile of ["deploy/docker/api.Dockerfile", "deploy/docker/web.Dockerfile", "deploy/docker/worker.Dockerfile"]) {
  const body = contents.get(dockerfile) || "";
  if (!body.includes("USER node")) {
    failures.push(`${dockerfile} should run as the non-root node user.`);
  }
  if (/ENV\s+(JWT_SECRET|STORAGE_SECRET_KEY|POSTGRES_PASSWORD|TURN_CREDENTIAL)/.test(body)) {
    failures.push(`${dockerfile} bakes a secret into the image.`);
  }
}

const migrationRoot = path.join(repoRoot, "packages", "database", "prisma", "ogun-migrations");
const migrationCount = readdirSync(migrationRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`deployment_assets_verified=${requiredAssets.length}`);
  console.log(`ogun_migrations_present=${migrationCount}`);
  console.log("deployment_asset_integrity=ok");
}
