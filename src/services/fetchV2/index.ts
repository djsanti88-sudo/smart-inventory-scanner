// Fetch V2 entry point - the isolated barcode evidence engine.
// Order: classify -> normalize -> cache -> structured sources -> discovery -> page evidence -> outcome.
// All network is injected (FetchImpl DI pattern); this module never touches globalThis.fetch itself.
// Count-first contract: EVERY path returns a result whose countBehavior persists + increments.
import { htmlToText } from "@/services/ai/pageFetch";
import { classifyIdentifier } from "./classify";
import { normalizeVariants } from "./normalize";
import { cleanBrand, evaluatePageJunk, usableIdentityName } from "./pageEvidence/junkRules";
import { extractProducts, type ExtractedProduct } from "./pageEvidence/extract";
import { proveAssociation } from "./pageEvidence/association";
import { snippetFindings } from "./pageEvidence/snippetEvidence";
import { scoreSource, decideOutcome, type SourceFinding } from "./scoring";
import { makeResult, type FetchV2Mode, type FetchV2Result } from "./types";
import type { DiscoveryProvider, DiscoveryCandidate } from "./sources/discovery";
import type { FetchV2Cache } from "./cache";
import { urlPreferenceScore } from "@/services/ai/firecrawlProvider";

export interface FetchedPage {
  ok: boolean;
  status: number;
  html: string;
}

export interface StructuredHit {
  url: string;
  name: string;
  brand: string;
  matchedBarcode: string;
  quality: "strong" | "medium" | "weak";
}

export interface FetchV2Deps {
  fetchPage: (url: string) => Promise<FetchedPage>;
  discovery: DiscoveryProvider[];
  structured?: Array<{ name: string; lookup: (variants: string[]) => Promise<StructuredHit | null> }>;
  cache?: FetchV2Cache;
  now?: () => number;
  /** Optional FREE door: predictable barcode-DB product URLs (V1 selectBarcodeUrls), fetched
   *  before any paid search. Max 2 are used. */
  patternUrls?: (variants: string[]) => string[];
}

export interface FetchV2Options {
  mode?: FetchV2Mode;
  maxSourcesPerCode?: number;
  maxTotalMs?: number;
}

// These shapes are counted but never chased around the web (spec: no endless product lookup).
const UNSUPPORTED_TYPES = new Set(["url", "raw_text", "unknown", "fnsku_like"]);

// Identity-name firewall + brand cleaning are shared with the snippet tier (junkRules.ts).

function codeInSnippet(cand: DiscoveryCandidate, variants: string[]): boolean {
  const hay = `${cand.title} ${cand.snippet}`.replace(/[\s-]/g, "");
  return variants.some((v) => /^\d{8,}$/.test(v) && hay.includes(v));
}

export async function fetchV2(raw: string, deps: FetchV2Deps, opts: FetchV2Options = {}): Promise<FetchV2Result> {
  const now = deps.now ?? Date.now;
  const started = now();
  const mode: FetchV2Mode = opts.mode ?? "balanced";
  const maxSources = opts.maxSourcesPerCode ?? 4;
  const maxTotalMs = opts.maxTotalMs ?? 20_000;
  const timeLeft = () => maxTotalMs - (now() - started);

  const identifier = classifyIdentifier(raw);
  const normalized = normalizeVariants(raw, identifier.type);
  const rulesFired: string[] = [];
  const sourcesChecked: string[] = [];
  let earlyStopped = false;

  const finish = (partial: Partial<FetchV2Result>): FetchV2Result =>
    makeResult({
      rawValue: raw,
      identifier,
      normalizedValues: normalized,
      sourcesChecked,
      ...partial,
      performance: {
        durationMs: now() - started,
        sourceCount: sourcesChecked.length,
        earlyStopped,
        cacheHit: false,
        ...partial.performance,
      },
      debug: { mode, rulesFired: [...rulesFired, ...(partial.debug?.rulesFired ?? [])], notes: partial.debug?.notes ?? [] },
    });

  // 1) Non-searchable shapes: counted under their grouping key, no web work at all.
  if (UNSUPPORTED_TYPES.has(identifier.type)) {
    rulesFired.push(`identifier type "${identifier.type}" is counted but not product-decoded`);
    return finish({ outcome: "unsupported" });
  }

  // 1b) Ultra-short vendor codes are too ambiguous for the open web ("3330" matched a linemen's
  // test set): counted, but identity goes straight to the next ladder step. No search is spent.
  if (identifier.type === "vendor_sku" && normalized.primary.length <= 4) {
    rulesFired.push("vendor code of 4 chars or less: too ambiguous for web identity, deferred to next ladder step");
    return finish({ outcome: "unknown" });
  }

  // 2) Verified-result cache: same code never re-crawls the web.
  const cached = deps.cache?.getVerified(normalized.primary);
  if (cached) {
    return { ...cached, performance: { ...cached.performance, cacheHit: true, durationMs: now() - started } };
  }

  // 2b) No-result receipt: the code was fully probed before and every door was empty. Owner rule:
  // never auto-retry - the ladder handles the residue. Still counted (count-first contract).
  const receipt = deps.cache?.getNoResult(normalized.primary);
  if (receipt) {
    rulesFired.push(`no-result receipt on file (${receipt}) - owner: no auto-retry, ladder handles it`);
    return finish({ outcome: "unknown" });
  }

  const findings: SourceFinding[] = [];

  // 3) Structured/free sources first (Open Food Facts, barcode DB APIs...). Keyed-by-barcode
  // APIs are inherently code-tied, so a hit arrives with strong association at its own quality.
  for (const src of deps.structured ?? []) {
    if (timeLeft() <= 0) { earlyStopped = true; break; }
    try {
      const hit = await src.lookup(normalized.all);
      sourcesChecked.push(`structured:${src.name}`);
      if (hit && !usableIdentityName(hit.name, normalized.primary)) {
        rulesFired.push(`structured ${src.name} hit dropped: junk-shaped name "${hit.name.slice(0, 40)}"`);
      } else if (hit) {
        const product: ExtractedProduct = { source: "json_ld", name: hit.name, brand: hit.brand, gtins: [hit.matchedBarcode.replace(/\D/g, "")], sku: "", description: "", imageUrl: "" };
        findings.push({
          url: hit.url,
          association: { level: "strong", matchedVariant: hit.matchedBarcode, matchedField: `structured.${src.name}`, product },
          product,
          junkRejected: false,
          junkReasons: [],
          quality: hit.quality,
          score: hit.quality === "strong" ? 85 : hit.quality === "medium" ? 55 : 30,
        });
      }
    } catch {
      rulesFired.push(`structured source ${src.name} failed (contained)`);
    }
  }

  // 4) Discovery (candidate URLs only) -> prioritized page fetches with junk gate + association proof.
  const needsDiscovery = !findings.some((f) => f.quality === "strong" && f.association.level === "strong");
  if (needsDiscovery && deps.discovery.length > 0) {
    let candidates: DiscoveryCandidate[] = [];
    let exactMatchCandidates: DiscoveryCandidate[] = [];

    const junkUrls = new Set<string>();
    const processPage = async (cand: DiscoveryCandidate): Promise<SourceFinding | null> => {
      let page: FetchedPage;
      try {
        page = await deps.fetchPage(cand.url);
      } catch {
        deps.cache?.markBadUrl(cand.url, "fetch failed");
        return null;
      }
      sourcesChecked.push(cand.url);
      if (!page.ok) {
        deps.cache?.markBadUrl(cand.url, `http ${page.status}`);
        return null;
      }
      const title = page.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? cand.title;
      const text = htmlToText(page.html);
      const junk = evaluatePageJunk({ url: cand.url, title, text }, normalized.primary);
      if (junk.rejected) {
        if (junk.reasons.some((r) => /search|echo|no-result|not-found|invalidat|recycled|only in the url/i.test(r))) {
          junkUrls.add(cand.url);
        }
        deps.cache?.markBadUrl(cand.url, junk.reasons[0] ?? "junk page");
        const f: SourceFinding = { url: cand.url, association: { level: "none", matchedVariant: "", matchedField: "", product: null }, product: null, junkRejected: true, junkReasons: junk.reasons, quality: "rejected", score: 0 };
        findings.push(f);
        return f;
      }
      const products = extractProducts(page.html).map((p) => ({
        ...p,
        name: usableIdentityName(p.name, normalized.primary) ? p.name : "",
        brand: cleanBrand(p.brand),
      }));
      const association = proveAssociation(normalized.all, products, text, cand.url);
      if (association.level === "none" && products.length === 0) {
        deps.cache?.markBadUrl(cand.url, "no code evidence and no product structure");
      }
      const { quality, score } = scoreSource(cand.url, association, false);
      const f: SourceFinding = { url: cand.url, association, product: association.product, junkRejected: false, junkReasons: [], quality, score };
      findings.push(f);
      return f;
    };

    // FREE pattern-URL door (owner: one good website is enough): predictable barcode-DB product
    // pages, direct-fetched before any paid search. Identity secured here = zero credits spent.
    if (deps.patternUrls && identifier.isPublicBarcode) {
      for (const url of deps.patternUrls(normalized.all).slice(0, 2)) {
        if (timeLeft() <= 0) { earlyStopped = true; break; }
        const f = await processPage({ url, title: "", snippet: "", rank: -1 });
        if (f && !f.junkRejected && f.association.level === "strong" && (f.product?.name ?? "").trim()) {
          rulesFired.push(
            f.quality === "strong"
              ? "free pattern-URL door secured a STRONG identity - entire provider loop skipped"
              : "free pattern-URL door secured the identity - paid search skipped (free corroboration may still run)",
          );
          break;
        }
      }
    }
    // Economic rule: a STRONG-quality identity skips the ENTIRE provider loop - nothing left to
    // prove. Any held identity (even medium, e.g. a single structured/pattern hit) still lets the
    // FREE provider (index 0) run once for corroboration, but PAID escalation providers (i > 0)
    // never run - we never pay to search for something we already hold.
    const heldIdentity = () =>
      findings.some((f) => !f.junkRejected && f.association.level === "strong" && (f.product?.name ?? "").trim());
    const strongSecured = () =>
      findings.some(
        (f) => !f.junkRejected && f.association.level === "strong" && f.quality === "strong" && (f.product?.name ?? "").trim(),
      );

    for (let i = 0; !strongSecured() && i < deps.discovery.length; i++) {
      const provider = deps.discovery[i];
      // Searches are cheap and fast; page fetches are what actually eat the clock. The quoted
      // escalation ALWAYS gets one shot - the time budget must never starve the step most likely
      // to solve a hard code (live bug: Brave slowness consumed 25s and Firecrawl never ran).
      if (i === 0 && timeLeft() <= 0) { earlyStopped = true; break; }
      // Never PAY to find what we already hold: once ANY identity is secured, only the FREE
      // provider (index 0) may still run for corroboration - every paid escalation stops here.
      if (i > 0 && heldIdentity()) break;
      // Escalation providers get the QUOTED exact-match query (the owner's "comillas" move) -
      // used only when earlier providers produced no candidate that carries the code. Their
      // results matched the code BY CONTRACT even when snippets hide it (canary-proven).
      const query = i === 0 ? normalized.primary : `"${normalized.primary}"`;
      const got = await provider.search(query);
      sourcesChecked.push(`discovery:${provider.name}`);
      const fresh = got.filter((g) => !candidates.some((c) => c.url === g.url));
      candidates = [...candidates, ...fresh];
      if (i > 0) exactMatchCandidates = [...exactMatchCandidates, ...fresh];
      if (snippetFindings(candidates, normalized.all, normalized.primary).some((s) => s.name)) break; // identity-carrying evidence only: nameless junk must not stop the escalation
      // Quoted found nothing? One UNQUOTED shot on the same escalation provider - Google-style
      // ranking often knows the code even when exact-string indexing misses it (forensic: Toyo
      // Eclipse). These results get NO exact-match assumption: visible code in snippet only.
      if (i > 0 && got.length === 0) {
        const loose = await provider.search(normalized.primary);
        sourcesChecked.push(`discovery:${provider.name}:unquoted`);
        candidates = [...candidates, ...loose.filter((g) => !candidates.some((c) => c.url === g.url))];
        if (snippetFindings(candidates, normalized.all, normalized.primary).some((s) => s.name)) break; // identity-carrying evidence only: nameless junk must not stop the escalation
        // Search backends return DIFFERENT results for the same quoted query minutes apart
        // (live: the Continental found in one run, empty the next). One bounded retry - this is
        // the 5th and final search of the code (2 Brave + quoted + unquoted + this).
        const again = await provider.search(query);
        sourcesChecked.push(`discovery:${provider.name}:quoted-retry`);
        const freshAgain = again.filter((g) => !candidates.some((c) => c.url === g.url));
        candidates = [...candidates, ...freshAgain];
        exactMatchCandidates = [...exactMatchCandidates, ...freshAgain];
        if (snippetFindings(candidates, normalized.all, normalized.primary).some((s) => s.name)) break; // identity-carrying evidence only: nameless junk must not stop the escalation
      }
    }

    const prioritized = candidates
      .filter((c) => !deps.cache?.isBadUrl(c.url))
      .map((c) => ({ c, snip: codeInSnippet(c, normalized.all) ? 1 : 0 }))
      .sort((a, b) => b.snip - a.snip || urlPreferenceScore(b.c.url) - urlPreferenceScore(a.c.url) || a.c.rank - b.c.rank)
      .map((x) => x.c)
      .slice(0, maxSources);

    for (const cand of prioritized) {
      if (timeLeft() <= 0) { earlyStopped = true; break; }
      const f = await processPage(cand);
      // Early win: a verification-grade finding ends the crawl (fast/balanced).
      if (f && mode !== "strict" && f.association.level === "strong" && f.quality === "strong") {
        earlyStopped = true;
        break;
      }
    }

    // Search-index evidence: ALL candidates (fetched or not) whose title/snippet carry the exact
    // code become snippet findings - the mapping often lives only in merchant-feed snippets.
    // Snippet evidence dies ONLY on ACTIVE junk (echo/no-result/invalidating pages) - a URL marked
    // bad because its page was unreachable/bot-blocked is still valid merchant-feed evidence
    // (forensic root cause: eBay 403s suppressed the exact listings that carry tire barcodes).
    const ACTIVE_JUNK_RE = /search|echo|no-result|not-found|invalidat|recycled|only in the url|junk/i;
    const liveCand = (list: DiscoveryCandidate[]) =>
      list.filter((c) => !junkUrls.has(c.url) && !(deps.cache && ACTIVE_JUNK_RE.test(deps.cache.badUrlReason(c.url))));
    const snips = [
      ...snippetFindings(liveCand(candidates), normalized.all, normalized.primary),
      ...snippetFindings(liveCand(exactMatchCandidates), normalized.all, normalized.primary, { assumeCarrying: true }),
    ].filter((s, i, arr) => arr.findIndex((x) => x.url === s.url) === i);
    for (const s of snips) {
      const product: ExtractedProduct | null = s.name
        ? { source: "og_title", name: s.name, brand: cleanBrand(""), gtins: [], sku: "", description: "", imageUrl: "" }
        : null;
      findings.push({
        url: s.url,
        association: { level: "weak", matchedVariant: s.matchedVariant, matchedField: "search_snippets", product },
        product,
        junkRejected: false,
        junkReasons: [],
        quality: "weak",
        score: 20,
        labeled: s.labeled,
      });
    }
  }

  // 5) Decide, fill evidence, cache.
  const decision = decideOutcome(identifier, findings, mode);
  rulesFired.push(...decision.rulesFired);
  const w = decision.winner;
  const p = w?.product;
  const result = finish({
    outcome: decision.outcome,
    product: p ? { brand: p.brand, name: p.name, model: "", partNumber: p.sku, size: "", description: p.description, category: "", imageUrl: p.imageUrl } : undefined,
    evidence: {
      exactCodeFound: findings.some((f) => f.association.level !== "none"),
      codeToProductProven: w?.association.level === "strong",
      sourceQuality: w ? w.quality : "none",
      sourceScore: w?.score ?? 0,
      identityScore: p?.name ? 1 : 0,
      associationScore: w?.association.level === "strong" ? 1 : w?.association.level === "weak" ? 0.4 : 0,
      finalConfidence: decision.confidence,
      winningSourceUrl: w?.url ?? "",
      winningSourceType: w ? (w.association.matchedField.startsWith("structured") ? "structured_api" : "web_page") : "",
      codeLocation: w?.association.matchedField ?? "",
      proofSummary: decision.rulesFired.join("; "),
    },
    conflicts: decision.conflicts,
  });

  if (result.outcome === "verified") deps.cache?.saveVerified(normalized.primary, result);
  // Write a PERMANENT receipt only for a COMPLETE empty probe: discovery actually ran, the time
  // budget did not truncate it, and no identity or evidence of any kind was found.
  if (
    result.outcome === "unknown" &&
    !earlyStopped &&
    deps.discovery.length > 0 &&
    findings.every((f) => f.junkRejected || !(f.product?.name ?? "").trim())
  ) {
    deps.cache?.markNoResult(normalized.primary, `probed ${new Date().toISOString().slice(0, 10)}: all doors empty`);
  }
  return result;
}
