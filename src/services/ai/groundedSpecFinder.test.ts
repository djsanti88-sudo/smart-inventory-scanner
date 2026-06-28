import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseSpecResponse, groundedSpecFind, GROUNDED_SPEC_GEMINI_MODEL } from "./groundedSpecFinder";

describe("groundedSpecFinder identity parse (pure)", () => {
  it("anchors the brand and builds productName from brand+model+size", () => {
    const out = parseSpecResponse({ brand: "WRONGBRAND", model: "Discoverer AT3", size: "245/75R16" }, "Cooper");
    expect(out.result?.brand).toBe("Cooper"); // anchor wins over the model's brand
    expect(out.result?.productName).toContain("Discoverer AT3");
    expect(out.result?.productName).toContain("245/75R16");
  });
  it("returns null when there is no model and no size", () => {
    expect(parseSpecResponse({ brand: "Cooper" }, "Cooper").result).toBeNull();
  });
});

it("mines the size from the model/description when the size field is empty", () => {
  const json = { brand: "Toyo", model: "Open Country A/T III 265/70R17", size: "" };
  const { result } = parseSpecResponse(json, "Toyo");
  expect(result).not.toBeNull();
  expect(result!.specsShort).toContain("265/70R17");
});

it("still prefers an explicit size field when present", () => {
  const json = { brand: "Toyo", model: "Open Country", size: "265/70R17" };
  const { result } = parseSpecResponse(json, "Toyo");
  expect(result!.specsShort).toContain("265/70R17");
});

it("defaults to a live Gemini model, not the retired gemini-2.0-flash-001", () => {
  expect(GROUNDED_SPEC_GEMINI_MODEL).not.toBe("gemini-2.0-flash-001");
  expect(GROUNDED_SPEC_GEMINI_MODEL).toMatch(/^gemini-2\.5-flash/);
});

describe("groundedSpecFind live request config", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GEMINI_API_KEY;
  });

  it("disables thinking so the 3s grounded call can actually finish", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        body = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ candidates: [{ content: { parts: [{ text: "{}" }] }, groundingMetadata: {} }] }),
          text: async () => "",
        } as unknown as Response;
      }),
    );
    await groundedSpecFind({ code: "012345678905", anchorBrand: "Cooper" });
    const gc = (body.generationConfig ?? {}) as Record<string, unknown>;
    expect(gc.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });
});
