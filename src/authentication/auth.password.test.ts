import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  sendEmailVerification: vi.fn(),
  fetch: vi.fn(),
  auth: { currentUser: null as unknown },
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
vi.mock("@/authentication/firebaseClient", () => ({
  getFirebaseAuth: () => mocks.auth,
  getDb: vi.fn(),
}));
vi.mock("@/authentication/service/authBypass", () => ({ isAuthBypassEnabled: () => false }));

import { signInWithPassword, signUp } from "./auth";

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
  vi.stubGlobal("fetch", mocks.fetch);
});

describe("signInWithPassword", () => {
  it("provisions the user's profile and workspace after a successful password sign-in", async () => {
    mocks.signInWithEmailAndPassword.mockResolvedValue({ user });

    const result = await signInWithPassword("a@b.co", "pw");

    expect(result.status).toBe("ready");
    expect(result.businessId).toBe("business-1");
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("returns a safe message on failure and never provisions", async () => {
    mocks.signInWithEmailAndPassword.mockRejectedValue({
      code: "auth/invalid-credential",
      message: "Firebase private detail",
    });

    const result = await signInWithPassword("a@b.co", "bad");

    expect(result.error).toBe("Email or password is incorrect.");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe("signUp", () => {
  it("reports account creation separately when workspace provisioning fails", async () => {
    mocks.createUserWithEmailAndPassword.mockResolvedValue({ user });
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ status: "failed", reason: "workspace_unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await signUp("a@b.co", "pw");

    expect(result.status).toBe("workspace_failed");
    expect(result.accountCreated).toBe(true);
  });

  it("sends a verification email to the newly created user", async () => {
    mocks.createUserWithEmailAndPassword.mockResolvedValue({ user });

    await signUp("a@b.co", "pw");

    expect(mocks.sendEmailVerification).toHaveBeenCalledWith(user);
  });

  it("still succeeds when the verification email send rejects asynchronously (fail-soft)", async () => {
    mocks.createUserWithEmailAndPassword.mockResolvedValue({ user });
    mocks.sendEmailVerification.mockRejectedValue(new Error("mail provider down"));

    const result = await signUp("a@b.co", "pw");

    expect(result.status).toBe("ready");
    expect(result.accountCreated).toBe(true);
  });

  it("succeeds normally when the verification email send succeeds", async () => {
    mocks.createUserWithEmailAndPassword.mockResolvedValue({ user });
    mocks.sendEmailVerification.mockResolvedValue(undefined);

    const result = await signUp("a@b.co", "pw");

    expect(result.status).toBe("ready");
    expect(mocks.sendEmailVerification).toHaveBeenCalledWith(user);
  });
});
