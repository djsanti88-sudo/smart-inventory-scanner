import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { GeminiStatusRow } from "@/components/GeminiStatusRow";

// Task 8: the Settings "Fast AI lookup" row must tell the truth - Gemini is permanently out of the
// decode ladder (corpus -> Go-UPC -> Fetch V2 -> GPT only), it is enrichment only. Presentational
// only - reads the already-fetched aiStatus fields, no fetch here.

afterEach(() => cleanup());

describe("GeminiStatusRow", () => {
  it("labels Gemini as not used for decode (enrichment only) when geminiUsedForDecode is false", () => {
    render(<GeminiStatusRow geminiConfigured={true} geminiUsedForDecode={false} />);
    const el = screen.getByTestId("gemini-status");
    expect(el.textContent).toContain("Gemini: not used for decode (enrichment only)");
  });

  it("still shows the not-used-for-decode label even when no key is configured", () => {
    render(<GeminiStatusRow geminiConfigured={false} geminiUsedForDecode={false} />);
    const el = screen.getByTestId("gemini-status");
    expect(el.textContent).toContain("Gemini: not used for decode (enrichment only)");
  });

  it("still shows the not-used-for-decode label even if geminiUsedForDecode is undefined (stale GET response)", () => {
    render(<GeminiStatusRow geminiConfigured={true} geminiUsedForDecode={undefined} />);
    const el = screen.getByTestId("gemini-status");
    expect(el.textContent).toContain("Gemini: not used for decode (enrichment only)");
  });

  it("reflects key-configured status alongside the label", () => {
    render(<GeminiStatusRow geminiConfigured={true} geminiUsedForDecode={false} />);
    expect(screen.getByTestId("gemini-status").textContent).toContain("key configured");
  });

  it("reflects key-missing status alongside the label", () => {
    render(<GeminiStatusRow geminiConfigured={false} geminiUsedForDecode={false} />);
    expect(screen.getByTestId("gemini-status").textContent).toContain("key missing");
  });

  it("uses plain punctuation only, no em dash or en dash (copy rule)", () => {
    render(<GeminiStatusRow geminiConfigured={true} geminiUsedForDecode={false} />);
    const text = screen.getByTestId("gemini-status").textContent ?? "";
    expect(text).not.toMatch(/[–—]/);
  });
});
