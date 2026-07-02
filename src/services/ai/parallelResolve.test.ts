// @vitest-environment node
//
// Plan D Task 4 - PARALLEL RESOLVER. Proves the speed-first race: fire the barcode-DB leg and the
// grounding leg CONCURRENTLY, take the FIRST confident answer, escalate to Firecrawl then the prefix
// floor ONLY on a double-miss, and never fail to decode. ALL THREE providers are mocked here - ZERO
// live network / AI / credits are ever touched by this suite.

import { describe, it, expect, vi } from "vitest";
import {
  resolveUnknownFast,
  type ParallelResolveDeps,
} from "@/services/ai/parallelResolve";

const CODE = "086699087829";

/** A deferred promise whose resolution we control - lets us prove a slow LOSER never delays the winner. */
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

describe("resolveUnknownFast - barcode-DB first, grounding only on a miss", () => {
  // FIX 3 (cost): the EXPENSIVE google_search grounding leg ($35/1k) must fire ONLY when the free
  // barcode-DB leg MISSES. These two tests are the cost proof.
  it("(cost-1) barcode-DB HIT -> the expensive grounding leg is NEVER called (0 calls)", async () => {
    const groundMock = vi.fn(async () => ({ text: "Should Never Run", grounded: true, sources: [`UPC ${CODE}`] }));
    const bdbMock = vi.fn(async () => ({ name: "Michelin LTX M/S2 All-Season", brand: "Michelin", sourceUrl: "https://x/y" }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.source).toBe("barcode_db");
    expect(r?.verified).toBe(true);
    expect(r?.aiCalled).toBe(false);
    expect(bdbMock).toHaveBeenCalledTimes(1);
    expect(groundMock).not.toHaveBeenCalled(); // <- the cost fix: no google_search on a barcode-DB hit
  });

  it("(cost-2) barcode-DB MISS -> grounding IS called and its Fix-1 code-in-sources gate still applies", async () => {
    const bdbMock = vi.fn(async () => null); // miss
    const verifiedGround = vi.fn(async () => ({
      text: "Sony WH-1000XM5 Wireless Headphones",
      grounded: true,
      sources: [`UPC ${CODE} - Sony WH-1000XM5 | go-upc`], // code IN sources -> Verified
    }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: verifiedGround });

    const r = await resolveUnknownFast(CODE, deps);

    expect(bdbMock).toHaveBeenCalledTimes(1);
    expect(verifiedGround).toHaveBeenCalledTimes(1); // grounding fires ONLY because barcode-DB missed
    expect(r?.source).toBe("grounding");
    expect(r?.verified).toBe(true);
    expect(r?.aiCalled).toBe(true);

    // ...and with the SAME miss, a grounding answer whose code is NOT in sources is still demoted (Fix 1).
    const demotedGround = vi.fn(async () => ({ text: "Hallucinated Name", grounded: true, sources: ["no code here"] }));
    const r2 = await resolveUnknownFast(CODE, baseDeps({ lookupBarcodeDb: vi.fn(async () => null), groundIdentify: demotedGround }));
    expect(r2?.source).toBe("grounding");
    expect(r2?.verified).toBe(false);
  });

  it("(a) barcode-DB HIT -> source barcode_db, aiCalled false, grounding leg NOT fired (cost)", async () => {
    const ground = deferred<{ text: string; grounded: boolean } | null>();
    const groundMock = vi.fn(() => ground.promise);
    const bdbMock = vi.fn(async () => ({ name: "Michelin LTX M/S2 All-Season", brand: "Michelin", sourceUrl: "https://x/y" }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r).not.toBeNull();
    expect(r?.source).toBe("barcode_db");
    expect(r?.brand).toBe("Michelin");
    expect(r?.name).toMatch(/Michelin LTX/);
    expect(r?.verified).toBe(true);
    expect(r?.aiCalled).toBe(false);
    // RECONCILED for Fix 3: barcode-DB is awaited FIRST, so a hit never fires the expensive grounding leg.
    expect(bdbMock).toHaveBeenCalledTimes(1);
    expect(groundMock).not.toHaveBeenCalled();
  });

  it("(b) barcode-DB miss + grounding usable WITH the exact code in its sources -> Verified grounding win", async () => {
    const bdbMock = vi.fn(async () => null);
    const groundMock = vi.fn(async () => ({
      text: "Sony WH-1000XM5 Wireless Headphones",
      grounded: true,
      sources: [`UPC ${CODE} - Sony WH-1000XM5 Wireless Headphones | go-upc`],
    }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.source).toBe("grounding");
    expect(r?.name).toMatch(/Sony WH-1000XM5/);
    expect(r?.verified).toBe(true);
    expect(r?.aiCalled).toBe(true);
    expect(bdbMock).toHaveBeenCalledTimes(1);
    expect(groundMock).toHaveBeenCalledTimes(1);
  });

  // FINDING 1 fix (preview mass-scan 2026-07-01): grounding hallucinations auto-counted as Verified.
  // Owner revisit-trigger fired -> Option 1: a grounding answer is Verified ONLY when the APP finds the
  // exact code in the grounding sources; otherwise it is DEMOTED to an unverified suggestion.
  it("(b2) grounding answer WITHOUT the code in its sources is DEMOTED: verified false, still a grounding suggestion", async () => {
    const groundMock = vi.fn(async () => ({
      text: "Nagoya Mosaic Clay Drop",
      grounded: true,
      sources: ["https://vertexaisearch.cloud.google.com/grounding-api-redirect/x", "Some Unrelated Page Title"],
    }));
    const floorMock = vi.fn(() => ({ name: "Acme / product unconfirmed", brand: "Acme" }));
    const deps = baseDeps({ groundIdentify: groundMock, prefixFloor: floorMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.source).toBe("grounding");
    expect(r?.verified).toBe(false); // Suggested downstream - NEVER auto-counted
    expect(r?.aiCalled).toBe(true);
    expect(r?.name).toMatch(/Nagoya Mosaic/);
    expect(floorMock).not.toHaveBeenCalled(); // a named suggestion beats the brand-only floor
  });

  it("(b3) grounding sources match the code across GTIN zero-padding variants", async () => {
    const groundMock = vi.fn(async () => ({
      text: "Michelin Defender LTX M/S",
      grounded: true,
      sources: [`EAN 0${CODE} - Michelin Defender listing`], // 13-digit zero-padded form of the UPC-12
    }));
    const r = await resolveUnknownFast(CODE, baseDeps({ groundIdentify: groundMock }));
    expect(r?.source).toBe("grounding");
    expect(r?.verified).toBe(true);
  });

  it("(b4) a refusal sentence from grounding is rejected outright -> falls to the floor (never a product)", async () => {
    const groundMock = vi.fn(async () => ({
      text: `Unable to identify the product associated with UPC ${CODE}.`,
      grounded: true,
      sources: [`UPC ${CODE} search results`], // code IS in sources - the refusal must still never win
    }));
    const floorMock = vi.fn(() => ({ name: "Coca-Cola / product unconfirmed", brand: "Coca-Cola" }));
    const r = await resolveUnknownFast(CODE, baseDeps({ groundIdentify: groundMock, prefixFloor: floorMock }));
    expect(r?.source).toBe("floor");
    expect(r?.verified).toBe(false);
  });

  it("(b4b) a refusal phrase isRefusal catches (but isUsableProductName does not) is rejected -> floor", async () => {
    // "couldn't find" is a genuine product-name shape to isUsableProductName, so only the grounding-leg
    // isRefusal guard stops it from becoming a hallucinated Verified product. Code IS in sources.
    const groundMock = vi.fn(async () => ({
      text: `We couldn't find a product for ${CODE}`,
      grounded: true,
      sources: [`UPC ${CODE} listing`],
    }));
    const floorMock = vi.fn(() => ({ name: "Pepsi / product unconfirmed", brand: "Pepsi" }));
    const r = await resolveUnknownFast(CODE, baseDeps({ groundIdentify: groundMock, prefixFloor: floorMock }));
    expect(r?.source).toBe("floor");
    expect(r?.verified).toBe(false);
  });

  it("(b5) a confident barcode-DB hit wins and grounding never runs (even a slow barcode-DB leg)", async () => {
    // RECONCILED for Fix 3: grounding no longer races barcode-DB. barcode-DB is awaited first, so a
    // confident hit (however slow it arrives) ends the pipeline and the grounding leg is never fired.
    const bdb = deferred<{ name: string; brand: string; sourceUrl: string } | null>();
    const bdbMock = vi.fn(() => bdb.promise);
    const groundMock = vi.fn(async () => ({
      text: "Hallucinated Product Name",
      grounded: true,
      sources: ["No code anywhere in these sources"],
    }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock });

    const pending = resolveUnknownFast(CODE, deps);
    await new Promise((res) => setTimeout(res, 0)); // resolver is parked awaiting the (slow) barcode-DB leg
    bdb.resolve({ name: "Real Structured Product", brand: "RealBrand", sourceUrl: "https://x/y" });
    const r = await pending;

    expect(r?.source).toBe("barcode_db");
    expect(r?.verified).toBe(true);
    expect(r?.name).toMatch(/Real Structured Product/);
    expect(groundMock).not.toHaveBeenCalled(); // cost: hit -> zero grounding spend
  });

  it("(b6) the premium grounding escalation obeys the same code-in-sources gate", async () => {
    const premiumMock = vi.fn(async () => ({
      text: "Premium Guessed Product",
      grounded: true,
      sources: ["nothing matching here"],
    }));
    const floorMock = vi.fn(() => null);
    const deps = baseDeps({ groundIdentifyPremium: premiumMock, prefixFloor: floorMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(premiumMock).toHaveBeenCalledTimes(1);
    expect(r?.source).toBe("grounding");
    expect(r?.verified).toBe(false); // premium answer without code-in-sources -> suggestion only
  });

  it("(c1) double miss with a source URL -> escalates to firecrawl, source firecrawl", async () => {
    // barcode-DB returns a URL but no usable title (miss for confidence, usable for escalation).
    const bdbMock = vi.fn(async () => ({ name: "", brand: "", sourceUrl: "https://shop.example.com/p/1" }));
    const groundMock = vi.fn(async () => null);
    const fcMock = vi.fn(async () => ({ title: "Stanley Quencher H2.0 Tumbler 40oz", markdown: "" }));
    const floorMock = vi.fn(() => ({ name: "Should Not Be Used / product unconfirmed", brand: "Should Not" }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock, firecrawlScrapeCheap: fcMock, prefixFloor: floorMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(fcMock).toHaveBeenCalledTimes(1);
    expect(fcMock).toHaveBeenCalledWith("https://shop.example.com/p/1");
    expect(r?.source).toBe("firecrawl");
    expect(r?.name).toMatch(/Stanley Quencher/);
    expect(r?.aiCalled).toBe(true);
    expect(floorMock).not.toHaveBeenCalled();
  });

  it("(c2) double miss, firecrawl null too -> falls to the prefix floor, source floor, verified false", async () => {
    const bdbMock = vi.fn(async () => ({ name: "", brand: "", sourceUrl: "https://shop.example.com/p/1" }));
    const groundMock = vi.fn(async () => null);
    const fcMock = vi.fn(async () => null);
    const floorMock = vi.fn(() => ({ name: "Coca-Cola / product unconfirmed", brand: "Coca-Cola" }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock, firecrawlScrapeCheap: fcMock, prefixFloor: floorMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(fcMock).toHaveBeenCalledTimes(1);
    expect(r?.source).toBe("floor");
    expect(r?.name).toMatch(/Coca-Cola/);
    expect(r?.brand).toBe("Coca-Cola");
    expect(r?.verified).toBe(false);
    expect(r?.aiCalled).toBe(false);
  });

  it("(c3) FIX 4: total miss with no URL and no brand floor -> a GENERIC unidentified floor, NEVER null (so it never falls through to the legacy path)", async () => {
    const deps = baseDeps(); // all legs miss, prefixFloor returns null (e.g. an unassigned 999-prefix)
    const r = await resolveUnknownFast(CODE, deps);
    // Must NOT be null (null used to fall through to the legacy Gemini/OpenAI path, which hallucinated
    // fake-verified canaries and drove the money-pit). Instead: a terminal, counted, NEVER-verified floor.
    expect(r).not.toBeNull();
    expect(r?.source).toBe("floor");
    expect(r?.verified).toBe(false);
    expect(r?.aiCalled).toBe(false);
    expect(r?.name).toMatch(/Unidentified item/);
    expect(r?.name).toContain(CODE);
  });

  it("(d) a barcode-DB hit returns immediately without ever firing (or waiting on) the grounding leg", async () => {
    // RECONCILED for Fix 3: previously proved a slow grounding LOSER didn't delay the barcode-DB winner
    // in a parallel race. Now the guarantee is stronger and cheaper: on a barcode-DB hit the grounding
    // leg is not fired at all, so it trivially cannot delay the winner.
    const groundMock = vi.fn(async () => ({ text: "Should Never Run", grounded: true, sources: [] }));
    const bdbMock = vi.fn(async () => ({ name: "Instant Winner Product", brand: "Acme", sourceUrl: "" }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.source).toBe("barcode_db");
    expect(r?.name).toMatch(/Instant Winner/);
    expect(groundMock).not.toHaveBeenCalled(); // hit -> grounding never runs (no delay, no spend)
  });

  it("a throwing leg does not reject the whole resolve (per-leg catch -> null)", async () => {
    const bdbMock = vi.fn(async () => {
      throw new Error("barcode DB blew up");
    });
    const groundMock = vi.fn(async () => ({ text: "Fallback Product Name Works", grounded: true, sources: [`UPC ${CODE} - Fallback Product Name Works`] }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock });

    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("grounding");
    expect(r?.name).toMatch(/Fallback Product Name/);
  });

  it("barcode-DB is tried first: a confident structured hit wins and grounding is not consulted", async () => {
    // RECONCILED for Fix 3: there is no longer a "tie" to break - barcode-DB is awaited first, so a
    // confident structured hit is returned before grounding would ever be called.
    const bdbMock = vi.fn(async () => ({ name: "Structured DB Product", brand: "DBBrand", sourceUrl: "https://x/y" }));
    const groundMock = vi.fn(async () => ({ text: "Grounded Model Product", grounded: true }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock });

    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("barcode_db");
    expect(r?.brand).toBe("DBBrand");
    expect(groundMock).not.toHaveBeenCalled();
  });
});
