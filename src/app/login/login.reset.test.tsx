import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

const { sendResetEmail, signInWithGoogle, signUp, signInWithPassword, ensureWorkspace, replace } = vi.hoisted(() => ({
  sendResetEmail: vi.fn(),
  signInWithGoogle: vi.fn(),
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  ensureWorkspace: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => ({ get: () => null }),
}));
vi.mock("@/authentication/auth", () => ({
  signInWithPassword: (...a: unknown[]) => signInWithPassword(...a),
  signUp: (...a: unknown[]) => signUp(...a),
  signInWithGoogle: (...a: unknown[]) => signInWithGoogle(...a),
  sendResetEmail: (...a: unknown[]) => sendResetEmail(...a),
  ensureWorkspace: (...a: unknown[]) => ensureWorkspace(...a),
  isAuthBypassEnabled: () => false,
}));

import LoginPage from "./page";

beforeEach(() => {
  sendResetEmail.mockReset();
  signInWithGoogle.mockReset();
  signUp.mockReset();
  signInWithPassword.mockReset();
  ensureWorkspace.mockReset();
  replace.mockReset();
});
afterEach(() => cleanup());

describe("login page reset + google", () => {
  it("shows a confirmation notice after requesting a reset", async () => {
    sendResetEmail.mockResolvedValue({ error: null });
    render(<LoginPage />);
    fireEvent.change(screen.getByTestId("login-email"), { target: { value: "a@b.co" } });
    fireEvent.click(screen.getByTestId("forgot-password"));
    fireEvent.click(screen.getByTestId("send-reset"));
    await waitFor(() => expect(sendResetEmail).toHaveBeenCalledWith("a@b.co"));
    expect(await screen.findByTestId("login-notice")).toBeInTheDocument();
  });

  it("calls Google sign-in when the Google button is clicked", async () => {
    signInWithGoogle.mockResolvedValue({
      status: "ready",
      accountCreated: false,
      businessId: "business-1",
      error: null,
    });
    render(<LoginPage />);
    fireEvent.click(screen.getByTestId("login-google"));
    await waitFor(() => expect(signInWithGoogle).toHaveBeenCalledOnce());
  });

  it("shows a repair action when account creation succeeds but workspace setup fails", async () => {
    signUp.mockResolvedValue({
      status: "workspace_failed",
      accountCreated: true,
      businessId: null,
      error: "Your account is ready, but workspace setup did not finish.",
    });
    render(<LoginPage />);
    fireEvent.click(screen.getByText("Need an account? Sign up"));
    fireEvent.change(screen.getByTestId("login-email"), { target: { value: "a@b.co" } });
    fireEvent.change(screen.getByTestId("login-password"), { target: { value: "password" } });
    fireEvent.click(screen.getByTestId("login-button"));

    expect(await screen.findByTestId("workspace-retry")).toBeInTheDocument();
    expect(screen.getByTestId("login-notice")).toHaveTextContent(
      "Your account was created, but its workspace still needs setup.",
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it("retries workspace setup without asking the user to sign in again", async () => {
    signUp.mockResolvedValue({
      status: "workspace_failed",
      accountCreated: true,
      businessId: null,
      error: "Your account is ready, but workspace setup did not finish.",
    });
    ensureWorkspace.mockResolvedValue({
      status: "ready",
      accountCreated: false,
      businessId: "business-1",
      error: null,
    });
    render(<LoginPage />);
    fireEvent.click(screen.getByText("Need an account? Sign up"));
    fireEvent.change(screen.getByTestId("login-email"), { target: { value: "a@b.co" } });
    fireEvent.change(screen.getByTestId("login-password"), { target: { value: "password" } });
    fireEvent.click(screen.getByTestId("login-button"));
    fireEvent.click(await screen.findByTestId("workspace-retry"));

    await waitFor(() => expect(ensureWorkspace).toHaveBeenCalledOnce());
    expect(replace).toHaveBeenCalledWith("/scan");
  });

  it("does not show an error or navigate when the Google popup is closed", async () => {
    signInWithGoogle.mockResolvedValue({
      status: "cancelled",
      accountCreated: false,
      businessId: null,
      error: null,
    });
    render(<LoginPage />);
    fireEvent.click(screen.getByTestId("login-google"));
    await waitFor(() => expect(signInWithGoogle).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("login-error")).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("routes ambiguous multi-business users to the selector", async () => {
    signInWithPassword.mockResolvedValue({
      status: "selection_required",
      accountCreated: false,
      businessId: null,
      businessIds: ["business-1", "business-2"],
      error: null,
    });
    render(<LoginPage />);
    fireEvent.change(screen.getByTestId("login-email"), { target: { value: "a@b.co" } });
    fireEvent.change(screen.getByTestId("login-password"), { target: { value: "password" } });
    fireEvent.click(screen.getByTestId("login-button"));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/business"));
    expect(replace).not.toHaveBeenCalledWith("/scan");
  });
});
