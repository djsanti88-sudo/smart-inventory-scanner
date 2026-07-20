import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

const sendResetEmail = vi.fn();
const signInWithGoogle = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/auth", () => ({
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  signInWithGoogle: (...a: unknown[]) => signInWithGoogle(...a),
  sendResetEmail: (...a: unknown[]) => sendResetEmail(...a),
  isAuthBypassEnabled: () => false,
}));

import LoginPage from "./page";

beforeEach(() => { sendResetEmail.mockReset(); signInWithGoogle.mockReset(); });
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
    signInWithGoogle.mockResolvedValue({ error: null });
    render(<LoginPage />);
    fireEvent.click(screen.getByTestId("login-google"));
    await waitFor(() => expect(signInWithGoogle).toHaveBeenCalledOnce());
  });
});
