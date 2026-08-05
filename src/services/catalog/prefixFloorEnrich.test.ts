import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchPrefixFloorEnrichment,
  isBareUnidentifiedLabel,
  isFloorGuessOnlyLabel,
  brandIsOnlyFloorGuess,
} from "@/services/catalog/prefixFloorEnrich";

// F5 bundle-surgery (wave 2, 2026-07-20): proves the client-side enrichment fetch never throws, never
// upgrades a non-fallback name, and correctly shapes its one network call - it is the ONLY piece of the
// bundle-surgery fix that touches the network from the browser, so it gets focused coverage.

describe("isBareUnidentifiedLabel", () => {
  it("matches the exact 'Unidentified item (barcode X)' fallback", () => {
    expect(isBareUnidentifiedLabel("Unidentified item (barcode 051596000004)", "051596000004")).toBe(true);
  });
  it("matches the exact 'Unidentified item (code X)' fallback (invalid check digit)", () => {
    expect(isBareUnidentifiedLabel("Unidentified item (code 222222222229)", "222222222229")).toBe(true);
  });
  it("does NOT match a decoded product name", () => {
    expect(isBareUnidentifiedLabel("Michelin Defender LTX M/S", "051596000004")).toBe(false);
  });
  it("does NOT match an already-resolved prefix-floor name", () => {
    expect(isBareUnidentifiedLabel("United Solutions / product unconfirmed", "051596000004")).toBe(false);
  });
  it("does NOT match another code's fallback label", () => {
    expect(isBareUnidentifiedLabel("Unidentified item (barcode 999999999999)", "051596000004")).toBe(false);
  });
});

// CLASS FIX (2026-08-04, cocacola-bug-report.md): isFloorGuessOnlyLabel/brandIsOnlyFloorGuess are the
// SINGLE shared signal every enrichProductIdentity call site in scanStore.ts now passes so a prefix-
// floor statistical brand guess can never permanently outrank a real decode's brand.
describe("isFloorGuessOnlyLabel", () => {
  it("matches the plain floor naming-aid suffix", () => {
    expect(isFloorGuessOnlyLabel("Coca-Cola / product unconfirmed")).toBe(true);
  });
  it("matches the family-annotated floor naming-aid suffix", () => {
    expect(isFloorGuessOnlyLabel("General (Continental family) / product unconfirmed")).toBe(true);
  });
  it("does NOT match a real decoded product name", () => {
    expect(isFloorGuessOnlyLabel("Michelin X-Ice North 4 225/60R18 104T")).toBe(false);
  });
  it("does NOT match the bare Unidentified-item fallback", () => {
    expect(isFloorGuessOnlyLabel("Unidentified item (barcode 049000026603)")).toBe(false);
  });
  it("does NOT match a name that merely contains the phrase mid-string", () => {
    expect(isFloorGuessOnlyLabel("product unconfirmed brand new tire")).toBe(false);
  });
  it("handles undefined/empty safely", () => {
    expect(isFloorGuessOnlyLabel(undefined)).toBe(false);
    expect(isFloorGuessOnlyLabel("")).toBe(false);
  });
});

describe("brandIsOnlyFloorGuess", () => {
  it("true for the bare Unidentified-item fallback", () => {
    expect(brandIsOnlyFloorGuess("Unidentified item (barcode 049000026603)", "049000026603")).toBe(true);
  });
  it("true for the floor naming-aid text (SEED/LEARNED-tier synchronous mint shape)", () => {
    expect(brandIsOnlyFloorGuess("Coca-Cola / product unconfirmed", "049000026603")).toBe(true);
  });
  it("true for the floor naming-aid text even when it arrived via the ASYNC DERIVED-tier enrichment race (no client-recomputable code relationship required)", () => {
    // Provenance-tier-agnostic by design: the async enrichPrefixFloorLabel fetch can resolve a
    // DERIVED-tier brand the client-safe SEED/LEARNED-only recompute could never reproduce - matching
    // purely on the naming-aid TEXT itself (not re-deriving from the code) closes that gap too.
    expect(brandIsOnlyFloorGuess("Coca-Cola / product unconfirmed", "999999999999")).toBe(true);
  });
  it("false for a real decoded product name", () => {
    expect(brandIsOnlyFloorGuess("Michelin X-Ice North 4 225/60R18 104T", "049000026603")).toBe(false);
  });
});

describe("fetchPrefixFloorEnrichment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null for a code shape that could never be a public barcode (no fetch attempted)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchPrefixFloorEnrichment("abc");
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls the route with the code as a query param and returns the floor on success", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ floor: { name: "General (Continental family) / product unconfirmed", brand: "General", familyLabel: "Continental family" } }),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchPrefixFloorEnrichment("5603344000016");
    expect(fetchSpy).toHaveBeenCalledWith("/api/prefix-floor?code=5603344000016");
    expect(result).toEqual({ name: "General (Continental family) / product unconfirmed", brand: "General", familyLabel: "Continental family" });
  });

  it("returns null when the server found no floor (floor: null)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ floor: null }) })));
    const result = await fetchPrefixFloorEnrichment("111000222333");
    expect(result).toBeNull();
  });

  it("returns null (never throws) on a non-ok HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const result = await fetchPrefixFloorEnrichment("051596000004");
    expect(result).toBeNull();
  });

  it("returns null (never throws) when fetch itself rejects (offline/network error)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(fetchPrefixFloorEnrichment("051596000004")).resolves.toBeNull();
  });
});
