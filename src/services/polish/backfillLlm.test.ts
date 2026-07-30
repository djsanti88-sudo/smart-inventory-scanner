import { describe, it, expect } from "vitest";
import { isLlmEligible, backfillWithLlm, LLM_ELIGIBLE_CONFIDENCE_THRESHOLD } from "@/services/polish/backfillLlm";
import type { StructuredProduct } from "@/services/polish/structurer";
import type { Product } from "@/types";

function product(over: Partial<Product> & { id: string }): Product {
  return {
    businessId: "b", name: "X", brand: "", category: "", specsShort: "", specsFull: "",
    primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [],
    imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "manual",
    confidence: 1, verified: true, createdAt: "t", updatedAt: "t", createdBy: "seed", updatedBy: "seed",
    ...over,
  };
}

// Manual spy provider (project convention: DI fakes, no vi.mock/live construction of geminiPolishProvider).
function spyProvider(reply: string | (() => string)) {
  const prompts: string[] = [];
  const provider = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    return typeof reply === "function" ? reply() : reply;
  };
  return { provider, prompts };
}

function llmReply(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    brand: "Acme",
    model: "Widget Pro",
    descriptionText: "Acme Widget Pro",
    sizeTag: "",
    sizeTagKind: "none",
    confidence: 0.8,
    ...overrides,
  });
}

describe("isLlmEligible", () => {
  it("is NOT eligible when never structured (no structuredConfidence yet)", () => {
    expect(isLlmEligible(product({ id: "p1" }))).toBe(false);
  });

  it("is NOT eligible when structuredBy is human, regardless of confidence", () => {
    expect(isLlmEligible(product({ id: "p2", structuredBy: "human", structuredConfidence: 0.1 }))).toBe(false);
  });

  it("is NOT eligible when structuredBy is trusted_corpus, regardless of confidence", () => {
    expect(isLlmEligible(product({ id: "p-corpus", structuredBy: "trusted_corpus", structuredConfidence: 0.1 }))).toBe(false);
  });

  it("is NOT eligible when confidence is at or above the threshold", () => {
    expect(
      isLlmEligible(
        product({ id: "p3", structuredBy: "deterministic", structuredConfidence: LLM_ELIGIBLE_CONFIDENCE_THRESHOLD }),
      ),
    ).toBe(false);
    expect(isLlmEligible(product({ id: "p4", structuredBy: "deterministic", structuredConfidence: 0.9 }))).toBe(
      false,
    );
  });

  it("IS eligible when structured deterministically with confidence below the threshold", () => {
    expect(isLlmEligible(product({ id: "p5", structuredBy: "deterministic", structuredConfidence: 0.4 }))).toBe(
      true,
    );
  });
});

describe("backfillWithLlm", () => {
  it("skips ineligible rows entirely - the provider is never called for them", async () => {
    const { provider, prompts } = spyProvider(llmReply());
    const eligible = product({ id: "e1", name: "Widget Cleaner Pro", structuredBy: "deterministic", structuredConfidence: 0.4 });
    const human = product({ id: "h1", name: "Weird Name", structuredBy: "human", structuredConfidence: 0.1 });
    const highConfidence = product({ id: "hc1", name: "Cooper Tire", structuredBy: "deterministic", structuredConfidence: 0.9 });

    const { products, eligibleIds, llmChangedIds } = await backfillWithLlm(
      [eligible, human, highConfidence],
      { provider, cache: new Map<string, StructuredProduct>() },
    );

    expect(eligibleIds).toEqual(["e1"]);
    expect(prompts.length).toBe(1); // provider called ONCE, only for the eligible row
    expect(llmChangedIds).toEqual(["e1"]);
    expect(products.find((p) => p.id === "h1")).toEqual(human); // untouched
    expect(products.find((p) => p.id === "hc1")).toEqual(highConfidence); // untouched
  });

  it("stamps a successful LLM polish as structuredBy llm with the LLM's confidence", async () => {
    const { provider } = spyProvider(llmReply({ confidence: 0.85 }));
    const eligible = product({ id: "e2", name: "Widget Cleaner Pro", structuredBy: "deterministic", structuredConfidence: 0.4 });

    const { products } = await backfillWithLlm([eligible], { provider, cache: new Map<string, StructuredProduct>() });

    const after = products.find((p) => p.id === "e2")!;
    expect(after.structuredBrand).toBe("Acme");
    expect(after.structuredModel).toBe("Widget Pro");
    expect(after.structuredBy).toBe("llm");
    expect(after.structuredConfidence).toBe(0.85);
  });

  it("a failed/null LLM polish leaves the row exactly as the deterministic pass left it", async () => {
    const { provider } = spyProvider("not valid json");
    const eligible = product({
      id: "e3", name: "Widget Cleaner Pro", structuredBy: "deterministic", structuredConfidence: 0.4,
      structuredBrand: undefined,
    });

    const { products, llmChangedIds } = await backfillWithLlm([eligible], {
      provider,
      cache: new Map<string, StructuredProduct>(),
    });

    expect(llmChangedIds).toEqual([]);
    expect(products.find((p) => p.id === "e3")).toEqual(eligible); // untouched
  });

  it("the deterministic tire sizeTag still overrides an LLM guess (polishWithLlm's own recompute)", async () => {
    const { provider } = spyProvider(llmReply({ sizeTag: "9999999", sizeTagKind: "none" }));
    const eligible = product({
      id: "e4", name: "Toyo Open Country 265/70R17", structuredBy: "deterministic", structuredConfidence: 0.4,
    });

    const { products } = await backfillWithLlm([eligible], { provider, cache: new Map<string, StructuredProduct>() });

    const after = products.find((p) => p.id === "e4")!;
    expect(after.sizeTag).toBe("2657017");
  });
});
