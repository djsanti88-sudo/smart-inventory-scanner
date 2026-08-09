import { beforeEach, describe, expect, it, vi } from "vitest";

// Task 3 (B7, auth surface, 2026-08-09):
//  (a) signUp must route its verification send through resendVerificationEmail, not call
//      sendEmailVerification directly - the doc comment at auth.ts claims every caller funnels through
//      the same auth surface; this proves it behaviorally (bypass mode short-circuits BOTH paths).
//  (b) resendVerificationEmail must have the same isAuthBypassEnabled() guard signOut has - in
//      bypass/mock mode it must never attempt a live Firebase send and must resolve success-shaped.

const mocks = vi.hoisted(() => ({
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  sendEmailVerification: vi.fn(),
  fetch: vi.fn(),
  auth: { currentUser: null as unknown },
  authBypassEnabled: false,
}));

vi.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: (...args: unknown[]) => mocks.signInWithEmailAndPassword(...args),
  createUserWithEmailAndPassword: (...args: unknown[]) => mocks.createUserWithEmailAndPassword(...args),
  sendEmailVerification: (...args: unknown[]) => mocks.sendEmailVerification(...args),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signInWithPopup: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  GoogleAuthProvider: vi.fn(),
}));
vi.mock("@/lib/firebaseClient", () => ({
  getFirebaseAuth: () => mocks.auth,
  getDb: vi.fn(),
}));
vi.mock("@/services/auth/authBypass", () => ({
  isAuthBypassEnabled: () => mocks.authBypassEnabled,
}));

import { signUp, resendVerificationEmail } from "./auth";

const user = {
  uid: "u1",
  email: "a@b.co",
  displayName: "A",
  getIdToken: vi.fn().mockResolvedValue("token"),
};

beforeEach(() => {
  mocks.signInWithEmailAndPassword.mockReset();
  mocks.createUserWithEmailAndPassword.mockReset();
  mocks.sendEmailVerification.mockReset().mockResolvedValue(undefined);
  mocks.fetch.mockReset().mockResolvedValue(
    new Response(JSON.stringify({ status: "ready", businessId: "business-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  mocks.auth.currentUser = user;
  mocks.authBypassEnabled = false;
  vi.stubGlobal("fetch", mocks.fetch);
});

describe("resendVerificationEmail", () => {
  it("sends via Firebase and returns { error: null } on success", async () => {
    const result = await resendVerificationEmail(user as never);
    expect(result).toEqual({ error: null });
    expect(mocks.sendEmailVerification).toHaveBeenCalledWith(user);
  });

  it("returns a mapped error string (not a throw) when the send rejects", async () => {
    mocks.sendEmailVerification.mockRejectedValueOnce(new Error("boom"));
    const result = await resendVerificationEmail(user as never);
    expect(result.error).toBeTruthy();
  });

  it("is guarded by isAuthBypassEnabled(): in bypass mode it never calls Firebase and resolves success-shaped", async () => {
    mocks.authBypassEnabled = true;
    const result = await resendVerificationEmail(user as never);
    expect(result).toEqual({ error: null });
    expect(mocks.sendEmailVerification).not.toHaveBeenCalled();
  });
});

describe("signUp verification-email routing (Task 3a)", () => {
  it("still sends a verification email on signup (normal, non-bypass mode)", async () => {
    mocks.createUserWithEmailAndPassword.mockResolvedValue({ user });

    await signUp("a@b.co", "pw");

    expect(mocks.sendEmailVerification).toHaveBeenCalledWith(user);
  });

  it("in bypass mode, signUp's verification-email send never reaches Firebase (proves it funnels through resendVerificationEmail's guard, not a direct sendEmailVerification call)", async () => {
    mocks.authBypassEnabled = true;
    mocks.createUserWithEmailAndPassword.mockResolvedValue({ user });

    const result = await signUp("a@b.co", "pw");

    // Give the fire-and-forget microtask a tick to run before asserting it never called Firebase.
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.sendEmailVerification).not.toHaveBeenCalled();
    // signup itself is unaffected by the guard (fail-soft either way).
    expect(result.accountCreated).toBe(true);
  });
});
