// Fetch V2 WEB-ONLY benchmark over the 150-code ground-truthed fixture. ZERO AI calls.
// Sources: Brave discovery (free) -> direct page fetch (free) -> Open Food Facts API (free)
// -> Firecrawl rawHtml scrape ONLY as a capped fallback for bot-blocked retail hosts.
//
// Usage:
//   npx tsx scripts/fetchv2-benchmark.mts --live            full 150-code run (crash-safe, resumable)
//   npx tsx scripts/fetchv2-benchmark.mts --live --limit=5  smoke slice
//
// Output: scripts/fetchv2-web-results.json in the SAME {spent, rows} shape as the ladder run,
// so the adjudicated grader can score it: node scripts/tmp-ladder-grade.mjs --input=<file>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fetchV2, type FetchV2Deps, type StructuredHit } from "../src/services/fetchV2/index";
import { FetchV2Cache } from "../src/services/fetchV2/cache";
import { braveProvider, firecrawlSearchProvider, type MinimalFetch } from "../src/services/fetchV2/sources/discovery";
import { firecrawlKeysFromEnv } from "../src/services/ai/firecrawlProvider";
import { isSafePublicUrl } from "../src/services/ai/urlSafety";
import { selectBarcodeUrls } from "../src/services/ai/barcodeSources";

const LIVE = process.argv.includes("--live");
if (!LIVE) { console.error("web benchmark makes live FREE web calls; pass --live to confirm"); process.exit(1); }
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.slice(8) ?? 0) || Infinity;
const RUN2 = process.argv.includes("--run2"); // stratified 50-code re-test after the guard fixes
const CODES = process.argv.find((a) => a.startsWith("--codes="))?.slice(8).split(",").map((s) => s.trim()).filter(Boolean);
const OUT_ARG = process.argv.find((a) => a.startsWith("--out="))?.slice(6);
const OUT = new URL(OUT_ARG ? `./${OUT_ARG}` : RUN2 ? "./fetchv2-web-results-run2.json" : "./fetchv2-web-results.json", import.meta.url);
const FORCE_RETRY = process.argv.includes("--force-retry"); // owner's manual override for receipts
const RECEIPTS = new URL("./fetchv2-noresult-receipts.json", import.meta.url);

// Stratified 50: every owner + half the canaries + a spread of the other groups (deterministic:
// first N of each group in fixture order, so run 1 rows exist for every one of them).
const RUN2_QUOTA: Record<string, number> = { owner: 21, canary: 5, tire: 8, upcEan: 8, part: 4, asin: 2, obscure: 2 };

// .env.local -> process.env (values never logged)
const envFile = (() => { try { return readFileSync(new URL("../.env.local", import.meta.url), "utf8"); } catch { return ""; } })();
for (const line of envFile.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const braveKey = process.env.BRAVE_SEARCH_API_KEY ?? "";
const fcKeys = firecrawlKeysFromEnv();
if (!braveKey) { console.error("BRAVE_SEARCH_API_KEY missing"); process.exit(1); }

// ---- budgets (hard guards) ----------------------------------------------------------------
const MAX_FC_CREDITS = Number(process.env.FC_CREDIT_CAP ?? 200); // hard guard; env-overridable per run
const USD_PER_FC_CREDIT = 0.00083;
let fcCredits = 0;
let braveQueries = 0;

// ---- polite direct page fetcher -------------------------------------------------------------
const UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
];
const hostCooldown = new Map<string, number>();
const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };

async function directFetch(url: string): Promise<{ ok: boolean; status: number; html: string }> {
  const host = hostOf(url);
  if (!host || !isSafePublicUrl(url)) return { ok: false, status: 0, html: "" };
  if ((hostCooldown.get(host) ?? 0) > Date.now()) return { ok: false, status: 429, html: "" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UAS[braveQueries % UAS.length], Accept: "text/html" }, signal: controller.signal, redirect: "follow" });
    if (res.status === 429 || res.status === 403) hostCooldown.set(host, Date.now() + 10 * 60_000);
    if (!res.ok) return { ok: false, status: res.status, html: "" };
    const reader = res.body?.getReader();
    let html = "";
    if (reader) {
      const dec = new TextDecoder();
      while (html.length < 400_000) {
        const { done, value } = await reader.read();
        if (done) break;
        html += dec.decode(value, { stream: true });
      }
      try { await reader.cancel(); } catch { /* stream already done */ }
    } else {
      html = (await res.text()).slice(0, 400_000);
    }
    return { ok: true, status: res.status, html };
  } catch {
    return { ok: false, status: 0, html: "" };
  } finally {
    clearTimeout(timer);
  }
}

// Firecrawl rawHtml scrape fallback for bot-blocked pages (1 credit, key rotation).
// Run 2: broadened from a fixed retail-host list to ANY safe host (owner authorized Firecrawl
// spend; the hard credit cap is the budget guard). Run 1 lost findable codes to bot-blocks.
async function fcScrapeHtml(url: string): Promise<{ ok: boolean; status: number; html: string }> {
  if (fcCredits + 1 > MAX_FC_CREDITS) return { ok: false, status: 402, html: "" };
  for (const key of fcKeys) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url, formats: ["rawHtml"], onlyMainContent: false, proxy: "basic" }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (res.status === 402 || res.status === 429) continue;
      if (!res.ok) return { ok: false, status: res.status, html: "" };
      const d = (await res.json()) as { data?: { rawHtml?: string; html?: string; creditsUsed?: number } ; creditsUsed?: number };
      fcCredits += typeof d?.data?.creditsUsed === "number" ? d.data.creditsUsed : typeof d?.creditsUsed === "number" ? d.creditsUsed : 1;
      const html = String(d?.data?.rawHtml ?? d?.data?.html ?? "").slice(0, 900_000);
      return { ok: html.length > 0, status: 200, html };
    } catch { continue; }
  }
  return { ok: false, status: 0, html: "" };
}

// Owner cap 2026-07-04: at most ONE paid scrape per code - if the best candidate's scrape does
// not settle it, more scrapes rarely do. Reset by the main loop before each code.
let scrapesThisCode = 0;
async function fetchPage(url: string): Promise<{ ok: boolean; status: number; html: string }> {
  const direct = await directFetch(url);
  if (direct.ok && direct.html.length > 500) return direct;
  if (fcKeys.length > 0 && isSafePublicUrl(url) && scrapesThisCode < 1) {
    scrapesThisCode++;
    return fcScrapeHtml(url);
  }
  return direct;
}

// ---- Brave with free-tier pacing (1 req/s) ---------------------------------------------------
let lastBrave = 0;
const rawBrave = braveProvider({ apiKey: braveKey, fetchImpl: fetch as unknown as MinimalFetch, timeoutMs: 8000 });
const pacedBrave = {
  name: "brave",
  async search(code: string) {
    const wait = lastBrave + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastBrave = Date.now();
    braveQueries++;
    return rawBrave.search(code);
  },
};
const fcSearch = firecrawlSearchProvider({ apiKeys: fcKeys, fetchImpl: fetch as unknown as MinimalFetch, timeoutMs: 15_000, retryDelayMs: 1500 });
let lastFc = 0;
const fcSearchGuarded = {
  name: "firecrawl",
  async search(code: string) {
    if (fcCredits + 2 > MAX_FC_CREDITS) return [];
    // Pace paid searches (>=1.5s apart) so batch bursts stop tripping per-minute rate limits.
    const wait = lastFc + 1500 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastFc = Date.now();
    const out = await fcSearch.search(code);
    fcCredits += 2;
    return out;
  },
};

// ---- Open Food Facts structured source (free, keyed by barcode = strong association) ---------
async function offLookup(variants: string[]): Promise<StructuredHit | null> {
  const ean = variants.find((v) => /^\d{13}$/.test(v)) ?? variants.find((v) => /^\d{8,14}$/.test(v));
  if (!ean) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${ean}.json`, {
      headers: { "User-Agent": "SmartInventoryScanner-FetchV2-benchmark/1.0" },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    const d = (await res.json()) as { status?: number; product?: { product_name?: string; brands?: string; code?: string } };
    if (d?.status !== 1 || !d.product?.product_name) return null;
    return {
      url: `https://world.openfoodfacts.org/product/${ean}`,
      name: String(d.product.product_name),
      brand: String(d.product.brands ?? "").split(",")[0].trim(),
      matchedBarcode: String(d.product.code ?? ean),
      quality: "medium",
    };
  } catch {
    return null;
  }
}

// ---- fixture + resume -------------------------------------------------------------------------
interface FixtureRow { code: string; codeType: string; truth: string; expected: string; group: string }
const FIXTURE_ARG = process.argv.find((a) => a.startsWith("--fixture="))?.slice(10);
const fixture = JSON.parse(
  readFileSync(FIXTURE_ARG ? new URL(`./${FIXTURE_ARG}`, import.meta.url) : new URL("../e2e/fixtures/dryrun-codes.json", import.meta.url), "utf8"),
) as { codes: FixtureRow[] };
interface OutRow {
  code: string; group: string; expected: string; truth: string; codeType: string;
  outcome: "verified" | "suggested" | "refused" | "error";
  product: string; cost: number; secs: number; guessConfidence: number;
  v2Outcome: string; winningSource: string; codeLocation: string; rules: string[]; sources?: string[];
}
const existing: OutRow[] = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")).rows ?? []) : [];
const done = new Set(existing.map((r) => r.code));
const rows: OutRow[] = [...existing];
const save = () => writeFileSync(OUT, JSON.stringify({ spent: +(fcCredits * USD_PER_FC_CREDIT).toFixed(4), engine: "fetch_v2_web_only", rows }, null, 1));

const OUTCOME_MAP: Record<string, OutRow["outcome"]> = {
  verified: "verified", suggested: "suggested", needs_review: "suggested",
  unknown: "refused", unsupported: "refused", rejected: "refused",
};

async function main() {
  const cache = new FetchV2Cache();
  let receipts: Record<string, string> = {};
  try { receipts = JSON.parse(readFileSync(RECEIPTS, "utf8")); } catch { /* first run */ }
  if (!FORCE_RETRY) for (const [code, note] of Object.entries(receipts)) cache.markNoResult(code, note);
  const deps: FetchV2Deps = {
    fetchPage,
    discovery: [pacedBrave, fcSearchGuarded],
    structured: [{ name: "openfoodfacts", lookup: offLookup }],
    cache,
    patternUrls: (variants) => {
      const code = variants.find((v) => /^\d{12,14}$/.test(v)) ?? variants[0];
      return selectBarcodeUrls(code).slice(0, 2);
    },
  };
  let pool = fixture.codes;
  if (CODES) pool = fixture.codes.filter((c) => CODES.includes(c.code));
  else if (RUN2) {
    const used: Record<string, number> = {};
    pool = fixture.codes.filter((c) => {
      const q = RUN2_QUOTA[c.group] ?? 0;
      used[c.group] = (used[c.group] ?? 0) + 1;
      return used[c.group] <= q;
    });
  }
  const todo = pool.filter((c) => !done.has(c.code)).slice(0, LIMIT);
  console.log(`fetchV2 WEB-ONLY benchmark: ${todo.length} codes to run (${done.size} already done). NO AI CALLS.`);

  let i = 0;
  for (const fx of todo) {
    i++;
    const t0 = Date.now();
    let row: OutRow;
    try {
      scrapesThisCode = 0;
      const r = await fetchV2(fx.code, deps, { mode: "balanced", maxSourcesPerCode: 3, maxTotalMs: 25_000 });
      const product = [r.product.brand, r.product.name].filter(Boolean).join(" ").trim();
      row = {
        code: fx.code, group: fx.group, expected: fx.expected, truth: fx.truth, codeType: fx.codeType,
        outcome: OUTCOME_MAP[r.outcome] ?? "refused",
        product,
        cost: 0, // filled from credit delta below
        secs: +((Date.now() - t0) / 1000).toFixed(2),
        guessConfidence: r.evidence.finalConfidence,
        v2Outcome: r.outcome,
        winningSource: r.evidence.winningSourceUrl,
        codeLocation: r.evidence.codeLocation,
        rules: r.debug.rulesFired.slice(0, 6),
        sources: r.sourcesChecked.slice(0, 12),
      };
    } catch (e) {
      row = { code: fx.code, group: fx.group, expected: fx.expected, truth: fx.truth, codeType: fx.codeType, outcome: "error", product: "", cost: 0, secs: +((Date.now() - t0) / 1000).toFixed(2), guessConfidence: 0, v2Outcome: "error:" + String((e as Error)?.message ?? e).slice(0, 80), winningSource: "", codeLocation: "", rules: [] };
    }
    rows.push(row);
    save();
    const note = cache.getNoResult(fx.code);
    if (note && !receipts[fx.code]) {
      receipts[fx.code] = note;
      writeFileSync(RECEIPTS, JSON.stringify(receipts, null, 1));
    }
    console.log(`[${i}/${todo.length}] ${fx.code} (${fx.group}) -> ${row.v2Outcome}${row.product ? " | " + row.product.slice(0, 60) : ""} (${row.secs}s)`);
  }

  // spread firecrawl cost evenly over rows that ran this session (approximation for the grader)
  console.log(`\ndone. brave queries=${braveQueries} ($0 free tier), firecrawl credits=${fcCredits} (~$${(fcCredits * USD_PER_FC_CREDIT).toFixed(4)})`);
  save();
  console.log(`wrote ${OUT.pathname}`);
}

main().catch((e) => { console.error("benchmark failed:", String((e as Error)?.message ?? e)); save(); process.exit(1); });
