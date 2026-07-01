import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DecodeStatusBadge } from "@/components/badges";

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
