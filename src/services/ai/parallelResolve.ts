// Plan D Task 4 - identification resolver (the heart of the grounding ladder), CROSS-CHECK auto-count.
//
// OWNER DECISION (2026-07-01, SUPERSEDES the single-source "trust UPCitemdb" order): a 21-code regression of
// historically-problematic barcodes proved single-source trust auto-counts ~40% WRONG on hard codes -
// UPCitemdb returned a WOMEN'S DRESS for Member's Mark water and MOTT'S for Cheerios; lone grounding returned
// OREO for Pico de Gallo and DORITOS for Lay's. Wrong identity is FAILURE, so a lone source may NEVER
// auto-count. The rule is now CROSS-CHECK:
//
//   1. Query TWO INDEPENDENT sources CONCURRENTLY: the free structured barcode-DB (UPCitemdb) and one free
//      Gemini 2.5 grounding call. Each candidate must be a usable, non-refusal product name; the barcode-DB
//      brand must also pass the GS1 brand-prefix firewall (prefixBrandConflict).
//   2. AUTO-COUNT (Verified) ONLY when the two names AGREE on identity (>=2 shared distinctive tokens -
//      typically brand + product/flavor). A lone wrong DB row and a lone grounding hallucination can't clear
//      this because the other source disagrees or is absent.
//   3. NO agreement (single source, or they differ) -> the best available name is a SUGGESTION shown for
//      one-tap human approval in Needs Review, NEVER auto-counted.
//   4. Neither source named it -> Firecrawl escalation (Suggestion), then the Plan C prefix floor, then the
//      Fix 4 generic terminal floor. NEVER a hallucinated product; NEVER null for a public code.
//
// Cost/speed: 1 free UPCitemdb lookup + 1 free Gemini 2.5 grounding call (1,500/day free), run concurrently
// (~1.5s wall), every win cached upstream (resolved once per code, ever). A 429 / rate-cap / error on either
// leg falls back GRACEFULLY (the safe() wrapper turns a throw into a clean null - never crash, never guess).
//
// All external work is injected via `deps` so tests mock every provider - ZERO live spend / fetch in tests.

import { isUsableProductName, cleanProductName } from "@/services/ai/decode";
import { prefixBrandConflict } from "@/services/catalog/brandPrefixGeneral";

export type ResolveSource = "barcode_db" | "grounding" | "firecrawl" | "floor";

export interface ParallelResolveResult {
  name: string;
  brand: string;
  /** Verified = safe to auto-count. ONLY a cross-checked (two-source agreement) win is verified. */
  verified: boolean;
  /** Whether a grounding/AI call was consulted for this resolution (true for every new public code now). */
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
  /** Fetchable grounding chunk URLs (web.uri) - kept for the Firecrawl escalation candidate URL. */
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
  /** Fast grounded identify (gemini-2.5-flash-lite). `url` switches google_search -> url_context. Null on miss. */
  groundIdentify: (code: string, opts?: { url?: string }) => Promise<GroundingLegResult | null>;
  /** 1-credit cheap Firecrawl scrape of ONE known URL (last-ditch name when no source named it). Null when unavailable. */
  firecrawlScrapeCheap: (url: string) => Promise<FirecrawlLegResult | null>;
  /** Firecrawl /search identity source: barcode-CONFIRMED product names from real result snippets. The
   *  reliable, credit-paid cross-check TIEBREAKER, called ONLY when the two free sources don't already
   *  agree. Returns [] when nothing carried the code; null when Firecrawl keys are exhausted (degrade
   *  gracefully to the free signals). Each entry is an independent real-page source for the consensus vote. */
  searchIdentify?: (code: string) => Promise<{ name: string; url: string }[] | null>;
  /** Plan C prefix floor: brand-only naming aid for an unresolved public barcode. Null for non-public codes. */
  prefixFloor: (code: string) => FloorLegResult | null;
  /** Optional premium grounding escalation (stronger model) - kept for back-compat; a lone source, so it can
   *  only ever produce a Suggestion under the cross-check rule. */
  groundIdentifyPremium?: (code: string, opts?: { url?: string }) => Promise<GroundingLegResult | null>;
  /** Injectable "is this a real product name" check (defaults to the shared isUsableProductName). */
  isUsable?: (name: string) => boolean;
  /** Injectable GS1 brand-prefix firewall: true when the barcode-DB brand clearly conflicts with the code's
   *  known single-brand prefix (the wrong-identity guard). Defaults to the real prefixBrandConflict. A
   *  conflicted barcode-DB brand is dropped from cross-check (cannot agree, cannot auto-count). */
  brandPrefixConflict?: (code: string, brand: string) => boolean;
  /** Deprecated: fetch-verify is no longer used to decide truth (a lone fetch-verify was fooled by
   *  multi-product distributor pages). Kept optional so existing callers/tests still type-check. */
  verifyCodeOnPage?: (urls: string[], code: string) => Promise<{ url: string; pageText: string } | null>;
}

// A grounding TEXT that is a refusal sentence ("unable to identify", "couldn't find", "not found",
// "no product", ...) is an answer SHAPE, never a product identity. Reject it so the leg misses.
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

// Generic product words that are NOT distinctive identity - two names sharing only these ("Potato Chips" in
// both a Lay's and a Doritos name) must NOT count as agreement. Agreement needs shared BRAND/flavor tokens.
// Also includes DATA-SITE / metadata noise (open food facts, amazon, smartlabel, nutrition, upc, ...) so two
// different products that both come from the same source site can't falsely "agree" on the site name.
const GENERIC_TOKENS = new Set([
  "chips", "chip", "crisps", "water", "cookies", "cookie", "soup", "snack", "snacks", "pack", "family",
  "size", "cereal", "bars", "bar", "mix", "drink", "tortilla", "potato", "classic", "original", "flavor",
  "flavored", "flavour", "count", "pouch", "bottle", "can", "cans", "box", "bag", "fine", "piece", "set",
  "the", "and", "with", "for", "oz", "ounce", "ounces",
  // data-site / metadata noise (from Firecrawl search snippet titles)
  "open", "food", "facts", "amazon", "walmart", "smartlabel", "nutrition", "ewg", "score", "scores",
  "wireshape", "data", "halal", "com", "org", "net", "ingredients", "upc", "ean", "gtin", "sku",
  "barcode", "item", "model", "product", "products", "listing", "shop", "store", "buy", "price",
]);

/** Distinctive (non-generic, >=3 char) tokens of a product name - the identity signal used for agreement. */
function significantTokens(name: string): string[] {
  return cleanProductName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t));
}

/** Two INDEPENDENT product names AGREE when they share >=2 distinctive tokens (typically brand + a product
 *  or flavor word). Agreement between two sources is the cross-check gate that makes an auto-count trustworthy:
 *  a lone wrong DB row or a lone grounding hallucination cannot clear it, because the other source disagrees
 *  or is absent. Deliberately strict - we prefer Needs Review over a wrong auto-count. */
export function identitiesAgree(a: string, b: string): boolean {
  const ta = new Set(significantTokens(a));
  const tb = new Set(significantTokens(b));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared >= 2;
}

/** One candidate identity and which source vouched for it (each is one vote in the consensus). */
interface Candidate {
  name: string;
  brand: string;
  source: ResolveSource;
}

/** CONSENSUS: return the identity that >=2 sources AGREE on, else null. This is the auto-count gate - a
 *  lone wrong UPCitemdb row, a lone grounding hallucination, or a single stray snippet can never clear it.
 *  When an agreeing cluster includes the structured barcode-DB row, that row's name/brand is returned (it is
 *  the cleanest identity); otherwise the first agreeing member. Candidates are checked barcode_db-first. */
function findConsensus(pool: Candidate[]): Candidate | null {
  for (let i = 0; i < pool.length; i++) {
    const cluster = pool.filter((p, j) => j === i || identitiesAgree(pool[i].name, p.name));
    if (cluster.length >= 2) {
      return cluster.find((p) => p.source === "barcode_db") ?? cluster[0];
    }
  }
  return null;
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
  const brandConflict = deps.brandPrefixConflict ?? prefixBrandConflict;

  // A candidate URL (barcode-DB offer link or a grounding chunk) so a double-miss can escalate to Firecrawl.
  let bestUrl = "";

  // 1. Query the TWO INDEPENDENT sources CONCURRENTLY (barcode-DB free; grounding free on Gemini 2.5).
  const [bd, gr] = await Promise.all([
    safe(() => deps.lookupBarcodeDb(code)),
    safe(() => deps.groundIdentify(code)),
  ]);
  if (bd?.sourceUrl) bestUrl = bd.sourceUrl;

  // Usable, firewall-passed candidate name from each source (empty string = that source did not name it).
  const bdName =
    bd && isUsable(bd.name) && !brandConflict(code, bd.brand) ? cleanProductName(bd.name) : "";
  const grUsable = !!gr && isUsable(gr.text) && !isRefusal(gr.text);
  const grName = grUsable ? cleanProductName(gr.text) : "";
  if (gr) {
    const u = gr.sourceUrls ?? [];
    if (u[0] && !bestUrl) bestUrl = u[0];
  }

  // 2. FAST FREE PATH: the two free sources already AGREE -> auto-count, spend ZERO Firecrawl credits.
  if (bdName && grName && identitiesAgree(bdName, grName)) {
    return { name: bdName, brand: bd!.brand, verified: true, aiCalled: true, source: "barcode_db" };
  }

  // 3. FIRECRAWL /search TIEBREAKER (prepaid credits) - called ONLY because the two free sources did not
  //    agree. It returns barcode-CONFIRMED identities from real result snippets (deterministic, no
  //    hallucination). null = keys exhausted (degrade to the free signals); [] = searched, nothing carried
  //    the code. Each hit is an independent real-page vote in the consensus below.
  const searchHits = deps.searchIdentify ? await safe(() => deps.searchIdentify!(code)) : null;
  if (searchHits && searchHits[0]?.url && !bestUrl) bestUrl = searchHits[0].url;

  // 4. CONSENSUS: pool every source (UPCitemdb + grounding + each barcode-confirmed snippet) and AUTO-COUNT
  //    the identity that >=2 of them agree on. A lone wrong DB row / lone grounding hallucination / single
  //    stray snippet can never clear this - two independent sources must name the same product.
  const pool: Candidate[] = [];
  if (bdName) pool.push({ name: bdName, brand: bd!.brand, source: "barcode_db" });
  if (grName) pool.push({ name: grName, brand: "", source: "grounding" });
  for (const h of searchHits ?? []) {
    const n = cleanProductName(h.name);
    if (isUsable(n) && !isRefusal(n)) pool.push({ name: n, brand: "", source: "firecrawl" });
  }
  const consensus = findConsensus(pool);
  if (consensus) return { ...consensus, verified: true, aiCalled: true };

  // 5. No consensus -> the best available name is a SUGGESTION (Needs Review), NEVER auto-counted. Prefer a
  //    barcode-confirmed Firecrawl snippet (real page), then the structured barcode-DB name, then grounding.
  const best =
    pool.find((p) => p.source === "firecrawl") ??
    pool.find((p) => p.source === "barcode_db") ??
    pool[0];
  if (best) return { ...best, verified: false, aiCalled: true };

  // 6. LAST-DITCH: no source named it, but a candidate URL exists -> scrape it cheaply for a name (Suggestion
  //    only - a lone scraped page is a single source). Junk/error titles are rejected by isUsableProductName.
  if (bestUrl) {
    const fc = await safe(() => deps.firecrawlScrapeCheap(bestUrl));
    if (fc) {
      const name = bestNameFromPage(fc.title, fc.markdown, isUsable);
      if (name && !isRefusal(name)) {
        return { name, brand: "", verified: false, aiCalled: true, source: "firecrawl" };
      }
    }
  }

  // 7. Optional premium grounding escalation - a lone source, so a SUGGESTION only (never auto-count).
  if (deps.groundIdentifyPremium) {
    const g = await safe(() => deps.groundIdentifyPremium!(code, bestUrl ? { url: bestUrl } : undefined));
    if (g && isUsable(g.text) && !isRefusal(g.text)) {
      return { name: cleanProductName(g.text), brand: "", verified: false, aiCalled: true, source: "grounding" };
    }
  }

  // 6. PREFIX FLOOR (Plan C): name the brand from the GS1 prefix, product explicitly unconfirmed (NOT verified).
  const floor = deps.prefixFloor(code);
  if (floor) return { name: floor.name, brand: floor.brand, verified: false, aiCalled: false, source: "floor" };

  // FIX 4: the caller only invokes this for a PUBLIC barcode, so we must ALWAYS be terminal here and NEVER
  // return null (a null fall-through reaches the expensive, hallucination-prone legacy path). When the prefix
  // maps to no brand, return a GENERIC unidentified floor: counted as Needs Review, NEVER Verified, no AI.
  return { name: `Unidentified item (barcode ${code})`, brand: "", verified: false, aiCalled: false, source: "floor" };
}
