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
import { lookupPrefix } from "@/services/catalog/prefixIndex";
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
  } catch (e) {
    console.warn("[learned-products] Failed to create Turso client:", (e as Error).message);
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
  } catch (e) {
    console.warn("[learned-products] Failed to ensure learned_products table:", (e as Error).message);
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
    const raw = JSON.parse(fs.readFileSync(storeFile(), "utf8"));
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
  } catch (e) {
    console.warn("[learned-products] getLearnedProduct failed:", (e as Error).message);
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
  } catch (e) {
    console.warn("[learned-products] upsertLearnedProduct failed:", (e as Error).message);
    // best-effort; never throw - a broken learned-tier store must never break a live decode
  }
}

/** Test-only: reset in-memory Turso client/table-ready state between test cases. */
export function __resetLearnedProductsForTest(): void {
  _tursoClient = null;
  _tursoTableReady = false;
}
