import { describe, it, expect } from "vitest";
import { buildLookupPrompt } from "@/services/ai/prompt";
import type { AiLookupRequest } from "@/services/ai/provider";
import { formatGs1Hint, GS1_HINT_DISCLAIMER } from "@/services/gs1Prefixes";

const req = (over: Partial<AiLookupRequest>): AiLookupRequest => ({
  rawCodeSanitized: "",
  cleanCodeSanitized: "",
  ...over,
});

function section(prompt: string, tag: string): string {
  const start = prompt.indexOf(`<${tag}>`);
  const end = prompt.indexOf(`</${tag}>`);
  return start >= 0 && end > start ? prompt.slice(start, end) : "";
}

describe("buildLookupPrompt - GS1 region hint (W3)", () => {
  it("injects the GS1 hint into trusted_context for a public barcode with a mapped prefix", () => {
    const hint = formatGs1Hint("855724007602", "upc_a"); // US/Canada region
    expect(hint).toBeTruthy();
    const prompt = buildLookupPrompt(req({ cleanCodeSanitized: "855724007602", gs1RegionHint: hint! }));
    const trusted = section(prompt, "trusted_context");
    expect(trusted).toContain("GS1 prefix region:");
    expect(trusted).toContain("United States and Canada");
    expect(trusted).toContain(GS1_HINT_DISCLAIMER);
  });

  it("states the exact non-authoritative disclaimer in the prompt", () => {
    const prompt = buildLookupPrompt(
      req({ cleanCodeSanitized: "4001234567894", gs1RegionHint: formatGs1Hint("4001234567894", "ean_13")! }),
    );
    expect(prompt).toContain(
      "GS1 numbering authority region only - not country of manufacture, not brand, and not product identity.",
    );
  });

  it("omits any GS1 hint when none applies (vendor label / SKU / unmapped prefix)", () => {
    const cases: ReadonlyArray<readonly [string, "vendor_label" | "alpha_sku" | "ean_13"]> = [
      ["X004DY7YUT", "vendor_label"],
      ["ABC-123", "alpha_sku"],
      ["3901234567890", "ean_13"], // prefix 390 is intentionally unmapped -> null
    ];
    for (const [code, type] of cases) {
      expect(formatGs1Hint(code, type)).toBeNull();
      const prompt = buildLookupPrompt(req({ cleanCodeSanitized: code, gs1RegionHint: formatGs1Hint(code, type) ?? undefined }));
      expect(prompt).not.toContain("GS1 prefix region:");
    }
  });

  it("never places the GS1 hint inside untrusted_input (kept to app-derived trusted context only)", () => {
    const prompt = buildLookupPrompt(
      req({ cleanCodeSanitized: "855724007602", gs1RegionHint: formatGs1Hint("855724007602", "upc_a")! }),
    );
    expect(section(prompt, "untrusted_input")).not.toContain("GS1 prefix region:");
  });
});

describe("buildLookupPrompt - Phase 8B scan-context + brand-prefix hints", () => {
  it("injects the tire scan-context instruction into trusted_context when scanContext is tire", () => {
    const trusted = section(buildLookupPrompt(req({ cleanCodeSanitized: "745125495781", scanContext: "tire" })), "trusted_context");
    expect(trusted).toContain("TIRE inventory");
    expect(trusted.toLowerCase()).toContain("non-tire");
  });

  it("injects a NON-AUTHORITATIVE learned brand-prefix hint when provided", () => {
    const trusted = section(
      buildLookupPrompt(req({ cleanCodeSanitized: "745125495781", brandPrefixHint: 'candidate prefix 0745125 has previously been human-approved for brand "fortune" in this business' })),
      "trusted_context",
    );
    expect(trusted).toContain("0745125");
    expect(trusted).toContain("NON-AUTHORITATIVE");
    expect(trusted.toLowerCase()).toContain("not identity truth");
  });

  it("omits the hints when not provided (default context, no learned hint)", () => {
    const prompt = buildLookupPrompt(req({ cleanCodeSanitized: "745125495781" }));
    expect(prompt).not.toContain("TIRE inventory");
    expect(prompt).not.toContain("Business catalog hint");
  });

  it("keeps the GS1 disclaimer alongside the new tire hint", () => {
    const prompt = buildLookupPrompt(req({ cleanCodeSanitized: "855724007602", gs1RegionHint: formatGs1Hint("855724007602", "upc_a")!, scanContext: "tire" }));
    expect(prompt).toContain("GS1 numbering authority region only");
    expect(prompt).toContain("TIRE inventory");
  });
});
