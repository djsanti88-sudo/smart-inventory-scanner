import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signInWithPopup: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  fetch: vi.fn(),
  auth: { currentUser: null as unknown },
}));

vi.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signInWithPopup: (...args: unknown[]) => mocks.signInWithPopup(...args),
  sendPasswordResetEmail: (...args: unknown[]) => mocks.sendPasswordResetEmail(...args),
  GoogleAuthProvider: vi.fn(),
}));
vi.mock("@/lib/firebaseClient", () => ({
  getFirebaseAuth: () => mocks.auth,
  getDb: vi.fn(),
}));
vi.mock("@/services/auth/authBypass", () => ({ isAuthBypassEnabled: () => false }));

import { sendResetEmail, signInWithGoogle } from "./auth";

const user = {
  uid: "u1",
  email: "a@b.co",
  displayName: "A",
  getIdToken: vi.fn().mockResolvedValue("token"),
};

beforeEach(() => {
  mocks.signInWithPopup.mockReset();
  mocks.sendPasswordResetEmail.mockReset();
  mocks.fetch.mockReset().mockResolvedValue(
    new Response(JSON.stringify({ status: "ready", businessId: "business-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  mocks.auth.currentUser = user;
  vi.stubGlobal("fetch", mocks.fetch);
});

describe("signInWithGoogle", () => {
  it("returns a ready workspace after a successful Google sign-in", async () => {
    mocks.signInWithPopup.mockResolvedValue({ user });
    const result = await signInWithGoogle();
    expect(result.error).toBeNull();
    expect(result.status).toBe("ready");
    expect(mocks.signInWithPopup).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("suppresses the expected popup-closed error", async () => {
    mocks.signInWithPopup.mockRejectedValue({ code: "auth/popup-closed-by-user" });
    const result = await signInWithGoogle();
    expect(result.status).toBe("cancelled");
    expect(result.error).toBeNull();
  });
});

describe("sendResetEmail", () => {
  it("returns no error on success", async () => {
    mocks.sendPasswordResetEmail.mockResolvedValue(undefined);
    const result = await sendResetEmail("a@b.co");
    expect(result.error).toBeNull();
    expect(mocks.sendPasswordResetEmail).toHaveBeenCalledOnce();
  });

  it("returns a safe message on failure", async () => {
    mocks.sendPasswordResetEmail.mockRejectedValue({
      code: "auth/network-request-failed",
      message: "Firebase internal endpoint",
    });
    const result = await sendResetEmail("x@y.co");
    expect(result.error).toBe("Check your internet connection and try again.");
  });
});
