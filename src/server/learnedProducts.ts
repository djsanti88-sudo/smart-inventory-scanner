// learnedProducts.ts (Task 21, owner-ratified 2026-07-15) - a prefix-corroborated LEARNED-PRODUCTS
// tier, kept STRICTLY SEPARATE from the trusted tire/retail corpus. A verified decode that ALSO
// clears an independent prefix-corroboration check gets remembered here so the next scan of the same
// code is a free suggestion instead of a re-paid decode. This tier is NEVER treated as ground truth:
// a learned row can only ever surface as a SUGGESTION (see pipeline.ts's learned-tier peek), never
// "verified", and it never marks the resolver "known" - only a human-approved alias/verified product
// does that (see CLAUDE.md's Resolver Trust Rules). Wrong identity is FAILURE; unknown is ACCEPTABLE.
//
// Storage shape mirrors decodeCacheStore.ts's file-fallback + Turso pattern exactly (keyed upsert by
// canonical code, INSERT OR REPLACE / ON CONFLICT DO UPDATE) - this is a lookup table, not an
// append-only ledger, so it does NOT reuse LadderStorage's appendOutcome/appendArchive contract.
import "server-only";
import fs from "node:fs";
import path from "node:path";

import type { EvidenceStrength } from "@/types";
import { canonicalGtin } from "@/services/upc/gtin";
import { isTrustedProductHost } from "@/services/ai/trustedProductHosts";
import { normalizeBrand } from "@/services/catalog/brandPrefixGeneral";
import { lookupPrefixFull as lookupPrefix } from "@/server/catalog/prefixIndexServer";
import { isBrandInPrefixFamily } from "@/services/tire/tirePrefixLookup";
import { hasRequiredTireSpecs } from "@/services/ai/tireSpecs";

// ---------------------------------------------------------------------------
// shouldLearnDecode - PURE write gate. No storage, no network, no side effects.
// ---------------------------------------------------------------------------

export interface ShouldLearnInput {
  code: string;
  status: string; // DecodeDecision.status ("verified" is the only status that can ever learn)
  exactCodeEvidenceVerifiedByApp: boolean;
  evidenceStrength: EvidenceStrength;
  sourceUrl: string; // the winning source URL (must be a trusted product host)
  brand: string;
  category: string;
  productName: string;
  specsShort: string;
  specsFull: string;
}

/**
 * True when the decoded brand is POSITIVELY CORROBORATED by the barcode's own GS1 company prefix -
 * never merely "not conflicting". Two independent signals are checked (either is sufficient):
 *   - the GENERAL catalog-derived dominant-brand map (brandPrefixGeneral.ts) names this exact prefix
 *     bucket as belonging to one unambiguous brand, and the decoded brand normalizes to that brand;
 *   - the tire-specific STRONG prefix-hint family (tirePrefixLookup.ts, strongOnly) includes this
 *     brand (covers same-company families like Michelin/BFGoodrich/Uniroyal-NA that the general map
 *     may not carry as a single dominant entry).
 * An UNMAPPED prefix (no data either way) returns false: absence of a conflict is not corroboration.
 */
function prefixCorroboratesBrand(code: string, brand: string): boolean {
  const nb = normalizeBrand(brand);
  if (!nb) return false;

  const generalDominant = lookupPrefix(code)?.dominant?.name;
  if (generalDominant && normalizeBrand(generalDominant) === nb) return true;

  if (isBrandInPrefixFamily(code, brand, { strongOnly: true })) return true;

  return false;
}

/** A short, honest, human-readable trace of why the prefix check passed/failed (stored on the row
 *  and surfaced in the learned-tier suggestion reason). Pure string builder, no side effects. */
export function prefixCheckNote(code: string, brand: string): string {
  const nb = normalizeBrand(brand);
  const generalDominant = lookupPrefix(code)?.dominant?.name;
  if (generalDominant && normalizeBrand(generalDominant) === nb) {
    return `prefix-corroborated: catalog dominant brand for this prefix is "${generalDominant}"`;
  }
  if (isBrandInPrefixFamily(code, brand, { strongOnly: true })) {
    return `prefix-corroborated: "${brand}" is in the barcode's strong tire-prefix brand family`;
  }
  return "prefix not corroborated";
}

/**
 * PURE gate: may this verified decode be written into the learned_products tier? ALL of the
 * following must hold (owner-ratified 2026-07-15, Task 21):
 *   - status === "verified" (a suggestion/needs_review/conflict never learns);
 *   - exactCodeEvidenceVerifiedByApp === true (the app's own verifier confirmed the code, never a
 *     model self-claim);
 *   - evidenceStrength === "fetched_source" (the app actually retrieved and read the page - the
 *     strongest evidence channel; url_only/snippet/grounding_chunk never qualify, even from a
 *     trusted host);
 *   - the winning sourceUrl's host is on the curated trusted-product allowlist
 *     (trustedProductHosts.ts);
 *   - the barcode's own GS1 prefix POSITIVELY CORROBORATES the decoded brand (prefixCorroboratesBrand
 *     above) - mere absence of a conflict is NOT enough; an unmapped/silent prefix refuses;
 *   - for a tire category, the decode also carries the REQUIRED tire specs (size + load/speed, or a
 *     valid commercial/flotation size alone) - hasRequiredTireSpecs, same gate the store's auto-count
 *     path already enforces, so a sibling-size tire (same model, different size) can never be
 *     silently remembered under the wrong size.
 */
export function shouldLearnDecode(input: ShouldLearnInput): boolean {
  if (input.status !== "verified") return false;
  if (!input.exactCodeEvidenceVerifiedByApp) return false;
  if (input.evidenceStrength !== "fetched_source") return false;
  if (!isTrustedProductHost(input.sourceUrl)) return false;
  if (!prefixCorroboratesBrand(input.code, input.brand)) return false;

  const isTire = (input.category ?? "").toLowerCase().includes("tire");
  if (isTire) {
    const specsCheck = { productName: input.productName, brand: input.brand, category: input.category, specsShort: input.specsShort, specsFull: input.specsFull };
    if (!hasRequiredTireSpecs(specsCheck)) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Storage - keyed upsert, mirrors decodeCacheStore.ts's Turso/file adapter pattern exactly.
// ---------------------------------------------------------------------------

export interface LearnedProductRow {
  code: string; // canonical GTIN key (see canonicalGtin) - PRIMARY KEY, upserted
  name: string;
  brand: string;
  category: string;
  specsShort: string;
  specsFull: string;
  confidence: number;
  sourceUrl: string;
  evidenceStrength: EvidenceStrength;
  prefixCheck: string; // the honest trace from prefixCheckNote(), stored for transparency
  createdAt: string; // ISO
}

function canonicalKey(code: string): string {
  return canonicalGtin(code) ?? (code ?? "").trim();
}

// --- Turso/libsql (production) ---------------------------------------------------------------------
type TursoClient = { execute: (stmt: { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LibsqlClientModule = { createClient: (config: { url: string; authToken: string }) => any };

let _tursoClient: TursoClient | null | "unavailable" = null;
let _tursoTableReady = false;

const DDL =
  "CREATE TABLE IF NOT EXISTS learned_products (" +
  "code TEXT PRIMARY KEY, name TEXT, brand TEXT, category TEXT, specs_short TEXT, specs_full TEXT, " +
  "confidence REAL, source_url TEXT, evidence_strength TEXT, prefix_check TEXT, created_at TEXT)";

async function getTursoClient(): Promise<TursoClient | null> {
  if (_tursoClient === "unavailable") return null;
  if (_tursoClient) return _tursoClient;
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!url || !token) { _tursoClient = "unavailable"; return null; }
  try {
    const { createClient } = (await import("@libsql/client")) as unknown as LibsqlClientModule;
    _tursoClient = createClient({ url, authToken: token }) as TursoClient;
    return _tursoClient;
  } catch {
    console.warn("[learned-products] Turso client unavailable.");
    _tursoClient = "unavailable";
    return null;
  }
}

async function ensureTursoTable(client: TursoClient): Promise<boolean> {
  if (_tursoTableReady) return true;
  try {
    await client.execute({ sql: DDL, args: [] });
    _tursoTableReady = true;
    return true;
  } catch {
    console.warn("[learned-products] Turso table unavailable.");
    return false;
  }
}

// --- File fallback (local dev / no Turso configured) ------------------------------------------------
function storeFile(): string {
  return process.env.LEARNED_PRODUCTS_FILE || path.resolve(".learned-products.json");
}

type FileShape = Record<string, LearnedProductRow>;

function isValidRow(v: unknown): v is LearnedProductRow {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.code === "string" &&
    typeof e.name === "string" &&
    typeof e.brand === "string" &&
    typeof e.category === "string" &&
    typeof e.confidence === "number" &&
    typeof e.sourceUrl === "string" &&
    typeof e.evidenceStrength === "string" &&
    typeof e.createdAt === "string"
  );
}

function readFileStore(): FileShape {
  try {
    const raw = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ storeFile(), "utf8"));
    if (raw && typeof raw === "object") return raw as FileShape;
  } catch {
    // no file yet / unreadable / corrupted JSON -> treat as empty, self-heals on next write
  }
  return {};
}

function writeFileStore(store: FileShape): void {
  try {
    fs.writeFileSync(storeFile(), JSON.stringify(store));
  } catch {
    // best-effort persistence (e.g. read-only serverless FS, impossible path)
  }
}

// --- Public API -------------------------------------------------------------------------------------

/** Read a learned row for a code. Returns null on a genuine miss OR any storage failure/corruption. */
export async function getLearnedProduct(code: string): Promise<LearnedProductRow | null> {
  const key = canonicalKey(code);
  if (!key) return null;
  try {
    const client = await getTursoClient();
    if (client) {
      const ready = await ensureTursoTable(client);
      if (!ready) return null;
      const result = await client.execute({
        sql:
          "SELECT code, name, brand, category, specs_short, specs_full, confidence, source_url, evidence_strength, prefix_check, created_at " +
          "FROM learned_products WHERE code = ?",
        args: [key],
      });
      const row = result.rows[0];
      if (!row) return null;
      return {
        code: String(row.code),
        name: String(row.name ?? ""),
        brand: String(row.brand ?? ""),
        category: String(row.category ?? ""),
        specsShort: String(row.specs_short ?? ""),
        specsFull: String(row.specs_full ?? ""),
        confidence: Number(row.confidence ?? 0),
        sourceUrl: String(row.source_url ?? ""),
        evidenceStrength: (row.evidence_strength as EvidenceStrength) ?? "none",
        prefixCheck: String(row.prefix_check ?? ""),
        createdAt: String(row.created_at ?? ""),
      };
    }
    const store = readFileStore();
    const row = store[key];
    return isValidRow(row) ? row : null;
  } catch {
    console.warn("[learned-products] Turso read failed.");
    return null;
  }
}

/** Upsert a learned row by canonical code. Best-effort: never throws, even on total storage failure. */
export async function upsertLearnedProduct(entry: LearnedProductRow): Promise<void> {
  const key = canonicalKey(entry.code);
  if (!key) return;
  const normalized: LearnedProductRow = { ...entry, code: key };
  try {
    const client = await getTursoClient();
    if (client) {
      const ready = await ensureTursoTable(client);
      if (!ready) return;
      await client.execute({
        sql:
          "INSERT INTO learned_products (code, name, brand, category, specs_short, specs_full, confidence, source_url, evidence_strength, prefix_check, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(code) DO UPDATE SET name=excluded.name, brand=excluded.brand, category=excluded.category, " +
          "specs_short=excluded.specs_short, specs_full=excluded.specs_full, confidence=excluded.confidence, " +
          "source_url=excluded.source_url, evidence_strength=excluded.evidence_strength, prefix_check=excluded.prefix_check, " +
          "created_at=excluded.created_at",
        args: [
          normalized.code,
          normalized.name,
          normalized.brand,
          normalized.category,
          normalized.specsShort,
          normalized.specsFull,
          normalized.confidence,
          normalized.sourceUrl,
          normalized.evidenceStrength,
          normalized.prefixCheck,
          normalized.createdAt,
        ],
      });
      return;
    }
    const store = readFileStore();
    store[key] = normalized;
    writeFileStore(store);
  } catch {
    console.warn("[learned-products] Turso write failed.");
    // best-effort; never throw - a broken learned-tier store must never break a live decode
  }
}

/**
 * LANE C ITEM C4 (owner-reported live regression, 2026-07-20): reverse prefix->learned-siblings
 * lookup. Given a 7-digit GS1 company prefix, returns every learned (previously-verified-then-learned)
 * row whose OWN code shares that prefix. Used by siblingPrefixConflict below to catch a fresh decode
 * that contradicts what the app already knows about this prefix from a genuinely verified sibling scan
 * - e.g. a code sharing the 721749* prefix with an already-learned Fortune tire decoding to an
 * unrelated perfume brand. Returns [] on a genuine miss OR any storage failure (never throws).
 */
export async function getLearnedProductsByPrefix(prefix: string): Promise<LearnedProductRow[]> {
  const p = (prefix ?? "").replace(/\D/g, "");
  if (!p || p.length < 4) return [];
  try {
    const client = await getTursoClient();
    if (client) {
      const ready = await ensureTursoTable(client);
      if (!ready) return [];
      const result = await client.execute({
        sql:
          "SELECT code, name, brand, category, specs_short, specs_full, confidence, source_url, evidence_strength, prefix_check, created_at " +
          "FROM learned_products WHERE code LIKE ? OR code LIKE ?",
        // canonicalGtin always pads to 14 digits; a real 12/13-digit code's prefix can start at
        // position 0, 1, or 2 of the stored 14-digit key depending on padding - match both the
        // zero-padded (14-digit) and unpadded start positions so no sibling is missed.
        args: [`${p}%`, `0${p}%`],
      });
      return result.rows.map((row) => ({
        code: String(row.code),
        name: String(row.name ?? ""),
        brand: String(row.brand ?? ""),
        category: String(row.category ?? ""),
        specsShort: String(row.specs_short ?? ""),
        specsFull: String(row.specs_full ?? ""),
        confidence: Number(row.confidence ?? 0),
        sourceUrl: String(row.source_url ?? ""),
        evidenceStrength: (row.evidence_strength as EvidenceStrength) ?? "none",
        prefixCheck: String(row.prefix_check ?? ""),
        createdAt: String(row.created_at ?? ""),
      }));
    }
    const store = readFileStore();
    return Object.values(store).filter((row) => isValidRow(row) && row.code.replace(/^0+/, "").startsWith(p.replace(/^0+/, "")));
  } catch {
    console.warn("[learned-products] Turso prefix read failed.");
    return [];
  }
}

export interface SiblingConflictCandidate {
  brand?: string;
  category?: string;
}

export interface SiblingConflictVerdict {
  conflict: boolean; // true => demote to needs_review (never suppress the row - it still appears+counts)
  overriddenByEvidence: boolean;
  reason: string; // platformOwner-only diagnostic
  siblingCode?: string;
}

function catTokens(s: string | undefined): string[] {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length >= 3);
}

/** Token-tolerant brand match, same tolerance shape as prefixFirewall.ts's candidateMatchesPrefix. */
function brandsMatch(a: string | undefined, b: string | undefined): boolean {
  const na = normalizeBrand(a);
  const nb = normalizeBrand(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const a0 = na.split(" ")[0];
  const b0 = nb.split(" ")[0];
  return (!!a0 && nb.includes(a0)) || (!!b0 && na.includes(b0));
}

/** True when the two category strings share no token overlap AND both are non-empty (unknown category
 *  on either side is never treated as a conflict - only a POSITIVE mismatch counts). */
function categoriesConflict(a: string | undefined, b: string | undefined): boolean {
  const ta = catTokens(a);
  const tb = catTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  return !ta.some((t) => tb.includes(t));
}

/**
 * SAME-PREFIX SIBLING CONTRADICTION GUARD (Item C4, owner-reported live regression 2026-07-20): when
 * the app already holds VERIFIED-then-learned evidence that GS1 prefix P belongs to brand/category X
 * (a learned row sharing this code's prefix), a NEW decode on prefix P whose identity contradicts X -
 * DIFFERENT brand family AND DIFFERENT category - must not be stored/applied as a clean suggestion. It
 * is a DEMOTION to needs_review with an honest conflict reason, never a suppression (the row always
 * appears+counts per the top-level "every scan counts" law). Strong app-verified exact-code evidence
 * for THIS scan still overrides (same override shape as evaluatePrefixFirewall). A same-company
 * different-category product (e.g. a tire manufacturer that also sells wheel accessories) is NOT a
 * conflict - only a brand mismatch AND a category mismatch together indicate contradiction (mirrors
 * evaluatePrefixFirewall's categoryCompatible escape hatch for legitimate multi-category manufacturers).
 * Inert (no conflict) when there is no learned sibling on this prefix at all - absence of data is never
 * treated as a conflict.
 */
export async function siblingPrefixConflict(
  code: string,
  candidate: SiblingConflictCandidate,
  opts: { exactCodeVerifiedByApp?: boolean } = {},
): Promise<SiblingConflictVerdict> {
  // NOTE: a 6-digit block (not the 7-digit candidateCompanyPrefix used elsewhere for corroboration) is
  // used here deliberately - real GS1 company-prefix length is variable, and the owner's live regression
  // fixture (721749089643 vs 721749249238, a Fortune-tire/Lattafa-perfume pair) shares only 6 digits.
  // A 6-digit block is coarser (more siblings match), which is the SAFER direction for a conflict GUARD
  // (a false negative here silently stores a wrong identity; a false positive only demotes to review,
  // never suppresses the row) - the brand+category double-mismatch requirement keeps it from
  // false-flagging unrelated same-block coincidences.
  const digits = (code ?? "").replace(/\D/g, "");
  const prefix = digits.slice(0, 6);
  if (prefix.length < 6) return { conflict: false, overriddenByEvidence: false, reason: "" };

  const siblings = await getLearnedProductsByPrefix(prefix);
  if (siblings.length === 0) return { conflict: false, overriddenByEvidence: false, reason: "" };

  for (const sib of siblings) {
    if (brandsMatch(candidate.brand, sib.brand)) continue; // same company - never a conflict
    if (!categoriesConflict(candidate.category, sib.category)) continue; // unknown/compatible category
    const rawConflict = true;
    const overriddenByEvidence = rawConflict && opts.exactCodeVerifiedByApp === true;
    const conflict = rawConflict && !overriddenByEvidence;
    const reason = overriddenByEvidence
      ? `Same-prefix sibling conflict present but OVERRIDDEN: the app verified the exact code in strong evidence for this scan.`
      : `Barcode prefix ${prefix} already has a verified sibling product "${sib.name}" (brand "${sib.brand}", category "${sib.category}"); ` +
        `candidate is a different brand + category ("${candidate.brand || "?"}" / "${candidate.category || "?"}"). Demoted to Needs Review.`;
    return { conflict, overriddenByEvidence, reason, siblingCode: sib.code };
  }
  return { conflict: false, overriddenByEvidence: false, reason: "" };
}

/** Test-only: reset in-memory Turso client/table-ready state between test cases. */
export function __resetLearnedProductsForTest(): void {
  _tursoClient = null;
  _tursoTableReady = false;
}
