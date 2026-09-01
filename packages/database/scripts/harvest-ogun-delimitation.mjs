/**
 * Harvests Ogun's delimitation tree from the INEC public voter-registration API.
 *
 * Read-only, public reference data, using the same endpoints and parameters the
 * application already integrates with. Written to a scratch file so the result
 * can be inspected before anything is checked into the repository.
 */
import { writeFileSync } from "node:fs";

const BASE = "https://cvr.inecnigeria.org/PublicApi";
const OGUN_STATE_CODE = "28";

function sanitize(value) {
  return value.replace(/^\d+\s*-\s*/, "").replace(/\s+/g, " ").trim();
}

async function options(path, params, attempt = 0) {
  try {
    const response = await fetch(`${BASE}/${path}/1/Search?${new URLSearchParams(params)}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const first = payload[0] || {};
    return Object.entries(first)
      .filter(([key]) => key !== "selected" && key !== "0")
      .map(([code, label]) => ({ code, name: sanitize(String(label)) }));
  } catch (error) {
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      return options(path, params, attempt + 1);
    }
    throw error;
  }
}

const lgas = await options("lgas", { "data[Search][state_id]": OGUN_STATE_CODE });
console.log(`lgas=${lgas.length}`);

const tree = [];
let wardTotal = 0;
let puTotal = 0;

for (const lga of lgas) {
  const wards = await options("wards", { "data[Search][local_government_id]": lga.code });
  wardTotal += wards.length;
  const wardNodes = [];
  for (const ward of wards) {
    const pus = await options("pus", { "data[Search][registration_area_id]": ward.code });
    puTotal += pus.length;
    wardNodes.push({ ...ward, pollingUnits: pus });
  }
  tree.push({ ...lga, wards: wardNodes });
  console.log(`  ${lga.name}: wards=${wards.length} pus=${wardNodes.reduce((t, w) => t + w.pollingUnits.length, 0)}`);
}

writeFileSync(
  process.argv[2],
  JSON.stringify({ source: BASE, stateCode: OGUN_STATE_CODE, lgas: tree }, null, 2),
);
console.log(`TOTAL lgas=${lgas.length} wards=${wardTotal} pollingUnits=${puTotal}`);
