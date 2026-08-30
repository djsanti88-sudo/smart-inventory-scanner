import { describe, it, expect, vi, beforeEach } from "vitest";
import { lookupByExactBarcode, lookupByExactPartNumber, getTireKnowledgeMeta, __resetTireKnowledgeCacheForTests } from "@/server/tire-knowledge/tireKnowledgeIndex";
import { resolveExactBarcode, resolveExactPartNumber } from "@/server/tire-knowledge/TireKnowledgeProvider";
import { isTireContext, hasRequiredTireSpecs } from "@/decoding/tireSpecs";

// Server-only tire knowledge: EXACT trusted-barcode hits resolve a verified tire WITHOUT AI; misses + the
// poison + near-matches return null (fall through to the existing AI path). Runs against the REAL committed
// generated index (Cooper 029142869870 + Falken 848983006165 from the bootstrap seed).

beforeEach(() => __resetTireKnowledgeCacheForTests());

describe("tireKnowledgeIndex - exact lookup", () => {
  it("resolves an exact trusted barcode (leading-zero UPC preserved as string)", async () => {
    const row = await lookupByExactBarcode("029142869870");
    expect(row?.brand).toBe("cooper");
    expect(row?.barcode).toBe("029142869870"); // leading zero intact
  });

  it("normalizes scanner separators but never numeric-converts", async () => {
    expect((await lookupByExactBarcode("0 29142-869870"))?.brand).toBe("cooper");
  });

  it("MISS for an unknown barcode -> null (falls through to AI)", async () => {
    expect(await lookupByExactBarcode("012345678905")).toBeNull();
  });

  it("POISON 745125495781 is NOT in the corpus -> null (never a corpus hit)", async () => {
    expect(await lookupByExactBarcode("745125495781")).toBeNull();
  });

  it("NEAR-MATCH 7451254957818 is not in the corpus, and never equates to 745125495781", async () => {
    expect(await lookupByExactBarcode("7451254957818")).toBeNull();
    expect(await lookupByExactBarcode("745125495781")).toBeNull();
  });

  it("exact part-number lookup resolves the row", async () => {
    expect((await lookupByExactPartNumber("90000027117"))?.brand).toBe("cooper");
    expect(await lookupByExactPartNumber("NOT-A-PART")).toBeNull();
  });

  it("exposes metadata for diagnostics", async () => {
    const meta = await getTireKnowledgeMeta();
    expect(meta?.barcode_index_count).toBeGreaterThanOrEqual(2);
  });
});

describe("TireKnowledgeProvider - decode result + safety", () => {
  it("exact barcode -> VERIFIED, app-verified, conf>=0.9, path=corpus_exact_barcode, full tire specs", async () => {
    const r = await resolveExactBarcode("029142869870");
    expect(r).not.toBeNull();
    expect(r!.decision.status).toBe("verified");
    expect(r!.decision.exactCodeEvidenceVerifiedByApp).toBe(true);
    expect(r!.decision.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r!.decision.corroborationPath).toBe("corpus_exact_barcode");
    const product = r!.results[0];
    expect(isTireContext(product)).toBe(true);
    expect(hasRequiredTireSpecs(product)).toBe(true); // size + load + speed grounded by the corpus
  });

  it("PRIVACY: the corpus result carries NO source URLs (no global-corpus leak to the decode response)", async () => {
    const r = await resolveExactBarcode("029142869870");
    expect(r!.results[0].sourceUrls).toEqual([]);
  });

  it("NO network call: resolving an exact barcode never calls fetch (no AI, no page fetch)", async () => {
    const orig = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await resolveExactBarcode("848983006165");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("MISS -> null so the existing AI path runs unchanged", async () => {
    expect(await resolveExactBarcode("012345678905")).toBeNull();
  });

  it("POISON -> null (never a corpus auto-count); never near-matches", async () => {
    expect(await resolveExactBarcode("745125495781")).toBeNull();
  });

  it("part number -> SUGGESTED (Needs Review), never silently auto-counts", async () => {
    const r = await resolveExactPartNumber("90000027117");
    expect(r!.decision.status).toBe("suggested");
    expect(r!.decision.exactCodeEvidenceVerifiedByApp).toBe(false);
  });

  it("lazy load: works after a cache reset (re-reads the generated index)", async () => {
    __resetTireKnowledgeCacheForTests();
    expect((await resolveExactBarcode("029142869870"))!.decision.status).toBe("verified");
  });
});
