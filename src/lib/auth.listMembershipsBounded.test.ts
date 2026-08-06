// Round 2 hardening (owner-reported live verification, 2026-08-06): the loadBusinessData bounded-retry
// fix alone did not stop the fresh-device gate hang, because listMemberships() - called BEFORE
// loadBusinessData in BusinessContextGate's bootstrap chain, and ALSO called directly (with no outer
// timeout) by other pages like the business switcher - had its own unbounded getDocs/getDoc calls. This
// proves listMemberships now uses the same bounded retry as businessDataLoader.ts instead of hanging
// forever on a stuck transport.
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocs: vi.fn(),
  getDoc: vi.fn(),
  doc: vi.fn((_db: unknown, collectionName: string, id: string) => ({ collectionName, id })),
  auth: { currentUser: { uid: "user-1" } as unknown },
}));

vi.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signInWithPopup: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  GoogleAuthProvider: vi.fn(),
}));
vi.mock("firebase/firestore", () => ({
  getDocs: (reference: unknown) => mocks.getDocs(reference),
  getDoc: (reference: unknown) => mocks.getDoc(reference),
  doc: (db: unknown, collectionName: string, id: string) => mocks.doc(db, collectionName, id),
  query: vi.fn((value: unknown) => value),
  collection: vi.fn((_db: unknown, name: string) => ({ name })),
  where: vi.fn(),
}));
vi.mock("@/lib/firebaseClient", () => ({
  getFirebaseAuth: () => mocks.auth,
  getDb: () => ({ __db: true }),
}));
vi.mock("@/services/auth/authBypass", () => ({ isAuthBypassEnabled: () => false }));

import { listMemberships } from "./auth";
import { READ_ATTEMPT_TIMEOUT_MS, READ_MAX_ATTEMPTS } from "@/services/db/firebase/boundedRead";

afterEach(() => {
  mocks.getDocs.mockReset();
  mocks.getDoc.mockReset();
  vi.useRealTimers();
});

describe("listMemberships bounded retry (fresh-device bootstrap hardening)", () => {
  it("REGRESSION: rejects within the bounded window instead of hanging forever when the memberships getDocs never settles", async () => {
    vi.useFakeTimers();
    mocks.getDocs.mockReturnValue(new Promise(() => {})); // stuck transport: never settles

    const resultPromise = listMemberships();
    let settled = false;
    resultPromise.then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(READ_ATTEMPT_TIMEOUT_MS * READ_MAX_ATTEMPTS + 10_000);

    expect(settled).toBe(true);
    await expect(resultPromise).rejects.toThrow(/Timed out/i);
  });

  it("REGRESSION: rejects within the bounded window when a per-membership business getDoc never settles", async () => {
    vi.useFakeTimers();
    mocks.getDocs.mockResolvedValue({
      docs: [{ id: "m1", data: () => ({ businessId: "biz-1", userId: "user-1", role: "owner" }) }],
    });
    mocks.getDoc.mockReturnValue(new Promise(() => {})); // stuck transport on the per-membership lookup

    const resultPromise = listMemberships();
    let settled = false;
    resultPromise.then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(READ_ATTEMPT_TIMEOUT_MS * READ_MAX_ATTEMPTS + 10_000);

    expect(settled).toBe(true);
    await expect(resultPromise).rejects.toThrow(/Timed out/i);
  });

  it("still filters an orphan membership on an immediate permission-denied (no wasted retries, error shape preserved)", async () => {
    mocks.getDocs.mockResolvedValue({
      docs: [{ id: "m1", data: () => ({ businessId: "biz-1", userId: "user-1", role: "owner" }) }],
    });
    mocks.getDoc.mockRejectedValue({ code: "permission-denied" });

    await expect(listMemberships()).resolves.toEqual([]);
  });

  it("propagates a real connectivity error immediately instead of retrying and masking its code", async () => {
    mocks.getDocs.mockResolvedValue({
      docs: [{ id: "m1", data: () => ({ businessId: "biz-1", userId: "user-1", role: "owner" }) }],
    });
    mocks.getDoc.mockRejectedValue({ code: "unavailable" });

    await expect(listMemberships()).rejects.toMatchObject({ code: "unavailable" });
  });
});
