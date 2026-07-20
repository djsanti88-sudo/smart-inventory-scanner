import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above top-level const declarations; Vitest 4 throws a TDZ error if the
// factory below references plain top-level consts. vi.hoisted runs before vi.mock and is safe to
// reference inside it (see src/lib/auth.google.test.ts for the established repo pattern).
const { signInWithEmailAndPassword, doc, getDoc, setDoc, serverTimestamp } = vi.hoisted(() => ({
  signInWithEmailAndPassword: vi.fn(),
  doc: vi.fn((..._a: unknown[]) => ({ __ref: true })),
  getDoc: vi.fn(),
  setDoc: vi.fn(),
  serverTimestamp: vi.fn(() => "SERVER_TIMESTAMP"),
}));

vi.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: (...a: unknown[]) => signInWithEmailAndPassword(...a),
  createUserWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signInWithPopup: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  GoogleAuthProvider: vi.fn(),
}));
vi.mock("@/lib/firebaseClient", () => ({ getFirebaseAuth: () => ({}), getDb: () => ({}) }));
vi.mock("@/services/auth/authBypass", () => ({ isAuthBypassEnabled: () => false }));
vi.mock("firebase/firestore", () => ({
  doc: (...a: unknown[]) => doc(...a),
  getDoc: (...a: unknown[]) => getDoc(...a),
  setDoc: (...a: unknown[]) => setDoc(...a),
  getDocs: vi.fn(),
  query: vi.fn(),
  collection: vi.fn(),
  where: vi.fn(),
  serverTimestamp: () => serverTimestamp(),
}));

import { signInWithPassword, ensureUserProfile } from "./auth";

beforeEach(() => {
  signInWithEmailAndPassword.mockReset();
  doc.mockClear();
  getDoc.mockReset();
  setDoc.mockReset();
  serverTimestamp.mockClear();
});

describe("signInWithPassword", () => {
  it("ensures the user's profile doc after a successful password sign-in", async () => {
    const user = { uid: "u1", email: "a@b.co", displayName: "A" };
    signInWithEmailAndPassword.mockResolvedValue({ user });
    getDoc.mockResolvedValue({ exists: () => false, data: () => undefined });
    setDoc.mockResolvedValue(undefined);

    const res = await signInWithPassword("a@b.co", "pw");

    expect(res.error).toBeNull();
    expect(setDoc).toHaveBeenCalledOnce();
    const [, payload] = setDoc.mock.calls[0];
    expect(payload.authUserId).toBe("u1");
  });

  it("returns the error message on failure and never calls ensureUserProfile", async () => {
    signInWithEmailAndPassword.mockRejectedValue(new Error("wrong password"));
    const res = await signInWithPassword("a@b.co", "bad");
    expect(res.error).toBe("wrong password");
    expect(setDoc).not.toHaveBeenCalled();
  });
});

describe("ensureUserProfile", () => {
  const user = { uid: "u1", email: "a@b.co", displayName: "A" } as unknown as Parameters<typeof ensureUserProfile>[0];

  it("writes lastLoginAt on every call", async () => {
    getDoc.mockResolvedValue({ exists: () => false, data: () => undefined });
    setDoc.mockResolvedValue(undefined);

    await ensureUserProfile(user);

    const [, payload] = setDoc.mock.calls[0];
    expect(payload.lastLoginAt).toBe("SERVER_TIMESTAMP");
  });

  it("sets signedUpAt when the profile doc does not already have it", async () => {
    getDoc.mockResolvedValue({ exists: () => false, data: () => undefined });
    setDoc.mockResolvedValue(undefined);

    await ensureUserProfile(user);

    const [, payload] = setDoc.mock.calls[0];
    expect(payload.signedUpAt).toBe("SERVER_TIMESTAMP");
  });

  it("does not overwrite signedUpAt when the profile doc already has it", async () => {
    getDoc.mockResolvedValue({ exists: () => true, data: () => ({ signedUpAt: "EXISTING" }) });
    setDoc.mockResolvedValue(undefined);

    await ensureUserProfile(user);

    const [, payload] = setDoc.mock.calls[0];
    expect(payload.signedUpAt).toBeUndefined();
    expect(payload.lastLoginAt).toBe("SERVER_TIMESTAMP");
  });
});
