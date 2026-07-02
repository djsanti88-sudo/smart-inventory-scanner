// @vitest-environment node
//
// Plan D Task 4 - CROSS-CHECK auto-count resolver. Proves: (1) barcode-DB + grounding are queried
// CONCURRENTLY; (2) an auto-count (Verified) happens ONLY when the two independent names AGREE on identity;
// (3) a lone wrong DB row and a lone grounding hallucination each land in Needs Review (Suggestion), NEVER
// auto-counted; (4) a disagreement between the two -> Needs Review; (5) firewall-conflicted DB brands are
// dropped; (6) a public miss ends at the terminal floor - NEVER null, NEVER a legacy fall-through. ALL
// providers are mocked here - ZERO live network / AI / credits are ever touched by this suite.
//
// RECONCILED (2026-07-01, owner decision): a 21-code regression proved single-source trust auto-counts ~40%
// WRONG on hard codes (a dress for Member's Mark water; Oreo for Pico de Gallo). Auto-count now requires
// TWO-SOURCE AGREEMENT. Every trust / hallucination / count / refusal / terminal-floor assertion is
// preserved, re-pointed at the cross-check rule.

import { describe, it, expect, vi } from "vitest";
import {
  resolveUnknownFast,
  identitiesAgree,
  type ParallelResolveDeps,
} from "@/services/ai/parallelResolve";

const CODE = "086699087829";

/** A deferred promise whose resolution we control - lets us prove both legs run concurrently. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Base deps: every leg misses. Individual tests override the legs they exercise. */
function baseDeps(over: Partial<ParallelResolveDeps> = {}): ParallelResolveDeps {
  return {
    lookupBarcodeDb: vi.fn(async () => null),
    groundIdentify: vi.fn(async () => null),
    firecrawlScrapeCheap: vi.fn(async () => null),
    prefixFloor: vi.fn(() => null),
    ...over,
  };
}

/** A grounding leg returning a given product text. */
function ground(text: string, sourceUrls: string[] = []) {
  return vi.fn(async () => ({ text, grounded: true, sources: [], sourceUrls }));
}

describe("identitiesAgree", () => {
  it("agrees when two names share >=2 distinctive tokens", () => {
    expect(identitiesAgree("Jumbo Stone Crab Claws", "JUMBO STONE CRAB CLAWS")).toBe(true);
    expect(identitiesAgree("Life Extension - Glycine 1000 mg 100 Vegetarian Capsules", "Life Extension Glycine 1000mg")).toBe(true);
    expect(identitiesAgree("Pringles Scorchin Cheddar Potato Crisps", "Pringles Scorchin Cheddar")).toBe(true);
  });
  it("does NOT agree on the real wrong-identity cases from the 21-code regression", () => {
    expect(identitiesAgree("Velvet Torch Womens Lace Strapless Dress", "Member's Mark Purified Water")).toBe(false);
    expect(identitiesAgree("Mott's Fruit Snacks Assorted Animals", "Cheerios Veggie Blends Blueberry Banana")).toBe(false);
    expect(identitiesAgree("Oreo Cookies", "Pico De Gallo Chips")).toBe(false);
    expect(identitiesAgree("Doritos Cool Ranch Tortilla Chips", "Lay's Potato Chips")).toBe(false);
  });
  it("does NOT agree when the only shared words are generic (Chips/Potato/Water/...)", () => {
    expect(identitiesAgree("Acme Potato Chips", "Zenith Potato Chips")).toBe(false); // only generic overlap
  });
});

describe("resolveUnknownFast - cross-check auto-count", () => {
  it("(x1) barcode-DB + grounding AGREE -> Verified auto-count, structured DB name/brand, both legs called", async () => {
    const bdbMock = vi.fn(async () => ({ name: "Jumbo Stone Crab Claws", brand: "Joe's", sourceUrl: "https://x/y" }));
    const groundMock = ground("Jumbo Stone Crab Claws");
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.source).toBe("barcode_db");
    expect(r?.verified).toBe(true); // two independent sources agree -> trustworthy auto-count
    expect(r?.aiCalled).toBe(true);
    expect(r?.name).toMatch(/Stone Crab/);
    expect(r?.brand).toBe("Joe's"); // structured DB brand preferred
    expect(bdbMock).toHaveBeenCalledTimes(1);
    expect(groundMock).toHaveBeenCalledTimes(1);
  });

  it("(x2) DB says a DRESS, grounding says WATER, NO Firecrawl tiebreaker -> Needs Review (the real 078742051451 case)", async () => {
    const bdbMock = vi.fn(async () => ({ name: "Velvet Torch Womens Lace Strapless Dress", brand: "Velvet Torch", sourceUrl: "https://x/y" }));
    const groundMock = ground("Member's Mark Purified Water 500ml");
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock }); // no searchIdentify

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.verified).toBe(false); // disagreement + no tiebreaker -> Suggestion, never a wrong auto-count
    expect(r?.source).toBe("barcode_db"); // structured DB name preferred for the suggestion
    expect(r?.name).toMatch(/Dress/);
  });

  it("(c1) DB=dress, grounding=water, Firecrawl snippet=water -> WATER gets 2 votes -> AUTO-COUNT water, dress OUTVOTED", async () => {
    const bdbMock = vi.fn(async () => ({ name: "Velvet Torch Womens Lace Strapless Dress", brand: "Velvet Torch", sourceUrl: "https://x/y" }));
    const groundMock = ground("Member's Mark Purified Water 500ml");
    const searchMock = vi.fn(async () => [{ name: "Members Mark Purified Water 16.91 oz", url: "https://amazon.com/p" }]);
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock, searchIdentify: searchMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(searchMock).toHaveBeenCalledTimes(1); // fired because the two free sources disagreed
    expect(r?.verified).toBe(true); // grounding + Firecrawl snippet agree on WATER -> auto-count
    expect(r?.name).toMatch(/Water/i);
    expect(r?.name).not.toMatch(/Dress/);
  });

  it("(c2) the two free sources already AGREE -> Firecrawl /search is NOT called (zero credits spent)", async () => {
    const bdbMock = vi.fn(async () => ({ name: "Jumbo Stone Crab Claws", brand: "Joe's", sourceUrl: "https://x/y" }));
    const groundMock = ground("Jumbo Stone Crab Claws");
    const searchMock = vi.fn(async () => [{ name: "should not run", url: "https://x/y" }]);
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock, searchIdentify: searchMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.verified).toBe(true);
    expect(searchMock).not.toHaveBeenCalled(); // free agreement short-circuits -> no Firecrawl credits
  });

  it("(c3) both free sources miss, but TWO Firecrawl snippets agree -> AUTO-COUNT (real pages self-corroborate)", async () => {
    const searchMock = vi.fn(async () => [
      { name: "Pringles Scorchin Cheddar Potato Crisps", url: "https://openfoodfacts.org/p" },
      { name: "Pringles Scorchin Cheddar", url: "https://ewg.org/p" },
    ]);
    const deps = baseDeps({ searchIdentify: searchMock }); // DB + grounding both null

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.source).toBe("firecrawl");
    expect(r?.verified).toBe(true);
    expect(r?.name).toMatch(/Pringles Scorchin/);
  });

  it("(c4) Firecrawl keys exhausted (searchIdentify null) -> degrade gracefully to free signals -> Needs Review", async () => {
    const bdbMock = vi.fn(async () => ({ name: "Velvet Torch Dress", brand: "Velvet Torch", sourceUrl: "https://x/y" }));
    const groundMock = ground("Member's Mark Purified Water");
    const searchMock = vi.fn(async () => null); // all Firecrawl keys exhausted
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock, searchIdentify: searchMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(r?.verified).toBe(false); // no tiebreaker available -> safe Needs Review, never a wrong count
  });

  it("(c5) a single Firecrawl snippet with no agreeing source -> Suggestion (Needs Review), not auto-count", async () => {
    const searchMock = vi.fn(async () => [{ name: "Some Lone Product Listing", url: "https://x/y" }]);
    const deps = baseDeps({ searchIdentify: searchMock }); // DB + grounding null

    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("firecrawl");
    expect(r?.verified).toBe(false); // one snippet is one source - needs a second to agree
    expect(r?.name).toMatch(/Some Lone Product/);
  });

  it("(x3) lone grounding hallucination (DB miss) -> Needs Review, NOT auto-counted (the real Oreo-for-Pico case)", async () => {
    const bdbMock = vi.fn(async () => null); // DB miss
    const groundMock = ground("Oreo Cookies");
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.source).toBe("grounding");
    expect(r?.verified).toBe(false); // single source can never auto-count
    expect(r?.aiCalled).toBe(true);
    expect(r?.name).toMatch(/Oreo/);
  });

  it("(x4) lone barcode-DB hit (grounding miss) -> Needs Review, NOT auto-counted", async () => {
    const bdbMock = vi.fn(async () => ({ name: "Some Structured Product", brand: "BD", sourceUrl: "https://x/y" }));
    const groundMock = vi.fn(async () => null); // grounding miss
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.source).toBe("barcode_db");
    expect(r?.verified).toBe(false); // single source -> Suggestion
    expect(r?.name).toMatch(/Some Structured Product/);
  });

  it("(x5) brand-prefix firewall drops a wrong-brand DB row -> grounding becomes the lone source -> Needs Review", async () => {
    const bdbMock = vi.fn(async () => ({ name: "Amazonia Patio Dining Set", brand: "Amazonia", sourceUrl: "https://x/y" }));
    const conflictMock = vi.fn(() => true); // firewall: brand clearly wrong for this barcode's prefix
    const groundMock = ground("Lay's Barbecue Potato Chips");
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, brandPrefixConflict: conflictMock, groundIdentify: groundMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(conflictMock).toHaveBeenCalledWith(CODE, "Amazonia");
    expect(r?.source).toBe("grounding"); // the firewalled DB row is dropped -> grounding is the only name
    expect(r?.verified).toBe(false); // lone source -> Suggestion (the garbage DB row never even shows)
    expect(r?.name).toMatch(/Lay's Barbecue/);
  });

  it("(x6) DB + grounding agree, but the DB brand conflicts with the prefix -> DB dropped -> no agreement -> Needs Review", async () => {
    const bdbMock = vi.fn(async () => ({ name: "Wrongbrand Cola", brand: "Wrongbrand", sourceUrl: "https://x/y" }));
    const conflictMock = vi.fn(() => true);
    const groundMock = ground("Wrongbrand Cola");
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, brandPrefixConflict: conflictMock, groundIdentify: groundMock });

    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.verified).toBe(false); // a firewalled DB row can't be one of the two agreeing sources
    expect(r?.source).toBe("grounding");
  });

  it("(r1) a grounding refusal sentence is treated as absent -> lone DB source -> Needs Review", async () => {
    const bdbMock = vi.fn(async () => ({ name: "Coca-Cola Classic 12 Pack", brand: "Coca-Cola", sourceUrl: "https://x/y" }));
    const groundMock = ground(`Unable to identify the product associated with UPC ${CODE}.`);
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock });

    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("barcode_db");
    expect(r?.verified).toBe(false); // refusal is not a second source -> no agreement -> Suggestion
    expect(r?.name).toMatch(/Coca-Cola/);
  });

  it("(floor-generic) both sources miss -> generic terminal floor (Fix 4: never null, never legacy, never Verified)", async () => {
    const deps = baseDeps(); // DB null, grounding null, prefixFloor null
    const r = await resolveUnknownFast(CODE, deps);
    expect(r).not.toBeNull();
    expect(r?.source).toBe("floor");
    expect(r?.verified).toBe(false);
    expect(r?.aiCalled).toBe(false);
    expect(r?.name).toMatch(/Unidentified item/);
    expect(r?.name).toContain(CODE);
  });

  it("(floor-brand) both miss with a brand-only prefix floor -> Suggested floor (verified false)", async () => {
    const floorMock = vi.fn(() => ({ name: "Coca-Cola / product unconfirmed", brand: "Coca-Cola" }));
    const deps = baseDeps({ prefixFloor: floorMock });
    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("floor");
    expect(r?.name).toMatch(/Coca-Cola/);
    expect(r?.verified).toBe(false);
  });

  it("(fc) both sources give no usable name but a candidate URL exists -> Firecrawl scrape -> Suggestion (never auto-count)", async () => {
    const bdbMock = vi.fn(async () => ({ name: "", brand: "", sourceUrl: "https://shop.example.com/p/1" }));
    const fcMock = vi.fn(async () => ({ title: "Stanley Quencher H2.0 Tumbler 40oz", markdown: "" }));
    const floorMock = vi.fn(() => ({ name: "Should Not Be Used", brand: "Should Not" }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, firecrawlScrapeCheap: fcMock, prefixFloor: floorMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(fcMock).toHaveBeenCalledWith("https://shop.example.com/p/1");
    expect(r?.source).toBe("firecrawl");
    expect(r?.name).toMatch(/Stanley Quencher/);
    expect(r?.verified).toBe(false); // a lone scraped page is a single source -> Suggestion
    expect(floorMock).not.toHaveBeenCalled();
  });

  it("(fc-error) a scrape titled 'Error' is rejected as a name -> falls to the floor (no blind suggestion)", async () => {
    const bdbMock = vi.fn(async () => ({ name: "", brand: "", sourceUrl: "https://shop.example.com/p/1" }));
    const fcMock = vi.fn(async () => ({ title: "Error", markdown: "" }));
    const floorMock = vi.fn(() => ({ name: "Coca-Cola / product unconfirmed", brand: "Coca-Cola" }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, firecrawlScrapeCheap: fcMock, prefixFloor: floorMock });

    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("floor");
    expect(r?.name).toMatch(/Coca-Cola/);
  });

  it("(prem) premium grounding escalation is a lone source -> Suggestion only, never auto-count", async () => {
    const premiumMock = ground("Premium Guessed Product");
    const deps = baseDeps({ groundIdentifyPremium: premiumMock });

    const r = await resolveUnknownFast(CODE, deps);
    expect(premiumMock).toHaveBeenCalledTimes(1);
    expect(r?.source).toBe("grounding");
    expect(r?.verified).toBe(false);
  });

  it("a throwing leg does not reject the whole resolve (per-leg catch -> null); the other source still resolves", async () => {
    const bdbMock = vi.fn(async () => {
      throw new Error("barcode-DB blew up");
    });
    const groundMock = ground("Fallback Product Name Works");
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock });

    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("grounding"); // DB threw -> lone grounding source
    expect(r?.verified).toBe(false);
    expect(r?.name).toMatch(/Fallback Product Name/);
  });

  it("(concurrent) both legs are queried concurrently (a slow DB does not stop grounding from being called)", async () => {
    const bd = deferred<{ name: string; brand: string; sourceUrl: string } | null>();
    const bdbMock = vi.fn(() => bd.promise);
    const groundMock = ground("Jumbo Stone Crab Claws");
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock });

    const pending = resolveUnknownFast(CODE, deps);
    await new Promise((res) => setTimeout(res, 0));
    // grounding was dispatched WITHOUT waiting for the slow DB leg
    expect(groundMock).toHaveBeenCalledTimes(1);
    bd.resolve({ name: "Jumbo Stone Crab Claws", brand: "Joe's", sourceUrl: "https://x/y" });
    const r = await pending;

    expect(r?.source).toBe("barcode_db");
    expect(r?.verified).toBe(true); // both agree
  });
});
