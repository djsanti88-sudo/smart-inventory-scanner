// src/components/AuthGuard.authmode.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn().mockResolvedValue(null),
  onAuthChange: () => () => {},
  isAuthBypassEnabled: () => false,
}));
const isOpenAccess = vi.fn();
vi.mock("@/services/auth/authMode", () => ({ isOpenAccess: () => isOpenAccess() }));

import { AuthGuard } from "./AuthGuard";

afterEach(() => cleanup());

describe("AuthGuard + AUTH_MODE", () => {
  it("renders children immediately in mock/open-access mode", () => {
    isOpenAccess.mockReturnValue(true);
    render(<AuthGuard><div data-testid="child">hi</div></AuthGuard>);
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
  it("hides children (loading) in live mode until a session resolves", () => {
    isOpenAccess.mockReturnValue(false);
    render(<AuthGuard><div data-testid="child">hi</div></AuthGuard>);
    expect(screen.queryByTestId("child")).toBeNull();
  });
});
