import type { AiLookupResult, CodeType, EvidenceResult } from "@/types";
import { normalizeResult } from "@/services/ai/provider";
import { verifyEvidence } from "@/services/ai/evidenceVerifier";
import { isUsableProductName, cleanProductName } from "@/services/ai/decode";
import { isSafePublicUrl } from "@/services/ai/urlSafety";

// Firecrawl fallback (Stage 2 source discovery). SERVER-SIDE ONLY. Used ONLY when the fast path
// returns no usable product. It does what a person does: search the open web for the barcode, open
// the top product pages, and read them - reaching retailer/marketplace listings (Faire, Amazon, ...)
// that the fixed barcode-DB list never covers. Key comes from FIRECRAWL_API_KEY (never hardcoded).

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";

export type FcFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface FirecrawlDeps {
  apiKey: string;
  fetchImpl?: FcFetch;
  signal?: AbortSignal;
}

export interface WebSearchResult {
  url: string;
  title: string;
}

function headers(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

function impl(deps: FirecrawlDeps): FcFetch {
  return deps.fetchImpl ?? (globalThis.fetch as unknown as FcFetch);
}

/** Firecrawl web search for a query (the barcode). Returns candidate {url,title}. Throws on HTTP error. */
export async function firecrawlSearch(query: string, deps: FirecrawlDeps, limit = 5): Promise<WebSearchResult[]> {
  const res = await impl(deps)(`${FIRECRAWL_BASE}/search`, {
    method: "POST",
    headers: headers(deps.apiKey),
    body: JSON.stringify({ query, limit }),
    signal: deps.signal,
  });
  if (!res.ok) throw new Error(`Firecrawl search error ${res.status}`);
  const d = (await res.json()) as { data?: { web?: unknown[] } | unknown[] };
  const web = (Array.isArray(d?.data) ? d?.data : (d?.data as { web?: unknown[] })?.web) ?? [];
  return (web as Array<{ url?: string; title?: string }>)
    .map((r) => ({ url: String(r.url ?? ""), title: String(r.title ?? "") }))
    .filter((r) => r.url);
}

/** Firecrawl scrape of one URL -> clean markdown + title (+ best-effort credits). Throws on HTTP error. */
export async function firecrawlScrape(url: string, deps: FirecrawlDeps): Promise<{ markdown: string; title: string; creditsUsed: number }> {
  const res = await impl(deps)(`${FIRECRAWL_BASE}/scrape`, {
    method: "POST",
    headers: headers(deps.apiKey),
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    signal: deps.signal,
  });
  if (!res.ok) throw new Error(`Firecrawl scrape error ${res.status}`);
  const d = (await res.json()) as { data?: { markdown?: string; md?: string; metadata?: { title?: string; ogTitle?: string } } };
  const md = String(d?.data?.markdown ?? d?.data?.md ?? "");
  const title = String(d?.data?.metadata?.title ?? d?.data?.metadata?.ogTitle ?? "");
  return { markdown: md, title, creditsUsed: creditsFrom(d) };
}

export type FirecrawlStatus = "ok" | "no_match" | "rate_limited" | "timeout" | "error";

export interface FirecrawlDiscovery {
  result: AiLookupResult | null;
  evidence: EvidenceResult;
  status: FirecrawlStatus;
  latencyMs: number;
  searchCount: number; // safe candidates we actually opened
  scrapeCount: number;
  // True when the search returned MORE results than we were allowed to open (maxScrape) and none of
  // the opened pages matched - i.e. the product might be on a result we never scraped (coverage gap).
  coverageMissed: boolean;
  creditsUsed: number; // best-effort, 0 if the API did not report it
}

// Prefer real product/listing pages; push search/category/cart/login/account noise to the back so the
// maxScrape budget is spent on pages that can actually carry a product + barcode.
export function urlPreferenceScore(url: string): number {
  const u = url.toLowerCase();
  let s = 0;
  if (/\/(product|products|item|items|listing|listings|dp|shop|store|buy)\b|\/p\/|\/p_[a-z0-9]/.test(u)) s += 3;
  if (/\/(search|find|category|categories|collection|collections|cart|checkout|login|signin|sign-in|account|tag|tags)\b|[?&](q|query|search)=/.test(u)) s -= 4;
  return s;
}

function creditsFrom(d: unknown): number {
  const o = d as { creditsUsed?: number; data?: { creditsUsed?: number }; scrape?: { creditsUsed?: number } };
  const n = o?.creditsUsed ?? o?.data?.creditsUsed ?? o?.scrape?.creditsUsed;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

// --- Cost-optimized single-URL scrape (Plan D Task 1) ---------------------------------------------
// Used when we already have a candidate URL (from a barcode-DB hit or an earlier cheap tier) and just
// need the page text for OUR extractor to read. This is the workhorse path: basic proxy + markdown
// only + onlyMainContent = 1 credit/page (NEVER json/LLM-extract mode, which costs 5). It rotates
// across up to 4 Firecrawl API keys so one exhausted key never blocks a lookup, and it NEVER throws
// into the scan flow - a fully exhausted/absent key set is a clean null ("unavailable").

export interface FirecrawlCheapDeps {
  fetchImpl?: FcFetch;
  signal?: AbortSignal;
  // Explicit key list for tests/callers that already resolved keys. When omitted, falls back to
  // FIRECRAWL_API_KEY_1..4 (then the legacy single FIRECRAWL_API_KEY) read from env, server-side only.
  apiKeys?: string[];
}

export interface FirecrawlCheapResult {
  markdown: string;
  title: string;
  creditsUsed: number;
  keyIndex: number; // which key (0-based, in rotation order) actually served the request
}

/** Reads FIRECRAWL_API_KEY_1..4 in order (skipping unset ones); falls back to legacy FIRECRAWL_API_KEY. */
export function firecrawlKeysFromEnv(): string[] {
  const numbered = [1, 2, 3, 4]
    .map((n) => process.env[`FIRECRAWL_API_KEY_${n}`])
    .filter((k): k is string => !!k && k.trim().length > 0);
  if (numbered.length > 0) return numbered;
  const legacy = process.env.FIRECRAWL_API_KEY;
  return legacy && legacy.trim().length > 0 ? [legacy] : [];
}

/**
 * Scrape ONE known URL as cheaply as possible (1 credit, basic proxy, markdown-only) and rotate
 * across configured keys when a key is out of credits (402) or rate-limited (429). Any other failure,
 * or a fully exhausted key list, resolves to null - never throws - so a bad key never breaks a scan.
 */
export async function firecrawlScrapeCheap(
  url: string,
  deps: FirecrawlCheapDeps = {},
  opts?: { maxAge?: number; proxy?: "basic" | "stealth" },
): Promise<FirecrawlCheapResult | null> {
  if (!isSafePublicUrl(url)) return null;
  const keys = deps.apiKeys && deps.apiKeys.length > 0 ? deps.apiKeys.filter(Boolean) : firecrawlKeysFromEnv();
  if (keys.length === 0) return null;

  const fetchFn = deps.fetchImpl ?? (globalThis.fetch as unknown as FcFetch);
  const body: Record<string, unknown> = { url, formats: ["markdown"], onlyMainContent: true, proxy: opts?.proxy ?? "basic" };
  if (opts?.maxAge != null) body.maxAge = opts.maxAge;

  for (let i = 0; i < keys.length; i++) {
    try {
      const res = await fetchFn(`${FIRECRAWL_BASE}/scrape`, {
        method: "POST",
        headers: headers(keys[i]),
        body: JSON.stringify(body),
        signal: deps.signal,
      });
      if (res.status === 402 || res.status === 429) continue; // this key is out of credits/quota: rotate
      if (!res.ok) return null; // any other failure: clean unavailable, never throw into the scan
      const d = (await res.json()) as { data?: { markdown?: string; md?: string; metadata?: { title?: string; ogTitle?: string } } };
      const markdown = String(d?.data?.markdown ?? d?.data?.md ?? "");
      const title = String(d?.data?.metadata?.title ?? d?.data?.metadata?.ogTitle ?? "");
      return { markdown, title, creditsUsed: creditsFrom(d), keyIndex: i };
    } catch {
      continue; // network/parse error on this key: try the next one rather than failing the whole lookup
    }
  }
  return null; // every key exhausted/rate-limited: clean unavailable, never throw
}

const noneEvidence = (): EvidenceResult => ({
  verified: false,
  strength: "none",
  matchedCode: "",
  matchedSources: [],
  reason: "Firecrawl fallback found no page containing the exact code.",
});

const isRateLimit = (msg: string) => /\b429\b|rate.?limit|quota/i.test(msg);

/** Best product name from a scraped page: prefer the page title, fall back to the first markdown heading. */
function bestName(title: string, markdown: string): string {
  if (isUsableProductName(title)) return cleanProductName(title);
  const heading = markdown
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^#{1,3}\s+\S/.test(l));
  if (heading) {
    const t = heading.replace(/^#{1,3}\s+/, "").trim();
    if (isUsableProductName(t)) return cleanProductName(t);
  }
  return "";
}

/**
 * Discover a product by searching the barcode, then scraping the top SAFE candidates IN PARALLEL
 * (wall-clock ~= the slowest single scrape, not the sum) and picking the EARLIEST-ranked page that
 * actually contains the exact code AND yields a usable product name. Searching deeper than the old
 * top-3 matters: real listings (e.g. Faire) often rank #4+, below the barcode-DB noise.
 */
export async function discoverViaFirecrawl(
  code: string,
  codeType: CodeType,
  deps: FirecrawlDeps,
  opts?: { maxScrape?: number; searchLimit?: number },
): Promise<FirecrawlDiscovery> {
  const start = Date.now();
  const maxScrape = opts?.maxScrape ?? 6;
  const searchLimit = opts?.searchLimit ?? Math.max(maxScrape + 2, 8);
  const digits = code.replace(/\D/g, "");
  const variants = [code, digits, digits.padStart(13, "0"), digits.padStart(14, "0")].filter(Boolean);
  const hasCode = (t: string) => variants.some((v) => t.includes(v));

  try {
    const raw = await firecrawlSearch(code, deps, searchLimit);
    const safe = raw.filter((r) => isSafePublicUrl(r.url));
    // Prefer product/listing URLs over search/cart/login noise (stable: search rank breaks ties).
    const prioritized = safe
      .map((r, rank) => ({ r, rank }))
      .sort((a, b) => urlPreferenceScore(b.r.url) - urlPreferenceScore(a.r.url) || a.rank - b.rank)
      .map((x) => x.r);
    const candidates = prioritized.slice(0, maxScrape);
    const coverage = (matched: boolean) => !matched && safe.length > candidates.length;
    if (candidates.length === 0) {
      return { result: null, evidence: noneEvidence(), status: "no_match", latencyMs: Date.now() - start, searchCount: 0, scrapeCount: 0, coverageMissed: coverage(false), creditsUsed: 0 };
    }

    // Scrape every safe candidate concurrently. A single scrape failure drops that candidate to null
    // (it must not abort the batch); a 429 is remembered so we can report rate_limited honestly.
    let sawRateLimit = false;
    let creditsUsed = 0;
    const scraped = await Promise.all(
      candidates.map(async (c, i) => {
        try {
          const s = await firecrawlScrape(c.url, deps);
          creditsUsed += s.creditsUsed;
          return { rank: i, url: c.url, md: s.markdown, title: s.title };
        } catch (e) {
          if (isRateLimit(String((e as Error)?.message ?? e ?? ""))) sawRateLimit = true;
          return null;
        }
      }),
    );

    // Pick the earliest (highest-preference) page that shows the exact code AND has a usable name.
    const ordered = scraped.filter((p): p is NonNullable<typeof p> => p !== null).sort((a, b) => a.rank - b.rank);
    for (const p of ordered) {
      if (!hasCode(p.md)) continue; // only trust a page that actually shows the exact code
      const name = bestName(p.title, p.md);
      if (!name) continue;
      const result = normalizeResult({ productName: name, sourceUrls: [p.url], primaryBarcode: code, confidence: 0.9 });
      const evidence = verifyEvidence(code, codeType, { fetchedSourceText: p.md, sourceUrls: [p.url], sourceSnippets: [], groundingChunks: [] });
      return { result, evidence, status: "ok", latencyMs: Date.now() - start, searchCount: candidates.length, scrapeCount: candidates.length, coverageMissed: false, creditsUsed };
    }
    return {
      result: null,
      evidence: noneEvidence(),
      status: sawRateLimit ? "rate_limited" : "no_match",
      latencyMs: Date.now() - start,
      searchCount: candidates.length,
      scrapeCount: candidates.length,
      coverageMissed: coverage(false),
      creditsUsed,
    };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e ?? "");
    const status: FirecrawlStatus = isRateLimit(msg) ? "rate_limited" : /timeout|abort/i.test(msg) ? "timeout" : "error";
    return { result: null, evidence: noneEvidence(), status, latencyMs: Date.now() - start, searchCount: 0, scrapeCount: 0, coverageMissed: false, creditsUsed: 0 };
  }
}
