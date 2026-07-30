import { createHash } from "node:crypto";
import {
  isTrustedLocalDemoTireRow,
  isValidLocalDemoGtin,
} from "../src/server/tire-knowledge/localDemoTrust.mjs";

export const LOCAL_DEMO_SAMPLE_SEED = "scanbin-local-tire-demo-v1";
export const LOCAL_DEMO_SAMPLE_TOTAL = 3000;
export const LOCAL_DEMO_BATCH_SIZE = 100;
export const LOCAL_DEMO_AGENT_COUNT = 10;

export function paddingEquivalenceKey(value) {
  const barcode = String(value ?? "").trim();
  if (!isValidLocalDemoGtin(barcode)) return barcode;
  if (barcode.length === 13 && barcode.startsWith("0") && isValidLocalDemoGtin(barcode.slice(1))) return barcode.slice(1);
  if (barcode.length === 14 && barcode.startsWith("00") && isValidLocalDemoGtin(barcode.slice(2))) return barcode.slice(2);
  return barcode;
}

export function mapDatabaseRow(row) {
  const completeness = Number(row.field_completeness_score || 0);
  return {
    barcode: String(row.barcode ?? "").trim(),
    barcodeType: String(row.barcode_type ?? ""),
    canonicalProductUid: String(row.canonical_product_uid ?? ""),
    brand: String(row.brand ?? ""),
    model: String(row.model_display || row.model || ""),
    size: String(row.size ?? ""),
    loadIndex: String(row.load_index ?? ""),
    speedRating: String(row.speed_rating ?? ""),
    manufacturerPartNumber: String(row.manufacturer_part_number ?? ""),
    type: String(row.type ?? ""),
    season: String(row.season ?? ""),
    sourceCount: Number(row.source_count || 0),
    confidence: String(row.confidence ?? ""),
    currentStatus: String(row.current_status ?? ""),
    usableFor: String(row.usable_for ?? ""),
    fieldCompletenessScore: completeness > 0 && completeness <= 1 ? completeness * 100 : completeness,
  };
}

function rank(seed, row) {
  return createHash("sha256").update(`${seed}|${row.canonicalProductUid}|${row.barcode}`).digest("hex");
}

function normalizedMpn(row) {
  return row.manufacturerPartNumber.replace(/[ -]/g, "").toUpperCase();
}

function barcodeShape(row) {
  if (row.barcode.length === 12) return "upc";
  if (row.barcode.length === 13) return "ean13";
  return "other";
}

function angleRules(mpnFrequency) {
  return [
    { angle: "mpn_topology", strata: [
      { stratum: "mpn_repeated", count: 250, test: (row) => { const key = normalizedMpn(row); return Boolean(key) && (mpnFrequency.get(key) || 0) > 1; } },
      { stratum: "mpn_unique", count: 50, test: (row) => { const key = normalizedMpn(row); return Boolean(key) && mpnFrequency.get(key) === 1; } },
    ] },
    { angle: "winter_all_terrain", strata: [{ stratum: "winter_or_all_terrain", count: 300, test: (row) => /winter|all[ _-]?terrain/i.test(`${row.model} ${row.type} ${row.season}`) }] },
    { angle: "special_size_forms", strata: [{ stratum: "size_lt_or_flotation", count: 300, test: (row) => /^LT/i.test(row.size) || /^\d{2,3}(?:\.\d+)?X/i.test(row.size) }] },
    { angle: "source_5plus", strata: [{ stratum: "source_count_5plus", count: 300, test: (row) => row.sourceCount >= 5 }] },
    { angle: "verified_strong", strata: [{ stratum: "verified_1src_strong", count: 300, test: (row) => row.confidence === "verified_1src_strong" }] },
    { angle: "lower_completeness", strata: [{ stratum: "completeness_70_or_lower", count: 300, test: (row) => row.fieldCompletenessScore <= 70 }] },
    { angle: "source_3", strata: [{ stratum: "source_count_3", count: 300, test: (row) => row.sourceCount === 3 }] },
    { angle: "ean", strata: [{ stratum: "barcode_ean13", count: 300, test: (row) => barcodeShape(row) === "ean13" }] },
    { angle: "upc", strata: [{ stratum: "barcode_upc", count: 300, test: (row) => barcodeShape(row) === "upc" }] },
    { angle: "diversity_holdout", strata: [{ stratum: "remaining_brand_size_diversity", count: 300, test: () => true }] },
  ];
}

export function localDemoSamplingContext(rows) {
  const eligible = rows.filter(isTrustedLocalDemoTireRow).map(mapDatabaseRow);
  const mpnFrequency = new Map();
  for (const row of eligible) {
    const key = normalizedMpn(row);
    if (key) mpnFrequency.set(key, (mpnFrequency.get(key) || 0) + 1);
  }
  return { eligible, rules: angleRules(mpnFrequency) };
}

export function sampleTireRows(rows, {
  seed = LOCAL_DEMO_SAMPLE_SEED,
  total = LOCAL_DEMO_SAMPLE_TOTAL,
  batchSize = LOCAL_DEMO_BATCH_SIZE,
  agentCount = LOCAL_DEMO_AGENT_COUNT,
} = {}) {
  if (!seed) throw new Error("A non-empty deterministic seed is required.");
  if (total !== LOCAL_DEMO_SAMPLE_TOTAL) throw new Error(`Local tire proof requires exactly ${LOCAL_DEMO_SAMPLE_TOTAL} rows.`);
  if (batchSize !== LOCAL_DEMO_BATCH_SIZE || agentCount !== LOCAL_DEMO_AGENT_COUNT) throw new Error("Local tire proof requires 100-row batches and 10 agents.");

  const { eligible, rules } = localDemoSamplingContext(rows);

  const usedBarcodes = new Set();
  const usedCanonicalIds = new Set();
  const usedEquivalenceKeys = new Set();
  const selected = [];
  for (const rule of rules) {
    for (const stratum of rule.strata) {
      const candidates = eligible.filter(stratum.test)
        .map((row) => ({ row, sampleRank: rank(seed, row) }))
        .sort((left, right) => left.sampleRank.localeCompare(right.sampleRank));
      let accepted = 0;
      for (const { row } of candidates) {
        const equivalenceKey = paddingEquivalenceKey(row.barcode);
        if (usedBarcodes.has(row.barcode) || usedCanonicalIds.has(row.canonicalProductUid) || usedEquivalenceKeys.has(equivalenceKey)) continue;
        usedBarcodes.add(row.barcode);
        usedCanonicalIds.add(row.canonicalProductUid);
        usedEquivalenceKeys.add(equivalenceKey);
        selected.push({ ...row, angle: rule.angle, stratum: stratum.stratum });
        accepted += 1;
        if (accepted === stratum.count) break;
      }
      if (accepted !== stratum.count) throw new Error(`Stratum ${stratum.stratum} requires ${stratum.count} rows; found ${accepted}.`);
    }
  }
  if (selected.length !== total) throw new Error(`Need ${total} eligible unique tire rows; found ${selected.length}.`);

  const batchesPerAgent = total / batchSize / agentCount;
  if (!Number.isInteger(batchesPerAgent)) throw new Error("total must divide evenly across batchSize and agentCount.");
  return selected.map((row, index) => ({
    ...row,
    ordinal: index + 1,
    batch: Math.floor(index / batchSize) + 1,
    agent: Math.floor(index / (batchSize * batchesPerAgent)) + 1,
  }));
}

export function sampleAngleRulesForValidation(rows) {
  return localDemoSamplingContext(rows).rules;
}
