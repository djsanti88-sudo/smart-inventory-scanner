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

describe("resolveUnknownFast - parallel barcode-DB || grounding race", () => {
  it("(a) barcode-DB fast, grounding slow -> source barcode_db, aiCalled false, BOTH legs fired (parallel)", async () => {
    const ground = deferred<{ text: string; grounded: boolean } | null>();
    const groundMock = vi.fn(() => ground.promise); // slow: stays pending until we resolve it
    const bdbMock = vi.fn(async () => ({ name: "Michelin LTX M/S2 All-Season", brand: "Michelin", sourceUrl: "https://x/y" }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r).not.toBeNull();
    expect(r?.source).toBe("barcode_db");
    expect(r?.brand).toBe("Michelin");
    expect(r?.name).toMatch(/Michelin LTX/);
    expect(r?.verified).toBe(true);
    expect(r?.aiCalled).toBe(false);
    // Proof of PARALLELISM: the grounding leg was invoked concurrently, not skipped.
    expect(bdbMock).toHaveBeenCalledTimes(1);
    expect(groundMock).toHaveBeenCalledTimes(1);
    ground.resolve(null); // cleanup the still-pending loser
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

  it("(b5) a fast UNVERIFIED grounding answer never beats a slower confident barcode-DB hit", async () => {
    const bdb = deferred<{ name: string; brand: string; sourceUrl: string } | null>();
    const bdbMock = vi.fn(() => bdb.promise);
    const groundMock = vi.fn(async () => ({
      text: "Hallucinated Product Name",
      grounded: true,
      sources: ["No code anywhere in these sources"],
    }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock });

    const pending = resolveUnknownFast(CODE, deps);
    // Let the (unverified) grounding leg settle first, then the structured hit arrives.
    await new Promise((res) => setTimeout(res, 0));
    bdb.resolve({ name: "Real Structured Product", brand: "RealBrand", sourceUrl: "https://x/y" });
    const r = await pending;

    expect(r?.source).toBe("barcode_db");
    expect(r?.verified).toBe(true);
    expect(r?.name).toMatch(/Real Structured Product/);
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

  it("(c3) total miss with no URL and no floor -> returns null (caller falls through to legacy path)", async () => {
    const deps = baseDeps(); // all legs miss, floor null
    const r = await resolveUnknownFast(CODE, deps);
    expect(r).toBeNull();
  });

  it("(d) a slow LOSER never delays the winner (winner resolves while loser still pending)", async () => {
    const loser = deferred<{ text: string; grounded: boolean } | null>();
    let loserSettled = false;
    loser.promise.then(() => {
      loserSettled = true;
    });
    const groundMock = vi.fn(() => loser.promise); // never settles during the assertion window
    const bdbMock = vi.fn(async () => ({ name: "Instant Winner Product", brand: "Acme", sourceUrl: "" }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.source).toBe("barcode_db");
    expect(r?.name).toMatch(/Instant Winner/);
    // The loser was fired (parallel) but had NOT settled when the winner returned - proof of no-delay.
    expect(groundMock).toHaveBeenCalledTimes(1);
    expect(loserSettled).toBe(false);
    loser.resolve(null); // cleanup
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

  it("prefers barcode-DB over grounding when both are confident and resolve together (structured wins the tie)", async () => {
    const bdbMock = vi.fn(async () => ({ name: "Structured DB Product", brand: "DBBrand", sourceUrl: "https://x/y" }));
    const groundMock = vi.fn(async () => ({ text: "Grounded Model Product", grounded: true }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock });

    const r = await resolveUnknownFast(CODE, deps);
    expect(r?.source).toBe("barcode_db");
    expect(r?.brand).toBe("DBBrand");
  });
});
