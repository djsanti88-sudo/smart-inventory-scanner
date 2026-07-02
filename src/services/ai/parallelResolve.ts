// Plan D Task 4 - PARALLEL RESOLVER (the speed-first heart of the grounding ladder).
//
// For an unknown code (one that missed the corpus/retail/cache), race two independent identification
// legs CONCURRENTLY and take the FIRST confident answer (target ~1s wall-clock):
//   - barcode-DB leg  (UPCitemdb, structured {name,brand,sourceUrl}) -> a hit is Verified, aiCalled:false
//   - grounding leg   (gemini-flash-lite google_search text)         -> a usable name is Verified, aiCalled:true
// The two legs are genuinely parallel: a slow LOSER never delays a fast winner (we resolve on the FIRST
// confident result via a small race helper, never awaiting the slower leg). If both legs resolve about
// together, the STRUCTURED barcode-DB answer wins the tie.
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

/**
 * Resolve to the FIRST confident leg. `preferred` wins a same-tick tie (registered first); a confident
 * `other` that finishes FIRST while `preferred` is still pending wins immediately (speed priority - the
 * slow preferred leg never delays it). Resolves to null only when BOTH settle non-confident.
 */
function firstConfident<T>(preferred: Promise<T | null>, other: Promise<T | null>): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    let preferredDone = false;
    let otherDone = false;
    let otherVal: T | null = null;
    const done = (v: T | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    preferred.then((v) => {
      preferredDone = true;
      if (v) return done(v); // preferred is confident -> it wins (also wins a same-tick tie)
      if (otherDone) return done(otherVal); // preferred missed and other already settled -> use other
      // else: preferred missed, other still pending -> wait for other
    });
    other.then((v) => {
      otherDone = true;
      otherVal = v;
      if (v) return done(v); // other confident -> wins whether preferred is pending OR already-missed
      if (preferredDone) return done(null); // both settled non-confident
      // else: other missed, preferred still pending -> wait for preferred
    });
  });
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
  // SUGGESTION, not a Verified win. We hold it here so it can NEVER beat a slower CONFIRMED barcode-DB hit
  // in the race, yet still beats the brand-only floor on a genuine double-miss (verified:false downstream).
  let groundingSuggestion: ParallelResolveResult | null = null;

  const barcodeLeg: Promise<ParallelResolveResult | null> = safe(async () => {
    const r = await deps.lookupBarcodeDb(code);
    if (r?.sourceUrl) bestUrl = r.sourceUrl;
    if (r && isUsable(r.name)) {
      return { name: cleanProductName(r.name), brand: r.brand, verified: true, aiCalled: false, source: "barcode_db" };
    }
    return null;
  });

  const groundingLeg: Promise<ParallelResolveResult | null> = safe(async () => {
    const r = await deps.groundIdentify(code);
    // A refusal sentence or non-usable text is not a product identity at all -> the leg misses.
    if (!r || !isUsable(r.text) || isRefusal(r.text)) return null;
    const result: ParallelResolveResult = { name: cleanProductName(r.text), brand: "", verified: true, aiCalled: true, source: "grounding" };
    if (codeInSources(code, r.sources ?? [])) return result; // exact code in sources -> Verified win
    // Code NOT in sources: demote to an unverified suggestion. Return null for the RACE (so a confirmed
    // barcode-DB hit still wins) but remember it as the double-miss fallback.
    groundingSuggestion = { ...result, verified: false };
    return null;
  });

  const winner = await firstConfident(barcodeLeg, groundingLeg);
  if (winner) return winner;

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

  // PREFIX FLOOR (Plan C): never fail to decode a public barcode - name the brand, leave the product
  // explicitly unconfirmed (NOT verified). Non-public codes have no floor -> null -> caller falls through.
  const floor = deps.prefixFloor(code);
  if (floor) return { name: floor.name, brand: floor.brand, verified: false, aiCalled: false, source: "floor" };

  return null;
}
