import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { KillSwitchBanner } from "@/components/KillSwitchBanner";

// Spec 2 (M1, kill-switch visibility): a shop owner must be able to tell "the SERVER has AI locked
// down (AI_LOOKUP_KILL_SWITCH)" apart from "I paused this myself (emergencyStop)". This banner renders
// ONLY the server condition; it is presentational (no fetch), reading the already-refreshed aiStatus.

afterEach(() => cleanup());

describe("KillSwitchBanner", () => {
  it("renders nothing when killSwitchOn is false", () => {
    render(<KillSwitchBanner killSwitchOn={false} />);
    expect(screen.queryByTestId("kill-switch-banner")).toBeNull();
  });

  it("renders a visible banner when killSwitchOn is true", () => {
    render(<KillSwitchBanner killSwitchOn={true} />);
    expect(screen.getByTestId("kill-switch-banner")).toBeInTheDocument();
  });

  it("explains scans still count and identity lookup is paused, not that scanning itself is broken", () => {
    render(<KillSwitchBanner killSwitchOn={true} />);
    const text = screen.getByTestId("kill-switch-banner").textContent ?? "";
    expect(text.toLowerCase()).toContain("scans still count");
    expect(text.toLowerCase()).toMatch(/needs review|paused/);
  });

  it("uses plain punctuation only, no em dash or en dash (copy rule)", () => {
    render(<KillSwitchBanner killSwitchOn={true} />);
    const text = screen.getByTestId("kill-switch-banner").textContent ?? "";
    expect(text).not.toMatch(/[–—]/);
  });
});
