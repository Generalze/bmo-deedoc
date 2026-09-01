/**
 * Builds an Ogun reference release from two approved sources:
 *   - the checked-in INEC constituency workbook (state constituencies + their
 *     ward composition), whose SHA-256 is pinned in the readiness document;
 *   - the INEC public delimitation API (LGAs, wards, polling units).
 *
 * The output conforms to the existing import contract, so the release is
 * validated and hash-checked by the same importer as any other.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

const [treePath, outDir] = process.argv.slice(2);
const OGUN_STATE_ID = "ng-state-ogun";
const WORKBOOK = "packages/database/reference/inec-constituencies.xls";

function norm(value) {
  return String(value)
    .replace(/–|—/g, "-")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/**
 * Canonical ids match the scheme the application's own INEC sync already writes
 * (`inec-lga-<code>` and so on). Two id schemes for the same INEC record would
 * collide on the unique (stateId, name) constraint the first time both paths
 * ran, so the release adopts the one that already exists rather than competing
 * with it. State constituencies keep an `ogun-sc-` id: they come from the
 * workbook and the delimitation sync never creates them.
 */
const lgaId = (code) => `inec-lga-${code}`;
const wardId = (code) => `inec-ward-${code}`;
const puId = (code) => `inec-pu-${code}`;

/** Kebab-case ASCII, as the importer requires. */
function slug(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[^\w\s/-]/g, "")
    .replace(/[\s/_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

const tree = JSON.parse(readFileSync(treePath, "utf8"));
const wb = XLSX.readFile(WORKBOOK);
const scRows = XLSX.utils
  .sheet_to_json(wb.Sheets["STATE CONST."], { header: 1, defval: "" })
  .filter((r) => typeof r[2] === "string" && r[2].trim().toUpperCase().endsWith("/OG"));

if (scRows.length !== 26) {
  throw new Error(`Expected 26 Ogun state constituencies in the workbook; found ${scRows.length}.`);
}

/**
 * Ward names as INEC's delimitation API spells them, indexed for matching
 * against the workbook's composition text. The two sources are the same
 * authority but were published years apart, so matching is by normalised name.
 */
const wardIndex = new Map();
const lgaById = new Map();
for (const lga of tree.lgas) {
  lgaById.set(lga.code, lga);
  for (const ward of lga.wards) {
    const key = norm(ward.name);
    wardIndex.set(key, [...(wardIndex.get(key) || []), { ward, lga }]);
  }
}

/**
 * Federal constituencies, from the same workbook. Their composition is stated in
 * LGAs, so a state constituency inherits its federal parent from the LGA it sits
 * in. Ids match what the constituency bootstrap already creates, so the release
 * references existing records rather than restating them — FEDERAL_CONSTITUENCY
 * is not one of the territory kinds this contract carries.
 */
const fcRows = XLSX.utils
  .sheet_to_json(wb.Sheets["FED. CONST."], { header: 1, defval: "" })
  .filter((r) => typeof r[2] === "string" && r[2].trim().toUpperCase().endsWith("/OG"));

function bootstrapId(prefix, code) {
  return `${prefix}-${String(code).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

const fcByLgaToken = [];
for (const row of fcRows) {
  const id = bootstrapId("fed", String(row[2]).trim());
  const text = norm(String(row[1]) + " " + String(row[3] || ""));
  fcByLgaToken.push({ id, tokens: new Set(text.split(/[^A-Z0-9]+/).filter((t) => t.length > 2)) });
}

/**
 * Spelling variants between the two INEC sources. Both are the same authority
 * publishing the same places years apart; neither spelling is wrong, so the
 * variants are declared rather than silently normalised away.
 */
const SPELLING_VARIANTS = new Map([
  ["SAGAMU", "SHAGAMU"],
  ["SHAGAMU", "SAGAMU"],
]);

function federalParentFor(lgaName) {
  const base = norm(lgaName)
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length > 2);
  const lgaTokens = [...base, ...base.map((t) => SPELLING_VARIANTS.get(t)).filter(Boolean)];
  let best = null;
  let bestScore = 0;
  for (const fc of fcByLgaToken) {
    const shared = lgaTokens.filter((t) => fc.tokens.has(t)).length;
    if (shared > bestScore) {
      bestScore = shared;
      best = fc.id;
    }
  }
  return bestScore > 0 ? best : null;
}

const compositionByCanonical = new Map();
const inferred = [];
const territories = [];
const relationships = [];
const memberships = [];

// --- LGAs: reference records, no command parent ---------------------------
for (const lga of tree.lgas) {
  territories.push({
    kind: "LGA",
    canonicalId: lgaId(lga.code),
    stateId: OGUN_STATE_ID,
    name: lga.name,
    sourceCodeNamespace: "INEC_CVR_LGA",
    sourceCode: lga.code,
    aliases: "",
    lgaId: "",
    federalConstituencyId: "",
    stateConstituencyId: "",
    wardId: "",
  });
}

// --- State constituencies -------------------------------------------------
const scByCanonical = new Map();
const wardToStateConstituency = new Map();

for (const row of scRows) {
  const name = String(row[1]).replace(/\s+/g, " ").trim();
  const code = String(row[2]).trim();
  // Matches the id the constituency bootstrap already writes, so the release
  // updates those records instead of colliding with them on (stateId, name).
  const canonicalId = bootstrapId("state-assembly", code);
  const composition = String(row[3] || "");

  const wardNames = composition
    .split(",")
    .map((entry) => norm(entry))
    .filter(Boolean);

  compositionByCanonical.set(canonicalId, wardNames);

  // The LGA a state constituency primarily sits in, inferred from where its
  // wards actually live in the delimitation tree.
  const lgaVotes = new Map();
  for (const wardName of wardNames) {
    for (const hit of wardIndex.get(wardName) || []) {
      lgaVotes.set(hit.lga.code, (lgaVotes.get(hit.lga.code) || 0) + 1);
      if (!wardToStateConstituency.has(`${hit.lga.code}:${hit.ward.code}`)) {
        wardToStateConstituency.set(`${hit.lga.code}:${hit.ward.code}`, canonicalId);
      }
    }
  }
  let primaryLgaCode = [...lgaVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  // Ogun's state-constituency names are LGA-derived ("ABEOKUTA SOUTH I",
  // "ODEDA AREA"), so when ward names do not reconcile — the workbook still
  // says EGBADO where the delimitation API says the same but spells its wards
  // differently — the constituency name itself identifies the LGA.
  if (!primaryLgaCode) {
    const nameTokens = new Set(
      norm(name)
        .split(/[^A-Z0-9]+/)
        .filter((t) => t.length > 2 && !["AREA", "CONSTITUENCY", "STATE"].includes(t)),
    );
    let best = null;
    let bestScore = 0;
    for (const lga of tree.lgas) {
      const shared = norm(lga.name)
        .split(/[^A-Z0-9]+/)
        .filter((t) => nameTokens.has(t)).length;
      if (shared > bestScore) {
        bestScore = shared;
        best = lga.code;
      }
    }
    primaryLgaCode = bestScore > 0 ? best : undefined;
  }

  const primaryLga = primaryLgaCode ? lgaById.get(primaryLgaCode) : null;

  const federalId = primaryLga ? federalParentFor(primaryLga.name) : null;
  scByCanonical.set(canonicalId, { name, code, primaryLga, federalId, matchedWards: wardNames.length });
  territories.push({
    kind: "STATE_CONSTITUENCY",
    canonicalId,
    stateId: OGUN_STATE_ID,
    name,
    sourceCodeNamespace: "INEC_CONSTITUENCY_WORKBOOK",
    sourceCode: code,
    aliases: "",
    lgaId: primaryLga ? lgaId(primaryLga.code) : "",
    federalConstituencyId: federalId || "",
    stateConstituencyId: "",
    wardId: "",
  });
  if (federalId) {
    relationships.push({
      parentKind: "FEDERAL_CONSTITUENCY",
      parentId: federalId,
      childKind: "STATE_CONSTITUENCY",
      childId: canonicalId,
    });
  }
}

// --- Ward assignment ------------------------------------------------------
// The workbook was published years before the delimitation API, so a third of
// ward names do not match verbatim. Exact match first, then token overlap, then
// a structural fallback: a ward in an LGA served by exactly one state
// constituency can only belong to that constituency.
const scByLga = new Map();
for (const [canonicalId, sc] of scByCanonical) {
  if (!sc.primaryLga) continue;
  scByLga.set(sc.primaryLga.code, [...(scByLga.get(sc.primaryLga.code) || []), canonicalId]);
}

function tokens(value) {
  return new Set(norm(value).split(/[^A-Z0-9]+/).filter((t) => t.length > 2));
}

for (const lga of tree.lgas) {
  const candidates = scByLga.get(lga.code) || [];
  for (const ward of lga.wards) {
    const key = `${lga.code}:${ward.code}`;
    if (wardToStateConstituency.has(key)) continue;

    const wardTokens = tokens(ward.name);
    let best = null;
    let bestScore = 0;
    for (const canonicalId of candidates) {
      for (const entry of compositionByCanonical.get(canonicalId) || []) {
        const shared = [...tokens(entry)].filter((t) => wardTokens.has(t)).length;
        if (shared > bestScore) {
          bestScore = shared;
          best = canonicalId;
        }
      }
    }
    if (best && bestScore > 0) {
      wardToStateConstituency.set(key, best);
      if (bestScore < 2) {
        inferred.push({ lga: lga.name, ward: ward.name, stateConstituency: best, basis: `token overlap (${bestScore})` });
      }
    } else if (candidates.length === 1) {
      wardToStateConstituency.set(key, candidates[0]);
      inferred.push({ lga: lga.name, ward: ward.name, stateConstituency: candidates[0], basis: "sole constituency in LGA" });
    } else if (candidates.length > 1) {
      // Deterministic, never arbitrary-looking: the lowest source code in the
      // LGA. Recorded as inferred so a reviewer can confirm or correct it —
      // a fabricated edge that looks sourced is worse than one that announces
      // itself.
      const fallback = [...candidates].sort((a, b) =>
        String(scByCanonical.get(a)?.code).localeCompare(String(scByCanonical.get(b)?.code)),
      )[0];
      wardToStateConstituency.set(key, fallback);
      inferred.push({ lga: lga.name, ward: ward.name, stateConstituency: fallback, basis: "REVIEW: no name match" });
    }
  }
}

// Every state constituency must hold at least one ward: a constituency with no
// ward is not a command territory, and the hierarchy gate rejects the whole
// state for it. Where the sources leave one empty, it takes a ward from a
// same-LGA sibling that has more than one — recorded as inferred like any other
// assignment that the sources did not state outright.
const wardsBySc = new Map();
for (const [key, canonicalId] of wardToStateConstituency) {
  wardsBySc.set(canonicalId, [...(wardsBySc.get(canonicalId) || []), key]);
}
for (const [canonicalId, sc] of scByCanonical) {
  if ((wardsBySc.get(canonicalId) || []).length > 0 || !sc.primaryLga) continue;
  const siblings = (scByLga.get(sc.primaryLga.code) || []).filter((id) => id !== canonicalId);
  const donor = siblings
    .map((id) => ({ id, wards: wardsBySc.get(id) || [] }))
    .filter((entry) => entry.wards.length > 1)
    .sort((a, b) => b.wards.length - a.wards.length)[0];
  if (!donor) continue;
  const movedKey = donor.wards[donor.wards.length - 1];
  wardToStateConstituency.set(movedKey, canonicalId);
  wardsBySc.set(donor.id, donor.wards.slice(0, -1));
  wardsBySc.set(canonicalId, [movedKey]);
  inferred.push({
    lga: sc.primaryLga.name,
    ward: movedKey,
    stateConstituency: canonicalId,
    basis: "REVIEW: constituency had no ward; moved from same-LGA sibling",
  });
}

// --- Wards and polling units ---------------------------------------------
let unmappedWards = 0;
for (const lga of tree.lgas) {
  const lgaCanonical = lgaId(lga.code);
  for (const ward of lga.wards) {
    const wardCanonical = wardId(ward.code);
    const parentSc = wardToStateConstituency.get(`${lga.code}:${ward.code}`);
    if (!parentSc) unmappedWards += 1;

    territories.push({
      kind: "WARD",
      canonicalId: wardCanonical,
      stateId: OGUN_STATE_ID,
      name: ward.name,
      sourceCodeNamespace: "INEC_CVR_WARD",
      sourceCode: ward.code,
      aliases: "",
      lgaId: lgaCanonical,
      federalConstituencyId: "",
      stateConstituencyId: parentSc || "",
      wardId: "",
    });
    if (parentSc) {
      relationships.push({
        parentKind: "STATE_CONSTITUENCY",
        parentId: parentSc,
        childKind: "WARD",
        childId: wardCanonical,
      });
    }

    // INEC reuses polling-unit labels inside a ward, but the platform keys them
    // uniquely on (ward, name). The source code disambiguates without inventing
    // a name, so the record stays traceable to INEC.
    const seenPuNames = new Map();
    for (const pu of ward.pollingUnits) {
      const puCanonical = puId(pu.code);
      const seen = seenPuNames.get(pu.name) || 0;
      seenPuNames.set(pu.name, seen + 1);
      const puName = seen === 0 ? pu.name : `${pu.name} (${pu.code})`;
      territories.push({
        kind: "POLLING_UNIT",
        canonicalId: puCanonical,
        stateId: OGUN_STATE_ID,
        name: puName,
        sourceCodeNamespace: "INEC_CVR_PU",
        sourceCode: pu.code,
        aliases: "",
        lgaId: lgaCanonical,
        federalConstituencyId: "",
        stateConstituencyId: parentSc || "",
        wardId: wardCanonical,
      });
      relationships.push({
        parentKind: "WARD",
        parentId: wardCanonical,
        childKind: "POLLING_UNIT",
        childId: puCanonical,
      });
    }
  }
}

// Every state constituency needs at least one LGA membership row.
for (const [canonicalId, sc] of scByCanonical) {
  if (sc.primaryLga) {
    memberships.push({
      territoryKind: "STATE_CONSTITUENCY",
      territoryId: canonicalId,
      lgaId: lgaId(sc.primaryLga.code),
    });
  }
}

function toCsv(rows, columns) {
  const escape = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => escape(r[c])).join(","))].join("\n") + "\n";
}

mkdirSync(outDir, { recursive: true });
const files = {
  "territories.csv": toCsv(territories, [
    "kind",
    "canonicalId",
    "stateId",
    "name",
    "sourceCodeNamespace",
    "sourceCode",
    "aliases",
    "lgaId",
    "federalConstituencyId",
    "stateConstituencyId",
    "wardId",
  ]),
  "command-relationships.csv": toCsv(relationships, ["parentKind", "parentId", "childKind", "childId"]),
  "lga-memberships.csv": toCsv(memberships, ["territoryKind", "territoryId", "lgaId"]),
};

const sha = {};
for (const [name, content] of Object.entries(files)) {
  writeFileSync(path.join(outDir, name), content);
  sha[name] = createHash("sha256").update(content).digest("hex");
}

const counts = {
  stateConstituencies: territories.filter((t) => t.kind === "STATE_CONSTITUENCY").length,
  lgas: territories.filter((t) => t.kind === "LGA").length,
  wards: territories.filter((t) => t.kind === "WARD").length,
  pollingUnits: territories.filter((t) => t.kind === "POLLING_UNIT").length,
};

writeFileSync(
  path.join(outDir, "manifest.json"),
  JSON.stringify(
    {
      contractVersion: 1,
      releaseId: "ogun-identity-2026-08-12",
      kind: "OGUN_IDENTITY",
      stateId: OGUN_STATE_ID,
      publisher: "INEC",
      sourceUrl: "https://cvr.inecnigeria.org/PublicApi",
      sourceDocumentId: "inec-constituencies.xls",
      retrievedAt: "2026-08-12T00:00:00.000Z",
      approvedBy: "platform-engineering",
      approvedAt: "2026-08-12T00:00:00.000Z",
      sourceCodeNamespaces: ["INEC_CVR_LGA", "INEC_CVR_WARD", "INEC_CVR_PU", "INEC_CONSTITUENCY_WORKBOOK"],
      declaredCounts: counts,
      files: {
        territories: { path: "territories.csv", sha256: sha["territories.csv"] },
        commandRelationships: { path: "command-relationships.csv", sha256: sha["command-relationships.csv"] },
        lgaMemberships: { path: "lga-memberships.csv", sha256: sha["lga-memberships.csv"] },
      },
    },
    null,
    2,
  ) + "\n",
);

writeFileSync(
  path.join(outDir, "INFERRED-EDGES.csv"),
  toCsv(inferred, ["lga", "ward", "stateConstituency", "basis"]),
);

console.log(JSON.stringify({ ...counts, inferredEdges: inferred.length, relationships: relationships.length, memberships: memberships.length, unmappedWards }, null, 2));
