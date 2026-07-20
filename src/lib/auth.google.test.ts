import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above top-level const declarations; Vitest 4 throws a TDZ error if the
// factory below references plain top-level consts. vi.hoisted runs before vi.mock and is safe to
// reference inside it (see src/server/decode/pipeline.test.ts for the established repo pattern).
const { signInWithPopup, sendPasswordResetEmail, GoogleAuthProvider } = vi.hoisted(() => ({
  signInWithPopup: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  GoogleAuthProvider: vi.fn(),
}));

vi.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signInWithPopup: (...a: unknown[]) => signInWithPopup(...a),
  sendPasswordResetEmail: (...a: unknown[]) => sendPasswordResetEmail(...a),
  GoogleAuthProvider,
}));
vi.mock("@/lib/firebaseClient", () => ({ getFirebaseAuth: () => ({}), getDb: () => ({}) }));
vi.mock("@/services/auth/authBypass", () => ({ isAuthBypassEnabled: () => false }));
vi.mock("firebase/firestore", () => ({
  doc: vi.fn(), setDoc: vi.fn(), getDoc: vi.fn(() => Promise.resolve({ exists: () => false, data: () => undefined })),
  // runTransaction invokes its callback with a fake tx whose get returns a not-exists snapshot.
  runTransaction: vi.fn((_db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ get: () => Promise.resolve({ exists: () => false, data: () => undefined }), set: vi.fn() }),
  ),
  getDocs: vi.fn(), query: vi.fn(),
  collection: vi.fn(), where: vi.fn(), serverTimestamp: vi.fn(),
}));

import { signInWithGoogle, sendResetEmail } from "./auth";

beforeEach(() => { signInWithPopup.mockReset(); sendPasswordResetEmail.mockReset(); });

describe("signInWithGoogle", () => {
  it("returns no error on success and ensures a profile", async () => {
    signInWithPopup.mockResolvedValue({ user: { uid: "u1", email: "a@b.co", displayName: "A" } });
    const res = await signInWithGoogle();
    expect(res.error).toBeNull();
    expect(signInWithPopup).toHaveBeenCalledOnce();
  });
  it("returns the error message on failure", async () => {
    signInWithPopup.mockRejectedValue(new Error("popup closed"));
    const res = await signInWithGoogle();
    expect(res.error).toBe("popup closed");
  });
});

describe("sendResetEmail", () => {
  it("returns no error on success", async () => {
    sendPasswordResetEmail.mockResolvedValue(undefined);
    const res = await sendResetEmail("a@b.co");
    expect(res.error).toBeNull();
    expect(sendPasswordResetEmail).toHaveBeenCalledOnce();
  });
  it("returns the error message on failure", async () => {
    sendPasswordResetEmail.mockRejectedValue(new Error("no user"));
    const res = await sendResetEmail("x@y.co");
    expect(res.error).toBe("no user");
  });
});
