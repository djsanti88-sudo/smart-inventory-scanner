// Plan D Task 4 - identification resolver (the heart of the grounding ladder), COST-ORDERED (Fix 3).
//
// For an unknown code (one that missed the corpus/retail/cache), try the FREE structured barcode-DB leg
// FIRST; only on a miss run the paid grounding leg. This is cost-ordered, not a parallel race: the
// expensive google_search grounding ($35/1k) must never fire when the free barcode-DB already has the code
// (it was mostly re-finding upcitemdb - the same source barcode-DB queries for free).
//   - barcode-DB leg (UPCitemdb, structured {name,brand,sourceUrl}) -> a hit is Verified, aiCalled:false; STOP.
//   - grounding leg  (gemini-flash-lite google_search) runs ONLY on a barcode-DB miss -> Verified ONLY when
//     the exact code is in its sources (FINDING-1), else a demoted unverified suggestion; aiCalled:true.
//
// Only a DOUBLE MISS escalates: firecrawl the best candidate URL (1-credit cheap scrape, Task 1) and
// parse a name, optionally one premium grounding call, then the Plan C prefix floor - so the resolver
// NEVER fails to decode for a public barcode. It returns null ONLY when there is nothing at all (not even
// a floor), letting the caller fall through to the legacy path unchanged.
//
// All external work is injected via `deps` so tests mock every provider - ZERO live spend in tests.

import { isUsableProductName, cleanProductName } from "@/services/ai/decode";
import { numericCodeInTexts } from "@/services/ai/evidenceVerifier";

export type ResolveSource = "barcode_db" | "grounding" | "firecrawl" | "floor";

export interface ParallelResolveResult {
  name: string;
  brand: string;
  /** Verified = safe to auto-count. barcode-DB / grounding hits are verified; the floor is NOT. */
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
  /** Grounding source texts (chunk titles + uris) for the app-side code-in-sources check. */
  sources?: string[];
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
  /** Injectable app-side "exact code appears in the grounding sources" check (defaults to
   *  evidenceVerifier.numericCodeInTexts). FINDING-1 gate: a grounding answer is Verified ONLY
   *  when this passes; otherwise it is demoted to an unverified suggestion. */
  codeInSources?: (code: string, sources: string[]) => boolean;
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
  const codeInSources = deps.codeInSources ?? numericCodeInTexts;

  // Capture the best candidate URL seen (a barcode-DB row can carry an offer link even when its title is
  // junk) so a double-miss can still escalate to a targeted Firecrawl scrape.
  let bestUrl = "";

  // FINDING-1: a usable grounding NAME whose exact code is NOT in the grounding sources is a low-confidence
  // SUGGESTION, not a Verified win. We hold it here so it still beats the brand-only floor on a genuine
  // miss, but downstream it counts as verified:false.
  let groundingSuggestion: ParallelResolveResult | null = null;

  // COST FIX (Fix 3): barcode-DB FIRST. A confident hit returns WITHOUT ever calling the expensive
  // google_search grounding leg ($35/1k). The barcode-DB leg is free and hits most codes, so grounding
  // fires ONLY on a genuine barcode-DB miss - not on every scan (which was mostly re-finding upcitemdb,
  // the very source the barcode-DB leg already queries for free).
  const bd = await safe(() => deps.lookupBarcodeDb(code));
  if (bd?.sourceUrl) bestUrl = bd.sourceUrl;
  if (bd && isUsable(bd.name)) {
    return { name: cleanProductName(bd.name), brand: bd.brand, verified: true, aiCalled: false, source: "barcode_db" };
  }

  // barcode-DB MISS -> now (and only now) run grounding. Same FINDING-1 gate: Verified only when the exact
  // code is in the grounding sources; a usable-but-unconfirmed name is demoted to a held suggestion; a
  // refusal sentence is not a product identity at all -> the leg misses.
  const gr = await safe(() => deps.groundIdentify(code));
  if (gr && isUsable(gr.text) && !isRefusal(gr.text)) {
    const verified = codeInSources(code, gr.sources ?? []);
    const result: ParallelResolveResult = { name: cleanProductName(gr.text), brand: "", verified, aiCalled: true, source: "grounding" };
    if (verified) return result; // exact code in sources -> Verified win
    groundingSuggestion = result; // usable but unconfirmed -> held (verified:false)
  }

  // DOUBLE MISS -> escalate. Both legs have settled (firstConfident returned null), so bestUrl is final.
  if (bestUrl) {
    const fc = await safe(() => deps.firecrawlScrapeCheap(bestUrl));
    if (fc) {
      const name = bestNameFromPage(fc.title, fc.markdown, isUsable);
      if (name) return { name, brand: "", verified: true, aiCalled: true, source: "firecrawl" };
    }
  }

  // Optional one premium grounding call (stronger model) when the cheap escalation did not resolve.
  // It obeys the SAME refusal + code-in-sources gate: Verified only when the exact code is in its sources.
  if (deps.groundIdentifyPremium) {
    const g = await safe(() => deps.groundIdentifyPremium!(code, bestUrl ? { url: bestUrl } : undefined));
    if (g && isUsable(g.text) && !isRefusal(g.text)) {
      const verified = codeInSources(code, g.sources ?? []);
      return { name: cleanProductName(g.text), brand: "", verified, aiCalled: true, source: "grounding" };
    }
  }

  // A held unverified grounding suggestion (usable name, code not in sources) beats the brand-only floor.
  if (groundingSuggestion) return groundingSuggestion;

  // PREFIX FLOOR (Plan C): name the brand from the GS1 prefix, product explicitly unconfirmed (NOT verified).
  const floor = deps.prefixFloor(code);
  if (floor) return { name: floor.name, brand: floor.brand, verified: false, aiCalled: false, source: "floor" };

  // FIX 4: the caller only invokes this for a PUBLIC barcode, so we must ALWAYS be terminal here and NEVER
  // return null (a null fall-through reaches the expensive, hallucination-prone legacy Gemini/OpenAI path -
  // which auto-verified fake canary codes with garbage names, the last remaining leak). When the prefix
  // maps to no brand (e.g. an unassigned 999-prefix), return a GENERIC unidentified floor: counted,
  // Suggested, NEVER Verified, no AI. This closes both the last hallucinations and the legacy money-pit.
  return { name: `Unidentified item (barcode ${code})`, brand: "", verified: false, aiCalled: false, source: "floor" };
}
