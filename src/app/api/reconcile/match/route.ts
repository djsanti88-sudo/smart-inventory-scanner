import { NextResponse } from "next/server";
import {
  matchExpectedRow,
  type CorpusCandidate,
  type MatcherDeps,
} from "@/services/reconcile/identityMatcher";
import type { ExpectedInventoryRow } from "@/services/reconcile/types";
import {
  lookupAllByPartNumber,
  candidatesBySizeToken,
  type TireKnowledgeRow,
} from "@/server/tire-knowledge/tireKnowledgeIndex";
import { tireSizeToken } from "@/services/ai/tireSpecs";
import { tirePartNumberVariants } from "@/services/catalog/tirePartNumber";
import { lookupRetailBarcodeAsync } from "@/server/retail-knowledge/retailKnowledgeIndex";
import type { PreviewMatchResult } from "@/services/universalImportPreview";

// Preview result = a MatchResult optionally enriched with the exact retail-corpus hit for a non-tire
// row (the "identified from the 4M-product catalog" badge). Shared with universalImportPreview.ts,
// which builds the ImportPreview from this same route's response.

// POST /api/reconcile/match (Task 7, Shop-Ware reconcile round).
// Runs the pure identity matcher (Task 5) server-side, per row, against the LOCAL tire corpus
// only: SQLite / Turso / committed JSON via tireKnowledgeIndex. NO API keys, NO paid calls, NO
// external network - nothing here can spend money or leak data, so no IS_E2E guard is needed
// (the guard on /api/ai-lookup exists to fence LIVE PROVIDERS, which this route does not have).
//
// The matcher is synchronous and takes injected MatcherDeps; the corpus lookups are async. The
// route therefore PRE-FETCHES every lookup a row can make (all its normalized part numbers, plus
// its size token) and hands the matcher plain map-backed closures. The dep does a direct keyed
// read with NO re-normalization - the matcher already normalized the PN (Task 5 review contract).

export const runtime = "nodejs";

/** Hard row cap: reconcile feeds are shop catalogs (thousands), not unbounded uploads. */
const MAX_ROWS = 20000;

/** Mirror of the matcher's rowSizeToken: size from sizeText, falling back to specs/model text. */
function rowSizeToken(row: ExpectedInventoryRow): string {
  const text = [row.sizeText ?? "", row.specs ?? "", row.model ?? ""].join(" ");
  return tireSizeToken({ productName: text, brand: row.brand });
}

function toCandidate(row: TireKnowledgeRow): CorpusCandidate {
  return {
    uid: row.canonical_product_uid,
    brand: row.brand || row.brand_normalized,
    name: row.model || row.model_normalized,
    sizeToken: tireSizeToken({ productName: `${row.size} ${row.raw_size_text}` }) || undefined,
    partNumber: row.manufacturer_part_number || undefined,
    barcode: row.barcode || undefined,
  };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

/** Untrusted-body row check (semantic firewall: uploaded CSV content is data, never obeyed). */
function isValidRow(v: unknown): v is ExpectedInventoryRow {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.externalId !== "string") return false;
  if (!isStringArray(r.partNumbers)) return false;
  if (typeof r.qty !== "number" || !Number.isFinite(r.qty)) return false;
  for (const key of ["brand", "model", "sizeText", "specs", "barcode", "name", "category"]) {
    if (r[key] !== undefined && typeof r[key] !== "string") return false;
  }
  return true;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const rows = (body as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) {
    return NextResponse.json({ error: "Body must be { rows: [...] }." }, { status: 400 });
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json({ error: `Too many rows (max ${MAX_ROWS}).` }, { status: 400 });
  }
  if (!rows.every(isValidRow)) {
    return NextResponse.json(
      { error: "Each row needs externalId (string), partNumbers (string array), and qty (number)." },
      { status: 400 },
    );
  }

  // Pre-fetch every key the matcher can ask for, cached across rows (feeds repeat sizes/PNs).
  const pnCache = new Map<string, CorpusCandidate[]>();
  const sizeCache = new Map<string, CorpusCandidate[]>();
  const matches: PreviewMatchResult[] = [];

  for (const row of rows) {
    for (const rawPn of row.partNumbers) {
      for (const key of tirePartNumberVariants(rawPn)) {
        if (pnCache.has(key)) continue;
        pnCache.set(key, (await lookupAllByPartNumber(key)).map(toCandidate));
      }
    }
    const sizeToken = rowSizeToken(row);
    if (sizeToken && !sizeCache.has(sizeToken)) {
      sizeCache.set(sizeToken, (await candidatesBySizeToken(sizeToken)).map(toCandidate));
    }

    const deps: MatcherDeps = {
      lookupByPartNumber: (normalizedPn) => pnCache.get(normalizedPn) ?? [],
      candidatesByBrandSize: (_brand, token) => sizeCache.get(token) ?? [],
      candidatesForFuzzy: (token) => sizeCache.get(token) ?? [],
    };
    const match = matchExpectedRow(row, deps);
    if (match.status === "non_tire" && row.barcode) {
      const retailCatalogMatch = await lookupRetailBarcodeAsync(row.barcode);
      matches.push(retailCatalogMatch ? { ...match, retailCatalogMatch } : match);
    } else {
      matches.push(match);
    }
  }

  return NextResponse.json({ matches });
}
