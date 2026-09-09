import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DecodeStatusBadge, StatusBadge, SyncBadge } from "@/user-interface/ui/badges";

// Plan C, Task 1 (presentational only): collapse the weak decode states into a single
// user-facing "Suggested" label. needs_review and conflict must both read "Suggested";
// verified must still read distinctly as "Verified" (kept as "Verified match"). This does
// NOT change the underlying decodeStatus enum or any counting/gating logic - labels only.

afterEach(() => cleanup());

describe("DecodeStatusBadge - Suggested relabel (Plan C Task 1)", () => {
  it('renders "Suggested" for decodeStatus "needs_review"', () => {
    render(<DecodeStatusBadge status="needs_review" />);
    expect(screen.getByText("Suggested")).toBeTruthy();
    expect(screen.queryByText(/Needs review/i)).toBeNull();
  });

  it('renders "Suggested" for decodeStatus "conflict"', () => {
    render(<DecodeStatusBadge status="conflict" />);
    expect(screen.getByText("Suggested")).toBeTruthy();
    expect(screen.queryByText(/^Conflict$/i)).toBeNull();
  });

  it('renders "Verified" (distinct from Suggested) for decodeStatus "verified"', () => {
    render(<DecodeStatusBadge status="verified" />);
    expect(screen.getByText(/Verified/)).toBeTruthy();
    expect(screen.queryByText("Suggested")).toBeNull();
  });
});

// P5 Task 5 (honest provenance badges, 2026-07-20): a bare model/API self-report can never mint an
// app-verified identity (see decode-trust plan). The badge must make that distinction VISIBLE:
// app-verified exact-code decodes read "Verified (app-confirmed)"; a GPT self-report suggestion
// reads "Suggested (AI)"; a Go-UPC self-report suggestion reads "Suggested (DB)". A plain verified
// row with no provenance signal (older rows, pre-P5 write sites) must still render a working
// "Verified" label so nothing existing breaks. Additive `provenance` prop only - no enum/logic change.
describe("DecodeStatusBadge - honest provenance labels (P5 Task 5)", () => {
  it('renders "Verified (app-confirmed)" for an app-verified exact-code decode', () => {
    render(<DecodeStatusBadge status="verified" provenance="app_verified" />);
    expect(screen.getByText("Verified (app-confirmed)")).toBeTruthy();
  });

  it('renders "Suggested (AI)" for a GPT self-report provenance', () => {
    render(<DecodeStatusBadge status="suggested" provenance="ai_self_report" />);
    expect(screen.getByText("Suggested (AI)")).toBeTruthy();
    expect(screen.queryByText(/^Suggested$/)).toBeNull();
  });

  it('renders "Suggested (DB)" for a Go-UPC (paid-DB) self-report provenance', () => {
    render(<DecodeStatusBadge status="suggested" provenance="db_self_report" />);
    expect(screen.getByText("Suggested (DB)")).toBeTruthy();
    expect(screen.queryByText(/^Suggested$/)).toBeNull();
  });

  it('renders a generic "Suggested" when status is suggested with no provenance signal', () => {
    render(<DecodeStatusBadge status="suggested" />);
    expect(screen.getByText("Suggested")).toBeTruthy();
  });

  it('renders a plain "Verified" for a verified row with no provenance signal (back-compat)', () => {
    render(<DecodeStatusBadge status="verified" />);
    expect(screen.getByText(/Verified/)).toBeTruthy();
    expect(screen.queryByText("Verified (app-confirmed)")).toBeNull();
  });

  it("never uses an em dash or en dash in any provenance label", () => {
    const cases: Array<["verified" | "suggested", "app_verified" | "ai_self_report" | "db_self_report" | undefined]> = [
      ["verified", "app_verified"],
      ["suggested", "ai_self_report"],
      ["suggested", "db_self_report"],
      ["suggested", undefined],
      ["verified", undefined],
    ];
    for (const [status, provenance] of cases) {
      cleanup();
      render(<DecodeStatusBadge status={status} provenance={provenance} />);
      const el = screen.getByTestId("decode-row-status");
      expect(el.textContent).not.toMatch(/[–—]/);
    }
  });
});

// Task 9b fix (reviewer finding): StatusBadge must tolerate the parked review status "suggested" -
// a real label + real classes, never an empty label with a literal "undefined" className. Defense
// in depth: NeedsReviewTable filters suggested reviews out, but any future surface that renders one
// must not show a broken badge.
describe("StatusBadge - tolerates the parked 'suggested' review status (Task 9b)", () => {
  it('renders a real "Suggested" label with no undefined className for status "suggested"', () => {
    render(<StatusBadge status="suggested" />);
    const el = screen.getByText("Suggested");
    expect(el).toBeTruthy();
    expect(el.className).not.toContain("undefined");
    expect(el.className.trim().length).toBeGreaterThan(0);
  });
});

describe("SyncBadge - explicit local-save labels", () => {
  it("renders exact pending copy for locally saved work waiting to sync", () => {
    render(<SyncBadge status="pending" />);
    expect(screen.getByTestId("sync-badge").textContent).toBe("Saved on this device, waiting to sync");
  });

  it("renders exact error copy for locally saved work that failed to sync", () => {
    render(<SyncBadge status="error" />);
    expect(screen.getByTestId("sync-badge").textContent).toBe("Saved on this device, sync failed");
  });
});
