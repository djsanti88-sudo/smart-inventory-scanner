import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { GptDecodePanel } from "@/decoding/panel/GptDecodePanel";

// Task 6: compact GPT decode spend/call status for the Settings "Live AI status" section.
// Presentational only - reads the already-fetched aiStatus.gptDecode field, no fetch here.

afterEach(() => cleanup());

describe("GptDecodePanel", () => {
  it('shows spend, cap, call count, and "Enabled" when the ladder budget allows another call', () => {
    render(<GptDecodePanel gptDecode={{ spentTodayUsd: 0.42, capUsd: 3, callsToday: 5, enabled: true }} />);
    const el = screen.getByTestId("gpt-decode-status");
    expect(el.textContent).toContain("$0.42 of $3.00");
    expect(el.textContent).toContain("5 calls");
    expect(el.textContent).toContain("Enabled");
    expect(el.textContent).not.toContain("Blocked");
  });

  it('shows "Blocked (no key)" when disabled with budget headroom', () => {
    render(<GptDecodePanel gptDecode={{ spentTodayUsd: 0, capUsd: 3, callsToday: 0, enabled: false }} />);
    const el = screen.getByTestId("gpt-decode-status");
    expect(el.textContent).toContain("Blocked (no key)");
    expect(el.textContent).not.toContain("Enabled");
  });

  it('shows "Blocked (daily cap reached)" when the next worst-case call would not fit', () => {
    render(<GptDecodePanel gptDecode={{ spentTodayUsd: 2.75, capUsd: 3, callsToday: 9, enabled: false }} />);
    expect(screen.getByTestId("gpt-decode-status").textContent).toContain("Blocked (daily cap reached)");
  });

  it("formats dollar amounts to two decimal places even for sub-cent internal precision", () => {
    render(<GptDecodePanel gptDecode={{ spentTodayUsd: 0.0091, capUsd: 3, callsToday: 1, enabled: true }} />);
    expect(screen.getByTestId("gpt-decode-status").textContent).toContain("$0.01 of $3.00");
  });

  it("renders nothing when gptDecode is not yet loaded (undefined)", () => {
    render(<GptDecodePanel gptDecode={undefined} />);
    expect(screen.queryByTestId("gpt-decode-status")).toBeNull();
  });

  it("uses plain punctuation only, no em dash or en dash (copy rule)", () => {
    render(<GptDecodePanel gptDecode={{ spentTodayUsd: 1, capUsd: 3, callsToday: 2, enabled: true }} />);
    const text = screen.getByTestId("gpt-decode-status").textContent ?? "";
    expect(text).not.toMatch(/[–—]/);
  });
});
