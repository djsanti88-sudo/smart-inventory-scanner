// @vitest-environment node
//
// Plan D Task 4 - GROUNDING-FIRST + FETCH-VERIFY resolver. Proves: (1) ONE flash-lite grounding call is the
// accurate primary; a usable answer is Verified ONLY when the APP fetches a candidate page and confirms the
// exact code is on it AND a distinctive token of the name corroborates that page; (2) an unconfirmed name is
// a held Suggestion, never auto-counted; (3) a hallucinated name on the wrong page is rejected by the
// name-corroboration guard; (4) grounding null (429/rate-cap) falls back to the barcode-DB leg, then the
// terminal floor - NEVER null, NEVER a legacy fall-through. ALL providers + fetch-verify are mocked here -
// ZERO live network / AI / credits are ever touched by this suite.
//
// RECONCILED (2026-07-01, owner decision SUPERSEDING the older Fix-3 barcode-DB-first cost order): grounding
// now runs FIRST (barcode-DB proved unreliable - "coconut oil" for glycine), and Verified requires a real
// page fetch (grounding source TITLES never carry the raw barcode). Every trust / hallucination / count /
// refusal (Fix 1) / terminal-floor (Fix 4) assertion is preserved, only re-pointed at the new order.

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

describe("resolveUnknownFast - grounding first, fetch-verify, barcode-DB fallback", () => {
  it("(g1) grounding usable + a fetched page confirms the code + name corroborated -> Verified grounding, aiCalled true", async () => {
    const groundMock = vi.fn(async () => ({
      text: "Sony WH-1000XM5 Wireless Headphones",
      grounded: true,
      sources: [],
      sourceUrls: ["https://vertexaisearch.cloud.google.com/redirect/a", "https://sony.example/p"],
    }));
    const verifyMock = verifyHit(`Sony WH-1000XM5 Wireless Headphones product page - UPC ${CODE}`);
    const bdbMock = vi.fn(async () => ({ name: "Should Not Run", brand: "X", sourceUrl: "https://x/y" }));
    const deps = baseDeps({ groundIdentify: groundMock, verifyCodeOnPage: verifyMock, lookupBarcodeDb: bdbMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.source).toBe("grounding");
    expect(r?.verified).toBe(true);
    expect(r?.aiCalled).toBe(true);
    expect(r?.name).toMatch(/Sony WH-1000XM5/);
    expect(groundMock).toHaveBeenCalledTimes(1); // exactly ONE grounding call (cost)
    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(verifyMock).toHaveBeenCalledWith(
      ["https://vertexaisearch.cloud.google.com/redirect/a", "https://sony.example/p"],
      CODE,
    );
    expect(bdbMock).not.toHaveBeenCalled(); // grounding won -> the barcode-DB fallback never runs
  });

  it("(g2) grounding usable but NO fetched page carries the code -> held Suggestion (verified false), never auto-counted", async () => {
    const groundMock = vi.fn(async () => ({
      text: "Nagoya Mosaic Clay Drop",
      grounded: true,
      sources: [],
      sourceUrls: ["https://x.example/redirect"],
    }));
    const verifyMock = vi.fn(async () => null); // code confirmed on NO page
    const bdbMock = vi.fn(async () => ({ name: "Barcode DB Name", brand: "BD", sourceUrl: "https://x/y" }));
    const floorMock = vi.fn(() => ({ name: "Acme / product unconfirmed", brand: "Acme" }));
    const deps = baseDeps({ groundIdentify: groundMock, verifyCodeOnPage: verifyMock, lookupBarcodeDb: bdbMock, prefixFloor: floorMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.source).toBe("grounding");
    expect(r?.verified).toBe(false); // Suggested downstream - NEVER auto-counted
    expect(r?.aiCalled).toBe(true);
    expect(r?.name).toMatch(/Nagoya Mosaic/);
    expect(bdbMock).not.toHaveBeenCalled(); // a usable grounding name short-circuits the fallback
    expect(floorMock).not.toHaveBeenCalled(); // a named suggestion beats the brand-only floor
  });

  it("(g3) NAME-CORROBORATION guard: a hallucinated name whose tokens are NOT on the code's page is NOT Verified", async () => {
    // The page DOES carry the exact code, but it is a glycine page; grounding's "Coconut Oil" must not verify.
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

  it("(g4) grounding name corroborated by a real distinctive token on the page -> Verified", async () => {
    const groundMock = vi.fn(async () => ({
      text: "Life Extension Glycine 1000mg",
      grounded: true,
      sources: [],
      sourceUrls: ["https://vitamins.example/glycine"],
    }));
    const verifyMock = verifyHit(`Glycine 1000mg by Life Extension - UPC ${CODE} - amino acid supplement`);
    const deps = baseDeps({ groundIdentify: groundMock, verifyCodeOnPage: verifyMock });

    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("grounding");
    expect(r?.verified).toBe(true);
    expect(r?.name).toMatch(/Glycine/);
  });

  it("(r1) a refusal sentence from grounding is rejected BEFORE any fetch -> falls to the floor", async () => {
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

  it("(bdb1) grounding null (e.g. 429) -> barcode-DB fallback; sourceUrl page fetch-confirms the code -> Verified barcode_db, aiCalled false", async () => {
    const groundMock = vi.fn(async () => null); // rate-cap / miss
    const bdbMock = vi.fn(async () => ({ name: "Michelin LTX M/S2 All-Season", brand: "Michelin", sourceUrl: "https://shop.example/p/1" }));
    const verifyMock = verifyHit(`Michelin LTX M/S2 All-Season tire - UPC ${CODE}`);
    const deps = baseDeps({ groundIdentify: groundMock, lookupBarcodeDb: bdbMock, verifyCodeOnPage: verifyMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(groundMock).toHaveBeenCalledTimes(1);
    expect(bdbMock).toHaveBeenCalledTimes(1); // fallback fires ONLY because grounding gave nothing usable
    expect(verifyMock).toHaveBeenCalledWith(["https://shop.example/p/1"], CODE);
    expect(r?.source).toBe("barcode_db");
    expect(r?.brand).toBe("Michelin");
    expect(r?.verified).toBe(true);
    expect(r?.aiCalled).toBe(false);
  });

  it("(bdb2) barcode-DB hit but its page does NOT confirm the code -> Suggested barcode_db (verified false), not counted", async () => {
    const bdbMock = vi.fn(async () => ({ name: "Some Structured Product", brand: "BD", sourceUrl: "https://shop.example/p/1" }));
    const verifyMock = vi.fn(async () => null);
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, verifyCodeOnPage: verifyMock });

    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("barcode_db");
    expect(r?.verified).toBe(false); // UPCitemdb is unreliable: unconfirmed -> Suggested only
    expect(r?.name).toMatch(/Some Structured Product/);
  });

  it("(bdb3) NAME-CORROBORATION guard on barcode-DB too: code on page but wrong name -> Suggested, not Verified", async () => {
    const bdbMock = vi.fn(async () => ({ name: "Coconut Oil", brand: "", sourceUrl: "https://shop.example/p/1" }));
    const verifyMock = verifyHit(`Glycine 1000mg by Life Extension - UPC ${CODE}`); // code present, "coconut" absent
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, verifyCodeOnPage: verifyMock });

    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("barcode_db");
    expect(r?.verified).toBe(false);
  });

  it("(429-floor) grounding null + barcode-DB null -> a public miss ends at the generic terminal floor (Fix 4: never null, never legacy)", async () => {
    const deps = baseDeps(); // grounding null, barcode-DB null, prefixFloor null (e.g. unassigned 999-prefix)
    const r = await resolveUnknownFast(CODE, deps);
    expect(r).not.toBeNull(); // null used to fall through to the legacy Gemini/OpenAI money-pit
    expect(r?.source).toBe("floor");
    expect(r?.verified).toBe(false);
    expect(r?.aiCalled).toBe(false);
    expect(r?.name).toMatch(/Unidentified item/);
    expect(r?.name).toContain(CODE);
  });

  it("(floor-brand) grounding + barcode-DB miss with a brand-only prefix floor -> Suggested floor (verified false)", async () => {
    const floorMock = vi.fn(() => ({ name: "Coca-Cola / product unconfirmed", brand: "Coca-Cola" }));
    const deps = baseDeps({ prefixFloor: floorMock });
    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("floor");
    expect(r?.name).toMatch(/Coca-Cola/);
    expect(r?.verified).toBe(false);
    expect(r?.aiCalled).toBe(false);
  });

  it("(fc) double miss with a barcode-DB offer URL (empty title) -> escalates to Firecrawl, source firecrawl", async () => {
    const groundMock = vi.fn(async () => null);
    const bdbMock = vi.fn(async () => ({ name: "", brand: "", sourceUrl: "https://shop.example.com/p/1" }));
    const fcMock = vi.fn(async () => ({ title: "Stanley Quencher H2.0 Tumbler 40oz", markdown: "" }));
    const floorMock = vi.fn(() => ({ name: "Should Not Be Used / product unconfirmed", brand: "Should Not" }));
    const deps = baseDeps({ groundIdentify: groundMock, lookupBarcodeDb: bdbMock, firecrawlScrapeCheap: fcMock, prefixFloor: floorMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(fcMock).toHaveBeenCalledTimes(1);
    expect(fcMock).toHaveBeenCalledWith("https://shop.example.com/p/1");
    expect(r?.source).toBe("firecrawl");
    expect(r?.name).toMatch(/Stanley Quencher/);
    expect(r?.aiCalled).toBe(true);
    expect(floorMock).not.toHaveBeenCalled();
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
    const groundMock = vi.fn(async () => {
      throw new Error("grounding blew up");
    });
    const bdbMock = vi.fn(async () => ({ name: "Fallback Product Name Works", brand: "", sourceUrl: "https://x/y" }));
    const verifyMock = verifyHit(`Fallback Product Name Works - UPC ${CODE}`);
    const deps = baseDeps({ groundIdentify: groundMock, lookupBarcodeDb: bdbMock, verifyCodeOnPage: verifyMock });

    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("barcode_db");
    expect(r?.verified).toBe(true);
    expect(r?.name).toMatch(/Fallback Product Name/);
  });

  it("(slow-grounding) a slow grounding leg is awaited first; its verified win ends the pipeline without the fallback", async () => {
    const gr = deferred<{ text: string; grounded: boolean; sources: string[]; sourceUrls: string[] } | null>();
    const groundMock = vi.fn(() => gr.promise);
    const verifyMock = verifyHit(`Real Grounded Product listing - UPC ${CODE}`);
    const bdbMock = vi.fn(async () => ({ name: "Should Never Run", brand: "X", sourceUrl: "https://x/y" }));
    const deps = baseDeps({ groundIdentify: groundMock, verifyCodeOnPage: verifyMock, lookupBarcodeDb: bdbMock });

    const pending = resolveUnknownFast(CODE, deps);
    await new Promise((res) => setTimeout(res, 0));
    gr.resolve({ text: "Real Grounded Product", grounded: true, sources: [], sourceUrls: ["https://g.example/x"] });
    const r = await pending;

    expect(r?.source).toBe("grounding");
    expect(r?.verified).toBe(true);
    expect(bdbMock).not.toHaveBeenCalled();
  });
});
