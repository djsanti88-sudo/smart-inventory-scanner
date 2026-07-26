import { describe, it, expect, vi, beforeEach } from "vitest";

// Root-cause regression test (owner report 2026-07-22): fresh signups had no business/membership doc
// until a manual /business -> Create -> Select flow, so every guarded API 403'd with "Not a member of
// this business" from the very first load. signUp() must auto-provision a default business + owner
// membership (via the existing createBusiness transactional writes) and select it, so a fresh account
// lands ready to work.
//
// vi.hoisted per the repo's established pattern (vi.mock factories are hoisted above top-level consts).
const { createUserWithEmailAndPassword, signInWithPopup } = vi.hoisted(() => ({
  createUserWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
}));

vi.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: (...a: unknown[]) => createUserWithEmailAndPassword(...a),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signInWithPopup: (...a: unknown[]) => signInWithPopup(...a),
  sendPasswordResetEmail: vi.fn(),
  GoogleAuthProvider: vi.fn(),
}));

const FAKE_USER = { uid: "u-new", email: "new@shop.co", displayName: "" };

vi.mock("@/lib/firebaseClient", () => ({
  getFirebaseAuth: () => ({ currentUser: FAKE_USER }),
  getDb: () => ({}),
}));
vi.mock("@/services/auth/authBypass", () => ({ isAuthBypassEnabled: () => false }));
vi.mock("@/lib/selectedBusiness", () => ({ setSelectedBusinessId: vi.fn() }));

// Firestore mock: ensureUserProfile's runTransaction, createBusiness's setDoc, and
// listMemberships'/getDocs's query. crypto.randomUUID is used by createBusiness for the new id.
const setDocCalls: Array<{ path: string; data: unknown }> = [];
let membershipDocs: Array<{ id: string; data: () => unknown }> = [];

vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, ...segments: string[]) => ({ path: segments.join("/") }),
  setDoc: vi.fn((ref: { path: string }, data: unknown) => {
    setDocCalls.push({ path: ref.path, data });
    return Promise.resolve();
  }),
  getDoc: vi.fn(() => Promise.resolve({ exists: () => false, data: () => undefined })),
  runTransaction: vi.fn((_db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ get: () => Promise.resolve({ exists: () => false, data: () => undefined }), set: vi.fn() }),
  ),
  getDocs: vi.fn(() => Promise.resolve({ docs: membershipDocs })),
  query: vi.fn((...a: unknown[]) => a),
  collection: vi.fn((_db: unknown, name: string) => name),
  where: vi.fn(),
  serverTimestamp: vi.fn(() => "SERVER_TIMESTAMP"),
}));

import { signUp, signInWithGoogle, ensureDefaultBusinessProvisioned } from "./auth";
import { setSelectedBusinessId } from "@/lib/selectedBusiness";

beforeEach(() => {
  createUserWithEmailAndPassword.mockReset();
  signInWithPopup.mockReset();
  vi.mocked(setSelectedBusinessId).mockReset();
  setDocCalls.length = 0;
  membershipDocs = [];
  if (!("randomUUID" in crypto)) {
    // jsdom/node test env should already have crypto.randomUUID; guard just in case.
    (crypto as unknown as { randomUUID: () => string }).randomUUID = () => "biz-uuid-1";
  }
});

describe("ensureDefaultBusinessProvisioned", () => {
  it("creates a default business + owner membership and selects it when the user has zero memberships", async () => {
    membershipDocs = [];
    await ensureDefaultBusinessProvisioned();

    const businessWrite = setDocCalls.find((c) => c.path.includes("businesses/"));
    const memberWrite = setDocCalls.find((c) => c.path.includes("businessMembers/"));
    expect(businessWrite).toBeDefined();
    expect((businessWrite!.data as { name: string }).name).toBe("My Business");
    expect(memberWrite).toBeDefined();
    expect((memberWrite!.data as { role: string; userId: string }).role).toBe("owner");
    expect((memberWrite!.data as { role: string; userId: string }).userId).toBe("u-new");
    expect(setSelectedBusinessId).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the user already has at least one membership", async () => {
    membershipDocs = [{ id: "b1_u-new", data: () => ({ businessId: "b1", userId: "u-new", role: "owner" }) }];
    await ensureDefaultBusinessProvisioned();

    expect(setDocCalls.some((c) => c.path.includes("businesses/"))).toBe(false);
    expect(setSelectedBusinessId).not.toHaveBeenCalled();
  });
});

describe("signUp auto-provisioning", () => {
  it("provisions a default business after a successful email/password signup", async () => {
    createUserWithEmailAndPassword.mockResolvedValue({ user: FAKE_USER });
    membershipDocs = [];

    const res = await signUp("new@shop.co", "pw123456");

    expect(res.error).toBeNull();
    expect(setDocCalls.some((c) => c.path.includes("businesses/"))).toBe(true);
    expect(setSelectedBusinessId).toHaveBeenCalledTimes(1);
  });

  it("does not throw signup even if provisioning fails (best-effort, not fatal)", async () => {
    createUserWithEmailAndPassword.mockResolvedValue({ user: FAKE_USER });
    // Force getDocs (listMemberships) to reject so ensureDefaultBusinessProvisioned's catch engages.
    const firestore = await import("firebase/firestore");
    vi.mocked(firestore.getDocs).mockRejectedValueOnce(new Error("boom"));

    const res = await signUp("new@shop.co", "pw123456");
    expect(res.error).toBeNull();
  });
});

describe("signInWithGoogle auto-provisioning", () => {
  it("provisions a default business after a successful first Google sign-in", async () => {
    signInWithPopup.mockResolvedValue({ user: FAKE_USER });
    membershipDocs = [];

    const res = await signInWithGoogle();

    expect(res.error).toBeNull();
    expect(setDocCalls.some((c) => c.path.includes("businesses/"))).toBe(true);
    expect(setSelectedBusinessId).toHaveBeenCalledTimes(1);
  });

  it("does not re-provision for a returning Google user with an existing membership", async () => {
    signInWithPopup.mockResolvedValue({ user: FAKE_USER });
    membershipDocs = [{ id: "b1_u-new", data: () => ({ businessId: "b1", userId: "u-new", role: "owner" }) }];

    const res = await signInWithGoogle();

    expect(res.error).toBeNull();
    expect(setDocCalls.some((c) => c.path.includes("businesses/"))).toBe(false);
    expect(setSelectedBusinessId).not.toHaveBeenCalled();
  });
});
