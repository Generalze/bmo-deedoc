/**
 * Cross-checks the TURN relay against what the API tells clients about it.
 *
 * The relay itself is well guarded: the entrypoint refuses to start without a
 * realm, external address and credentials, refuses a TLS listener it has no
 * certificate for, and refuses an unsubstituted placeholder. The compose file
 * makes every required variable a hard `:?` failure.
 *
 * What nothing checked is that those settings agree with the ones the API hands
 * to browsers. They are separate variables read by separate processes, and each
 * side is internally valid while disagreeing with the other. Every failure below
 * looks like correct configuration from inside a single file:
 *
 *   - The API advertises `turns:` while coturn has no certificate, so its TLS
 *     and DTLS listeners are explicitly off. Clients are then configured with a
 *     relay endpoint that has nothing listening on it.
 *   - The port in TURN_URL is not the port coturn listens on.
 *   - The API's TURN credentials are not coturn's, so allocation is refused
 *     during the call and never at start-up.
 *   - The relay port range does not match the range the firewall opens.
 *
 * A relay that is misconfigured this way does not fail loudly. It fails only for
 * the users who need it — the ones behind carrier-grade NAT, on election day.
 *
 * This validates configuration files and an optional environment. It does not
 * prove a relay is running or reachable; that needs a real host.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

function read(relativePath) {
  const full = path.join(repoRoot, relativePath);
  if (!existsSync(full)) {
    failures.push(`Missing TURN asset: ${relativePath}`);
    return null;
  }
  return readFileSync(full, "utf8");
}

/**
 * The exact test the API applies before it will report turnConfigured. Kept
 * character-for-character in step with apps/api/src/routes/election-day.ts: a
 * validator that is more permissive than the code it checks would pass a URL
 * the API then silently discards.
 */
const API_TURN_URL_PATTERN = /^turns?:[^\s:]+(:\d{1,5})?(\?transport=(udp|tcp))?$/i;

/** Reads KEY=VALUE pairs from a dotenv-style file, ignoring comments. */
function parseEnvFile(text) {
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

/* ---- Asset presence ----------------------------------------------------- */

const template = read("deploy/coturn/turnserver.conf.template");
const entrypoint = read("deploy/coturn/entrypoint.sh");
const compose = read("docker-compose.prod.yml");
const deploymentDoc = read("docs/DEPLOYMENT_VPS.md");

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}

/* ---- The template and its renderer agree -------------------------------- */

const placeholders = new Set([...template.matchAll(/__([A-Z0-9_]+)__/g)].map((match) => match[1]));
for (const placeholder of placeholders) {
  // TLS_SECTION is replaced by awk rather than sed, so it is matched separately.
  const substituted =
    entrypoint.includes(`__${placeholder}__`) || (placeholder === "TLS_SECTION" && entrypoint.includes("tls="));
  if (!substituted) {
    failures.push(
      `deploy/coturn/turnserver.conf.template uses __${placeholder}__ but deploy/coturn/entrypoint.sh never substitutes it. The relay would start with a literal placeholder, or refuse to start.`,
    );
  }
}
notes.push(`turn_template_placeholders=${placeholders.size}`);

if (!entrypoint.includes('grep -q "__[A-Z_]*__"')) {
  failures.push(
    "deploy/coturn/entrypoint.sh no longer refuses an unsubstituted placeholder in the rendered configuration.",
  );
}

/* ---- The relay stays closed to private networks ------------------------- */

const requiredDenyRanges = [
  ["10.0.0.0-10.255.255.255", "RFC1918 — the compose backplane, PostgreSQL and Redis"],
  ["172.16.0.0-172.31.255.255", "Docker bridge networks"],
  ["192.168.0.0-192.168.255.255", "RFC1918 LAN"],
  ["169.254.0.0-169.254.255.255", "link-local, including the cloud metadata endpoint"],
  ["127.0.0.0-127.255.255.255", "loopback"],
  ["100.64.0.0-100.127.255.255", "carrier-grade NAT"],
  ["::ffff:0.0.0.0-::ffff:255.255.255.255", "IPv4-mapped IPv6, which otherwise bypasses the IPv4 rules"],
];
for (const [range, why] of requiredDenyRanges) {
  if (!template.includes(`denied-peer-ip=${range}`)) {
    failures.push(
      `deploy/coturn/turnserver.conf.template no longer denies ${range} (${why}). An authenticated client could relay to it, which is a server-side request forgery primitive.`,
    );
  }
}

if (!template.includes("lt-cred-mech")) {
  failures.push("deploy/coturn/turnserver.conf.template must keep lt-cred-mech; an open relay is abused within hours.");
}
if (template.includes("\nno-auth") || /^\s*no-auth\s*$/m.test(template)) {
  failures.push("deploy/coturn/turnserver.conf.template enables anonymous relay (no-auth).");
}

/* ---- Committed credentials ---------------------------------------------- */

for (const [asset, text] of [
  ["deploy/coturn/turnserver.conf.template", template],
  ["docker-compose.prod.yml", compose],
]) {
  const userLine = text.match(/^\s*user=(.+)$/m);
  if (userLine && !userLine[1].includes("__TURN_USERNAME__") && !userLine[1].includes("${")) {
    failures.push(`${asset} appears to carry a literal TURN credential: ${userLine[0].trim()}`);
  }
}

/* ---- Compose wiring ------------------------------------------------------ */

if (!/coturn:[\s\S]*?network_mode:\s*host/.test(compose)) {
  failures.push(
    "docker-compose.prod.yml must run coturn with network_mode: host. A bridged relay hands out container addresses that no client can reach.",
  );
}
for (const required of ["TURN_REALM", "TURN_EXTERNAL_IP", "TURN_USERNAME", "TURN_CREDENTIAL"]) {
  if (!new RegExp(`${required}:\\s*\\$\\{${required}:\\?`).test(compose)) {
    failures.push(`docker-compose.prod.yml must fail closed when ${required} is unset (\${${required}:?...}).`);
  }
}

/* ---- The firewall range matches the relay range ------------------------- */

const composeMin = compose.match(/TURN_MIN_PORT:\s*\$\{TURN_MIN_PORT:-(\d+)\}/);
const composeMax = compose.match(/TURN_MAX_PORT:\s*\$\{TURN_MAX_PORT:-(\d+)\}/);
const documentedRange = deploymentDoc.match(/ufw allow (\d+):(\d+)\/udp/);
if (composeMin && composeMax && documentedRange) {
  const [, docMin, docMax] = documentedRange;
  if (docMin !== composeMin[1] || docMax !== composeMax[1]) {
    failures.push(
      `The documented firewall relay range ${docMin}-${docMax} does not match the compose defaults ${composeMin[1]}-${composeMax[1]}. Allocations outside the opened range are silently dropped.`,
    );
  }
  notes.push(`turn_relay_range=${composeMin[1]}-${composeMax[1]}`);
} else {
  failures.push("Could not read the TURN relay port range from both docker-compose.prod.yml and docs/DEPLOYMENT_VPS.md.");
}

/* ---- The advertised URL agrees with the relay --------------------------- */

/**
 * Runs only when an environment is supplied. Without one this is a static
 * check of the assets; with one it is the cross-check that actually matters.
 */
const envFileArgument = process.argv.indexOf("--env-file");
let env = null;
let envLabel = "";
if (envFileArgument !== -1 && process.argv[envFileArgument + 1]) {
  const envPath = process.argv[envFileArgument + 1];
  const full = path.isAbsolute(envPath) ? envPath : path.join(repoRoot, envPath);
  if (!existsSync(full)) {
    console.error(`FAIL --env-file ${envPath} does not exist.`);
    process.exit(1);
  }
  env = parseEnvFile(readFileSync(full, "utf8"));
  envLabel = envPath;
} else if (process.env.TURN_URL) {
  env = new Map(
    ["TURN_URL", "TURN_USERNAME", "TURN_CREDENTIAL", "TURN_PORT", "TURN_TLS_PORT", "TURN_TLS_CERT", "TURN_TLS_KEY", "TURN_REALM", "TURN_EXTERNAL_IP", "TURN_MIN_PORT", "TURN_MAX_PORT"].map(
      (key) => [key, process.env[key] ?? ""],
    ),
  );
  envLabel = "process environment";
}

if (!env) {
  notes.push("turn_runtime_crosscheck=skipped_no_env");
  notes.push("turn_hint=pass --env-file .env.production to cross-check the advertised relay against the running one");
} else {
  const turnUrl = (env.get("TURN_URL") || "").trim();
  const username = (env.get("TURN_USERNAME") || "").trim();
  const credential = (env.get("TURN_CREDENTIAL") || "").trim();
  const listenPort = (env.get("TURN_PORT") || "3478").trim();
  const tlsPort = (env.get("TURN_TLS_PORT") || "5349").trim();
  const tlsCert = (env.get("TURN_TLS_CERT") || "").trim();
  const tlsKey = (env.get("TURN_TLS_KEY") || "").trim();

  if (!turnUrl) {
    // Not an error. No TURN is an honest state, and the API reports it.
    notes.push(`turn_configured=false source=${envLabel}`);
    notes.push("turn_note=calls will not cross carrier-grade NAT until a relay is configured");
  } else {
    if (!API_TURN_URL_PATTERN.test(turnUrl)) {
      failures.push(
        `TURN_URL "${turnUrl}" does not match the pattern the API requires, so the API will report turnConfigured=false and never hand this relay to a browser — while the relay itself runs.`,
      );
    }
    if (!username || !credential) {
      failures.push(
        "TURN_URL is set but TURN_USERNAME or TURN_CREDENTIAL is empty. The API refuses to advertise a half-configured relay, so the relay would run unused.",
      );
    }

    const scheme = turnUrl.slice(0, turnUrl.indexOf(":")).toLowerCase();
    const afterScheme = turnUrl.slice(turnUrl.indexOf(":") + 1).split("?")[0];
    const portMatch = afterScheme.match(/:(\d{1,5})$/);
    const advertisedPort = portMatch ? portMatch[1] : scheme === "turns" ? tlsPort : listenPort;

    if (scheme === "turns") {
      if (!tlsCert || !tlsKey) {
        failures.push(
          `TURN_URL advertises "turns:" but TURN_TLS_CERT/TURN_TLS_KEY are not both set. The entrypoint disables the TLS and DTLS listeners without a certificate, so every client would be handed a relay endpoint with nothing listening on it.`,
        );
      }
      if (advertisedPort !== tlsPort) {
        failures.push(
          `TURN_URL advertises TLS port ${advertisedPort} but coturn listens for TLS on ${tlsPort}.`,
        );
      }
    } else if (advertisedPort !== listenPort) {
      failures.push(`TURN_URL advertises port ${advertisedPort} but coturn listens on ${listenPort}.`);
    }

    const minPort = Number.parseInt((env.get("TURN_MIN_PORT") || "49160").trim(), 10);
    const maxPort = Number.parseInt((env.get("TURN_MAX_PORT") || "49200").trim(), 10);
    if (!Number.isFinite(minPort) || !Number.isFinite(maxPort) || minPort >= maxPort) {
      failures.push(`TURN_MIN_PORT (${minPort}) must be below TURN_MAX_PORT (${maxPort}).`);
    }

    if (failures.length === 0) {
      notes.push(`turn_configured=true scheme=${scheme} port=${advertisedPort} source=${envLabel}`);
      notes.push(`turn_tls=${scheme === "turns" ? "required_and_present" : "not_advertised"}`);
    }
  }
}

/* ---- Report -------------------------------------------------------------- */

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`turn_configuration_integrity=failed checks=${failures.length}`);
  process.exit(1);
}

for (const note of notes) console.log(note);
console.log("turn_configuration_integrity=ok");
