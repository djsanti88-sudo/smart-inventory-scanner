"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithPassword, signUp, isAuthBypassEnabled } from "@/lib/auth";

// Supabase email/password login for the launch MVP. In E2E/test bypass mode (never production) the form
// just routes to /scan so existing Playwright specs keep working without a live auth backend.
export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    if (isAuthBypassEnabled()) {
      router.replace("/scan");
      return;
    }
    setBusy(true);
    const res = mode === "signup" ? await signUp(email, password) : await signInWithPassword(email, password);
    setBusy(false);
    if (res.error) {
      setError(res.error.message);
      return;
    }
    if (mode === "signup" && !res.data.session) {
      setNotice("Account created. Check your email to confirm, then sign in.");
      setMode("signin");
      return;
    }
    router.replace(mode === "signup" ? "/business" : "/scan");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-zinc-900">Smart Inventory Scanner</h1>
        <p className="mt-1 text-sm text-zinc-500">{mode === "signin" ? "Sign in to your account." : "Create an account."}</p>

        <label className="mt-5 block text-sm font-medium text-zinc-700" htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          data-testid="login-email"
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
        />

        <label className="mt-3 block text-sm font-medium text-zinc-700" htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="login-password"
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
        />

        {error && <p className="mt-3 text-sm text-red-600" data-testid="login-error">{error}</p>}
        {notice && <p className="mt-3 text-sm text-green-700" data-testid="login-notice">{notice}</p>}

        <button
          type="submit"
          disabled={busy}
          data-testid="login-button"
          className="mt-5 w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "Please wait..." : mode === "signin" ? "Sign in" : "Create account"}
        </button>

        <button
          type="button"
          onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); setNotice(""); }}
          className="mt-3 w-full text-center text-xs text-blue-600 hover:underline"
        >
          {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
