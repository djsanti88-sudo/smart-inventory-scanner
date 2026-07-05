import { describe, expect, it } from "vitest";
import type { StructuredProduct } from "./structurer";
import { polishWithLlm, mockPolishProvider, geminiPolishProvider } from "./llmPolish";

// Manual spy provider (project convention: DI fakes, no vi.mock). Records every prompt it sees.
function spyProvider(reply: string | (() => string)) {
  const prompts: string[] = [];
  const provider = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    return typeof reply === "function" ? reply() : reply;
  };
  return { provider, prompts };
}

function validReply(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    brand: "Michelin",
    model: "Defender T+H",
    descriptionText: "Michelin Defender T+H 205/55R16",
    sizeTag: "2055516",
    sizeTagKind: "tire",
    confidence: 0.85,
    ...overrides,
  });
}

function freshCache(): Map<string, StructuredProduct> {
  return new Map();
}

describe("polishWithLlm - happy path", () => {
  it("parses a strict-JSON reply into a StructuredProduct", async () => {
    const { provider } = spyProvider(validReply());
    const r = await polishWithLlm("Michelin Defender T+H 205/55R16", { provider, cache: freshCache() });
    expect(r).not.toBeNull();
    expect(r?.brand).toBe("Michelin");
    expect(r?.model).toBe("Defender T+H");
    expect(r?.descriptionText).toBe("Michelin Defender T+H 205/55R16");
    expect(r?.sizeTag).toBe("2055516");
    expect(r?.sizeTagKind).toBe("tire");
    expect(r?.confidence).toBe(0.85);
  });

  it("extracts JSON wrapped in a fenced code block with prose around it", async () => {
    const { provider } = spyProvider("Sure! Here you go:\n```json\n" + validReply() + "\n```\nHope that helps.");
    const r = await polishWithLlm("Michelin Defender T+H 205/55R16", { provider, cache: freshCache() });
    expect(r?.brand).toBe("Michelin");
  });
});

describe("polishWithLlm - contained failures (never throw, return null)", () => {
  it("returns null on unparseable JSON", async () => {
    const { provider } = spyProvider("this is not json at all");
    const r = await polishWithLlm("Some Product", { provider, cache: freshCache() });
    expect(r).toBeNull();
  });

  it("returns null when a required field is missing", async () => {
    const reply = JSON.stringify({ brand: "X", model: "Y" }); // missing the rest
    const { provider } = spyProvider(reply);
    const r = await polishWithLlm("Some Product", { provider, cache: freshCache() });
    expect(r).toBeNull();
  });

  it("returns null when a field has the wrong type", async () => {
    const { provider } = spyProvider(validReply({ confidence: "very high" }));
    const r = await polishWithLlm("Some Product", { provider, cache: freshCache() });
    expect(r).toBeNull();
  });

  it("returns null when sizeTagKind is not one of the allowed values", async () => {
    const { provider } = spyProvider(validReply({ sizeTagKind: "banana" }));
    const r = await polishWithLlm("Some Product", { provider, cache: freshCache() });
    expect(r).toBeNull();
  });

  it("returns null when the provider rejects", async () => {
    const provider = async (): Promise<string> => {
      throw new Error("provider down");
    };
    const r = await polishWithLlm("Some Product", { provider, cache: freshCache() });
    expect(r).toBeNull();
  });

  it("returns null for an empty or whitespace-only name without calling the provider", async () => {
    const { provider, prompts } = spyProvider(validReply());
    expect(await polishWithLlm("", { provider, cache: freshCache() })).toBeNull();
    expect(await polishWithLlm("   ", { provider, cache: freshCache() })).toBeNull();
    expect(prompts.length).toBe(0);
  });
});

describe("polishWithLlm - confidence clamping", () => {
  it("clamps confidence above 1 down to 1", async () => {
    const { provider } = spyProvider(validReply({ confidence: 1.7 }));
    const r = await polishWithLlm("Some Product", { provider, cache: freshCache() });
    expect(r?.confidence).toBe(1);
  });

  it("clamps negative confidence up to 0", async () => {
    const { provider } = spyProvider(validReply({ confidence: -0.4 }));
    const r = await polishWithLlm("Some Product", { provider, cache: freshCache() });
    expect(r?.confidence).toBe(0);
  });
});

describe("polishWithLlm - sanitizer runs BEFORE the prompt", () => {
  it("masks emails, phone numbers and labeled prices so they never reach the provider", async () => {
    const dirty = "Widget Pro cost $12.50 call 555-123-4567 email boss@shop.com";
    const { provider, prompts } = spyProvider(validReply({ sizeTag: "", sizeTagKind: "none" }));
    await polishWithLlm(dirty, { provider, cache: freshCache() });
    expect(prompts.length).toBe(1);
    const prompt = prompts[0];
    expect(prompt).not.toContain("boss@shop.com");
    expect(prompt).not.toContain("555-123-4567");
    expect(prompt).not.toContain("$12.50");
    expect(prompt).toContain("[redacted-email]");
    expect(prompt).toContain("[redacted-phone]");
    expect(prompt).toContain("[redacted-cost]");
  });
});

describe("polishWithLlm - tire sizeTag is recomputed deterministically", () => {
  it("prefers the deterministic tire tag over a wrong LLM sizeTag", async () => {
    const { provider } = spyProvider(validReply({ sizeTag: "9999999", sizeTagKind: "none" }));
    const r = await polishWithLlm("Toyo Open Country 265/70R17", { provider, cache: freshCache() });
    expect(r?.sizeTag).toBe("2657017");
    expect(r?.sizeTagKind).toBe("tire");
  });

  it("keeps the LLM sizeTag when the name has no tire size", async () => {
    const { provider } = spyProvider(validReply({ sizeTag: "9.25oz", sizeTagKind: "weight" }));
    const r = await polishWithLlm("Protein Powder Vanilla 9.25 oz", { provider, cache: freshCache() });
    expect(r?.sizeTag).toBe("9.25oz");
    expect(r?.sizeTagKind).toBe("weight");
  });
});

describe("polishWithLlm - cache", () => {
  it("cache hit skips the provider entirely", async () => {
    const cache = freshCache();
    const cached: StructuredProduct = {
      brand: "Cached",
      model: "Result",
      descriptionText: "Cached Result",
      sizeTag: "",
      sizeTagKind: "none",
      confidence: 0.75,
    };
    cache.set("Cached Result", cached);
    const { provider, prompts } = spyProvider(validReply());
    const r = await polishWithLlm("Cached Result", { provider, cache });
    expect(prompts.length).toBe(0); // provider NOT called
    expect(r?.brand).toBe("Cached");
  });

  it("cache miss calls the provider once and caches the result for next time", async () => {
    const cache = freshCache();
    const { provider, prompts } = spyProvider(validReply());
    const first = await polishWithLlm("Michelin Defender T+H 205/55R16", { provider, cache });
    const second = await polishWithLlm("Michelin Defender T+H 205/55R16", { provider, cache });
    expect(prompts.length).toBe(1); // second call served from cache
    expect(first?.brand).toBe("Michelin");
    expect(second?.brand).toBe("Michelin");
  });

  it("does NOT cache a failed (null) polish so a later retry can succeed", async () => {
    const cache = freshCache();
    let calls = 0;
    const provider = async (): Promise<string> => {
      calls++;
      return calls === 1 ? "garbage" : validReply();
    };
    const first = await polishWithLlm("Some Product", { provider, cache });
    const second = await polishWithLlm("Some Product", { provider, cache });
    expect(first).toBeNull();
    expect(second?.brand).toBe("Michelin");
    expect(calls).toBe(2);
  });
});

describe("mockPolishProvider - deterministic canned splits, no network", () => {
  it("produces a reply that polishWithLlm parses into a StructuredProduct", async () => {
    const provider = mockPolishProvider();
    const r = await polishWithLlm("Falken Wildpeak AT3W 265/70R17", { provider, cache: freshCache() });
    expect(r).not.toBeNull();
    expect(r?.brand).toBe("Falken");
    expect(r?.descriptionText).toContain("Wildpeak");
    // deterministic tire recompute still applies on top of the mock
    expect(r?.sizeTag).toBe("2657017");
    expect(r?.sizeTagKind).toBe("tire");
  });

  it("is deterministic: same input always yields the same reply", async () => {
    const provider = mockPolishProvider();
    const a = await provider("Product name: \"\"\"Widget Cleaner Pro\"\"\"");
    const b = await provider("Product name: \"\"\"Widget Cleaner Pro\"\"\"");
    expect(a).toBe(b);
  });
});

describe("geminiPolishProvider - defined but NEVER constructed in tests", () => {
  it("is exported as a factory function (not constructed here - no live network in tests)", () => {
    expect(typeof geminiPolishProvider).toBe("function");
  });
});
