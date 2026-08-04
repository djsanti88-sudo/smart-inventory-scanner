import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const RECONCILIATION_SHA256 = "DAB216234D5346BAEEFBAE80E5C704F2F3C5D568CC3CA01FD5C4990B44183FFD";
export const EXPECTED_COUNTS = Object.freeze({
  acceptedSpellings: 13_656,
  bossTrustedLookupKeys: 5_626,
  canonicalProductIds: 5_528,
  nonGtinApprovedRows: 314,
  nonGtinApprovedIdentifiers: 310,
  excludedCasePacks: 1,
});

const sha256 = (value) => createHash("sha256").update(value).digest("hex").toUpperCase();
const gtinShape = (value) => /^\d{8}$|^\d{12,14}$/.test(String(value ?? "").trim());

export function canonicalGtin(value) {
  const code = String(value ?? "").trim();
  return gtinShape(code) ? code.replace(/^0+/, "").padStart(14, "0") : null;
}

export function validCheckDigit(value) {
  const code = String(value ?? "").trim();
  if (!gtinShape(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let index = digits.length - 1, weight = 3; index >= 0; index -= 1, weight = 4 - weight) sum += digits[index] * weight;
  return (10 - (sum % 10)) % 10 === check;
}

export function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1; } else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = []; cell = "";
    } else cell += char;
  }
  if (quoted) throw new Error("Pinned reconciliation CSV contains an unclosed quote.");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [headers, ...values] = rows;
  return values.map((fields) => Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? ""])));
}

function lookupKey(value) {
  const exact = String(value ?? "").trim();
  return canonicalGtin(exact) ?? (exact ? `nongtin:${exact}` : null);
}

/**
 * Derives scanner spellings only from the hash-pinned reconciliation source.  No barcode material is
 * stored in the repo or emitted by callers; callers report only aggregate counts and hashes.
 */
export function deriveCorpusFixtures(rows, manifest) {
  const spellings = new Map();
  const lookupKeys = new Map();
  const canonicalProductIds = new Set();
  const packageSpellings = new Set();
  let nonGtinApprovedRows = 0;

  for (const row of rows) {
    const raw = String(row.raw_barcode ?? "").trim();
    const rawKey = lookupKey(raw);
    const candidates = String(row.normalized_barcode_candidates || raw).split("|").map((candidate) => candidate.trim()).filter(Boolean);
    if (row.final_status === "packaging_code" && rawKey && manifest.blockedPackageCanonicalKeys.includes(rawKey)) {
      for (const candidate of candidates) {
        if (!validCheckDigit(candidate) || canonicalGtin(candidate) !== rawKey) throw new Error("Blocked package source contains a non-equivalent spelling.");
        packageSpellings.add(candidate);
      }
      continue;
    }
    if (row.final_status !== "accepted" && row.final_status !== "alias") continue;
    const canonicalProductId = String(row.matched_stable_product_id ?? "").trim();
    if (!canonicalProductId) throw new Error("Accepted source row omits its repair-issued product identity.");
    if (row.gtin_valid !== "true") {
      // The reconciliation's `gtin_valid` flag is the authority.  Some approved shop labels are
      // digit-shaped but intentionally not GTIN identities; they remain opaque non-GTIN keys.
      const nonGtinKey = raw ? `nongtin:${raw}` : null;
      if (!nonGtinKey) continue;
      nonGtinApprovedRows += 1;
      const previous = spellings.get(raw);
      if (previous && previous.canonicalProductId !== canonicalProductId) throw new Error("One approved non-GTIN spelling maps to multiple products.");
      spellings.set(raw, { lookupKey: nonGtinKey, canonicalProductId });
      lookupKeys.set(nonGtinKey, canonicalProductId);
      canonicalProductIds.add(canonicalProductId);
      continue;
    }
    if (!rawKey || !validCheckDigit(raw)) throw new Error("Accepted GTIN source row is malformed.");
    for (const candidate of candidates) {
      if (!validCheckDigit(candidate) || canonicalGtin(candidate) !== rawKey) throw new Error("Accepted spelling is not canonical-equivalent.");
      const previous = spellings.get(candidate);
      if (previous && previous.lookupKey !== rawKey) throw new Error("One accepted spelling maps to multiple lookup keys.");
      spellings.set(candidate, { lookupKey: rawKey, canonicalProductId });
    }
    const existingProduct = lookupKeys.get(rawKey);
    if (existingProduct && existingProduct !== canonicalProductId) throw new Error("One accepted lookup key maps to multiple products.");
    lookupKeys.set(rawKey, canonicalProductId);
    canonicalProductIds.add(canonicalProductId);
  }

  return { spellings, lookupKeys, canonicalProductIds, packageSpellings, nonGtinApprovedRows };
}

export function loadCorpusFixtures(reconciliationPath, manifest) {
  if (!reconciliationPath) throw new Error("BOSS_RECONCILIATION_PATH is required; the private source is never committed.");
  const bytes = readFileSync(reconciliationPath);
  if (sha256(bytes) !== RECONCILIATION_SHA256) throw new Error("BOSS_RECONCILIATION_PATH SHA-256 does not match the pinned reconciliation source.");
  const fixtures = deriveCorpusFixtures(csvRows(bytes.toString("utf8")), manifest);
  // Source rows name the repair-issued identity, while the runtime index may preserve a global
  // canonical identity for a public overlap.  Count the same identities the resolver will return.
  const indexDir = join(process.cwd(), "src", "server", "tire-knowledge", "exact-index");
  const indexedCanonicalProductIds = new Set();
  const unresolvedLookupKeys = new Set(fixtures.lookupKeys.keys());
  for (let shard = 0; shard < 64 && unresolvedLookupKeys.size; shard += 1) {
    const name = shard.toString(16).padStart(2, "0");
    const entries = JSON.parse(readFileSync(join(indexDir, `${name}.json`), "utf8"));
    for (const key of unresolvedLookupKeys) {
      const row = entries[key];
      if (!row) continue;
      if (row.bossTrusted !== true || typeof row.canonical_product_uid !== "string" || !row.canonical_product_uid) {
        throw new Error("Trusted exact index does not attest a reconciliation lookup key.");
      }
      indexedCanonicalProductIds.add(row.canonical_product_uid);
      unresolvedLookupKeys.delete(key);
    }
  }
  if (unresolvedLookupKeys.size) throw new Error("Trusted exact index is missing a reconciliation lookup key.");
  fixtures.canonicalProductIds = indexedCanonicalProductIds;
  const expected = EXPECTED_COUNTS;
  if (manifest.acceptedSpellings !== expected.acceptedSpellings
    || manifest.admittedBossCodes !== expected.bossTrustedLookupKeys
    || manifest.nonGtinApprovedRows !== expected.nonGtinApprovedRows
    || manifest.nonGtinApprovedIdentifiers !== expected.nonGtinApprovedIdentifiers
    || manifest.excludedCasePacks !== expected.excludedCasePacks
    || fixtures.spellings.size !== expected.acceptedSpellings
    || fixtures.lookupKeys.size !== expected.bossTrustedLookupKeys
    || fixtures.canonicalProductIds.size !== expected.canonicalProductIds
    || fixtures.nonGtinApprovedRows !== expected.nonGtinApprovedRows
    || [...fixtures.spellings.values()].filter(({ lookupKey: key }) => key.startsWith("nongtin:")).length !== expected.nonGtinApprovedIdentifiers
    || fixtures.packageSpellings.size !== expected.excludedCasePacks) {
    throw new Error("Pinned reconciliation census disagrees with the trusted exact-index manifest.");
  }
  return fixtures;
}

/**
 * A deliberately small UI set.  It is derived at run time from the pinned private
 * source, so neither barcodes nor product labels enter git or the receipt.  The
 * shortest spellings exercise the bug class that used to be filtered before the
 * trusted-exact route; the boundary set covers opaque and GTIN-shaped keys.
 */
export function selectUiCorpusSample(fixtures, { shortest = 20, boundary = 12 } = {}) {
  const entries = [...fixtures.spellings.entries()].map(([code, value]) => ({ code, ...value }));
  const byLengthThenHash = [...entries].sort((left, right) =>
    left.code.length - right.code.length || sha256(left.code).localeCompare(sha256(right.code)),
  );
  const selected = byLengthThenHash.slice(0, shortest);
  const selectedCodes = new Set(selected.map(({ code }) => code));
  const classes = new Map();
  for (const entry of entries) {
    if (selectedCodes.has(entry.code)) continue;
    const key = entry.lookupKey.startsWith("nongtin:")
      ? "opaque"
      : entry.code.length <= 8 ? "gtin-short" : entry.code.length === 12 ? "upc" : entry.code.length === 13 ? "ean" : "gtin-long";
    if (!classes.has(key)) classes.set(key, entry);
  }
  for (const entry of classes.values()) {
    if (selected.length >= shortest + boundary) break;
    selected.push(entry);
  }
  if (selected.length < shortest) throw new Error("Private corpus did not contain the required shortest UI sample.");
  return selected;
}

export function runtimeCanonicalIdFor(entry) {
  const shard = (createHash("sha256").update(entry.lookupKey).digest()[0] % 64).toString(16).padStart(2, "0");
  const rows = JSON.parse(readFileSync(join(process.cwd(), "src", "server", "tire-knowledge", "exact-index", `${shard}.json`), "utf8"));
  const row = rows[entry.lookupKey];
  if (!row || row.bossTrusted !== true || typeof row.canonical_product_uid !== "string" || !row.canonical_product_uid) throw new Error("Selected UI spelling lacks a trusted exact runtime identity.");
  return row.canonical_product_uid;
}
