// src/app/login/page.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

const replaceMock = vi.fn();
const searchParamsGetMock = vi.fn((_key: string) => null as string | null);
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => ({ get: (key: string) => searchParamsGetMock(key) }),
}));

const signInWithPasswordMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  ensureWorkspace: vi.fn(),
  signInWithPassword: (...args: unknown[]) => signInWithPasswordMock(...args),
  signUp: vi.fn(),
  signInWithGoogle: vi.fn(),
  sendResetEmail: vi.fn(),
  isAuthBypassEnabled: () => false,
}));

const setSelectedBusinessIdMock = vi.fn();
vi.mock("@/lib/selectedBusiness", () => ({
  setSelectedBusinessId: (...args: unknown[]) => setSelectedBusinessIdMock(...args),
}));

import LoginPage from "./page";

afterEach(() => {
  cleanup();
  replaceMock.mockClear();
  searchParamsGetMock.mockReset().mockReturnValue(null);
  signInWithPasswordMock.mockReset();
  setSelectedBusinessIdMock.mockClear();
});

async function submitLogin() {
  fireEvent.change(screen.getByTestId("login-email"), { target: { value: "a@b.com" } });
  fireEvent.change(screen.getByTestId("login-password"), { target: { value: "secret123" } });
  await act(async () => {
    fireEvent.click(screen.getByTestId("login-button"));
  });
}

describe("Login page returnTo handling (#33b/#34)", () => {
  it("redirects to /scan when no returnTo is present", async () => {
    signInWithPasswordMock.mockResolvedValue({ status: "ready", businessId: "biz-1" });
    render(<LoginPage />);
    await submitLogin();
    expect(replaceMock).toHaveBeenCalledWith("/scan");
  });

  it("honors a valid internal returnTo on successful sign-in", async () => {
    searchParamsGetMock.mockImplementation((key: string) => (key === "returnTo" ? "/history" : null));
    signInWithPasswordMock.mockResolvedValue({ status: "ready", businessId: "biz-1" });
    render(<LoginPage />);
    await submitLogin();
    expect(replaceMock).toHaveBeenCalledWith("/history");
  });

  it("falls back to /scan when returnTo is an external/unsafe URL", async () => {
    searchParamsGetMock.mockImplementation((key: string) =>
      key === "returnTo" ? "https://evil.example/phish" : null,
    );
    signInWithPasswordMock.mockResolvedValue({ status: "ready", businessId: "biz-1" });
    render(<LoginPage />);
    await submitLogin();
    expect(replaceMock).toHaveBeenCalledWith("/scan");
  });

  it("falls back to /scan when returnTo is protocol-relative (//)", async () => {
    searchParamsGetMock.mockImplementation((key: string) =>
      key === "returnTo" ? "//evil.example/phish" : null,
    );
    signInWithPasswordMock.mockResolvedValue({ status: "ready", businessId: "biz-1" });
    render(<LoginPage />);
    await submitLogin();
    expect(replaceMock).toHaveBeenCalledWith("/scan");
  });

  it("falls back to /scan when returnTo contains a backslash (review finding 2)", async () => {
    searchParamsGetMock.mockImplementation((key: string) =>
      key === "returnTo" ? "/\\evil.com" : null,
    );
    signInWithPasswordMock.mockResolvedValue({ status: "ready", businessId: "biz-1" });
    render(<LoginPage />);
    await submitLogin();
    expect(replaceMock).toHaveBeenCalledWith("/scan");
  });
});
