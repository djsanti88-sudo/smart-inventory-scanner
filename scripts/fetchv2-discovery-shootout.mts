// Discovery-provider shootout for Fetch V2. ISOLATED: discovery-only, no counting, no verification,
// no production behavior change. Judges Brave Search / Firecrawl / Vertex AI Search as candidate-URL
// discovery providers using the SAME junk/product heuristics production uses (imported, not rebuilt).
//
// Usage:
//   npx tsx scripts/fetchv2-discovery-shootout.mts          MOCK self-test ($0, zero network)
//   npx tsx scripts/fetchv2-discovery-shootout.mts --live   real calls, only for providers with keys
//
// Live budget guard: aborts past MAX_EST_CREDITS Firecrawl credits / MAX_BRAVE_QUERIES Brave queries.
// Keys are never printed. Unconfigured providers are reported as "not configured", never a failure.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { isUsableProductName } from "../src/services/ai/decode";
import { isJunkSourceUrl, classifySource, TIER_RANK, hostOf } from "../src/services/catalog/sourceTrust";
import { urlPreferenceScore, firecrawlKeysFromEnv, type FcFetch } from "../src/services/ai/firecrawlProvider";
import { isSafePublicUrl } from "../src/services/ai/urlSafety";
import { detectCodeType } from "../src/services/codeTypeDetector";

const LIVE = process.argv.includes("--live");
const SKIP_FC = process.argv.includes("--skip-firecrawl"); // Brave-only validation: $0, no credits
const OUT_DIR = new URL("../reports/discovery-shootout/2026-07-04/", import.meta.url);
const OUT_JSON = new URL(LIVE ? (SKIP_FC ? "results-brave.json" : "results.json") : "results-mock.json", OUT_DIR);

// Load .env.local into process.env (names the providers need only; values never logged).
const envFile = (() => { try { return readFileSync(new URL("../.env.local", import.meta.url), "utf8"); } catch { return ""; } })();
for (const line of envFile.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

// --- Budget guards (live) --------------------------------------------------------------------
const MAX_EST_CREDITS = 60; // Firecrawl: search=2cr, cheap scrape=1cr
const MAX_BRAVE_QUERIES = 55;
const USD_PER_FC_CREDIT = 0.00083; // Firecrawl Standard plan ($83 / 100k credits); Hobby is ~6.4x this
const USD_PER_BRAVE_QUERY_PAID = 0.003; // Brave Base plan $3 CPM; free tier = $0 (2k/mo)
let fcCreditsSpent = 0;
let braveQueriesSpent = 0;

// --- Fixture ----------------------------------------------------------------------------------
type Row = { code: string; kind: "barcode" | "asin" | "canary" | "url" };
const FIXTURE: Row[] = [
  { code: "051596320812", kind: "barcode" },
  { code: "078742051451", kind: "barcode" },
  { code: "078742028477", kind: "barcode" },
  { code: "028400325042", kind: "barcode" },
  { code: "00070470001272", kind: "barcode" },
  { code: "0078742058221", kind: "barcode" },
  { code: "4981910515661", kind: "barcode" },
  { code: "5000396053432", kind: "barcode" },
  { code: "B09B8V1LZ3", kind: "asin" },
  { code: "749000000015", kind: "canary" }, // checksum-valid UNASSIGNED UPC (e2e/fixtures/dryrun-codes.json)
  { code: "https://www.example.com/products/acme-widget-12345", kind: "url" },
];

// --- Candidate classification (production heuristics, shared verdict logic) --------------------
interface Candidate {
  url: string;
  title: string;
  snippet: string;
  rank: number;
  host: string;
  looksLikeProductPage: boolean;
  looksLikeJunkSearchPage: boolean;
}

function classifyCandidate(code: string, rank: number, url: string, title: string, snippet: string): Candidate {
  const tier = classifySource(url);
  // Barcode-DB hosts legitimately serve products at /search?q= URLs (sourceTrust keeps them
  // "supporting"), so junk = weak-tier junk URL OR a title production would refuse to adopt.
  const junkUrl = isJunkSourceUrl(url) && tier === "weak";
  const usableTitle = isUsableProductName(title, code);
  const looksLikeJunkSearchPage = junkUrl || !usableTitle;
  const looksLikeProductPage =
    !looksLikeJunkSearchPage && (urlPreferenceScore(url) > 0 || TIER_RANK[tier] >= 2);
  return { url, title, snippet, rank, host: hostOf(url), looksLikeProductPage, looksLikeJunkSearchPage };
}

function pickBest(cands: Candidate[]): { url: string; reason: string } | null {
  const plausible = cands.filter((c) => c.looksLikeProductPage);
  if (plausible.length === 0) return null;
  plausible.sort(
    (a, b) =>
      TIER_RANK[classifySource(b.url)] - TIER_RANK[classifySource(a.url)] ||
      urlPreferenceScore(b.url) - urlPreferenceScore(a.url) ||
      a.rank - b.rank,
  );
  const w = plausible[0];
  return { url: w.url, reason: `tier=${classifySource(w.url)} urlPref=${urlPreferenceScore(w.url)} rank=${w.rank} usable title` };
}

// --- Output contract --------------------------------------------------------------------------
interface ShootoutRow {
  provider: "brave" | "firecrawl" | "vertex";
  code: string;
  queriesTried: string[];
  candidateUrls: Candidate[];
  bestCandidate: { url: string; reason: string } | null;
  timingMs: number;
  estimatedCostUsd: number;
  creditsUsed: number | null;
  errors: string[];
  notes: string;
  scrapeProbe?: { url: string; title: string; markdownChars: number; codeOnPage: boolean; creditsUsed: number }[];
}

// --- Brave adapter ----------------------------------------------------------------------------
const braveKey = process.env.BRAVE_SEARCH_API_KEY ?? "";
type RawHit = { url: string; title: string; snippet: string };

async function braveQuery(q: string, key: string, fetchImpl: FcFetch): Promise<RawHit[]> {
  const res = await fetchImpl(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=10`,
    { method: "GET", headers: { Accept: "application/json", "X-Subscription-Token": key } },
  );
  if (!res.ok) throw new Error(`brave http ${res.status}`);
  const d = (await res.json()) as { web?: { results?: Array<{ url?: string; title?: string; description?: string }> } };
  return (d.web?.results ?? [])
    .map((r) => ({ url: String(r.url ?? ""), title: String(r.title ?? ""), snippet: String(r.description ?? "") }))
    .filter((r) => r.url && isSafePublicUrl(r.url));
}

async function runBrave(row: Row, fetchImpl: FcFetch): Promise<ShootoutRow> {
  const base: ShootoutRow = { provider: "brave", code: row.code, queriesTried: [], candidateUrls: [], bestCandidate: null, timingMs: 0, estimatedCostUsd: 0, creditsUsed: null, errors: [], notes: "" };
  if (row.kind === "url") return { ...base, notes: "raw URL scan: discovery skipped; Fetch V2 fetches the URL directly" };
  if (!braveKey && LIVE) return { ...base, notes: "not configured: BRAVE_SEARCH_API_KEY missing (free key: https://api-dashboard.search.brave.com, ~2k queries/mo free)" };
  const queries = [row.code, `${row.code} UPC`, `${row.code} GTIN`, `${row.code} barcode`, `${row.code} product`];
  const start = Date.now();
  const seen = new Set<string>();
  for (const q of queries) {
    if (LIVE && braveQueriesSpent >= MAX_BRAVE_QUERIES) { base.errors.push("brave query budget reached"); break; }
    try {
      if (LIVE) { braveQueriesSpent++; await new Promise((r) => setTimeout(r, 1100)); } // free tier is 1 req/s
      const hits = await braveQuery(q, braveKey || "mock", fetchImpl);
      base.queriesTried.push(q);
      for (const h of hits) {
        if (seen.has(h.url)) continue;
        seen.add(h.url);
        base.candidateUrls.push(classifyCandidate(row.code, base.candidateUrls.length, h.url, h.title, h.snippet));
      }
      if (base.candidateUrls.filter((c) => c.looksLikeProductPage).length >= 3) break; // early-stop: conserve quota
    } catch (e) {
      base.errors.push(String((e as Error).message ?? e));
    }
  }
  base.timingMs = Date.now() - start;
  base.bestCandidate = pickBest(base.candidateUrls);
  base.estimatedCostUsd = 0; // free tier; paid Base plan would be queries x $0.003
  base.notes = base.notes || `free tier $0 (paid would be ~$${(base.queriesTried.length * USD_PER_BRAVE_QUERY_PAID).toFixed(4)})`;
  return base;
}

// --- Firecrawl adapter (search + scrape probe) --------------------------------------------------
const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";
const fcKeys = firecrawlKeysFromEnv();

function creditsFrom(d: unknown, fallback: number): number {
  const o = d as { creditsUsed?: number; data?: { creditsUsed?: number } };
  const n = o?.creditsUsed ?? o?.data?.creditsUsed;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

async function fcSearch(q: string, fetchImpl: FcFetch): Promise<{ hits: RawHit[]; credits: number }> {
  for (let i = 0; i < Math.max(fcKeys.length, LIVE ? 0 : 1); i++) {
    const res = await fetchImpl(`${FIRECRAWL_BASE}/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${LIVE ? fcKeys[i] : "mock"}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, limit: 8 }),
    });
    if (res.status === 402 || res.status === 429) continue; // rotate key
    if (!res.ok) throw new Error(`firecrawl search http ${res.status}`);
    const d = (await res.json()) as { data?: { web?: unknown[] } | unknown[] };
    const web = (Array.isArray(d?.data) ? d?.data : (d?.data as { web?: unknown[] })?.web) ?? [];
    const hits = (web as Array<{ url?: string; title?: string; description?: string }>)
      .map((r) => ({ url: String(r.url ?? ""), title: String(r.title ?? ""), snippet: String(r.description ?? "") }))
      .filter((r) => r.url && isSafePublicUrl(r.url));
    return { hits, credits: creditsFrom(d, 2) }; // snippets-only search = 2 credits
  }
  throw new Error("firecrawl: all keys exhausted (402/429)");
}

async function fcScrape(url: string, fetchImpl: FcFetch): Promise<{ title: string; markdown: string; credits: number }> {
  for (let i = 0; i < Math.max(fcKeys.length, LIVE ? 0 : 1); i++) {
    const res = await fetchImpl(`${FIRECRAWL_BASE}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${LIVE ? fcKeys[i] : "mock"}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, proxy: "basic" }),
    });
    if (res.status === 402 || res.status === 429) continue;
    if (!res.ok) throw new Error(`firecrawl scrape http ${res.status}`);
    const d = (await res.json()) as { data?: { markdown?: string; metadata?: { title?: string; ogTitle?: string } } };
    return {
      title: String(d?.data?.metadata?.title ?? d?.data?.metadata?.ogTitle ?? ""),
      markdown: String(d?.data?.markdown ?? ""),
      credits: creditsFrom(d, 1), // basic proxy + markdown + onlyMainContent = 1 credit
    };
  }
  throw new Error("firecrawl: all keys exhausted (402/429)");
}

function codeOnPage(code: string, text: string): boolean {
  const digits = code.replace(/\D/g, "");
  const variants = [code, digits, digits.replace(/^0+/, ""), digits.padStart(13, "0"), digits.padStart(14, "0")].filter((v) => v.length >= 8 || v === code);
  return variants.some((v) => text.includes(v));
}

async function runFirecrawl(row: Row, fetchImpl: FcFetch): Promise<ShootoutRow> {
  const base: ShootoutRow = { provider: "firecrawl", code: row.code, queriesTried: [], candidateUrls: [], bestCandidate: null, timingMs: 0, estimatedCostUsd: 0, creditsUsed: 0, errors: [], notes: "", scrapeProbe: [] };
  if (row.kind === "url") return { ...base, creditsUsed: null, notes: "raw URL scan: discovery skipped; Fetch V2 fetches the URL directly" };
  if (LIVE && fcKeys.length === 0) return { ...base, creditsUsed: null, notes: "not configured: FIRECRAWL_API_KEY(_1..4) missing" };
  const start = Date.now();
  let credits = 0;
  try {
    if (LIVE && fcCreditsSpent + 2 > MAX_EST_CREDITS) throw new Error("credit budget reached before search");
    const { hits, credits: c } = await fcSearch(row.code, fetchImpl);
    credits += c;
    if (LIVE) fcCreditsSpent += c;
    base.queriesTried.push(row.code);
    for (const h of hits) base.candidateUrls.push(classifyCandidate(row.code, base.candidateUrls.length, h.url, h.title, h.snippet));
    // Scrape probe: top 2 plausible product pages -> tests Firecrawl's "page extractor" role.
    const toScrape = base.candidateUrls.filter((cd) => cd.looksLikeProductPage).slice(0, 2);
    for (const cand of toScrape) {
      if (LIVE && fcCreditsSpent + 1 > MAX_EST_CREDITS) { base.errors.push("credit budget reached before scrape"); break; }
      try {
        const s = await fcScrape(cand.url, fetchImpl);
        credits += s.credits;
        if (LIVE) fcCreditsSpent += s.credits;
        base.scrapeProbe!.push({ url: cand.url, title: s.title.slice(0, 160), markdownChars: s.markdown.length, codeOnPage: codeOnPage(row.code, s.markdown), creditsUsed: s.credits });
      } catch (e) {
        base.errors.push(`scrape ${hostOf(cand.url)}: ${String((e as Error).message ?? e)}`);
      }
    }
  } catch (e) {
    base.errors.push(String((e as Error).message ?? e));
  }
  base.timingMs = Date.now() - start;
  base.bestCandidate = pickBest(base.candidateUrls);
  base.creditsUsed = credits;
  base.estimatedCostUsd = +(credits * USD_PER_FC_CREDIT).toFixed(5);
  return base;
}

// --- Vertex AI Search: config detection only ----------------------------------------------------
function runVertex(row: Row): ShootoutRow {
  const required = ["GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS", "VERTEX_AI_SEARCH_DATA_STORE_ID", "VERTEX_AI_SEARCH_LOCATION"];
  const missing = required.filter((n) => !process.env[n]);
  return {
    provider: "vertex", code: row.code, queriesTried: [], candidateUrls: [], bestCandidate: null,
    timingMs: 0, estimatedCostUsd: 0, creditsUsed: null, errors: [],
    notes: missing.length
      ? `not configured: missing ${missing.join(", ")}. Vertex AI Search queries an OWNER-INDEXED data store (your own product corpus), not the open web; open-web grounding is a separate paid Gemini feature. Setup: GCP project -> enable Discovery Engine API -> create data store -> index product data -> service account JSON.`
      : "configured (unexpected) - live adapter not implemented in this shootout",
  };
}

// --- Mock fetch (self-test, $0) -----------------------------------------------------------------
function mockFetch(): FcFetch {
  const productHit = (code: string) => ({
    url: `https://www.walmart.com/ip/great-value-product/${code}`,
    title: "Great Value Distilled Water, 1 Gallon",
    description: `UPC ${code} Great Value Distilled Water 1 Gal.`,
  });
  const junkHit = (code: string) => ({
    url: `https://barcode-list.com/barcode/EN/Search.htm?barcode=${code}`,
    title: `Search For: ${code}`,
    description: "Barcode list search results",
  });
  const echoHit = (code: string) => ({
    url: `https://www.upcdatabase.com/item/${code}`,
    title: `UPC Database | ${code}`,
    description: "",
  });
  return async (url, init) => {
    const isCanary = String(init?.body ?? url).includes("749000000015") || url.includes("749000000015");
    if (url.includes("api.search.brave.com")) {
      const code = decodeURIComponent(url.match(/[?&]q=([^&]+)/)?.[1] ?? "").split(" ")[0];
      const results = isCanary ? [junkHit(code), echoHit(code)] : [productHit(code), junkHit(code), echoHit(code)];
      return { ok: true, status: 200, json: async () => ({ web: { results } }) };
    }
    if (url.includes("/search")) {
      const code = String(JSON.parse(String(init?.body ?? "{}")).query ?? "");
      const web = isCanary ? [junkHit(code), echoHit(code)] : [productHit(code), junkHit(code), echoHit(code)];
      return { ok: true, status: 200, json: async () => ({ data: { web }, creditsUsed: 2 }) };
    }
    if (url.includes("/scrape")) {
      const target = String(JSON.parse(String(init?.body ?? "{}")).url ?? "");
      const code = target.match(/(\d{8,14})/)?.[1] ?? "";
      return { ok: true, status: 200, json: async () => ({ data: { markdown: `# Great Value Distilled Water\nUPC: ${code}\nBrand: Great Value`, metadata: { title: "Great Value Distilled Water, 1 Gallon - Walmart.com" } }, creditsUsed: 1 }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

// --- Scoring ------------------------------------------------------------------------------------
function median(ns: number[]): number { const s = [...ns].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; }
function p95(ns: number[]): number { const s = [...ns].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] : 0; }

function scoreProvider(rows: ShootoutRow[]) {
  const searchable = rows.filter((r) => r.queriesTried.length > 0 && r.code !== "749000000015");
  const canary = rows.find((r) => r.code === "749000000015");
  const allCands = searchable.flatMap((r) => r.candidateUrls);
  const timings = searchable.map((r) => r.timingMs).filter((t) => t > 0);
  const totalCost = rows.reduce((s, r) => s + r.estimatedCostUsd, 0);
  return {
    ran: searchable.length,
    discoveryHitRate: searchable.length ? +(searchable.filter((r) => r.bestCandidate).length / searchable.length).toFixed(2) : 0,
    junkRate: allCands.length ? +(allCands.filter((c) => c.looksLikeJunkSearchPage).length / allCands.length).toFixed(2) : 0,
    productPageRate: allCands.length ? +(allCands.filter((c) => c.looksLikeProductPage).length / allCands.length).toFixed(2) : 0,
    speedMedianMs: median(timings),
    speedP95Ms: p95(timings),
    totalCostUsd: +totalCost.toFixed(4),
    estimatedCostPer1000Codes: searchable.length ? +((totalCost / searchable.length) * 1000).toFixed(2) : 0,
    canaryPlausibleCandidates: canary ? canary.candidateUrls.filter((c) => c.looksLikeProductPage).length : null,
  };
}

// --- Main ---------------------------------------------------------------------------------------
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const fetchImpl: FcFetch = LIVE ? (globalThis.fetch as unknown as FcFetch) : mockFetch();
  console.log(`mode=${LIVE ? "LIVE" : "MOCK"}  brave=${braveKey ? "key present" : "NOT CONFIGURED"}  firecrawl=${fcKeys.length ? `${fcKeys.length} keys` : "NOT CONFIGURED"}  vertex=NOT CONFIGURED (detector)`);

  const rows: ShootoutRow[] = [];
  const save = () => writeFileSync(OUT_JSON, JSON.stringify({ mode: LIVE ? "live" : "mock", generatedAt: "2026-07-04", fcCreditsSpent, braveQueriesSpent, rows, scores: { brave: scoreProvider(rows.filter((r) => r.provider === "brave")), firecrawl: scoreProvider(rows.filter((r) => r.provider === "firecrawl")) } }, null, 2));

  for (const row of FIXTURE) {
    console.log(`\n=== ${row.code} (${row.kind}) [type=${detectCodeType(row.code)}]`);
    if (!SKIP_FC) {
      const fc = await runFirecrawl(row, fetchImpl);
      rows.push(fc); save();
      console.log(`  firecrawl: ${fc.candidateUrls.length} candidates, best=${fc.bestCandidate ? hostOf(fc.bestCandidate.url) : "none"}, ${fc.timingMs}ms, ${fc.creditsUsed ?? "-"}cr${fc.errors.length ? ", errors: " + fc.errors.join(" | ") : ""}${fc.notes ? " (" + fc.notes.slice(0, 80) + ")" : ""}`);
    }
    const br = await runBrave(row, fetchImpl);
    rows.push(br); save();
    console.log(`  brave:     ${br.candidateUrls.length} candidates, best=${br.bestCandidate ? hostOf(br.bestCandidate.url) : "none"}, ${br.timingMs}ms${br.errors.length ? ", errors: " + br.errors.join(" | ") : ""}${br.notes ? " (" + br.notes.slice(0, 80) + ")" : ""}`);
    rows.push(runVertex(row)); save();
  }

  // Mock self-test assertions: the plumbing must classify junk correctly and keep the canary clean.
  if (!LIVE) {
    const fcRows = rows.filter((r) => r.provider === "firecrawl");
    const canary = fcRows.find((r) => r.code === "749000000015")!;
    const normal = fcRows.find((r) => r.code === "051596320812")!;
    const junkTitles = normal.candidateUrls.filter((c) => c.looksLikeJunkSearchPage);
    const assert = (cond: boolean, msg: string) => { if (!cond) { console.error(`SELF-TEST FAIL: ${msg}`); process.exit(1); } };
    assert(canary.candidateUrls.filter((c) => c.looksLikeProductPage).length === 0, "canary must yield zero plausible product pages");
    assert(normal.bestCandidate !== null, "normal code must find a best candidate");
    assert(junkTitles.length >= 2, "'Search For:' and 'UPC Database |' echo titles must be flagged junk");
    assert(normal.scrapeProbe!.length > 0 && normal.scrapeProbe![0].codeOnPage, "scrape probe must confirm code on page");
    assert(rows.filter((r) => r.provider === "brave" && r.code === "051596320812")[0].bestCandidate !== null, "brave adapter path must work in mock");
    console.log("\nMOCK SELF-TEST: all assertions passed");
  }

  console.log(`\nwrote ${OUT_JSON.pathname.replace(/^\//, "")}`);
  console.log(`spend: firecrawl ${fcCreditsSpent}cr (~$${(fcCreditsSpent * USD_PER_FC_CREDIT).toFixed(4)}), brave ${braveQueriesSpent} queries ($0 free tier)`);
}

main().catch((e) => { console.error("shootout failed:", String((e as Error)?.message ?? e)); process.exit(1); });
