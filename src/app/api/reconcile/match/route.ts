import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { isLiveAuth } from "@/authentication/service/authMode";
import { isAuthBypassEnabled } from "@/authentication/service/authBypass";
import { COLLECTIONS, memberDocId } from "@/services/db/types";
import { checkRateLimit, intEnv } from "@/services/security/aiSpendGuard";
import { decodeStorage } from "@/server/decode/storage";
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
import { logServerEvent } from "@/server/log";

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
const MAX_ROWS = 5_000;
const MAX_REQUEST_BYTES = 512 * 1024;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function authConfigurationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /credential|GOOGLE_APPLICATION_CREDENTIALS|default credentials|service account|ENOENT/i.test(message);
}

async function authorize(businessId: string, idToken: string): Promise<NextResponse | { uid: string | null }> {
  if (isAuthBypassEnabled() || !isLiveAuth()) return { uid: null };
  if (!idToken) return json({ error: "Sign in required." }, 401);
  let uid: string;
  try {
    uid = (await getAdminAuth().verifyIdToken(idToken)).uid;
  } catch (error) {
    if (authConfigurationError(error)) return json({ error: "Server auth is not configured." }, 503);
    return json({ error: "Invalid or expired sign-in." }, 401);
  }
  try {
    const member = await getAdminDb()
      .doc(`${COLLECTIONS.businessMembers}/${memberDocId(businessId, uid)}`)
      .get();
    return member.exists ? { uid } : json({ error: "Not a member of this business." }, 403);
  } catch (error) {
    if (authConfigurationError(error)) return json({ error: "Server auth is not configured." }, 503);
    return json({ error: "Could not verify business membership." }, 503);
  }
}

function responseRow(row: ExpectedInventoryRow): Omit<ExpectedInventoryRow, "raw"> {
  const { externalId, partNumbers, brand, model, sizeText, specs, barcode, name, category, qty } = row;
  return { externalId, partNumbers, brand, model, sizeText, specs, barcode, name, category, qty };
}

function responseMatch(match: PreviewMatchResult): PreviewMatchResult {
  const candidate = match.candidate && {
    uid: match.candidate.uid,
    brand: match.candidate.brand,
    name: match.candidate.name,
    sizeToken: match.candidate.sizeToken,
    partNumber: match.candidate.partNumber,
    barcode: match.candidate.barcode,
  };
  const candidates = match.candidates?.map((item) => ({
    uid: item.uid,
    brand: item.brand,
    name: item.name,
    sizeToken: item.sizeToken,
    partNumber: item.partNumber,
    barcode: item.barcode,
  }));
  return {
    row: responseRow(match.row),
    status: match.status,
    reason: match.reason,
    ...(candidate ? { candidate } : {}),
    ...(match.confidence !== undefined ? { confidence: match.confidence } : {}),
    ...(match.matchBasis ? { matchBasis: match.matchBasis } : {}),
    ...(candidates ? { candidates } : {}),
    ...(match.linkageSuggestion ? { linkageSuggestion: { barcode: match.linkageSuggestion.barcode, partNumber: match.linkageSuggestion.partNumber } } : {}),
    ...(match.viaAffixCore !== undefined ? { viaAffixCore: match.viaAffixCore } : {}),
    ...(match.retailCatalogMatch ? {
      retailCatalogMatch: {
        productName: match.retailCatalogMatch.productName,
        brand: match.retailCatalogMatch.brand,
        category: match.retailCatalogMatch.category,
        barcode: match.retailCatalogMatch.barcode,
      },
    } : {}),
  } as PreviewMatchResult;
}

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
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    return json({ error: "Reconcile request must be 512KB or smaller." }, 413);
  }

  let body: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
      return json({ error: "Reconcile request must be 512KB or smaller." }, 413);
    }
    body = JSON.parse(raw) as unknown;
  } catch {
    logServerEvent({ route: "/api/reconcile/match", event: "error", reasonCode: "invalid_json", status: 400 });
    return json({ error: "Body must be valid JSON." }, 400);
  }

  const parsed = body as { rows?: unknown; businessId?: unknown; idToken?: unknown } | null;
  const businessId = text(parsed?.businessId);
  const authorization = await authorize(businessId, text(parsed?.idToken));
  if (authorization instanceof NextResponse) return authorization;

  // Live buckets use server-verified identities. Auth-bypass/mock mode shares one fixed bucket:
  // mock callers have no verified identity, so their supplied businessId must never shape durable
  // limiter state or permit unlimited 5,000-row requests.
  const rateLimitKey = authorization.uid
    ? `RECONCILE:${businessId}:${authorization.uid}`
    : "RECONCILE:mock";
  try {
    const rate = await checkRateLimit(rateLimitKey, {
      limit: intEnv(process.env.RECONCILE_MATCH_RATE_LIMIT, 30),
      windowMs: intEnv(process.env.RECONCILE_MATCH_RATE_WINDOW_MS, 60_000),
      storage: await decodeStorage(),
      failClosedOnStorageError: true,
    });
    if (!rate.allowed) {
      return NextResponse.json({ error: "Too many reconcile requests. Slow down and try again.", retryAfterMs: rate.retryAfterMs }, {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) },
      });
    }
  } catch {
    logServerEvent({ route: "/api/reconcile/match", event: "rate_limit_unavailable", reasonCode: "storage_error", status: 503 });
    return json({ error: "Rate limiting is temporarily unavailable. Try again shortly." }, 503);
  }

  const rows = parsed?.rows;
  if (!Array.isArray(rows)) {
    logServerEvent({ route: "/api/reconcile/match", event: "error", reasonCode: "missing_rows", status: 400 });
    return json({ error: "Body must be { rows: [...] }." }, 400);
  }
  if (rows.length > MAX_ROWS) {
    logServerEvent({ route: "/api/reconcile/match", event: "error", reasonCode: "too_many_rows", status: 400 });
    return json({ error: `Too many rows (max ${MAX_ROWS}).` }, 413);
  }
  if (!rows.every(isValidRow)) {
    logServerEvent({ route: "/api/reconcile/match", event: "error", reasonCode: "invalid_row_shape", status: 400 });
    return json(
      { error: "Each row needs externalId (string), partNumbers (string array), and qty (number)." },
      400,
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

  return json({ matches: matches.map(responseMatch) });
}
