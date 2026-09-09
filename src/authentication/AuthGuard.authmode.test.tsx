// src/components/AuthGuard.authmode.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

const replaceMock = vi.fn();
const pathnameMock = vi.fn(() => "/history");
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => pathnameMock(),
}));

const getSessionMock = vi.fn(async () => null as { uid: string } | null);
const onAuthChangeMock = vi.fn((_cb: (s: unknown) => void) => () => {});
vi.mock("@/authentication/auth", () => ({
  getSession: () => getSessionMock(),
  onAuthChange: (cb: (s: unknown) => void) => onAuthChangeMock(cb),
  isAuthBypassEnabled: () => false,
}));
const isOpenAccess = vi.fn();
vi.mock("@/authentication/service/authMode", () => ({ isOpenAccess: () => isOpenAccess() }));

import { AuthGuard } from "./AuthGuard";

// Mirrors AuthGuard.tsx's AUTH_GUARD_SETTLE_TIMEOUT_MS (not exported; kept in sync by review).
const SETTLE_TIMEOUT_MS = 15_000;

afterEach(() => {
  cleanup();
  replaceMock.mockClear();
  pathnameMock.mockReset().mockReturnValue("/history");
  getSessionMock.mockReset().mockResolvedValue(null);
  onAuthChangeMock.mockReset().mockImplementation(() => () => {});
});

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

describe("AuthGuard deep-link auth restore race (#33b/#34)", () => {
  it("does not bounce to /login when an ambiguous pre-restore null precedes the real settled session", async () => {
    isOpenAccess.mockReturnValue(false);
    pathnameMock.mockReturnValue("/history");

    let resolveSession!: (u: { uid: string } | null) => void;
    getSessionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    );
    // onAuthChange is a second, independent subscription. Simulate it delivering an
    // ambiguous pre-restore "null" tick synchronously, before getSession() has settled.
    onAuthChangeMock.mockImplementation((cb: (s: unknown) => void) => {
      cb(null);
      return () => {};
    });

    render(
      <AuthGuard>
        <div data-testid="child">hi</div>
      </AuthGuard>,
    );

    // The ambiguous onAuthChange(null) tick already fired above; the guard must not have
    // committed to "anon" (and redirected) off that signal alone.
    expect(replaceMock).not.toHaveBeenCalled();

    // getSession() now settles with the real, restored user.
    await act(async () => {
      resolveSession({ uid: "real-user" });
    });

    expect(replaceMock).not.toHaveBeenCalledWith(expect.stringContaining("/login"));
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("appends returnTo with the current path when it does redirect to /login", async () => {
    isOpenAccess.mockReturnValue(false);
    pathnameMock.mockReturnValue("/history");
    getSessionMock.mockResolvedValue(null);
    onAuthChangeMock.mockImplementation(() => () => {});

    await act(async () => {
      render(
        <AuthGuard>
          <div data-testid="child">hi</div>
        </AuthGuard>,
      );
    });

    expect(replaceMock).toHaveBeenCalledWith("/login?returnTo=%2Fhistory");
  });
});

describe("AuthGuard bounded settle timeout (review finding 1: stuck-loading fallback)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not render null forever when getSession() stalls: falls back to the latest onAuthChange value at the settle deadline", () => {
    vi.useFakeTimers();
    isOpenAccess.mockReturnValue(false);

    // getSession() never resolves (simulated SDK stall).
    getSessionMock.mockImplementation(() => new Promise<{ uid: string } | null>(() => {}));
    let authChangeCb: ((s: unknown) => void) | null = null;
    onAuthChangeMock.mockImplementation((cb: (s: unknown) => void) => {
      authChangeCb = cb;
      return () => {};
    });

    render(
      <AuthGuard>
        <div data-testid="child">hi</div>
      </AuthGuard>,
    );

    // Still loading: getSession() has not settled and the deadline has not elapsed.
    expect(screen.queryByTestId("child")).toBeNull();

    // A later onAuthChange tick reports a real signed-in user (still ignored while getSession
    // has not settled, but remembered as the latest-known value for the fallback).
    act(() => {
      authChangeCb?.({ uid: "late-user" });
    });
    expect(screen.queryByTestId("child")).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();

    // The bounded settle deadline elapses: the guard must not hang on "loading" forever.
    act(() => {
      vi.advanceTimersByTime(SETTLE_TIMEOUT_MS);
    });

    expect(screen.getByTestId("child")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("falls back to anon (redirects to /login with returnTo) at the settle deadline when no signal ever arrived", () => {
    vi.useFakeTimers();
    isOpenAccess.mockReturnValue(false);
    pathnameMock.mockReturnValue("/history");

    getSessionMock.mockImplementation(() => new Promise<{ uid: string } | null>(() => {}));
    onAuthChangeMock.mockImplementation(() => () => {});

    render(
      <AuthGuard>
        <div data-testid="child">hi</div>
      </AuthGuard>,
    );

    expect(replaceMock).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(SETTLE_TIMEOUT_MS);
    });

    expect(replaceMock).toHaveBeenCalledWith("/login?returnTo=%2Fhistory");
    expect(screen.queryByTestId("child")).toBeNull();
  });
});
