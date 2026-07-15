import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DecodeStatusBadge, StatusBadge } from "@/components/badges";

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
