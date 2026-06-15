"use client";

// Local mock auth for the private V1. No real provider is wired; this just gates the UI behind a
// demo login flag in localStorage. The real path (Firebase Auth) is documented in .env.example
// and CLAUDE.md. Never treat this as real security.

const KEY = "sis-auth";

export function isAuthed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function login(): void {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    // ignore
  }
}

export function logout(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
