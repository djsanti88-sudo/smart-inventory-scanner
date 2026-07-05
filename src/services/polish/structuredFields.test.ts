import { describe, it, expect } from "vitest";
import { structuredFieldsFor } from "@/services/polish/structuredFields";

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

  it("re-structures freely when the previous stamp was deterministic or unset", () => {
    expect(structuredFieldsFor("Michelin Defender 225/65R17", "Michelin", "deterministic").structuredBy).toBe(
      "deterministic",
    );
    expect(structuredFieldsFor("Michelin Defender 225/65R17", "Michelin", undefined).structuredBy).toBe(
      "deterministic",
    );
  });
});
