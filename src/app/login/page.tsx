"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/lib/auth";

// Local demo login. No real auth provider is wired in V1; this gates the private app behind a
// local flag. Firebase Auth is the documented future path.
export default function LoginPage() {
  const router = useRouter();
  const [user, setUser] = useState("owner");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    login();
    router.replace("/scan");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
      >
        <h1 className="text-xl font-semibold text-zinc-900">Smart Inventory Scanner</h1>
        <p className="mt-1 text-sm text-zinc-500">Private access. Local demo login.</p>

        <label className="mt-5 block text-sm font-medium text-zinc-700" htmlFor="user">
          User
        </label>
        <input
          id="user"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
        />

        <button
          type="submit"
          data-testid="login-button"
          className="mt-5 w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
        >
          Enter
        </button>

        <p className="mt-4 text-xs text-zinc-400">
          This is a local mock login for the private V1. It is not real authentication.
        </p>
      </form>
    </div>
  );
}
