import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocs: vi.fn(),
  getDoc: vi.fn(),
  doc: vi.fn((_db: unknown, collectionName: string, id: string) => ({
    collectionName,
    id,
  })),
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

beforeEach(() => {
  mocks.getDocs.mockReset();
  mocks.getDoc.mockReset();
});

describe("listMemberships", () => {
  it("returns only memberships whose parent business exists, with a display name", async () => {
    mocks.getDocs.mockResolvedValue({
      docs: [
        {
          id: "active_user-1",
          data: () => ({ businessId: "active", userId: "user-1", role: "owner" }),
        },
        {
          id: "orphan_user-1",
          data: () => ({ businessId: "orphan", userId: "user-1", role: "viewer" }),
        },
      ],
    });
    mocks.getDoc
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ name: "Main Street Auto" }),
      })
      .mockResolvedValueOnce({ exists: () => false, data: () => undefined });

    await expect(listMemberships()).resolves.toEqual([
      {
        id: "active_user-1",
        businessId: "active",
        userId: "user-1",
        role: "owner",
        businessName: "Main Street Auto",
      },
    ]);
  });

  it("uses a safe fallback name when an existing business has no usable name", async () => {
    mocks.getDocs.mockResolvedValue({
      docs: [{
        id: "active_user-1",
        data: () => ({ businessId: "active", userId: "user-1", role: "counter" }),
      }],
    });
    mocks.getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ name: "   " }),
    });

    const memberships = await listMemberships();

    expect(memberships[0].businessName).toBe("Unnamed business");
  });

  it("filters an orphan when parent validation is denied by the security rules", async () => {
    mocks.getDocs.mockResolvedValue({
      docs: [{
        id: "orphan_user-1",
        data: () => ({ businessId: "orphan", userId: "user-1", role: "viewer" }),
      }],
    });
    mocks.getDoc.mockRejectedValue({ code: "permission-denied" });

    await expect(listMemberships()).resolves.toEqual([]);
  });

  it("does not hide connectivity failures as an empty membership list", async () => {
    mocks.getDocs.mockResolvedValue({
      docs: [{
        id: "active_user-1",
        data: () => ({ businessId: "active", userId: "user-1", role: "owner" }),
      }],
    });
    mocks.getDoc.mockRejectedValue({ code: "unavailable" });

    await expect(listMemberships()).rejects.toMatchObject({ code: "unavailable" });
  });
});
