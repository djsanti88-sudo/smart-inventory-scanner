// Plan D Task 4 - identification resolver (the heart of the grounding ladder), BARCODE-DB-FIRST + FETCH-VERIFY.
//
// OWNER DECISION (2026-07-01, SUPERSEDES the short-lived grounding-first order): a 6-code bake-off + online
// accuracy research settled it. The free structured barcode-DB (UPCitemdb, 711M records, ~1s, $0) resolved
// 6/6 real codes CORRECTLY - including glycine 737870166917. The earlier "UPCitemdb is unreliable - it said
// coconut oil for glycine" claim was a MISDIAGNOSIS: that coconut-oil row came from Open Food Facts (removed
// in Fix 5), NOT UPCitemdb. Grounding is slower AND rate-capped, so it is now the FALLBACK, not the primary:
//
//   1. BARCODE-DB FIRST: one free UPCitemdb lookup. OWNER DECISION (2026-07-01): a usable structured hit on
//      a public barcode is TRUSTED like the tire/retail corpus and AUTO-COUNTS (Verified) - the bake-off
//      proved 6/6 accuracy and UPCitemdb's affiliate "offer" links can't fetch-confirm a raw code, so a
//      fetch gate would just route every correct hit to Needs Review. The ONE free guardrail: the GS1
//      brand-prefix firewall (prefixBrandConflict) - if the barcode's known single-brand prefix clearly
//      disagrees with the DB's brand (the coconut-oil-style wrong-identity case), the hit is HELD as an
//      unverified Suggestion instead (shown for one-tap human approval, never auto-counted). Grounding does
//      NOT run on a usable barcode-DB hit - so the common path spends $0, no fetch, and no rate-capped call.
//   2. GROUNDING FALLBACK (only when barcode-DB gave nothing usable): exactly ONE flash-lite google_search
//      call, Verified ONLY when the APP fetch-confirms the exact code (+ name corroboration); else a Suggestion.
//   3. Held barcode-DB suggestion, then Firecrawl escalation (existing), then the Plan C prefix floor,
//      then the Fix 4 generic terminal floor. NEVER a hallucinated product; NEVER null for a public code.
//
// Cost/speed: the common path is 1 free barcode-DB lookup + AT MOST 1 candidate-page fetch (plain FREE fetch,
// ~5s). Grounding (paid, rate-capped) fires only on a barcode-DB miss. Every win is cached upstream (resolved
// once per code), and a 429 / rate-cap / error on any leg falls back GRACEFULLY (the safe() wrapper turns a
// throw into a clean null - never crash, never guess a product).
//
// All external work is injected via `deps` so tests mock every provider - ZERO live spend / fetch in tests.

import { isUsableProductName, cleanProductName } from "@/services/ai/decode";
import { verifyCodeOnPage as realVerifyCodeOnPage, pageTextHasCode } from "@/services/ai/verifyCodeOnPage";
import { prefixBrandConflict } from "@/services/catalog/brandPrefixGeneral";

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
  /** Injectable GS1 brand-prefix firewall: true when the barcode-DB brand clearly conflicts with the code's
   *  known single-brand prefix (the wrong-identity guard). Defaults to the real prefixBrandConflict. A hit is
   *  auto-counted ONLY when this returns false. */
  brandPrefixConflict?: (code: string, brand: string) => boolean;
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
  const brandConflict = deps.brandPrefixConflict ?? prefixBrandConflict;

  // Best candidate URL seen (a barcode-DB offer link or a grounding chunk) so a double-miss can still
  // escalate to a targeted Firecrawl scrape.
  let bestUrl = "";

  // A usable barcode-DB NAME whose brand FAILS the prefix firewall is a low-confidence SUGGESTION, not a
  // Verified win. Held here so it still beats the brand-only floor, but counts verified:false.
  let barcodeSuggestion: ParallelResolveResult | null = null;

  // 1. BARCODE-DB FIRST (free, fast, TRUSTED primary). One UPCitemdb lookup. A usable hit on a public
  //    barcode AUTO-COUNTS (Verified) - owner-approved trust of the structured DB (bake-off 6/6). The only
  //    free guardrail: the GS1 brand-prefix firewall. If the barcode's known single-brand prefix clearly
  //    disagrees with the DB brand (wrong-identity case), it is HELD as a Suggestion instead. No fetch-verify
  //    is done here (affiliate offer links can't confirm the raw code), so a hit is fast and spends $0, and
  //    grounding never runs on a usable hit.
  const bd = await safe(() => deps.lookupBarcodeDb(code));
  if (bd?.sourceUrl) bestUrl = bd.sourceUrl;
  if (bd && isUsable(bd.name)) {
    if (!brandConflict(code, bd.brand)) {
      return { name: cleanProductName(bd.name), brand: bd.brand, verified: true, aiCalled: false, source: "barcode_db" };
    }
    // brand clearly conflicts with the barcode's known prefix -> hold as Suggestion, never auto-count.
    barcodeSuggestion = { name: cleanProductName(bd.name), brand: bd.brand, verified: false, aiCalled: false, source: "barcode_db" };
  }

  // 2. GROUNDING FALLBACK - ONLY when barcode-DB gave nothing usable (null / rate-limit / unusable name).
  //    Exactly ONE flash-lite google_search call. A usable, non-refusal answer is VERIFIED only when the APP
  //    fetches a candidate page, confirms the exact code is on it, AND a distinctive token of the grounding
  //    name corroborates that page. Otherwise it is a Suggestion (never auto-counted).
  if (!barcodeSuggestion) {
    const gr = await safe(() => deps.groundIdentify(code));
    if (gr && isUsable(gr.text) && !isRefusal(gr.text)) {
      const urls = gr.sourceUrls ?? [];
      if (urls[0] && !bestUrl) bestUrl = urls[0];
      const page = urls.length ? await safe(() => verifyPage(urls, code)) : null;
      if (page && nameCorroboratedOnPage(gr.text, page.pageText)) {
        return { name: cleanProductName(gr.text), brand: "", verified: true, aiCalled: true, source: "grounding" };
      }
      return { name: cleanProductName(gr.text), brand: "", verified: false, aiCalled: true, source: "grounding" };
    }
  }

  // 3. Held unverified barcode-DB suggestion (usable name, code not confirmed on a page) beats everything below.
  if (barcodeSuggestion) return barcodeSuggestion;

  // 4. FIRECRAWL escalation: a double-miss with a candidate URL scrapes it cheaply for a name. A scraped
  //    arbitrary page is the LEAST-trusted source, so it AUTO-COUNTS (Verified) ONLY when the scrape actually
  //    carries the exact scanned code (same digit-boundary match as verifyCodeOnPage). Otherwise the name is
  //    a held Suggestion, never a blind auto-count (this is what stopped an "Error"-titled page verifying).
  if (bestUrl) {
    const fc = await safe(() => deps.firecrawlScrapeCheap(bestUrl));
    if (fc) {
      const name = bestNameFromPage(fc.title, fc.markdown, isUsable);
      if (name && !isRefusal(name)) {
        const codeOnPage = pageTextHasCode(`${fc.title}\n${fc.markdown}`, code);
        return { name, brand: "", verified: codeOnPage, aiCalled: true, source: "firecrawl" };
      }
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
