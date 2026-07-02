// @vitest-environment node
//
// Plan D Task 4 - BARCODE-DB-FIRST + FETCH-VERIFY resolver. Proves: (1) one FREE UPCitemdb lookup is the
// accurate primary; a usable hit is Verified ONLY when the APP fetches its sourceUrl page and confirms the
// exact code is on it AND a distinctive token of the name corroborates that page; (2) an unconfirmed name is
// a held Suggestion, never auto-counted; (3) a stale/wrong DB row whose name is not on the code's page is
// rejected by the name-corroboration guard; (4) grounding fires ONLY as a fallback when barcode-DB gives
// nothing usable, obeys the same fetch-verify gate, and a grounding refusal / 429 still ends at the terminal
// floor - NEVER null, NEVER a legacy fall-through. ALL providers + fetch-verify are mocked here - ZERO live
// network / AI / credits are ever touched by this suite.
//
// RECONCILED (2026-07-01, owner decision): barcode-DB now runs FIRST (bake-off: 6/6 correct, free, ~1s; the
// "coconut oil for glycine" bug was Open Food Facts, NOT UPCitemdb). Grounding is the paid, rate-capped
// FALLBACK. Every trust / hallucination / count / refusal (Fix 1) / terminal-floor (Fix 4) assertion is
// preserved, only re-pointed at the new order.

import { describe, it, expect, vi } from "vitest";
import {
  resolveUnknownFast,
  type ParallelResolveDeps,
} from "@/services/ai/parallelResolve";

const CODE = "086699087829";

/** A deferred promise whose resolution we control - lets us prove a slow leg never delays the winner. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Base deps: every leg misses; fetch-verify finds nothing. Individual tests override the legs they exercise. */
function baseDeps(over: Partial<ParallelResolveDeps> = {}): ParallelResolveDeps {
  return {
    lookupBarcodeDb: vi.fn(async () => null),
    groundIdentify: vi.fn(async () => null),
    verifyCodeOnPage: vi.fn(async () => null),
    firecrawlScrapeCheap: vi.fn(async () => null),
    prefixFloor: vi.fn(() => null),
    ...over,
  };
}

/** A fetch-verify mock that "confirms" the code and hands back the given page text. */
function verifyHit(pageText: string) {
  return vi.fn(async (urls: string[]) => ({ url: urls[0] ?? "https://page.example/p", pageText }));
}

describe("resolveUnknownFast - barcode-DB first, fetch-verify, grounding fallback", () => {
  it("(bd1) barcode-DB usable + no brand-prefix conflict -> AUTO-COUNT (Verified barcode_db, aiCalled false); grounding + fetch-verify never run", async () => {
    const bdbMock = vi.fn(async () => ({
      name: "Michelin LTX M/S2 All-Season",
      brand: "Michelin",
      sourceUrl: "https://shop.example/p/1",
    }));
    const verifyMock = vi.fn(async () => null);
    const groundMock = vi.fn(async () => ({ text: "Should Not Run", grounded: true, sources: [], sourceUrls: ["https://x/y"] }));
    // firewall says NO conflict -> the trusted structured hit auto-counts.
    const conflictMock = vi.fn(() => false);
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, verifyCodeOnPage: verifyMock, groundIdentify: groundMock, brandPrefixConflict: conflictMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.source).toBe("barcode_db");
    expect(r?.verified).toBe(true); // TRUSTED structured DB auto-counts (owner decision)
    expect(r?.aiCalled).toBe(false);
    expect(r?.brand).toBe("Michelin");
    expect(r?.name).toMatch(/Michelin LTX/);
    expect(bdbMock).toHaveBeenCalledTimes(1);
    expect(conflictMock).toHaveBeenCalledWith(CODE, "Michelin");
    expect(verifyMock).not.toHaveBeenCalled(); // no fetch-verify for the structured DB (fast, $0)
    expect(groundMock).not.toHaveBeenCalled(); // barcode-DB won -> the paid grounding fallback never runs
  });

  it("(bd2) barcode-DB usable but the GS1 brand-prefix firewall flags a wrong-brand conflict -> held Suggestion (verified false); grounding + floor never run", async () => {
    // The DB says "Coconut Oil"/"Generic" but the barcode's known prefix belongs to Life Extension -> conflict.
    const bdbMock = vi.fn(async () => ({ name: "Coconut Oil", brand: "Generic Foods", sourceUrl: "https://shop.example/p/1" }));
    const conflictMock = vi.fn(() => true); // firewall: brand clearly wrong for this barcode's prefix
    const groundMock = vi.fn(async () => ({ text: "Grounding Name", grounded: true, sources: [], sourceUrls: ["https://g/x"] }));
    const floorMock = vi.fn(() => ({ name: "Acme / product unconfirmed", brand: "Acme" }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, brandPrefixConflict: conflictMock, groundIdentify: groundMock, prefixFloor: floorMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.source).toBe("barcode_db");
    expect(r?.verified).toBe(false); // wrong-brand-for-prefix -> Suggested, NEVER auto-counted (coconut-oil guard)
    expect(r?.aiCalled).toBe(false);
    expect(r?.name).toMatch(/Coconut Oil/);
    expect(groundMock).not.toHaveBeenCalled(); // a usable (if conflicted) barcode-DB name short-circuits the fallback
    expect(floorMock).not.toHaveBeenCalled(); // a named suggestion beats the brand-only floor
  });

  it("(bd3) firewall lets an unknown-prefix / unbranded hit pass (real default returns false) -> Verified", async () => {
    // Uses the REAL prefixBrandConflict (not injected): an empty brand never conflicts, so a usable name auto-counts.
    const bdbMock = vi.fn(async () => ({ name: "Life Extension Glycine 1000mg", brand: "", sourceUrl: "https://x/y" }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock });

    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("barcode_db");
    expect(r?.verified).toBe(true);
    expect(r?.name).toMatch(/Glycine/);
  });

  it("(gr1) barcode-DB null (miss) -> grounding fallback; a fetched page confirms the code + name -> Verified grounding, aiCalled true", async () => {
    const bdbMock = vi.fn(async () => null); // barcode-DB miss
    const groundMock = vi.fn(async () => ({
      text: "Sony WH-1000XM5 Wireless Headphones",
      grounded: true,
      sources: [],
      sourceUrls: ["https://vertexaisearch.cloud.google.com/redirect/a", "https://sony.example/p"],
    }));
    const verifyMock = verifyHit(`Sony WH-1000XM5 Wireless Headphones product page - UPC ${CODE}`);
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock, verifyCodeOnPage: verifyMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(bdbMock).toHaveBeenCalledTimes(1);
    expect(groundMock).toHaveBeenCalledTimes(1); // fallback fires ONLY because barcode-DB gave nothing usable
    expect(r?.source).toBe("grounding");
    expect(r?.verified).toBe(true);
    expect(r?.aiCalled).toBe(true);
    expect(r?.name).toMatch(/Sony WH-1000XM5/);
    expect(verifyMock).toHaveBeenCalledWith(
      ["https://vertexaisearch.cloud.google.com/redirect/a", "https://sony.example/p"],
      CODE,
    );
  });

  it("(gr2) grounding fallback hit but NO fetched page carries the code -> Suggested grounding (verified false)", async () => {
    const groundMock = vi.fn(async () => ({
      text: "Nagoya Mosaic Clay Drop",
      grounded: true,
      sources: [],
      sourceUrls: ["https://x.example/redirect"],
    }));
    const verifyMock = vi.fn(async () => null); // code confirmed on NO page
    const floorMock = vi.fn(() => ({ name: "Acme / product unconfirmed", brand: "Acme" }));
    const deps = baseDeps({ groundIdentify: groundMock, verifyCodeOnPage: verifyMock, prefixFloor: floorMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.source).toBe("grounding");
    expect(r?.verified).toBe(false);
    expect(r?.aiCalled).toBe(true);
    expect(r?.name).toMatch(/Nagoya Mosaic/);
    expect(floorMock).not.toHaveBeenCalled(); // a named grounding suggestion beats the brand-only floor
  });

  it("(gr3) NAME-CORROBORATION guard on grounding too: code on page but hallucinated name -> Suggested, not Verified", async () => {
    const groundMock = vi.fn(async () => ({
      text: "Coconut Oil",
      grounded: true,
      sources: [],
      sourceUrls: ["https://vitamins.example/glycine"],
    }));
    const verifyMock = verifyHit(`Glycine 1000mg by Life Extension - UPC ${CODE} - amino acid supplement`);
    const deps = baseDeps({ groundIdentify: groundMock, verifyCodeOnPage: verifyMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.source).toBe("grounding");
    expect(r?.verified).toBe(false); // code on page, but the NAME does not corroborate -> held suggestion
    expect(r?.name).toMatch(/Coconut Oil/);
  });

  it("(r1) a refusal sentence from the grounding fallback is rejected BEFORE any fetch -> falls to the floor", async () => {
    const groundMock = vi.fn(async () => ({
      text: `Unable to identify the product associated with UPC ${CODE}.`,
      grounded: true,
      sources: [],
      sourceUrls: [`https://search.example/${CODE}`],
    }));
    const verifyMock = vi.fn(async () => ({ url: "x", pageText: `page with ${CODE}` }));
    const floorMock = vi.fn(() => ({ name: "Coca-Cola / product unconfirmed", brand: "Coca-Cola" }));
    const deps = baseDeps({ groundIdentify: groundMock, verifyCodeOnPage: verifyMock, prefixFloor: floorMock });

    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("floor");
    expect(r?.verified).toBe(false);
    expect(verifyMock).not.toHaveBeenCalled(); // a refusal never even reaches fetch-verify
  });

  it("(r2) a refusal phrase isRefusal catches (but isUsableProductName does not) -> floor, never a product", async () => {
    const groundMock = vi.fn(async () => ({
      text: `We couldn't find a product for ${CODE}`,
      grounded: true,
      sources: [],
      sourceUrls: [`https://search.example/${CODE}`],
    }));
    const floorMock = vi.fn(() => ({ name: "Pepsi / product unconfirmed", brand: "Pepsi" }));
    const deps = baseDeps({ groundIdentify: groundMock, prefixFloor: floorMock });

    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("floor");
    expect(r?.verified).toBe(false);
  });

  it("(429-floor) barcode-DB null + grounding null -> a public miss ends at the generic terminal floor (Fix 4: never null, never legacy)", async () => {
    const deps = baseDeps(); // barcode-DB null, grounding null, prefixFloor null (e.g. unassigned 999-prefix)
    const r = await resolveUnknownFast(CODE, deps);
    expect(r).not.toBeNull(); // null used to fall through to the legacy Gemini/OpenAI money-pit
    expect(r?.source).toBe("floor");
    expect(r?.verified).toBe(false);
    expect(r?.aiCalled).toBe(false);
    expect(r?.name).toMatch(/Unidentified item/);
    expect(r?.name).toContain(CODE);
  });

  it("(floor-brand) barcode-DB + grounding miss with a brand-only prefix floor -> Suggested floor (verified false)", async () => {
    const floorMock = vi.fn(() => ({ name: "Coca-Cola / product unconfirmed", brand: "Coca-Cola" }));
    const deps = baseDeps({ prefixFloor: floorMock });
    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("floor");
    expect(r?.name).toMatch(/Coca-Cola/);
    expect(r?.verified).toBe(false);
    expect(r?.aiCalled).toBe(false);
  });

  it("(fc) double miss with a barcode-DB offer URL (empty name); scrape CARRIES the code -> Verified firecrawl", async () => {
    const bdbMock = vi.fn(async () => ({ name: "", brand: "", sourceUrl: "https://shop.example.com/p/1" }));
    const groundMock = vi.fn(async () => null);
    const fcMock = vi.fn(async () => ({ title: "Stanley Quencher H2.0 Tumbler 40oz", markdown: `product page UPC ${CODE}` }));
    const floorMock = vi.fn(() => ({ name: "Should Not Be Used / product unconfirmed", brand: "Should Not" }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock, firecrawlScrapeCheap: fcMock, prefixFloor: floorMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(fcMock).toHaveBeenCalledTimes(1);
    expect(fcMock).toHaveBeenCalledWith("https://shop.example.com/p/1");
    expect(r?.source).toBe("firecrawl");
    expect(r?.name).toMatch(/Stanley Quencher/);
    expect(r?.verified).toBe(true); // the scrape carries the exact code -> trusted enough to auto-count
    expect(r?.aiCalled).toBe(true);
    expect(floorMock).not.toHaveBeenCalled();
  });

  it("(fc-nocode) firecrawl scrape whose page does NOT carry the code -> Suggested firecrawl (verified false), never a blind auto-count", async () => {
    const bdbMock = vi.fn(async () => ({ name: "", brand: "", sourceUrl: "https://shop.example.com/p/1" }));
    const fcMock = vi.fn(async () => ({ title: "Some Unrelated Category Page Title", markdown: "no barcode here at all" }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, firecrawlScrapeCheap: fcMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.source).toBe("firecrawl");
    expect(r?.verified).toBe(false); // code not on the scraped page -> Suggestion, not auto-counted
    expect(r?.aiCalled).toBe(true);
  });

  it("(fc-error-title) a scrape titled 'Error' is NOT a usable product -> skips firecrawl, falls to the floor (no blind auto-count)", async () => {
    const bdbMock = vi.fn(async () => ({ name: "", brand: "", sourceUrl: "https://shop.example.com/p/1" }));
    const fcMock = vi.fn(async () => ({ title: "Error", markdown: "" }));
    const floorMock = vi.fn(() => ({ name: "Coca-Cola / product unconfirmed", brand: "Coca-Cola" }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, firecrawlScrapeCheap: fcMock, prefixFloor: floorMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.source).toBe("floor"); // "Error" rejected as a name -> no firecrawl win, lands on the floor
    expect(r?.name).toMatch(/Coca-Cola/);
    expect(r?.verified).toBe(false);
  });

  it("(fc-null) double miss, firecrawl null too -> prefix floor, source floor, verified false", async () => {
    const bdbMock = vi.fn(async () => ({ name: "", brand: "", sourceUrl: "https://shop.example.com/p/1" }));
    const fcMock = vi.fn(async () => null);
    const floorMock = vi.fn(() => ({ name: "Coca-Cola / product unconfirmed", brand: "Coca-Cola" }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, firecrawlScrapeCheap: fcMock, prefixFloor: floorMock });

    const r = await resolveUnknownFast(CODE, deps);
    expect(fcMock).toHaveBeenCalledTimes(1);
    expect(r?.source).toBe("floor");
    expect(r?.name).toMatch(/Coca-Cola/);
    expect(r?.verified).toBe(false);
  });

  it("(prem) premium grounding escalation obeys the same fetch-verify gate: no page confirm -> suggestion only", async () => {
    const premiumMock = vi.fn(async () => ({ text: "Premium Guessed Product", grounded: true, sources: [], sourceUrls: [] }));
    const deps = baseDeps({ groundIdentifyPremium: premiumMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(premiumMock).toHaveBeenCalledTimes(1);
    expect(r?.source).toBe("grounding");
    expect(r?.verified).toBe(false); // premium answer without a fetch-confirmed page -> suggestion only
    expect(r?.aiCalled).toBe(true);
  });

  it("(prem-verified) premium grounding whose page fetch-confirms the code + name -> Verified", async () => {
    const premiumMock = vi.fn(async () => ({ text: "Premium Real Product", grounded: true, sources: [], sourceUrls: ["https://p.example/x"] }));
    const verifyMock = verifyHit(`Premium Real Product listing - UPC ${CODE}`);
    const deps = baseDeps({ groundIdentifyPremium: premiumMock, verifyCodeOnPage: verifyMock });

    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("grounding");
    expect(r?.verified).toBe(true);
    expect(r?.name).toMatch(/Premium Real Product/);
  });

  it("a throwing leg does not reject the whole resolve (per-leg catch -> null), fallback still resolves", async () => {
    const bdbMock = vi.fn(async () => {
      throw new Error("barcode-DB blew up");
    });
    const groundMock = vi.fn(async () => ({ text: "Fallback Product Name Works", grounded: true, sources: [], sourceUrls: ["https://x/y"] }));
    const verifyMock = verifyHit(`Fallback Product Name Works - UPC ${CODE}`);
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock, verifyCodeOnPage: verifyMock });

    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("grounding");
    expect(r?.verified).toBe(true);
    expect(r?.name).toMatch(/Fallback Product Name/);
  });

  it("(slow-barcode-db) a slow barcode-DB leg is awaited first; its verified win ends the pipeline without the grounding fallback", async () => {
    const bd = deferred<{ name: string; brand: string; sourceUrl: string } | null>();
    const bdbMock = vi.fn(() => bd.promise);
    const verifyMock = verifyHit(`Real Structured Product listing - UPC ${CODE}`);
    const groundMock = vi.fn(async () => ({ text: "Should Never Run", grounded: true, sources: [], sourceUrls: ["https://x/y"] }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, verifyCodeOnPage: verifyMock, groundIdentify: groundMock });

    const pending = resolveUnknownFast(CODE, deps);
    await new Promise((res) => setTimeout(res, 0));
    bd.resolve({ name: "Real Structured Product", brand: "", sourceUrl: "https://x.example/p" });
    const r = await pending;

    expect(r?.source).toBe("barcode_db");
    expect(r?.verified).toBe(true);
    expect(groundMock).not.toHaveBeenCalled();
  });
});
