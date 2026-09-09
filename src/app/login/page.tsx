"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ensureWorkspace,
  signInWithPassword,
  signUp,
  signInWithGoogle,
  sendResetEmail,
  isAuthBypassEnabled,
} from "@/authentication/auth";
import { setSelectedBusinessId } from "@/users-businesses/selectedBusiness";
import type { AuthFlowResult } from "@/authentication/service/provisioningTypes";

const DEFAULT_DESTINATION = "/scan";

// A returnTo query param is untrusted input (semantic firewall): only accept an internal
// path (starts with "/", not a protocol-relative "//", no URL scheme) or fall back to /scan.
function resolveReturnTo(raw: string | null): string {
  if (!raw) return DEFAULT_DESTINATION;
  if (!raw.startsWith("/")) return DEFAULT_DESTINATION;
  if (raw.startsWith("//")) return DEFAULT_DESTINATION;
  if (raw.includes("://") || raw.includes("\\")) return DEFAULT_DESTINATION;
  return raw;
}

// Firebase email/password + Google login. In E2E/test bypass mode (never production) the form just routes
// to /scan so existing Playwright specs keep working without a live auth backend.
function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<"signin" | "signup" | "reset">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [workspaceRetry, setWorkspaceRetry] = useState(false);

  function handleAuthResult(result: AuthFlowResult) {
    if (result.status === "ready") {
      setSelectedBusinessId(result.businessId);
      router.replace(resolveReturnTo(searchParams.get("returnTo")));
      return;
    }
    if (result.status === "workspace_failed") {
      setWorkspaceRetry(true);
      setNotice(
        result.accountCreated
          ? "Your account was created, but its workspace still needs setup."
          : "You are signed in, but your workspace still needs setup.",
      );
      return;
    }
    if (result.status === "selection_required") {
      router.replace("/business");
      return;
    }
    if (result.status === "auth_failed") setError(result.error);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    setWorkspaceRetry(false);
    if (isAuthBypassEnabled()) {
      router.replace("/scan");
      return;
    }
    setBusy(true);
    if (mode === "reset") {
      const res = await sendResetEmail(email);
      setBusy(false);
      if (res.error) { setError(res.error); return; }
      setNotice("If that address has an account, a reset link is on its way.");
      return;
    }
    const res = mode === "signup" ? await signUp(email, password) : await signInWithPassword(email, password);
    setBusy(false);
    handleAuthResult(res);
  }

  async function handleGoogle() {
    setError("");
    setNotice("");
    setWorkspaceRetry(false);
    if (isAuthBypassEnabled()) { router.replace("/scan"); return; }
    setBusy(true);
    const res = await signInWithGoogle();
    setBusy(false);
    handleAuthResult(res);
  }

  async function handleWorkspaceRetry() {
    setBusy(true);
    setError("");
    const result = await ensureWorkspace();
    setBusy(false);
    handleAuthResult(result);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-zinc-900">Smart Inventory Scanner</h1>
        <p className="mt-1 text-base text-zinc-600">
          {mode === "signin" ? "Sign in to your account." : mode === "signup" ? "Create an account." : "Reset your password."}
        </p>

        <label className="mt-5 block text-base font-medium text-zinc-800" htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          data-testid="login-email"
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-3 text-base"
        />

        {mode !== "reset" && (
          <>
            <label className="mt-3 block text-base font-medium text-zinc-800" htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="login-password"
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-3 text-base"
            />
          </>
        )}

        {error && <p className="mt-3 text-base text-red-600" data-testid="login-error">{error}</p>}
        {notice && <p className="mt-3 text-base text-green-700" data-testid="login-notice">{notice}</p>}
        {workspaceRetry && (
          <button
            type="button"
            onClick={handleWorkspaceRetry}
            disabled={busy}
            data-testid="workspace-retry"
            className="mt-3 inline-flex min-h-[48px] w-full items-center justify-center rounded-lg border border-blue-300 bg-white px-4 text-base font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50"
          >
            Retry workspace setup
          </button>
        )}

        <button
          type="submit"
          disabled={busy}
          data-testid={mode === "reset" ? "send-reset" : "login-button"}
          className="mt-5 inline-flex min-h-[48px] w-full items-center justify-center rounded-lg bg-blue-600 px-4 text-base font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "Please wait..." : mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}
        </button>

        {mode !== "reset" && (
          <button
            type="button"
            onClick={handleGoogle}
            disabled={busy}
            data-testid="login-google"
            className="mt-3 inline-flex min-h-[48px] w-full items-center justify-center rounded-lg border border-zinc-300 bg-white px-4 text-base font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
          >
            Continue with Google
          </button>
        )}

        <div className="mt-3 flex items-center justify-between text-sm">
          <button
            type="button"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError("");
              setNotice("");
              setWorkspaceRetry(false);
            }}
            className="text-blue-700 hover:underline"
          >
            {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
          </button>
          {mode !== "reset" ? (
            <button
              type="button"
              data-testid="forgot-password"
              onClick={() => {
                setMode("reset");
                setError("");
                setNotice("");
                setWorkspaceRetry(false);
              }}
              className="text-blue-700 hover:underline"
            >
              Forgot password?
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setMode("signin");
                setError("");
                setNotice("");
                setWorkspaceRetry(false);
              }}
              className="text-blue-700 hover:underline"
            >
              Back to sign in
            </button>
          )}
        </div>
      </form>
    </main>
  );
}

// useSearchParams() requires a Suspense boundary during static/production builds.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
