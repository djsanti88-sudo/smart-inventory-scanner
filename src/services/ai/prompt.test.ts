import { describe, it, expect } from "vitest";
import { buildLookupPrompt } from "@/services/ai/prompt";

// The decode prompt drives BOTH providers (Gemini Flash + ChatGPT mini). The owner's rule:
// the FIRST web search must be the bare scanned number by itself on google.com (no extra words),
// then a dashes-removed alias search, then other routes. These tests pin that procedure.

describe("buildLookupPrompt search procedure (bare number first on google.com)", () => {
  it("tells the model to FIRST search google.com for the exact code BY ITSELF with no other words", () => {
    const p = buildLookupPrompt({ rawCodeSanitized: "078742051451", cleanCodeSanitized: "078742051451" });
    expect(p).toMatch(/google\.com/i);
    expect(p).toMatch(/BY ITSELF/i);
    expect(p).toMatch(/NO other words/i);
    // the concrete bare code is embedded so the instruction is unambiguous
    expect(p).toContain('"078742051451"');
  });

  it("falls back to a dashes/separators-removed alias search before any other route", () => {
    const p = buildLookupPrompt({ rawCodeSanitized: "2881-6861", cleanCodeSanitized: "2881-6861" });
    expect(p).toMatch(/remove the dashes|dashes\/separators/i);
    expect(p).toContain('"28816861"'); // dashes removed
    // other routes (barcode DBs / retailer pages) come only AFTER the two bare-code searches
    expect(p).toMatch(/Only if both bare-code searches fail/i);
  });

  it("still instructs to trust a result only when the page shows the exact code", () => {
    const p = buildLookupPrompt({ rawCodeSanitized: "049000028904", cleanCodeSanitized: "049000028904" });
    expect(p).toMatch(/exact scanned code|exact code/i);
  });
});
