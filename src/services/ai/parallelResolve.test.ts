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

  it("(b) barcode-DB miss + grounding usable -> source grounding, aiCalled true, verified", async () => {
    const bdbMock = vi.fn(async () => null);
    const groundMock = vi.fn(async () => ({ text: "Sony WH-1000XM5 Wireless Headphones", grounded: true }));
    const deps = baseDeps({ lookupBarcodeDb: bdbMock, groundIdentify: groundMock });

    const r = await resolveUnknownFast(CODE, deps);

    expect(r?.source).toBe("grounding");
    expect(r?.name).toMatch(/Sony WH-1000XM5/);
    expect(r?.verified).toBe(true);
    expect(r?.aiCalled).toBe(true);
    expect(bdbMock).toHaveBeenCalledTimes(1);
    expect(groundMock).toHaveBeenCalledTimes(1);
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
    const groundMock = vi.fn(async () => ({ text: "Fallback Product Name Works", grounded: true }));
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
