import { describe, it, expect, vi } from "vitest";
import { structuredFieldsFor, safeStructuredFieldsFor } from "@/services/polish/structuredFields";

describe("structuredFieldsFor", () => {
  it("structures a tire name deterministically and stamps structuredBy deterministic", () => {
    const patch = structuredFieldsFor("Cooper Discoverer AT3 265/70R17", "Cooper");
    expect(patch.structuredBrand).toBe("Cooper");
    expect(patch.structuredModel).toContain("Discoverer");
    expect(patch.sizeTag).toBe("2657017");
    expect(patch.structuredBy).toBe("deterministic");
  });

  it("never calls an LLM and never throws on junk input", () => {
    const patch = structuredFieldsFor("», amazon.com", "");
    expect(patch.structuredBy).toBe("deterministic");
    expect(patch.structuredBrand).toBeUndefined();
  });

  it("returns an EMPTY patch when the previous stamp is human (never overwrite a human correction)", () => {
    const patch = structuredFieldsFor("Cooper Discoverer AT3 265/70R17", "Cooper", "human");
    expect(patch).toEqual({});
  });

  it("does not overwrite a trusted corpus model with deterministic parsing", () => {
    expect(structuredFieldsFor("Cooper Discoverer AT3 265/70R17", "Cooper", "trusted_corpus")).toEqual({});
  });

  it("re-structures freely when the previous stamp was deterministic or unset", () => {
    expect(structuredFieldsFor("Michelin Defender 225/65R17", "Michelin", "deterministic").structuredBy).toBe(
      "deterministic",
    );
    expect(structuredFieldsFor("Michelin Defender 225/65R17", "Michelin", undefined).structuredBy).toBe(
      "deterministic",
    );
  });

  it("stamps structuredConfidence from the structurer's own confidence", () => {
    const patch = structuredFieldsFor("Cooper Discoverer AT3 265/70R17", "Cooper");
    expect(patch.structuredConfidence).toBe(0.9); // brand + size both found

    const lowConfidence = structuredFieldsFor("Widget Cleaner Pro", "");
    expect(lowConfidence.structuredConfidence).toBeLessThan(0.6); // no brand, no size
  });
});

describe("safeStructuredFieldsFor", () => {
  it("behaves exactly like structuredFieldsFor when nothing throws", () => {
    const patch = safeStructuredFieldsFor("Cooper Discoverer AT3 265/70R17", "Cooper");
    expect(patch.structuredBrand).toBe("Cooper");
    expect(patch.structuredBy).toBe("deterministic");
  });

  it("never throws: a structurer crash returns an empty patch instead", async () => {
    const structurerModule = await import("@/services/polish/structurer");
    const spy = vi.spyOn(structurerModule, "structureProduct").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => safeStructuredFieldsFor("Anything", "Brand")).not.toThrow();
    expect(safeStructuredFieldsFor("Anything", "Brand")).toEqual({});
    spy.mockRestore();
  });
});
