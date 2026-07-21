// src/services/columnIntelligence.ts
import { tireSizeToken } from "@/services/ai/tireSpecs";
import { sanitizeCell } from "@/services/csvImport";
import type { ColumnMapping, ImportField, MappingSource } from "@/services/importSchema";
import { normalizedEditSimilarity } from "@/services/reconcile/normalizedEditDistance";
import { isGtinShaped } from "@/services/upc/gtin";

export const HEADER_SYNONYMS: Readonly<Record<ImportField, readonly string[]>> = {
  partNumber: [
    "part number",
    "part no",
    "part",
    "pn",
    "item no",
    "item number",
    "mfg part number",
    "manufacturer part number",
    "sku",
    "primary sku",
  ],
  brand: ["brand", "make", "manufacturer", "mfr"],
  model: ["model", "product", "description", "product name"],
  size: ["size", "tire size", "tyre size"],
  // "item description" is intentionally NOT here: it is treated as name-leaning free text and left
  // to fuzzy/content inference; bare "description" stays a model synonym (Shop-Ware fixture law).
  quantity: ["qty", "quantity", "count", "qoh", "quantity on hand", "qty on hand", "on hand"],
  uom: ["unit", "uom", "unit of measure"],
  barcode: ["barcode", "primary barcode", "upc", "ean", "gtin"],
  name: ["name", "product name", "item name"],
  category: ["category", "department", "product category"],
};

// Extra text cues that strongly imply a field but are not standalone synonyms. A header containing
// one of these tokens (e.g. "Mfr Code", "Vendor Item #", "Stock SKU") is nudged toward the field.
// These are ADVISORY weight for the fuzzy scorer, never an exact match on their own.
const FIELD_TEXT_CUES: Readonly<Partial<Record<ImportField, readonly string[]>>> = {
  partNumber: ["code", "sku", "ref", "reference", "stock", "vendor", "supplier", "catalog", "material"],
  name: ["desc", "description", "title", "item"],
  brand: ["vendor", "supplier"],
  quantity: ["hand", "stock", "avail", "available", "onhand"],
};

// A fuzzy header text score at or above this maps the field (MEDIUM tier unless corroborated).
const FUZZY_HEADER_THRESHOLD = 0.6;
// Sampling + majority thresholds for value-based (content) inference.
const CONTENT_SAMPLE_ROWS = 40;
const CONTENT_MAJORITY = 0.7;

export type FieldTier = "high" | "medium";

export interface ColumnInference {
  headerRowIndex: number;
  headers: string[];
  mapping: ColumnMapping;
  // Per-mapped-field confidence tier. HIGH = auto-map (exact synonym, or fuzzy-header and content
  // agree). MEDIUM = a single decent signal; the UI pre-fills it but asks for a one-tap confirm.
  tiers: Partial<Record<ImportField, FieldTier>>;
  confidence: "high" | "low";
  source: MappingSource;
  reasons: string[];
}

export function normalizeImportHeader(value: string): string {
  return sanitizeCell(value)
    .toLowerCase()
    .replace(/#/g, " number ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function exactFieldForHeader(value: string): ImportField | undefined {
  const normalized = normalizeImportHeader(value);
  return (Object.keys(HEADER_SYNONYMS) as ImportField[]).find((field) =>
    HEADER_SYNONYMS[field].includes(normalized),
  );
}

function tokens(value: string): string[] {
  return normalizeImportHeader(value).split(" ").filter(Boolean);
}

// Token-overlap fraction of the header tokens that also appear (as whole tokens) in the synonym.
function tokenOverlap(headerTokens: string[], synonym: string): number {
  if (headerTokens.length === 0) return 0;
  const synTokens = new Set(synonym.split(" ").filter(Boolean));
  const shared = headerTokens.filter((t) => synTokens.has(t)).length;
  return shared / headerTokens.length;
}

// Fuzzy score of a header against a single field: the best blend of token overlap and whole-string
// edit similarity across the field's synonyms, plus a small bonus when a text cue token appears.
function fuzzyFieldScore(headerText: string, field: ImportField): number {
  const normalized = normalizeImportHeader(headerText);
  if (!normalized) return 0;
  const headerTokens = normalized.split(" ").filter(Boolean);
  let best = 0;
  for (const synonym of HEADER_SYNONYMS[field]) {
    const overlap = tokenOverlap(headerTokens, synonym);
    const edit = normalizedEditSimilarity(normalized, synonym);
    // Token overlap catches multi-word headers that share a whole synonym token ("qty on hand" vs
    // "on hand"); edit similarity alone (scaled) catches a close single-token typo ("brnd" -> "brand")
    // that shares no exact token. Take whichever signal is stronger.
    best = Math.max(best, 0.6 * overlap + 0.4 * edit, 0.9 * edit);
  }
  const cues = FIELD_TEXT_CUES[field] ?? [];
  if (cues.some((cue) => headerTokens.includes(cue))) best = Math.max(best, 0.75);
  return best;
}

// Best fuzzy field for a header (excluding exact matches, which are handled first). Returns the
// field and its score only when the score clears the threshold.
function fuzzyFieldForHeader(headerText: string): { field: ImportField; score: number } | undefined {
  let winner: { field: ImportField; score: number } | undefined;
  for (const field of Object.keys(HEADER_SYNONYMS) as ImportField[]) {
    const score = fuzzyFieldScore(headerText, field);
    if (score >= FUZZY_HEADER_THRESHOLD && (!winner || score > winner.score)) {
      winner = { field, score };
    }
  }
  return winner;
}

function nonBlank(row: string[]): boolean {
  return row.some((cell) => cell.trim() !== "");
}

// Header-row score: count of columns whose header is an EXACT synonym. Kept exact so header-row
// DETECTION (skipping title/blank rows) stays as precise as before; fuzzy matching happens after
// the header row is chosen, not while scoring which row is the header.
function headerScore(row: string[]): number {
  return new Set(row.map(exactFieldForHeader).filter((field): field is ImportField => Boolean(field))).size;
}

function valuesForColumn(rows: string[][], index: number): string[] {
  return rows
    .slice(0, CONTENT_SAMPLE_ROWS)
    .map((row) => row[index] ?? "")
    .map((value) => value.trim())
    .filter(Boolean);
}

// Fraction of non-empty sampled values that satisfy a shape predicate.
function majorityFraction(values: string[], fits: (value: string) => boolean): number {
  if (values.length === 0) return 0;
  return values.filter(fits).length / values.length;
}

function isQuantityValue(value: string): boolean {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && !isGtinShaped(value);
}

function isSizeValue(value: string): boolean {
  return tireSizeToken({ productName: value }) !== "";
}

// SKU / part-number shape: an alphanumeric code that carries letters and/or separators (- / .),
// has no internal spaces, is a moderate length, and is not a bare barcode (all digits, GTIN length).
function isPartNumberValue(value: string): boolean {
  if (/\s/.test(value)) return false;
  if (value.length < 3 || value.length > 24) return false;
  if (isGtinShaped(value)) return false;
  if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(value)) return false;
  const hasDigit = /\d/.test(value);
  const hasSeparator = /[._/-]/.test(value);
  // A part number essentially always carries a digit or a separator. A pure alphabetic token
  // (e.g. "widget", "michelin") is a name/brand word, not a SKU, so require one of the two.
  if (!hasDigit && !hasSeparator) return false;
  return true;
}

// Free-text / name shape: multiple words or a longer phrase, letter-dominant, low digit ratio.
function isNameValue(value: string): boolean {
  if (value.length <= 8) return false;
  const letters = (value.match(/[a-z]/gi) ?? []).length;
  const digits = (value.match(/\d/g) ?? []).length;
  if (letters < 4) return false;
  if (digits > letters) return false;
  const hasSpace = /\s/.test(value);
  const words = value.trim().split(/\s+/).filter(Boolean);
  return hasSpace && words.length >= 2;
}

const UOM_WORDS = new Set([
  "each", "ea", "case", "box", "pack", "pk", "ct", "pc", "pcs", "piece", "pieces",
  "unit", "units", "carton", "pallet", "set", "pair", "dozen", "roll", "bag",
]);
function isUomValue(value: string): boolean {
  return UOM_WORDS.has(value.trim().toLowerCase());
}

interface ContentSignal {
  field: ImportField;
  fits: (value: string) => boolean;
}

// Ordered by specificity: narrower shapes first so a column is claimed by its most specific match.
const CONTENT_SIGNALS: ContentSignal[] = [
  { field: "barcode", fits: isGtinShaped },
  { field: "size", fits: isSizeValue },
  { field: "uom", fits: isUomValue },
  { field: "quantity", fits: isQuantityValue },
  { field: "partNumber", fits: isPartNumberValue },
  { field: "name", fits: isNameValue },
];

interface Proposal {
  field: ImportField;
  score: number;
  tier: FieldTier;
}

export function inferColumnMapping(matrix: string[][]): ColumnInference {
  const candidateRows = matrix
    .map((row, index) => ({ row, index, score: headerScore(row) }))
    .filter(({ row }) => nonBlank(row));
  const first = candidateRows[0] ?? { row: [], index: 0, score: 0 };
  const header = candidateRows.reduce((best, current) => current.score > best.score ? current : best, first);
  const headers = header.row.map(sanitizeCell);
  const reasons: string[] = [];

  const dataRows = matrix.slice(header.index + 1).filter(nonBlank);

  // Per column, collect at most one proposal per column, keyed by column index. We first gather ALL
  // candidate (column -> field) proposals with a confidence score, then resolve conflicts globally so
  // a field is never assigned to two columns and a column is never assigned to two fields.
  interface ColumnProposal {
    index: number;
    field: ImportField;
    score: number;
    tier: FieldTier;
    reason: string;
  }
  const proposals: ColumnProposal[] = [];

  headers.forEach((headerText, index) => {
    const columnValues = valuesForColumn(dataRows, index);

    // 1) Exact synonym header -> HIGH.
    const exact = exactFieldForHeader(headerText);
    if (exact) {
      proposals.push({ index, field: exact, score: 1, tier: "high", reason: `${exact} mapped from header.` });
      return;
    }

    // 2) Fuzzy header + content inference -> combine into a tier.
    const fuzzy = fuzzyFieldForHeader(headerText);

    // Content inference: the best-fitting shape whose non-empty sampled values clear the majority.
    let content: Proposal | undefined;
    for (const signal of CONTENT_SIGNALS) {
      const fraction = majorityFraction(columnValues, signal.fits);
      if (fraction >= CONTENT_MAJORITY && (!content || fraction > content.score)) {
        content = { field: signal.field, score: fraction, tier: "medium" };
      }
    }

    if (fuzzy && content && fuzzy.field === content.field) {
      // Both signals agree -> HIGH auto-map.
      proposals.push({ index, field: fuzzy.field, score: 1, tier: "high", reason: `${fuzzy.field} mapped from header text and cell content.` });
      return;
    }
    if (fuzzy) {
      proposals.push({ index, field: fuzzy.field, score: fuzzy.score, tier: "medium", reason: `${fuzzy.field} guessed from header text; confirm before importing.` });
    }
    if (content) {
      proposals.push({ index, field: content.field, score: content.score, tier: "medium", reason: `${content.field} guessed from cell content; confirm before importing.` });
    }
  });

  // Resolve conflicts: a HIGH proposal always beats a MEDIUM one for the same field; among equal
  // tiers the higher score wins. A column never receives two fields (first accepted wins per column).
  const tierRank: Record<FieldTier, number> = { high: 2, medium: 1 };
  const ordered = [...proposals].sort((a, b) => {
    const t = tierRank[b.tier] - tierRank[a.tier];
    return t !== 0 ? t : b.score - a.score;
  });
  const mapping: ColumnMapping = {};
  const tiers: Partial<Record<ImportField, FieldTier>> = {};
  const usedColumns = new Set<number>();
  for (const proposal of ordered) {
    if (mapping[proposal.field] !== undefined) continue;
    if (usedColumns.has(proposal.index)) continue;
    mapping[proposal.field] = proposal.index;
    tiers[proposal.field] = proposal.tier;
    usedColumns.add(proposal.index);
    reasons.push(proposal.reason);
  }

  const hasIdentity = mapping.partNumber !== undefined || mapping.barcode !== undefined || mapping.name !== undefined;
  const hasQuantity = mapping.quantity !== undefined;
  const anyExactHeader = header.score > 0;
  const source: MappingSource = anyExactHeader ? "header" : "content";
  // HIGH overall confidence requires every mapped field to be HIGH tier and the core columns present.
  const allHigh = Object.values(tiers).every((tier) => tier === "high");
  const confidence = anyExactHeader && hasIdentity && hasQuantity && allHigh ? "high" : "low";
  if (!hasIdentity) reasons.push("No identity column was recognized.");
  if (!hasQuantity) reasons.push("No quantity column was recognized.");
  if (confidence === "low") reasons.push(`Seen headers: ${headers.join(", ") || "(none)"}.`);

  return {
    headerRowIndex: header.index,
    headers,
    mapping,
    tiers,
    confidence,
    source,
    reasons,
  };
}

export function validateManualMapping(
  headers: string[],
  mapping: ColumnMapping,
): { ok: true } | { ok: false; errors: string[] } {
  const assigned = Object.values(mapping).filter((value): value is number => value !== undefined);
  if (new Set(assigned).size !== assigned.length) {
    return { ok: false, errors: ["One source column cannot be assigned to more than one field."] };
  }
  if (assigned.some((index) => index < 0 || index >= headers.length)) {
    return { ok: false, errors: ["A mapped column is outside the uploaded file."] };
  }
  if (mapping.partNumber === undefined && mapping.barcode === undefined && mapping.name === undefined) {
    return { ok: false, errors: ["Map at least one identity field: part number, barcode, or name."] };
  }
  if (mapping.quantity === undefined) {
    return { ok: false, errors: ["Map the quantity field before previewing."] };
  }
  return { ok: true };
}
