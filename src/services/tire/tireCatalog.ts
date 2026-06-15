// Tire catalog pipeline. PURE (no React, no next/*, no network). Deterministic dedupe + multi-source
// merge + confidence/status scoring per the owner's rules, plus the no-padding count categories and an
// import-ready CSV that feeds the app's existing csvImport.buildProductImport. The network/Firecrawl
// discovery that FEEDS this lives in scripts/tire-discovery.mjs and is kept separate (and legal: facts
// only, robots-checked, capped). This module is unit-tested with fixtures and never fabricates data.

export type TireSourceType =
  | "shop_export"
  | "vendor_csv"
  | "distributor_catalog"
  | "manufacturer_catalog"
  | "retailer_page"
  | "barcode_api"
  | "gs1_lookup"
  | "field_scan"
  | "other";

export type TireStatus = "verified" | "candidate" | "conflicted" | "hold";

/** One factual observation about a tire from a single source. Facts only; keep the source URL/note. */
export interface TireObservation {
  sourceType: TireSourceType;
  sourceUrl?: string;
  sourceNote?: string;
  brand: string;
  model: string;
  size?: string; // e.g. 245/40R18
  loadIndex?: string;
  speedRating?: string;
  sidewall?: string; // BSW/OWL/RWL
  season?: string;
  category?: string; // default "Tire"
  partNumber?: string;
  mfrPartNumber?: string;
  vendorSku?: string;
  upcGtin?: string; // a scannable UPC/EAN/GTIN if (and only if) the source actually provided one
  fieldConfirmed?: boolean; // a real scan confirmed this in the field
}

export interface TireRecord {
  // identity
  brand: string;
  model: string;
  size: string;
  loadIndex: string;
  speedRating: string;
  sidewall: string;
  season: string;
  category: string;
  // codes
  upcGtin: string;
  partNumber: string;
  mfrPartNumber: string;
  vendorSku: string;
  // provenance / trust
  sourceTypes: TireSourceType[];
  sourceUrls: string[];
  sourceNotes: string[];
  confidence: number; // 0..1
  status: TireStatus;
  scannable: "verified_scannable" | "candidate_scannable" | "spec_only";
  evidenceNotes: string;
  dedupeKey: string;
  verifiedAt: string | null;
}

export interface TireCatalogResult {
  records: TireRecord[];
  conflicts: TireRecord[];
  counts: {
    total: number;
    verifiedScannable: number; // status verified AND has UPC/GTIN
    candidateScannable: number; // not verified-scannable, but has SOME scannable code (UPC/GTIN/SKU/partNumber)
    specOnlyCandidate: number; // no scannable code at all
    conflicted: number;
    rejectedHeld: number; // status "hold"
  };
}

const BASE_CONFIDENCE: Record<TireSourceType, number> = {
  manufacturer_catalog: 0.8,
  distributor_catalog: 0.6,
  vendor_csv: 0.6,
  shop_export: 0.5,
  retailer_page: 0.4,
  field_scan: 0.7,
  barcode_api: 0.6,
  gs1_lookup: 0.6,
  other: 0.3,
};

const norm = (s: string | undefined): string => (s ?? "").trim();
const lc = (s: string | undefined): string => norm(s).toLowerCase().replace(/\s+/g, " ");
/** Digits-only normalization for barcodes (so "0 49000 02890 4" == "049000028904"). */
const digits = (s: string | undefined): string => (s ?? "").replace(/\D/g, "");

/** Dedupe key: UPC/GTIN first (most authoritative); else normalized identity tuple. */
export function dedupeKey(o: { upcGtin?: string; brand: string; model: string; size?: string; loadIndex?: string; speedRating?: string; sidewall?: string }): string {
  const g = digits(o.upcGtin);
  if (g) return `gtin:${g}`;
  return `id:${[lc(o.brand), lc(o.model), lc(o.size), lc(o.loadIndex), lc(o.speedRating), lc(o.sidewall)].join("|")}`;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100));
}

/** Score a group of observations that share a dedupe key. Implements the owner's scoring rules. */
function scoreGroup(obs: TireObservation[]): { confidence: number; conflict: boolean; reason: string } {
  const distinctSourceTypes = [...new Set(obs.map((o) => o.sourceType))];
  const base = Math.max(...distinctSourceTypes.map((t) => BASE_CONFIDENCE[t]));
  // +0.1 per ADDITIONAL independent agreeing source type, capped at +0.2
  const agreementBonus = Math.min(0.2, Math.max(0, distinctSourceTypes.length - 1) * 0.1);
  const fieldBonus = obs.some((o) => o.fieldConfirmed) ? 0.1 : 0;

  // Conflict: the same key carries contradictory identity facts (e.g. two different brands/models),
  // OR the same GTIN maps to different brand+model. Conflicts get a -0.3 penalty and status conflicted.
  const brands = new Set(obs.map((o) => lc(o.brand)).filter(Boolean));
  const models = new Set(obs.map((o) => lc(o.model)).filter(Boolean));
  const conflict = brands.size > 1 || models.size > 1;
  const conflictPenalty = conflict ? -0.3 : 0;

  const confidence = clamp(base + agreementBonus + fieldBonus + conflictPenalty);
  const reason =
    `base ${base} (${distinctSourceTypes.join("+")})` +
    (agreementBonus ? ` +${agreementBonus} agreement` : "") +
    (fieldBonus ? " +0.1 field" : "") +
    (conflict ? " -0.3 conflict" : "");
  return { confidence, conflict, reason };
}

function classifyStatus(confidence: number, conflict: boolean): TireStatus {
  if (conflict) return "conflicted";
  if (confidence >= 0.8) return "verified";
  if (confidence >= 0.5) return "candidate";
  return "hold";
}

function firstNonEmpty(obs: TireObservation[], pick: (o: TireObservation) => string | undefined): string {
  for (const o of obs) {
    const v = norm(pick(o));
    if (v) return v;
  }
  return "";
}

/** Build the deduped, scored, classified catalog from raw observations. Never fabricates fields. */
export function buildTireCatalog(observations: TireObservation[]): TireCatalogResult {
  const groups = new Map<string, TireObservation[]>();
  for (const o of observations) {
    const key = dedupeKey(o);
    const arr = groups.get(key) ?? [];
    arr.push(o);
    groups.set(key, arr);
  }

  const records: TireRecord[] = [];
  for (const [key, obs] of groups) {
    const { confidence, conflict, reason } = scoreGroup(obs);
    const status = classifyStatus(confidence, conflict);

    const upcGtin = digits(firstNonEmpty(obs, (o) => o.upcGtin));
    const partNumber = firstNonEmpty(obs, (o) => o.partNumber);
    const mfrPartNumber = firstNonEmpty(obs, (o) => o.mfrPartNumber);
    const vendorSku = firstNonEmpty(obs, (o) => o.vendorSku);

    const hasAnyCode = Boolean(upcGtin || partNumber || mfrPartNumber || vendorSku);
    const scannable: TireRecord["scannable"] =
      status === "verified" && upcGtin ? "verified_scannable" : hasAnyCode ? "candidate_scannable" : "spec_only";

    records.push({
      brand: firstNonEmpty(obs, (o) => o.brand),
      model: firstNonEmpty(obs, (o) => o.model),
      size: firstNonEmpty(obs, (o) => o.size),
      loadIndex: firstNonEmpty(obs, (o) => o.loadIndex),
      speedRating: firstNonEmpty(obs, (o) => o.speedRating),
      sidewall: firstNonEmpty(obs, (o) => o.sidewall),
      season: firstNonEmpty(obs, (o) => o.season),
      category: firstNonEmpty(obs, (o) => o.category) || "Tire",
      upcGtin,
      partNumber,
      mfrPartNumber,
      vendorSku,
      sourceTypes: [...new Set(obs.map((o) => o.sourceType))],
      sourceUrls: [...new Set(obs.map((o) => norm(o.sourceUrl)).filter(Boolean))],
      sourceNotes: [...new Set(obs.map((o) => norm(o.sourceNote)).filter(Boolean))],
      confidence,
      status,
      scannable,
      evidenceNotes: reason,
      dedupeKey: key,
      verifiedAt: status === "verified" ? "scored" : null,
    });
  }

  const conflicts = records.filter((r) => r.status === "conflicted");
  const counts = countCategories(records);
  return { records, conflicts, counts };
}

// A clean PARTITION (every record falls in exactly one bucket): conflicted and hold take priority,
// then the remaining (verified/candidate) records split by scannable coverage. No padding, no overlap.
export function countCategories(records: TireRecord[]): TireCatalogResult["counts"] {
  const active = records.filter((r) => r.status !== "conflicted" && r.status !== "hold");
  return {
    total: records.length,
    verifiedScannable: active.filter((r) => r.scannable === "verified_scannable").length,
    candidateScannable: active.filter((r) => r.scannable === "candidate_scannable").length,
    specOnlyCandidate: active.filter((r) => r.scannable === "spec_only").length,
    conflicted: records.filter((r) => r.status === "conflicted").length,
    rejectedHeld: records.filter((r) => r.status === "hold").length,
  };
}

/** Build an app-import-ready CSV (columns understood by csvImport.buildProductImport). Only records that
 *  carry at least one scannable code are emitted (spec-only/conflicted rows are NOT app-importable). */
export function toImportCsv(records: TireRecord[]): string {
  const importable = records.filter((r) => r.status !== "conflicted" && (r.upcGtin || r.vendorSku || r.partNumber || r.mfrPartNumber));
  const headers = ["name", "brand", "category", "specs", "gtin", "upc", "primary_sku", "vendor_codes", "source", "confidence", "status"];
  const esc = (v: string) => (/[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  const rows = importable.map((r) => {
    const name = `${r.brand} ${r.model}`.trim();
    const isGtin = r.upcGtin.length >= 13 || r.upcGtin.length === 14;
    const vendorCodes = [r.vendorSku, r.partNumber, r.mfrPartNumber].filter(Boolean).join(" | ");
    return [
      name,
      r.brand,
      r.category,
      [r.size, r.loadIndex, r.speedRating, r.sidewall].filter(Boolean).join(" "),
      isGtin ? r.upcGtin : "",
      !isGtin && r.upcGtin ? r.upcGtin : "",
      r.vendorSku || r.partNumber || r.mfrPartNumber || "",
      vendorCodes,
      r.sourceTypes.join("+"),
      String(r.confidence),
      r.status,
    ].map((x) => esc(String(x ?? "")));
  });
  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";
}

/** Full catalog CSV (every record incl. spec-only/conflicted, with provenance). For the data file. */
export function toCatalogCsv(records: TireRecord[]): string {
  const headers = [
    "brand", "model", "size", "load_index", "speed_rating", "sidewall", "season", "category",
    "upc_gtin", "part_number", "mfr_part_number", "vendor_sku",
    "status", "scannable", "confidence", "source_types", "source_urls", "source_notes", "evidence_notes", "dedupe_key",
  ];
  const esc = (v: string) => (/[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  const rows = records.map((r) =>
    [
      r.brand, r.model, r.size, r.loadIndex, r.speedRating, r.sidewall, r.season, r.category,
      r.upcGtin, r.partNumber, r.mfrPartNumber, r.vendorSku,
      r.status, r.scannable, String(r.confidence), r.sourceTypes.join("+"), r.sourceUrls.join(" | "), r.sourceNotes.join(" | "), r.evidenceNotes, r.dedupeKey,
    ].map((x) => esc(String(x ?? ""))),
  );
  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";
}

export function toJsonl(records: TireRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
}
