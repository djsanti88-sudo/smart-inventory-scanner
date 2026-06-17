import { describe, it, expect } from "vitest";
import { capSnippet, capSnippets, MAX_AI_SNIPPET_CHARS } from "@/services/ai/snippetCap";
import { normalizeResult } from "@/services/ai/provider";
import { verifyEvidence } from "@/services/ai/evidenceVerifier";

describe("snippetCap (W4) - per-snippet cap", () => {
  it("caps a single snippet at MAX_AI_SNIPPET_CHARS (1500)", () => {
    expect(MAX_AI_SNIPPET_CHARS).toBe(1500);
    expect(capSnippet("x".repeat(5000)).length).toBe(1500);
    expect(capSnippet("short")).toBe("short"); // unchanged when under the cap
  });

  it("caps every snippet in a list and tolerates non-arrays", () => {
    const out = capSnippets(["a".repeat(2000), "ok"]);
    expect(out[0].length).toBe(1500);
    expect(out[1]).toBe("ok");
    expect(capSnippets(undefined)).toEqual([]);
    expect(capSnippets(null)).toEqual([]);
  });
});

describe("normalizeResult caps AI-bound snippets (W4)", () => {
  it("caps sourceSnippets and groundingChunks at 1500 chars", () => {
    const r = normalizeResult({
      productName: "Thing",
      sourceSnippets: ["s".repeat(4000)],
      groundingChunks: ["g".repeat(4000)],
      confidence: 0.9,
    });
    expect(r.sourceSnippets?.[0]?.length).toBe(1500);
    expect(r.groundingChunks?.[0]?.length).toBe(1500);
  });

  it("leaves short snippets intact", () => {
    const r = normalizeResult({ productName: "Thing", sourceSnippets: ["UPC 049000028904"], confidence: 0.9 });
    expect(r.sourceSnippets?.[0]).toBe("UPC 049000028904");
  });
});

describe("verifyEvidence keeps FULL fetched text (W4 boundary)", () => {
  it("matches an exact code that appears BEYOND char 1500 in fetchedSourceText (never truncated)", () => {
    const code = "049000028904";
    // Bury the exact code well past the 1500-char snippet cap to prove fetched text is not truncated.
    const fetchedSourceText = "lorem ".repeat(400) + ` product page ${code} in stock`; // > 2400 chars
    expect(fetchedSourceText.length).toBeGreaterThan(1500);
    const r = verifyEvidence(code, "upc_a", { sourceUrls: [], sourceSnippets: [], groundingChunks: [], fetchedSourceText });
    expect(r.verified).toBe(true);
    expect(r.strength).toBe("fetched_source");
  });

  it("still verifies a code present within a snippet (evidence strength behavior preserved)", () => {
    const code = "049000028904";
    const r = verifyEvidence(code, "upc_a", { sourceUrls: [], sourceSnippets: [`Acme Cola UPC ${code} fizzy drink`], groundingChunks: [] });
    expect(r.verified).toBe(true);
    expect(r.strength).toBe("snippet");
  });
});
