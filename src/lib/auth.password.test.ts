import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above top-level const declarations; Vitest 4 throws a TDZ error if the
// factory below references plain top-level consts. vi.hoisted runs before vi.mock and is safe to
// reference inside it (see src/lib/auth.google.test.ts for the established repo pattern).
// `runTransaction(db, fn)` invokes `fn(tx)`; the fake `tx` reads via `txGet` (models the
// transactional re-read) and writes via `txSet`. This lets the race test assert that a
// concurrent-write's re-read still sees an existing signedUpAt and never overwrites it.
const { signInWithEmailAndPassword, doc, txGet, txSet, runTransaction, serverTimestamp } = vi.hoisted(() => {
  const txGet = vi.fn();
  const txSet = vi.fn();
  return {
    signInWithEmailAndPassword: vi.fn(),
    doc: vi.fn((..._a: unknown[]) => ({ __ref: true })),
    txGet,
    txSet,
    runTransaction: vi.fn((_db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ get: (...a: unknown[]) => txGet(...a), set: (...a: unknown[]) => txSet(...a) }),
    ),
    serverTimestamp: vi.fn(() => "SERVER_TIMESTAMP"),
  };
});

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
  getDoc: vi.fn(),
  setDoc: vi.fn(),
  runTransaction: (...a: [unknown, (tx: unknown) => Promise<unknown>]) => runTransaction(...a),
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
  txGet.mockReset();
  txSet.mockReset();
  runTransaction.mockClear();
  serverTimestamp.mockClear();
});

describe("signInWithPassword", () => {
  it("ensures the user's profile doc after a successful password sign-in", async () => {
    const user = { uid: "u1", email: "a@b.co", displayName: "A" };
    signInWithEmailAndPassword.mockResolvedValue({ user });
    txGet.mockResolvedValue({ exists: () => false, data: () => undefined });
    txSet.mockReturnValue(undefined);

    const res = await signInWithPassword("a@b.co", "pw");

    expect(res.error).toBeNull();
    expect(txSet).toHaveBeenCalledOnce();
    const [, payload] = txSet.mock.calls[0];
    expect(payload.authUserId).toBe("u1");
  });

  it("returns the error message on failure and never calls ensureUserProfile", async () => {
    signInWithEmailAndPassword.mockRejectedValue(new Error("wrong password"));
    const res = await signInWithPassword("a@b.co", "bad");
    expect(res.error).toBe("wrong password");
    expect(txSet).not.toHaveBeenCalled();
  });
});

describe("ensureUserProfile", () => {
  const user = { uid: "u1", email: "a@b.co", displayName: "A" } as unknown as Parameters<typeof ensureUserProfile>[0];

  it("writes lastLoginAt on every call", async () => {
    txGet.mockResolvedValue({ exists: () => false, data: () => undefined });
    txSet.mockReturnValue(undefined);

    await ensureUserProfile(user);

    const [, payload] = txSet.mock.calls[0];
    expect(payload.lastLoginAt).toBe("SERVER_TIMESTAMP");
  });

  it("sets signedUpAt when the profile doc does not already have it", async () => {
    txGet.mockResolvedValue({ exists: () => false, data: () => undefined });
    txSet.mockReturnValue(undefined);

    await ensureUserProfile(user);

    const [, payload] = txSet.mock.calls[0];
    expect(payload.signedUpAt).toBe("SERVER_TIMESTAMP");
  });

  it("does not overwrite signedUpAt when the profile doc already has it", async () => {
    txGet.mockResolvedValue({ exists: () => true, data: () => ({ signedUpAt: "EXISTING" }) });
    txSet.mockReturnValue(undefined);

    await ensureUserProfile(user);

    const [, payload] = txSet.mock.calls[0];
    expect(payload.signedUpAt).toBeUndefined();
    expect(payload.lastLoginAt).toBe("SERVER_TIMESTAMP");
  });

  it("reads and writes inside a single transaction (atomic decide-then-write, no bare getDoc/setDoc)", async () => {
    txGet.mockResolvedValue({ exists: () => false, data: () => undefined });
    txSet.mockReturnValue(undefined);

    await ensureUserProfile(user);

    // The read that decides signedUpAt MUST be the transaction's own get (re-read on conflict),
    // and the write MUST be the transaction's set - otherwise the TOCTOU race is still open.
    expect(runTransaction).toHaveBeenCalledOnce();
    expect(txGet).toHaveBeenCalledOnce();
    expect(txSet).toHaveBeenCalledOnce();
  });

  it("preserves an existing signedUpAt when the transaction re-reads on a concurrent-write conflict", async () => {
    // Models Firestore's runTransaction retry: the first attempt sees no doc, but the retry's
    // re-read (after another client committed signedUpAt) sees it and must not overwrite it.
    txGet
      .mockResolvedValueOnce({ exists: () => false, data: () => undefined })
      .mockResolvedValueOnce({ exists: () => true, data: () => ({ signedUpAt: "EXISTING" }) });
    txSet.mockReturnValue(undefined);

    // Run twice against the same fake tx to simulate the re-read the transaction performs.
    await ensureUserProfile(user);
    await ensureUserProfile(user);

    const [, firstPayload] = txSet.mock.calls[0];
    const [, secondPayload] = txSet.mock.calls[1];
    expect(firstPayload.signedUpAt).toBe("SERVER_TIMESTAMP"); // first writer stamps it
    expect(secondPayload.signedUpAt).toBeUndefined(); // re-read sees it -> never overwritten
  });
});
