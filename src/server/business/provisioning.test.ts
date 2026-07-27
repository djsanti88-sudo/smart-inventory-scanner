import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultBusinessIdFor,
  namedBusinessIdFor,
  provisionBusiness,
  type ProvisionIdentity,
} from "./provisioning";

type StoredDoc = Record<string, unknown>;

function fakeFirestore(initial: Record<string, StoredDoc> = {}) {
  const docs = new Map(Object.entries(initial));
  const transactionWrites: Array<{ path: string; data: StoredDoc; merge?: boolean }> = [];

  function ref(path: string) {
    return { path };
  }

  const db = {
    doc: vi.fn((path: string) => ref(path)),
    collection: vi.fn(() => ({
      where: vi.fn((_field: string, _op: string, value: string) => ({
        kind: "membership-query",
        value,
      })),
    })),
    runTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: vi.fn(async (target: { path?: string; kind?: string; value?: string }) => {
          if (target.kind === "membership-query") {
            const matching = [...docs.entries()]
              .filter(([path, data]) => path.startsWith("businessMembers/") && data.userId === target.value)
              .map(([path, data]) => ({ id: path.split("/")[1], data: () => data }));
            return { empty: matching.length === 0, docs: matching };
          }
          const value = target.path ? docs.get(target.path) : undefined;
          return { exists: Boolean(value), data: () => value };
        }),
        set: vi.fn((target: { path: string }, data: StoredDoc, options?: { merge?: boolean }) => {
          const merged = options?.merge ? { ...(docs.get(target.path) ?? {}), ...data } : data;
          docs.set(target.path, merged);
          transactionWrites.push({ path: target.path, data, merge: options?.merge });
        }),
      };
      return work(tx);
    }),
  };

  return { db, docs, transactionWrites };
}

const identity: ProvisionIdentity = {
  uid: "user-1",
  email: "owner@example.com",
  name: "Owner",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-26T12:00:00.000Z"));
});

describe("provisionBusiness", () => {
  it("atomically creates a deterministic default business, owner membership, and profile", async () => {
    const { db, docs } = fakeFirestore();
    const defaultId = defaultBusinessIdFor(identity.uid);

    const result = await provisionBusiness(db as never, identity, { mode: "ensure_default" });

    expect(result).toEqual({ status: "ready", businessId: defaultId });
    expect(db.runTransaction).toHaveBeenCalledOnce();
    expect(docs.get(`businesses/${defaultId}`)).toMatchObject({
      name: "My Business",
      createdBy: "user-1",
    });
    expect(docs.get(`businessMembers/${defaultId}_user-1`)).toMatchObject({
      businessId: defaultId,
      userId: "user-1",
      role: "owner",
    });
    expect(docs.get("userProfiles/user-1")).toMatchObject({
      authUserId: "user-1",
      email: "owner@example.com",
    });
  });

  it("returns an existing membership instead of creating another default business", async () => {
    const { db, docs } = fakeFirestore({
      "businesses/existing": {
        name: "Existing",
        createdBy: "user-1",
      },
      "businessMembers/existing_user-1": {
        businessId: "existing",
        userId: "user-1",
        role: "owner",
      },
    });

    const result = await provisionBusiness(db as never, identity, { mode: "ensure_default" });

    expect(result).toEqual({ status: "existing", businessId: "existing" });
    expect(docs.has(`businesses/${defaultBusinessIdFor(identity.uid)}`)).toBe(false);
    expect(docs.has("userProfiles/user-1")).toBe(true);
  });

  it("repairs a missing owner membership for an existing deterministic default business", async () => {
    const defaultId = defaultBusinessIdFor(identity.uid);
    const { db, docs } = fakeFirestore({
      [`businesses/${defaultId}`]: {
        name: "My Business",
        createdBy: "user-1",
      },
    });

    const result = await provisionBusiness(db as never, identity, { mode: "ensure_default" });

    expect(result).toEqual({ status: "ready", businessId: defaultId });
    expect(docs.get(`businessMembers/${defaultId}_user-1`)).toMatchObject({
      businessId: defaultId,
      userId: "user-1",
      role: "owner",
    });
  });

  it("does not grant membership to a foreign business that preclaims the default ID", async () => {
    const defaultId = defaultBusinessIdFor(identity.uid);
    const { db, docs } = fakeFirestore({
      [`businesses/${defaultId}`]: {
        name: "Preclaimed",
        createdBy: "attacker",
      },
      [`businessMembers/${defaultId}_attacker`]: {
        businessId: defaultId,
        userId: "attacker",
        role: "owner",
      },
    });

    const first = await provisionBusiness(db as never, identity, { mode: "ensure_default" });
    const second = await provisionBusiness(db as never, identity, { mode: "ensure_default" });

    expect(first).toMatchObject({ status: "ready" });
    expect(second).toMatchObject({ status: "existing" });
    expect("businessId" in first && "businessId" in second && first.businessId)
      .toBe("businessId" in second ? second.businessId : "");
    expect("businessId" in first && first.businessId).not.toBe(defaultId);
    expect(docs.has(`businessMembers/${defaultId}_user-1`)).toBe(false);
    expect(docs.get(`businesses/${defaultId}`)).toMatchObject({
      name: "Preclaimed",
      createdBy: "attacker",
    });

    if (!("businessId" in first)) {
      throw new Error("Expected a provisioned fallback business");
    }
    expect(docs.get(`businesses/${first.businessId}`)).toMatchObject({
      createdBy: identity.uid,
    });
    expect(docs.get(`businessMembers/${first.businessId}_user-1`)).toMatchObject({
      businessId: first.businessId,
      userId: identity.uid,
      role: "owner",
    });
    expect(docs.get(`userProfiles/${identity.uid}`)).toMatchObject({
      defaultBusinessId: first.businessId,
    });
  });

  it("preserves a valid preferred business for a multi-membership user", async () => {
    const { db } = fakeFirestore({
      "businesses/b1": { name: "One", createdBy: "other" },
      "businesses/b2": { name: "Two", createdBy: "other" },
      "businessMembers/b1_user-1": { businessId: "b1", userId: "user-1", role: "counter" },
      "businessMembers/b2_user-1": { businessId: "b2", userId: "user-1", role: "admin" },
    });

    const result = await provisionBusiness(db as never, identity, {
      mode: "ensure_default",
      preferredBusinessId: "b2",
    });

    expect(result).toEqual({ status: "existing", businessId: "b2" });
  });

  it("requires selection for multiple valid memberships without a valid preference", async () => {
    const { db } = fakeFirestore({
      "businesses/b1": { name: "One", createdBy: "other" },
      "businesses/b2": { name: "Two", createdBy: "other" },
      "businessMembers/b1_user-1": { businessId: "b1", userId: "user-1", role: "counter" },
      "businessMembers/b2_user-1": { businessId: "b2", userId: "user-1", role: "admin" },
    });

    const result = await provisionBusiness(db as never, identity, {
      mode: "ensure_default",
      preferredBusinessId: "deleted",
    });

    expect(result).toEqual({ status: "selection_required", businessIds: ["b1", "b2"] });
  });

  it.each(["counter", "viewer", "owner"])(
    "does not resurrect an arbitrary missing business from an orphan %s membership",
    async (role) => {
      const { db, docs } = fakeFirestore({
        "businessMembers/deleted_user-1": {
          businessId: "deleted",
          userId: "user-1",
          role,
        },
      });

      const result = await provisionBusiness(db as never, identity, {
        mode: "ensure_default",
        preferredBusinessId: "deleted",
      });

      expect(result).toEqual({
        status: "ready",
        businessId: defaultBusinessIdFor(identity.uid),
      });
      expect(docs.has("businesses/deleted")).toBe(false);
    },
  );

  it("ignores a malformed stored membership ID instead of constructing an unsafe path", async () => {
    const { db } = fakeFirestore({
      "businessMembers/malformed_user-1": {
        businessId: "bad/path",
        userId: "user-1",
        role: "owner",
      },
    });

    const result = await provisionBusiness(db as never, identity, { mode: "ensure_default" });

    expect(result).toEqual({
      status: "ready",
      businessId: defaultBusinessIdFor(identity.uid),
    });
  });

  it("repairs only the deterministic default workspace when its business is missing", async () => {
    const defaultId = defaultBusinessIdFor(identity.uid);
    const { db, docs } = fakeFirestore({
      [`businessMembers/${defaultId}_user-1`]: {
        businessId: defaultId,
        userId: "user-1",
        role: "owner",
      },
    });

    const result = await provisionBusiness(db as never, identity, {
      mode: "ensure_default",
      preferredBusinessId: defaultId,
    });

    expect(result).toEqual({ status: "ready", businessId: defaultId });
    expect(docs.get(`businesses/${defaultId}`)).toMatchObject({ createdBy: "user-1" });
  });

  it("uses the same named business ID for a retried request", async () => {
    const { db, docs } = fakeFirestore();
    const input = { mode: "create_named" as const, name: "Main Street Auto", requestId: "request-123" };

    const first = await provisionBusiness(db as never, identity, input);
    const second = await provisionBusiness(db as never, identity, input);
    const expectedId = namedBusinessIdFor(identity.uid, input.requestId);

    expect(first).toEqual({ status: "ready", businessId: expectedId });
    expect(second).toEqual({ status: "existing", businessId: expectedId });
    expect([...docs.keys()].filter((path) => path.startsWith("businesses/"))).toHaveLength(1);
  });

  it("recovers idempotently when a foreign business preclaims a named request ID", async () => {
    const input = {
      mode: "create_named" as const,
      name: "Main Street Auto",
      requestId: "request-preclaimed",
    };
    const deterministicId = namedBusinessIdFor(identity.uid, input.requestId);
    const { db, docs } = fakeFirestore({
      [`businesses/${deterministicId}`]: {
        name: "Preclaimed",
        createdBy: "attacker",
      },
      [`businessMembers/${deterministicId}_${identity.uid}`]: {
        businessId: deterministicId,
        userId: identity.uid,
        role: "owner",
      },
    });

    const first = await provisionBusiness(db as never, identity, input);
    const second = await provisionBusiness(db as never, identity, input);

    expect(first).toMatchObject({ status: "ready" });
    expect(second).toMatchObject({ status: "existing" });
    expect("businessId" in first && "businessId" in second && first.businessId)
      .toBe("businessId" in second ? second.businessId : "");
    expect("businessId" in first && first.businessId).not.toBe(deterministicId);

    if (!("businessId" in first)) {
      throw new Error("Expected a provisioned fallback business");
    }
    expect(docs.get(`businesses/${first.businessId}`)).toMatchObject({
      name: input.name,
      createdBy: identity.uid,
    });
    expect(docs.get(`businessMembers/${first.businessId}_${identity.uid}`)).toMatchObject({
      businessId: first.businessId,
      userId: identity.uid,
      role: "owner",
    });
  });

  it("converges concurrent default provisioning on one deterministic business", async () => {
    const { db, docs } = fakeFirestore();

    const results = await Promise.all([
      provisionBusiness(db as never, identity, { mode: "ensure_default" }),
      provisionBusiness(db as never, identity, { mode: "ensure_default" }),
    ]);

    const businessIds = results.flatMap((result) =>
      "businessId" in result ? [result.businessId] : []
    );
    expect(businessIds).toEqual([
      defaultBusinessIdFor(identity.uid),
      defaultBusinessIdFor(identity.uid),
    ]);
    expect([...docs.keys()].filter((path) => path.startsWith("businesses/"))).toHaveLength(1);
    expect([...docs.keys()].filter((path) => path.startsWith("businessMembers/"))).toHaveLength(1);
  });

  it("preserves signedUpAt while refreshing lastLoginAt", async () => {
    const { db, docs } = fakeFirestore({
      "userProfiles/user-1": {
        authUserId: "user-1",
        signedUpAt: "original",
      },
      "businesses/existing": {
        name: "Existing",
        createdBy: "user-1",
      },
      "businessMembers/existing_user-1": {
        businessId: "existing",
        userId: "user-1",
        role: "owner",
      },
    });

    await provisionBusiness(db as never, identity, { mode: "ensure_default" });

    expect(docs.get("userProfiles/user-1")).toMatchObject({
      signedUpAt: "original",
      lastLoginAt: expect.anything(),
    });
  });
});
