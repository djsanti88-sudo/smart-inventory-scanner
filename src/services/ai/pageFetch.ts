import type { AiLookupResult, CodeType, EvidenceResult } from "@/types";
import { normalizeResult } from "@/services/ai/provider";
import { verifyEvidence } from "@/services/ai/evidenceVerifier";
import { isUsableProductName, cleanProductName } from "@/services/ai/decode";

// Page-fetch-and-read: the app itself opens public barcode/retail pages, reads the text, confirms
// the exact code is on the page (strong "fetched_source" evidence), and extracts the product. This
// is what a person (or the ChatGPT website) does - search, then OPEN and READ the page - which the
// raw provider web-search tools often skip. SERVER-SIDE ONLY. No secrets involved.

/** Deterministic candidate lookup URLs built straight from the code (works even if AI returns nothing). */
export function barcodeDbUrls(code: string): string[] {
  const c = (code ?? "").trim();
  if (!c) return [];
  const c13 = c.replace(/\D/g, "").padStart(13, "0"); // many DBs index by the 13-digit GTIN
  return [
    `https://go-upc.com/search?q=${encodeURIComponent(c)}`,
    `https://www.upcitemdb.com/upc/${encodeURIComponent(c)}`,
    `https://barcodesdatabase.org/barcode/${encodeURIComponent(c13)}`,
    `https://www.barcodelookup.com/${encodeURIComponent(c)}`,
    `https://www.buycott.com/upc/${encodeURIComponent(c)}`,
  ];
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/** Strip HTML to readable text (drop scripts/styles, tags, decode common entities, collapse space). */
export function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Heuristic product extraction from page HTML (og:title / JSON-LD name / <title>). */
export function extractTitleProduct(html: string): { productName: string; brand: string } {
  const out = { productName: "", brand: "" };
  if (!html) return out;

  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const ld = html.match(/"@type"\s*:\s*"Product"[\s\S]*?"name"\s*:\s*"([^"]+)"/i);
  const brand = html.match(/"brand"\s*:\s*(?:"([^"]+)"|\{[^}]*"name"\s*:\s*"([^"]+)")/i);
  const title = html.match(/<title>([^<]+)<\/title>/i);

  let name = (ld?.[1] || og?.[1] || title?.[1] || "").trim();
  // Trim common site suffixes ("... | Barcode Lookup", "... - UPCitemdb").
  name = name.replace(/\s*[|\-–]\s*(barcode lookup|upcitemdb|go-upc|buycott|barcode|upc).*$/i, "").trim();
  out.productName = name;
  out.brand = (brand?.[1] || brand?.[2] || "").trim();
  return out;
}

export interface FetchedPage {
  url: string;
  text: string;
  html: string;
}

export type FetchImpl = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

// Rotate a few realistic desktop UAs so sites are less likely to bot-block (helps naive UA blocks;
// it will NOT defeat IP-based 429/403 - the cache/low-volume + backoff are the real mitigation).
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
];
let uaIdx = 0;
function nextUA(): string {
  uaIdx = (uaIdx + 1) % USER_AGENTS.length;
  return USER_AGENTS[uaIdx];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });
}

interface FetchOpts {
  timeoutMs: number;
  maxBytes: number;
  backoffMs: number;
  signal?: AbortSignal;
}

/** Fetch one URL with a per-call timeout; on 429/403 back off once then skip politely. */
async function fetchOne(url: string, fetchImpl: FetchImpl, opts: FetchOpts): Promise<FetchedPage | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
    try {
      const res = await fetchImpl(url, {
        signal,
        headers: { "User-Agent": nextUA(), Accept: "text/html,application/xhtml+xml" },
      });
      if (res.status === 429 || res.status === 403) {
        if (attempt === 0) {
          await sleep(opts.backoffMs, opts.signal); // one short backoff, then give up
          continue;
        }
        return null; // rate-limited -> skip politely
      }
      if (!res.ok) return null;
      const html = (await res.text()).slice(0, opts.maxBytes);
      const text = htmlToText(html);
      return text.length > 0 ? { url, html, text } : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Fetch each URL server-side (concurrently), strip to text. Skips failures + rate-limited sites. */
export async function fetchPages(
  urls: string[],
  deps?: { fetchImpl?: FetchImpl; timeoutMs?: number; maxBytes?: number; backoffMs?: number; signal?: AbortSignal },
): Promise<FetchedPage[]> {
  const fetchImpl = deps?.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
  const opts: FetchOpts = {
    timeoutMs: deps?.timeoutMs ?? 7000,
    maxBytes: deps?.maxBytes ?? 400_000,
    backoffMs: deps?.backoffMs ?? 400,
    signal: deps?.signal,
  };
  const settled = await Promise.allSettled(urls.map((u) => fetchOne(u, fetchImpl, opts)));
  return settled
    .filter((r): r is PromiseFulfilledResult<FetchedPage | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((p): p is FetchedPage => p !== null);
}

/**
 * Fetch candidate URLs concurrently and resolve the MOMENT a page containing the exact code arrives -
 * do not wait for slow/hung sibling sites (that wait was the ~8s tail). All sites still run, so a slow
 * winner is not lost; we just stop blocking on the laggards. Falls back to all-settled if none match.
 */
// A barcode DB's "Product Not Found" page ECHOES the searched code in its error text, so "the code is
// on the page" is not enough to trust it. Detect those so they never win or get scraped as a product.
const NOT_FOUND_RE = /\b(product not found|not able to find|no(?:t)? (?:results?|product|match)|couldn't find|we were not able)\b/i;
export function looksLikeNotFound(text: string): boolean {
  return NOT_FOUND_RE.test(text || "");
}

async function fetchUntilCodePage(
  urls: string[],
  codeVariants: string[],
  fetchImpl: FetchImpl,
  opts: FetchOpts,
): Promise<{ codePage: FetchedPage | null; pages: FetchedPage[] }> {
  const pages: FetchedPage[] = [];
  let productPage: FetchedPage | null = null; // has the code AND a usable product title -> real winner
  let fallbackPage: FetchedPage | null = null; // has the code but no usable product (used only if nothing better)
  let resolveFound: () => void = () => {};
  const found = new Promise<void>((r) => (resolveFound = r));
  const tasks = urls.map((u) =>
    fetchOne(u, fetchImpl, opts)
      .then((p) => {
        if (!p) return;
        pages.push(p);
        if (productPage) return;
        if (!codeVariants.some((v) => p.html.includes(v))) return;
        // Early-win ONLY on a real product page (usable title, not a "not found" page); otherwise keep
        // looking at the other sites and hold this only as a last-resort fallback.
        const usable = isUsableProductName(extractTitleProduct(p.html).productName) && !looksLikeNotFound(p.text);
        if (usable) {
          productPage = p;
          resolveFound();
        } else if (!fallbackPage && !looksLikeNotFound(p.text)) {
          fallbackPage = p;
        }
      })
      .catch(() => {}),
  );
  await Promise.race([found, Promise.allSettled(tasks)]);
  return { codePage: productPage ?? fallbackPage, pages };
}

export interface PageEnrichResult {
  result: AiLookupResult | null;
  evidence: EvidenceResult;
  fetchedUrls: string[];
  pageCount: number;
  fetchedText: string;
}

function uniq(a: string[]): string[] {
  return [...new Set(a.filter(Boolean))];
}

/**
 * Open candidate pages, confirm the exact code is on them (fetched_source evidence), and extract the
 * product. An optional `extract` (e.g. a model reading the page text) overrides the heuristic.
 */
export async function enrichWithPageFetch(params: {
  code: string;
  codeType: CodeType;
  extraUrls?: string[];
  maxPages?: number;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
  extract?: (pageText: string, code: string, signal?: AbortSignal) => Promise<Partial<AiLookupResult>> | Partial<AiLookupResult>;
}): Promise<PageEnrichResult> {
  const urls = uniq([...(params.extraUrls ?? []), ...barcodeDbUrls(params.code)]).slice(0, params.maxPages ?? 6);
  // ONLY trust a page that actually contains the exact scanned code (or a GTIN-13/14 variant).
  const codeDigits = params.code.replace(/\D/g, "");
  const codeVariants = [params.code, codeDigits, codeDigits.padStart(13, "0"), codeDigits.padStart(14, "0")].filter(Boolean);

  const fetchImpl = params.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
  const fetchOpts: FetchOpts = { timeoutMs: 7000, maxBytes: 400_000, backoffMs: 400, signal: params.signal };
  const { codePage, pages } = await fetchUntilCodePage(urls, codeVariants, fetchImpl, fetchOpts);

  const fetchedUrls = pages.map((p) => p.url);
  // The code-bearing page is the authoritative source; read just it (faster than joining every page).
  const fetchedText = (codePage ? codePage.text : pages.map((p) => p.text).join("\n\n")).slice(0, 24_000);

  const evidence = verifyEvidence(params.code, params.codeType, {
    fetchedSourceText: fetchedText,
    sourceUrls: fetchedUrls,
    sourceSnippets: [],
    groundingChunks: [],
  });

  // If no fetched page contains the code, return NO product (-> Needs Review). Never fall back to a
  // site's generic/search title (the "710154236681 website-title" bug).
  if (pages.length === 0 || !codePage) {
    return { result: null, evidence, fetchedUrls, pageCount: pages.length, fetchedText };
  }

  // FAST PATH: read the code-bearing page's OWN structured data (ld+json / og:title) first - no model
  // call. Only pay for the model read when the page doesn't self-describe with a usable name. The
  // model read was the ~6s tail and, for barcode-DB pages, returned no extra specs anyway.
  const h = extractTitleProduct(codePage.html);
  let candidateName = isUsableProductName(h.productName) ? h.productName : "";
  let candidateBrand = h.brand;
  let extracted: Partial<AiLookupResult> | null = null;
  if (!candidateName && params.extract) {
    try {
      extracted = await params.extract(fetchedText, params.code, params.signal);
    } catch {
      extracted = null;
    }
    if (isUsableProductName(extracted?.productName ?? "")) {
      candidateName = String(extracted?.productName).trim();
      candidateBrand = candidateBrand || (extracted?.brand ?? "").trim();
    }
  }

  const cleanName = isUsableProductName(candidateName) ? cleanProductName(candidateName) : "";
  const result = cleanName
    ? normalizeResult({
        ...(extracted ?? {}),
        productName: cleanName,
        brand: candidateBrand,
        sourceUrls: uniq([...(extracted?.sourceUrls ?? []), ...fetchedUrls]),
        primaryBarcode: extracted?.primaryBarcode || params.code,
        confidence: extracted?.confidence ?? (evidence.verified ? 0.92 : 0.6),
        // Carry the exact code-bearing page text so this result's fetched_source provenance survives any
        // later re-verification (evidenceOf). It is the same text already verified above into `evidence`.
        fetchedSourceText: codePage ? codePage.text : fetchedText,
      })
    : null;

  return { result, evidence, fetchedUrls, pageCount: pages.length, fetchedText };
}
