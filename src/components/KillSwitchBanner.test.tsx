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

  // Silent-failure fix (review of 92e9c32c): when the server status could not be confirmed (a
  // failed refreshAiStatus), the banner must not silently render nothing as if AI is fine - it
  // must show a muted "could not confirm" note instead of assuming off.
  describe("statusUnknown (silent-failure fix)", () => {
    it("shows a muted 'could not confirm' note when statusUnknown is true and killSwitchOn is false", () => {
      render(<KillSwitchBanner killSwitchOn={false} statusUnknown={true} />);
      expect(screen.queryByTestId("kill-switch-banner")).toBeNull();
      const note = screen.getByTestId("kill-switch-status-unknown");
      expect(note).toBeInTheDocument();
      expect(note.textContent ?? "").toMatch(/could not confirm/i);
    });

    it("renders nothing when statusUnknown is false/omitted and killSwitchOn is false (unchanged default)", () => {
      render(<KillSwitchBanner killSwitchOn={false} />);
      expect(screen.queryByTestId("kill-switch-banner")).toBeNull();
      expect(screen.queryByTestId("kill-switch-status-unknown")).toBeNull();
    });

    it("prefers the confirmed red banner over the muted note when killSwitchOn is true, even if statusUnknown is also true", () => {
      render(<KillSwitchBanner killSwitchOn={true} statusUnknown={true} />);
      expect(screen.getByTestId("kill-switch-banner")).toBeInTheDocument();
      expect(screen.queryByTestId("kill-switch-status-unknown")).toBeNull();
    });

    it("the muted note also uses plain punctuation only (copy rule)", () => {
      render(<KillSwitchBanner killSwitchOn={false} statusUnknown={true} />);
      const text = screen.getByTestId("kill-switch-status-unknown").textContent ?? "";
      expect(text).not.toMatch(/[–—]/);
    });
  });
});
