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

/** Firecrawl scrape of one URL -> clean markdown + title. Throws on HTTP error. */
export async function firecrawlScrape(url: string, deps: FirecrawlDeps): Promise<{ markdown: string; title: string }> {
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
  return { markdown: md, title };
}

export type FirecrawlStatus = "ok" | "no_match" | "rate_limited" | "timeout" | "error";

export interface FirecrawlDiscovery {
  result: AiLookupResult | null;
  evidence: EvidenceResult;
  status: FirecrawlStatus;
  latencyMs: number;
  searchCount: number;
  scrapeCount: number;
}

const noneEvidence = (): EvidenceResult => ({
  verified: false,
  strength: "none",
  matchedCode: "",
  matchedSources: [],
  reason: "Firecrawl fallback found no page containing the exact code.",
});

/**
 * Discover a product by searching the barcode, then scraping the top SAFE candidates until one page
 * actually contains the exact code AND yields a usable product name. Capped by maxScrape.
 */
export async function discoverViaFirecrawl(
  code: string,
  codeType: CodeType,
  deps: FirecrawlDeps,
  opts?: { maxScrape?: number },
): Promise<FirecrawlDiscovery> {
  const start = Date.now();
  const maxScrape = opts?.maxScrape ?? 3;
  const digits = code.replace(/\D/g, "");
  const variants = [code, digits, digits.padStart(13, "0"), digits.padStart(14, "0")].filter(Boolean);
  const hasCode = (t: string) => variants.some((v) => t.includes(v));

  try {
    const candidates = (await firecrawlSearch(code, deps, 5)).filter((r) => isSafePublicUrl(r.url)).slice(0, maxScrape);
    let scrapeCount = 0;
    for (const c of candidates) {
      scrapeCount++;
      let md = "";
      let title = "";
      try {
        const s = await firecrawlScrape(c.url, deps);
        md = s.markdown;
        title = s.title;
      } catch {
        continue; // a single scrape failure shouldn't abort the others
      }
      if (!hasCode(md)) continue; // only trust a page that actually shows the exact code
      const name = isUsableProductName(title) ? cleanProductName(title) : "";
      if (!name) continue;
      const result = normalizeResult({ productName: name, sourceUrls: [c.url], primaryBarcode: code, confidence: 0.9 });
      const evidence = verifyEvidence(code, codeType, { fetchedSourceText: md, sourceUrls: [c.url], sourceSnippets: [], groundingChunks: [] });
      return { result, evidence, status: "ok", latencyMs: Date.now() - start, searchCount: candidates.length, scrapeCount };
    }
    return { result: null, evidence: noneEvidence(), status: "no_match", latencyMs: Date.now() - start, searchCount: candidates.length, scrapeCount };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e ?? "");
    const status: FirecrawlStatus = /\b429\b|rate.?limit|quota/i.test(msg) ? "rate_limited" : /timeout|abort/i.test(msg) ? "timeout" : "error";
    return { result: null, evidence: noneEvidence(), status, latencyMs: Date.now() - start, searchCount: 0, scrapeCount: 0 };
  }
}
