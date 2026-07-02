// Plan D Task 4 - identification resolver (the heart of the grounding ladder), GROUNDING-FIRST + FETCH-VERIFY.
//
// OWNER DECISION (2026-07-01, SUPERSEDES the older barcode-DB-first cost order): for an unknown code (one
// that missed corpus/retail/cache) Google/grounding is the ACCURATE primary now. The free structured
// barcode-DB (UPCitemdb) proved UNRELIABLE - it returned "coconut oil" for glycine 737870166917 and
// blindly trusting it auto-verified a WRONG product. So:
//
//   1. GROUNDING FIRST: exactly ONE flash-lite google_search call. A usable, non-refusal answer is marked
//      VERIFIED only when the APP independently FETCHES a candidate page and confirms (a) the exact code is
//      really on that page AND (b) a distinctive token of the grounding name is on that same page (guards a
//      hallucinated name like "coconut oil" from being "verified" against a glycine page). Otherwise the
//      name is HELD as an unverified suggestion (never auto-counts).
//   2. BARCODE-DB FALLBACK (only when grounding gave nothing usable): a UPCitemdb hit is Verified ONLY if
//      its sourceUrl page fetch-confirms the exact code (+ name corroboration); otherwise it is a Suggestion.
//   3. Held grounding suggestion, then Firecrawl escalation (existing), then the Plan C prefix floor,
//      then the Fix 4 generic terminal floor. NEVER a hallucinated product; NEVER null for a public code.
//
// Cost/speed: 1 grounding call + AT MOST 2 candidate-page fetches (plain FREE fetch, ~5s each), every win
// cached upstream (paid once per code), and a 429 / rate-cap / error on any leg falls back GRACEFULLY (the
// safe() wrapper turns a throw into a clean null - never crash, never guess a product).
//
// All external work is injected via `deps` so tests mock every provider - ZERO live spend / fetch in tests.

import { isUsableProductName, cleanProductName } from "@/services/ai/decode";
import { verifyCodeOnPage as realVerifyCodeOnPage } from "@/services/ai/verifyCodeOnPage";

export type ResolveSource = "barcode_db" | "grounding" | "firecrawl" | "floor";

export interface ParallelResolveResult {
  name: string;
  brand: string;
  /** Verified = safe to auto-count. Only a fetch-confirmed grounding/barcode-DB/firecrawl win is verified. */
  verified: boolean;
  /** Whether the WINNING answer came from an AI call (grounding/firecrawl-escalation) vs structured/floor. */
  aiCalled: boolean;
  source: ResolveSource;
}

export interface BarcodeDbLegResult {
  name: string;
  brand: string;
  sourceUrl: string;
}
export interface GroundingLegResult {
  text: string;
  grounded: boolean;
  /** Grounding source texts (chunk titles + uris) - legacy text signal, kept for back-compat. */
  sources?: string[];
  /** Fetchable grounding chunk URLs (web.uri) - verifyCodeOnPage fetches these to confirm the code. */
  sourceUrls?: string[];
}
export interface FirecrawlLegResult {
  markdown: string;
  title: string;
}
export interface FloorLegResult {
  name: string;
  brand: string;
}

export interface ParallelResolveDeps {
  /** Structured barcode-DB lookup (UPCitemdb). Returns null on miss/rate-limit/error - never throws into us. */
  lookupBarcodeDb: (code: string) => Promise<BarcodeDbLegResult | null>;
  /** Fast grounded identify (gemini-flash-lite). `url` switches google_search -> url_context. Null on miss. */
  groundIdentify: (code: string, opts?: { url?: string }) => Promise<GroundingLegResult | null>;
  /** 1-credit cheap Firecrawl scrape of ONE known URL (escalation only). Null when unavailable. */
  firecrawlScrapeCheap: (url: string) => Promise<FirecrawlLegResult | null>;
  /** Plan C prefix floor: brand-only naming aid for an unresolved public barcode. Null for non-public codes. */
  prefixFloor: (code: string) => FloorLegResult | null;
  /** Optional premium grounding escalation (stronger model) used on a double-miss when no URL panned out. */
  groundIdentifyPremium?: (code: string, opts?: { url?: string }) => Promise<GroundingLegResult | null>;
  /** Injectable "is this a real product name" check (defaults to the shared isUsableProductName). */
  isUsable?: (name: string) => boolean;
  /** Injectable fetch-verify: fetch candidate URLs and return the first page that carries the exact code
   *  (or a GTIN variant), else null. Defaults to the real verifyCodeOnPage; tests inject a mock so ZERO
   *  live network runs. A grounding/barcode-DB answer is Verified ONLY when this confirms the code. */
  verifyCodeOnPage?: (urls: string[], code: string) => Promise<{ url: string; pageText: string } | null>;
}

// A grounding TEXT that is a refusal sentence ("unable to identify", "couldn't find", "not found",
// "no product", ...) is an answer SHAPE, never a product identity. It must NEVER become a "product
// name" - reject it so the leg misses and falls through to barcode-DB / floor. (isUsableProductName
// already blocks some of these; this is the explicit grounding-leg guard for the full owner list.)
const REFUSAL_RE =
  /\b(?:unable to identify|not a recognized product|no product|couldn'?t find|could not find|cannot identify|can'?t identify|i cannot|i don'?t have|not found|no information)\b/i;
export function isRefusal(text: string): boolean {
  return REFUSAL_RE.test(text ?? "");
}

/** Never let a leg's rejection reject the whole resolve: a throw becomes a clean null. */
async function safe<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** NAME-CORROBORATION guard: at least one distinctive token (>=4 alphanumeric chars) of the candidate
 *  name appears on the fetched page. Without this, a page that merely carries the code could "verify" a
 *  hallucinated name (e.g. the barcode-DB's "coconut oil" against a glycine page). Case-insensitive. */
export function nameCorroboratedOnPage(name: string, pageText: string): boolean {
  const clean = cleanProductName(name);
  if (!clean || !pageText) return false;
  const hay = pageText.toLowerCase();
  const tokens = clean.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
  return tokens.some((t) => hay.includes(t));
}

/** Best product name from a scraped page: prefer the page title, else the first markdown heading. */
function bestNameFromPage(title: string, markdown: string, isUsable: (n: string) => boolean): string {
  if (isUsable(title)) return cleanProductName(title);
  const heading = markdown
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^#{1,3}\s+\S/.test(l));
  if (heading) {
    const t = heading.replace(/^#{1,3}\s+/, "").trim();
    if (isUsable(t)) return cleanProductName(t);
  }
  return "";
}

export async function resolveUnknownFast(
  code: string,
  deps: ParallelResolveDeps,
): Promise<ParallelResolveResult | null> {
  const isUsable = deps.isUsable ?? isUsableProductName;
  const verifyPage = deps.verifyCodeOnPage ?? realVerifyCodeOnPage;

  // Best candidate URL seen (a grounding chunk or a barcode-DB offer link) so a double-miss can still
  // escalate to a targeted Firecrawl scrape.
  let bestUrl = "";

  // A usable grounding NAME that could NOT be fetch-confirmed on any candidate page is a low-confidence
  // SUGGESTION, not a Verified win. Held here so it still beats the brand-only floor, but counts verified:false.
  let groundingSuggestion: ParallelResolveResult | null = null;

  // 1. GROUNDING FIRST (accurate primary). One flash-lite google_search call. A usable, non-refusal answer
  //    is VERIFIED only when the APP fetches a candidate page, confirms the exact code is on it, AND a
  //    distinctive token of the grounding name corroborates that page. Otherwise it is a held suggestion.
  const gr = await safe(() => deps.groundIdentify(code));
  if (gr && isUsable(gr.text) && !isRefusal(gr.text)) {
    const urls = gr.sourceUrls ?? [];
    if (urls[0]) bestUrl = urls[0];
    const page = urls.length ? await safe(() => verifyPage(urls, code)) : null;
    if (page && nameCorroboratedOnPage(gr.text, page.pageText)) {
      return { name: cleanProductName(gr.text), brand: "", verified: true, aiCalled: true, source: "grounding" };
    }
    groundingSuggestion = { name: cleanProductName(gr.text), brand: "", verified: false, aiCalled: true, source: "grounding" };
  }

  // 2. BARCODE-DB FALLBACK - ONLY when grounding gave nothing usable (null / refusal / unusable). UPCitemdb
  //    proved unreliable, so a bare hit is a Suggestion; it is Verified ONLY when its sourceUrl page
  //    fetch-confirms the exact code (+ name corroboration). Prefer confirmed-on-page for Verified.
  if (!groundingSuggestion) {
    const bd = await safe(() => deps.lookupBarcodeDb(code));
    if (bd?.sourceUrl && !bestUrl) bestUrl = bd.sourceUrl;
    if (bd && isUsable(bd.name)) {
      if (bd.sourceUrl) {
        const page = await safe(() => verifyPage([bd.sourceUrl], code));
        if (page && nameCorroboratedOnPage(bd.name, page.pageText)) {
          return { name: cleanProductName(bd.name), brand: bd.brand, verified: true, aiCalled: false, source: "barcode_db" };
        }
      }
      // usable name but NOT fetch-confirmed -> Suggested (verified:false), NEVER auto-counted.
      return { name: cleanProductName(bd.name), brand: bd.brand, verified: false, aiCalled: false, source: "barcode_db" };
    }
  }

  // 3. Held unverified grounding suggestion (usable name, code not confirmed on a page) beats everything below.
  if (groundingSuggestion) return groundingSuggestion;

  // 4. FIRECRAWL escalation (existing): a double-miss with a candidate URL scrapes it cheaply for a name.
  if (bestUrl) {
    const fc = await safe(() => deps.firecrawlScrapeCheap(bestUrl));
    if (fc) {
      const name = bestNameFromPage(fc.title, fc.markdown, isUsable);
      if (name) return { name, brand: "", verified: true, aiCalled: true, source: "firecrawl" };
    }
  }

  // 5. Optional one premium grounding call (stronger model) when the cheap escalation did not resolve.
  //    Same gate: Verified only when the APP fetch-confirms the exact code (+ name corroboration).
  if (deps.groundIdentifyPremium) {
    const g = await safe(() => deps.groundIdentifyPremium!(code, bestUrl ? { url: bestUrl } : undefined));
    if (g && isUsable(g.text) && !isRefusal(g.text)) {
      const urls = g.sourceUrls ?? [];
      const page = urls.length ? await safe(() => verifyPage(urls, code)) : null;
      const verified = !!(page && nameCorroboratedOnPage(g.text, page.pageText));
      return { name: cleanProductName(g.text), brand: "", verified, aiCalled: true, source: "grounding" };
    }
  }

  // 6. PREFIX FLOOR (Plan C): name the brand from the GS1 prefix, product explicitly unconfirmed (NOT verified).
  const floor = deps.prefixFloor(code);
  if (floor) return { name: floor.name, brand: floor.brand, verified: false, aiCalled: false, source: "floor" };

  // FIX 4: the caller only invokes this for a PUBLIC barcode, so we must ALWAYS be terminal here and NEVER
  // return null (a null fall-through reaches the expensive, hallucination-prone legacy Gemini/OpenAI path -
  // which auto-verified fake canary codes with garbage names, the last remaining leak). When the prefix
  // maps to no brand (e.g. an unassigned 999-prefix), return a GENERIC unidentified floor: counted,
  // Suggested, NEVER Verified, no AI. This closes both the last hallucinations and the legacy money-pit.
  return { name: `Unidentified item (barcode ${code})`, brand: "", verified: false, aiCalled: false, source: "floor" };
}
