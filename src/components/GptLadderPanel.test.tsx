import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { GptLadderPanel } from "@/components/GptLadderPanel";

// Task 6: compact GPT ladder spend/call status for the Settings "Live AI status" section.
// Presentational only - reads the already-fetched aiStatus.gptLadder field, no fetch here.

afterEach(() => cleanup());

describe("GptLadderPanel", () => {
  it('shows spend, cap, call count, and "Enabled" when the ladder budget allows another call', () => {
    render(<GptLadderPanel gptLadder={{ spentTodayUsd: 0.42, capUsd: 3, callsToday: 5, enabled: true }} />);
    const el = screen.getByTestId("gpt-ladder-status");
    expect(el.textContent).toContain("$0.42 of $3.00");
    expect(el.textContent).toContain("5 calls");
    expect(el.textContent).toContain("Enabled");
    expect(el.textContent).not.toContain("Blocked");
  });

  it('shows "Blocked" when enabled is false', () => {
    render(<GptLadderPanel gptLadder={{ spentTodayUsd: 0, capUsd: 3, callsToday: 0, enabled: false }} />);
    const el = screen.getByTestId("gpt-ladder-status");
    expect(el.textContent).toContain("Blocked");
    expect(el.textContent).not.toContain("Enabled");
  });

  it("formats dollar amounts to two decimal places even for sub-cent internal precision", () => {
    render(<GptLadderPanel gptLadder={{ spentTodayUsd: 0.0091, capUsd: 3, callsToday: 1, enabled: true }} />);
    expect(screen.getByTestId("gpt-ladder-status").textContent).toContain("$0.01 of $3.00");
  });

  it("renders nothing when gptLadder is not yet loaded (undefined)", () => {
    render(<GptLadderPanel gptLadder={undefined} />);
    expect(screen.queryByTestId("gpt-ladder-status")).toBeNull();
  });

  it("uses plain punctuation only, no em dash or en dash (copy rule)", () => {
    render(<GptLadderPanel gptLadder={{ spentTodayUsd: 1, capUsd: 3, callsToday: 2, enabled: true }} />);
    const text = screen.getByTestId("gpt-ladder-status").textContent ?? "";
    expect(text).not.toMatch(/[–—]/);
  });
});
