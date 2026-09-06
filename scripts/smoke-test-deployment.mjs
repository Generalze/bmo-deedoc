/**
 * Post-deploy smoke test.
 *
 * Runs against a deployed instance and asks whether it is safe and correct, not
 * merely whether it responds. `/health` returns "ok" unconditionally, so a
 * deployment can report healthy with no database behind it; every check here
 * looks at something that would actually be wrong.
 *
 * It is deliberately read-only and unauthenticated. It creates nothing, changes
 * nothing, and needs no credentials, so it is safe to run against staging on
 * every deploy and against production immediately after one.
 *
 *   node scripts/smoke-test-deployment.mjs --api https://ops.example.org/api
 *   node scripts/smoke-test-deployment.mjs --api http://127.0.0.1:4000 --web http://127.0.0.1:3000
 *
 * Exit 0 means the deployment is serving correctly and safely. Exit 1 names
 * what is wrong.
 */

function argument(name) {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

const apiBase = (argument("--api") || process.env.SMOKE_API_BASE_URL || "").replace(/\/$/, "");
const webBase = (argument("--web") || process.env.SMOKE_WEB_BASE_URL || "").replace(/\/$/, "");
const expectPayoutsEnabled = process.argv.includes("--expect-payouts-enabled");

if (!apiBase) {
  console.error("FAIL --api <base-url> is required (or set SMOKE_API_BASE_URL).");
  process.exit(1);
}

const failures = [];
const notes = [];
const timeoutMs = Number.parseInt(argument("--timeout") || "10000", 10);

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiBase}${path}`, { ...options, signal: controller.signal });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    return { status: response.status, payload, text, headers: response.headers };
  } catch (error) {
    return { status: 0, payload: null, text: String(error?.message || error), headers: new Headers() };
  } finally {
    clearTimeout(timer);
  }
}

function check(label, condition, detail) {
  if (condition) {
    notes.push(`ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ---- The process is alive and actually ready ----------------------------- */

const health = await request("/health");
check("api responds", health.status === 200, `GET /health returned ${health.status || health.text}`);

const ready = await request("/readyz");
check("api is ready", ready.status === 200, `GET /readyz returned ${ready.status}: ${JSON.stringify(ready.payload)}`);

if (ready.payload?.checks) {
  for (const [name, result] of Object.entries(ready.payload.checks)) {
    check(`dependency: ${name}`, result.ok !== false, result.detail);
  }
}

/* ---- Money is off ---------------------------------------------------------
 * The single most consequential thing to get wrong on a fresh deployment.
 * Payout execution is disabled by default in every environment, production
 * included, and is cleared only by a deliberate operator action.
 */
const payoutsEnabled = ready.payload?.payoutExecutionEnabled;
if (expectPayoutsEnabled) {
  check("payout execution is enabled, as explicitly expected", payoutsEnabled === true, `reported ${payoutsEnabled}`);
} else {
  check(
    "payout execution is disabled",
    payoutsEnabled === false,
    payoutsEnabled === undefined
      ? "readiness did not report the payout kill switch"
      : `PAYOUT_EXECUTION_ENABLED is ${payoutsEnabled}. Pass --expect-payouts-enabled only if this was deliberate.`,
  );
}

/* ---- Territory scope ------------------------------------------------------
 * The platform operates in Ogun State only, and the public state list is what a
 * registering member sees. A deployment offering more than Ogun is serving the
 * wrong product.
 */
const states = await request("/auth/territories/states");
check("public state list responds", states.status === 200, `returned ${states.status}`);
const stateItems = states.payload?.states || states.payload?.items || states.payload;
if (Array.isArray(stateItems)) {
  check(
    "only Ogun State is offered",
    stateItems.length === 1 && /ogun/i.test(stateItems[0]?.name || ""),
    `got ${stateItems.length} states: ${stateItems.map((item) => item?.name).join(", ")}`,
  );
} else if (states.status === 200) {
  failures.push("public state list did not return an array");
}

/* ---- Nothing private is reachable without a session ---------------------- */

const protectedPaths = [
  "/auth/me",
  "/pre-election/verifications",
  "/evidence/assets",
  "/election-day/situation-room/status",
  "/governance/inferred-edges",
];
for (const path of protectedPaths) {
  const response = await request(path);
  check(
    `unauthenticated ${path} is refused`,
    response.status === 401 || response.status === 403,
    `returned ${response.status}`,
  );
}

/* ---- Security headers ----------------------------------------------------- */

if (health.status === 200) {
  const headers = health.headers;
  check("HSTS is set", Boolean(headers.get("strict-transport-security")) || apiBase.startsWith("http://"),
    "no Strict-Transport-Security header on an HTTPS deployment");
  check("content type options are set", headers.get("x-content-type-options") === "nosniff",
    `x-content-type-options is ${headers.get("x-content-type-options")}`);
}

/* ---- The web app is served ------------------------------------------------ */

if (webBase) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${webBase}/login`, { signal: controller.signal, redirect: "follow" });
    check("web serves the sign-in page", response.status === 200, `GET ${webBase}/login returned ${response.status}`);
    const root = await fetch(`${webBase}/`, { signal: controller.signal, redirect: "manual" });
    check(
      "the site root forwards to the single sign-in door",
      root.status >= 300 && root.status < 400 && /\/login$/.test(root.headers.get("location") || ""),
      `root returned ${root.status} -> ${root.headers.get("location")}`,
    );
  } catch (error) {
    failures.push(`web app unreachable — ${error?.message || error}`);
  } finally {
    clearTimeout(timer);
  }
} else {
  notes.push("skip web checks (pass --web <base-url> to include them)");
}

/* ---- Report --------------------------------------------------------------- */

for (const note of notes) console.log(note);

if (failures.length > 0) {
  console.error("");
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`\ndeployment_smoke_test=failed checks=${failures.length} target=${apiBase}`);
  process.exit(1);
}

console.log(`\ndeployment_smoke_test=ok target=${apiBase}`);
