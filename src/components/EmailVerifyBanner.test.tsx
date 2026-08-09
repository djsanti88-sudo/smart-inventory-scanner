import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const resendVerificationEmail = vi.fn(async (..._args: unknown[]) => ({ error: null as string | null }));
vi.mock("@/lib/auth", () => ({ resendVerificationEmail: (...a: unknown[]) => resendVerificationEmail(...a) }));

import { EmailVerifyBanner } from "./EmailVerifyBanner";

const unverifiedPasswordUser: Record<string, unknown> = {
  email: "shop@example.com",
  emailVerified: false,
  providerData: [{ providerId: "password" }],
};

afterEach(() => cleanup());

describe("EmailVerifyBanner", () => {
  beforeEach(() => {
    sessionStorage.clear();
    resendVerificationEmail.mockClear();
    resendVerificationEmail.mockResolvedValue({ error: null });
  });

  it("shows for an unverified password user", () => {
    render(<EmailVerifyBanner user={unverifiedPasswordUser as never} />);
    expect(screen.getByText(/Verify your email/i)).toBeInTheDocument();
    expect(screen.getByText(/shop@example.com/)).toBeInTheDocument();
  });

  it("hides for a verified user", () => {
    render(<EmailVerifyBanner user={{ ...unverifiedPasswordUser, emailVerified: true } as never} />);
    expect(screen.queryByText(/Verify your email/i)).toBeNull();
  });

  it("hides for a Google user regardless of flag", () => {
    render(
      <EmailVerifyBanner
        user={{ ...unverifiedPasswordUser, providerData: [{ providerId: "google.com" }] } as never}
      />,
    );
    expect(screen.queryByText(/Verify your email/i)).toBeNull();
  });

  it("hides when user is null (signed out / mock mode)", () => {
    render(<EmailVerifyBanner user={null} />);
    expect(screen.queryByText(/Verify your email/i)).toBeNull();
  });

  it("resend calls resendVerificationEmail and confirms on success", async () => {
    render(<EmailVerifyBanner user={unverifiedPasswordUser as never} />);
    fireEvent.click(screen.getByRole("button", { name: /resend/i }));
    expect(resendVerificationEmail).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Sent/i)).toBeInTheDocument();
  });

  it("shows a distinct failure state (not Sent) when resend fails, and allows retry", async () => {
    resendVerificationEmail.mockResolvedValueOnce({ error: "network error" });
    render(<EmailVerifyBanner user={unverifiedPasswordUser as never} />);

    fireEvent.click(screen.getByRole("button", { name: /resend/i }));

    expect(await screen.findByText(/Could not send the email\. Try again\./i)).toBeInTheDocument();
    expect(screen.queryByText(/^Sent\.$/)).toBeNull();

    // Button must remain usable for a retry, and a retry can succeed.
    resendVerificationEmail.mockResolvedValueOnce({ error: null });
    fireEvent.click(screen.getByRole("button", { name: /resend/i }));
    await waitFor(() => expect(resendVerificationEmail).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/^Sent\.$/)).toBeInTheDocument();
  });

  it("dismiss hides it and persists for the session", () => {
    const { unmount } = render(<EmailVerifyBanner user={unverifiedPasswordUser as never} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText(/Verify your email/i)).toBeNull();
    unmount();
    render(<EmailVerifyBanner user={unverifiedPasswordUser as never} />);
    expect(screen.queryByText(/Verify your email/i)).toBeNull();
  });
});
