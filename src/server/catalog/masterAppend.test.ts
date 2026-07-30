import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LadderStorage } from "@/server/upc/storage";

// M1 deep-review fix 1 (re-leak): the "disputed" remerge path in appendMasterCatalogEntry must never
// write disputedBy/auditLog onto the PUBLIC catalogEntries parent doc (mirrors the split
// catalogDispute.ts already enforces - see catalogModeration.rules.test.ts). Mock firebase-admin's
// FieldValue the same sentinel-object way route.test.ts already does, so the "strip the legacy fields
// off the parent" assertion can check for the delete sentinel without a live Firestore app.
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    delete: () => ({ __op: "delete" }),
  },
}));

import {
  buildMasterCatalogEntry,
  appendMasterCatalogEntry,
  __resetMasterAppendErrorLatchForTests,
  type MasterAppendInput,
} from "./masterAppend";

function baseInput(overrides: Partial<MasterAppendInput> = {}): MasterAppendInput {
  return {
    normalizedBarcode: "012345678905",
    codeType: "upc_a",
    decision: { status: "verified", exactCodeEvidenceVerifiedByApp: true, confidence: 0.92 },
    identity: { name: "Widget 100", brand: "Acme", category: "tools" },
    ...overrides,
  };
}

describe("buildMasterCatalogEntry (pure trust gate)", () => {
  // (a) suggested/self-report/vendor_label/x00 -> null
  it("returns null for a suggested (non-verified) decision", () => {
    expect(buildMasterCatalogEntry(baseInput({ decision: { status: "suggested", exactCodeEvidenceVerifiedByApp: true } }))).toBeNull();
  });

  it("returns null for a bare GPT self-report (verified status but app-unverified evidence)", () => {
    expect(buildMasterCatalogEntry(baseInput({ decision: { status: "verified", exactCodeEvidenceVerifiedByApp: false } }))).toBeNull();
  });

  it("returns null for a vendor_label codeType even when verified + app-verified", () => {
    expect(buildMasterCatalogEntry(baseInput({ codeType: "vendor_label" }))).toBeNull();
  });

  it("returns null for an X00 / FNSKU-style non-public codeType", () => {
    expect(buildMasterCatalogEntry(baseInput({ codeType: "x00" }))).toBeNull();
  });

  it("returns null for an empty identity name", () => {
    expect(buildMasterCatalogEntry(baseInput({ identity: { name: "", brand: "Acme" } }))).toBeNull();
  });

  // (b) verified + app-verified + upc_a -> entry with provenanceTier "ladder_verified_strong"
  it("builds a well-formed entry for a strong app-verified public-barcode decode", () => {
    const entry = buildMasterCatalogEntry(baseInput());
    expect(entry).not.toBeNull();
    expect(entry!.provenanceTier).toBe("ladder_verified_strong");
    expect(entry!.verificationStatus).toBe("verified");
    expect(entry!.id).toMatch(/^gtin_/);
    expect(entry!.normalizedBarcode).toBe("012345678905");
    expect(entry!.name).toBe("Widget 100");
    expect(entry!.brand).toBe("Acme");
  });

  it("builds entries for ean_13 and gtin_14 public shapes too", () => {
    expect(buildMasterCatalogEntry(baseInput({ codeType: "ean_13" }))).not.toBeNull();
    expect(buildMasterCatalogEntry(baseInput({ codeType: "gtin_14" }))).not.toBeNull();
  });

  // (c) stray businessId key -> output has none
  it("never leaks a businessId key onto the master payload even if present on the input object", () => {
    const dirtyInput = baseInput() as MasterAppendInput & { businessId?: string };
    dirtyInput.businessId = "biz-should-never-appear";
    const entry = buildMasterCatalogEntry(dirtyInput);
    expect(entry).not.toBeNull();
    expect(entry).not.toHaveProperty("businessId");
    expect(JSON.stringify(entry)).not.toContain("biz-should-never-appear");
  });

  // (f) canonicalGtin null (malformed code despite public codeType) -> builder returns null, no
  // "gtin_null" id ever constructed (review F5).
  it("returns null (never gtin_null) when canonicalGtin cannot resolve a malformed code", () => {
    const entry = buildMasterCatalogEntry(baseInput({ normalizedBarcode: "not-a-gtin-shape" }));
    expect(entry).toBeNull();
  });

  // FIX 1 (max-review, confidence floor): the builder must enforce a HARD server-side >=0.8 confidence
  // floor independent of any request threshold. clampConfidenceThreshold floors at 0.6, so without this
  // gate a crafted POST could mint a 0.6-0.79 "verified" into the shared cross-tenant master catalog,
  // violating the documented decode invariant (CLAUDE.md: verified requires confidence >= 0.8).
  it("returns null when confidence is 0.79 (just under the 0.8 master-truth floor)", () => {
    expect(
      buildMasterCatalogEntry(baseInput({ decision: { status: "verified", exactCodeEvidenceVerifiedByApp: true, confidence: 0.79 } })),
    ).toBeNull();
  });

  it("builds an entry when confidence is exactly 0.8 (floor inclusive)", () => {
    expect(
      buildMasterCatalogEntry(baseInput({ decision: { status: "verified", exactCodeEvidenceVerifiedByApp: true, confidence: 0.8 } })),
    ).not.toBeNull();
  });

  it("returns null when confidence is undefined (no numeric confidence, never assume it cleared the floor)", () => {
    expect(
      buildMasterCatalogEntry(baseInput({ decision: { status: "verified", exactCodeEvidenceVerifiedByApp: true, confidence: undefined } })),
    ).toBeNull();
  });
});

// ---- Admin-SDK upsert (mocked db, never live Firestore) ----

function makeMockTx(existingData: Record<string, unknown> | undefined, exists: boolean) {
  const setCalls: Array<[unknown, unknown, unknown]> = [];
  const tx = {
    get: vi.fn().mockResolvedValue({ exists, data: () => existingData }),
    set: vi.fn((ref: unknown, data: unknown, opts: unknown) => {
      setCalls.push([ref, data, opts]);
    }),
  };
  return { tx, setCalls };
}

function makeMockDb(txImpl: (tx: unknown) => Promise<unknown>) {
  const docRef = { id: "gtin_012345678905" };
  const collectionDoc = vi.fn(() => docRef);
  const collection = vi.fn(() => ({ doc: collectionDoc }));
  const runTransaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(await txImpl));
  return { collection, runTransaction, docRef } as unknown as FirebaseFirestore.Firestore & {
    collection: typeof collection;
    runTransaction: typeof runTransaction;
  };
}

describe("appendMasterCatalogEntry (Admin-SDK upsert, mocked)", () => {
  const entry = buildMasterCatalogEntry(baseInput())!;

  // (e) write applied with merge semantics at catalogEntries/gtin_<canonical> inside runTransaction
  it("writes with merge semantics at the deterministic gtin_<canonical> doc id", async () => {
    const { tx, setCalls } = makeMockTx(undefined, false);
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ({ id: entry.id })) })),
      runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as FirebaseFirestore.Firestore;

    const result = await appendMasterCatalogEntry(entry, { db });
    expect(result).toBe("written");
    expect(db.runTransaction).toHaveBeenCalledOnce();
    expect(tx.get).toHaveBeenCalledOnce();
    expect(setCalls).toHaveLength(1);
    const [, data, opts] = setCalls[0];
    expect(opts).toEqual({ merge: true });
    expect((data as Record<string, unknown>).provenanceTier).toBe("ladder_verified_strong");
    expect((db.collection as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("catalogEntries");
  });

  // (d) mocked existing doc human_verified -> "skipped_human", write not applied (transaction path)
  it("skips (no downgrade) when the existing doc is already human_verified", async () => {
    const { tx, setCalls } = makeMockTx({ provenanceTier: "human_verified" }, true);
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ({ id: entry.id })) })),
      runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as FirebaseFirestore.Firestore;

    const result = await appendMasterCatalogEntry(entry, { db });
    expect(result).toBe("skipped_human");
    expect(setCalls).toHaveLength(0);
  });

  // Re-append trap: an owner-REJECTED entry is a human decision too. A later strong ladder decode
  // of the same code must never silently flip it back to verified - skip with its own honest outcome.
  it("skips (never re-verifies) when the existing doc is owner-rejected", async () => {
    const { tx, setCalls } = makeMockTx({ verificationStatus: "rejected", provenanceTier: "ladder_verified_strong" }, true);
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ({ id: entry.id })) })),
      runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as FirebaseFirestore.Firestore;

    const result = await appendMasterCatalogEntry(entry, { db });
    expect(result).toBe("skipped_rejected");
    expect(setCalls).toHaveLength(0);
  });

  // Catalog revocation round (design §2.4b CRITICAL): a disputed entry must NEVER be silently
  // re-verified by the very next strong ladder decode of the same code - that would undo a live
  // dispute with no human in the loop. The re-decode instead lands as a "pending" re-candidate,
  // preserving the dispute history (disputeCount) so the reviewing human sees both the fresh
  // evidence AND the dispute trail together.
  //
  // M1 deep-review fix 1 (RE-LEAK): disputedBy/auditLog (raw businessId + free-text reason) were
  // moved off the public catalogEntries parent doc by commit f416404e (see catalogDispute.ts /
  // catalogModeration.rules.test.ts), but THIS remerge path independently re-wrote
  // existing.disputedBy/auditLog straight back onto the parent whenever it fired - re-opening the
  // exact leak the split was supposed to close. Fix: never spread those fields onto the parent; if
  // present on the existing doc (legacy - predates the moderation split), migrate them into the
  // locked moderation subcollection doc in the SAME transaction and strip them off the parent with
  // FieldValue.delete().
  function makeModRef() {
    return { __kind: "moderation" as const };
  }
  function makeParentRefWithModeration(id: string, modRef: { __kind: "moderation" }) {
    return {
      id,
      collection: vi.fn((name: string) => {
        if (name !== "moderation") throw new Error(`unexpected subcollection ${name}`);
        return { doc: vi.fn((docId: string) => (docId === "log" ? modRef : { __kind: "moderation" as const })) };
      }),
    };
  }
  function makeDisputedTx(
    parentData: Record<string, unknown>,
    modData: Record<string, unknown> | undefined,
    modExists: boolean,
  ) {
    const setCalls: Array<{ ref: unknown; data: unknown; opts: unknown }> = [];
    const tx = {
      get: vi.fn((ref: { __kind?: string }) =>
        Promise.resolve(
          ref?.__kind === "moderation"
            ? { exists: modExists, data: () => modData }
            : { exists: true, data: () => parentData },
        ),
      ),
      set: vi.fn((ref: unknown, data: unknown, opts: unknown) => {
        setCalls.push({ ref, data, opts });
      }),
    };
    return { tx, setCalls };
  }

  it("re-append over a disputed doc lands as pending (never silently re-verifies), preserving disputeCount", async () => {
    const existing = { verificationStatus: "disputed", provenanceTier: "ladder_verified_strong", disputeCount: 1 };
    const { tx, setCalls } = makeDisputedTx(existing, undefined, false);
    const modRef = makeModRef();
    const parentRef = makeParentRefWithModeration(entry.id, modRef);
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => parentRef) })),
      runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as FirebaseFirestore.Firestore;

    const result = await appendMasterCatalogEntry(entry, { db });
    expect(result).toBe("written");
    expect(setCalls).toHaveLength(1);
    const payload = setCalls[0].data as Record<string, unknown>;
    // Fresh identity fields land, but verificationStatus is demoted to "pending" - never "verified".
    expect(payload.verificationStatus).toBe("pending");
    expect(payload.name).toBe(entry.name);
    // Dispute history (the plain count, never raw businessId/free text) is preserved untouched.
    expect(payload.disputeCount).toBe(1);
  });

  it("NEVER re-writes disputedBy/auditLog onto the public parent doc, even when absent from the existing doc", async () => {
    const existing = { verificationStatus: "disputed", provenanceTier: "ladder_verified_strong", disputeCount: 2 };
    const { tx, setCalls } = makeDisputedTx(existing, undefined, false);
    const modRef = makeModRef();
    const parentRef = makeParentRefWithModeration(entry.id, modRef);
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => parentRef) })),
      runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as FirebaseFirestore.Firestore;

    const result = await appendMasterCatalogEntry(entry, { db });
    expect(result).toBe("written");
    const payload = setCalls[0].data as Record<string, unknown>;
    expect(payload).not.toHaveProperty("disputedBy");
    expect(payload).not.toHaveProperty("auditLog");
    // No legacy fields on the existing doc -> nothing to migrate, moderation subcollection untouched.
    expect(parentRef.collection).not.toHaveBeenCalled();
    expect(setCalls).toHaveLength(1);
  });

  it("migrates LEGACY disputedBy/auditLog off a pre-split parent doc into the locked moderation subcollection, stripping them from the parent with FieldValue.delete()", async () => {
    const legacyDisputedBy = [{ businessId: "biz-a", at: "2026-07-20T00:00:00.000Z" }];
    const legacyAuditLog = [{ at: "2026-07-20T00:00:00.000Z", action: "disputed", by: "biz-a" }];
    const existing = {
      verificationStatus: "disputed",
      provenanceTier: "ladder_verified_strong",
      disputeCount: 1,
      disputedBy: legacyDisputedBy,
      auditLog: legacyAuditLog,
    };
    const { tx, setCalls } = makeDisputedTx(existing, undefined, false);
    const modRef = makeModRef();
    const parentRef = makeParentRefWithModeration(entry.id, modRef);
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => parentRef) })),
      runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as FirebaseFirestore.Firestore;

    const result = await appendMasterCatalogEntry(entry, { db });
    expect(result).toBe("written");
    expect(setCalls).toHaveLength(2);

    const parentSet = setCalls.find((c) => c.ref === parentRef)!;
    const parentPayload = parentSet.data as Record<string, unknown>;
    expect(parentPayload.verificationStatus).toBe("pending");
    expect(parentPayload.disputeCount).toBe(1);
    // The legacy fields are explicitly stripped (FieldValue.delete() sentinel), not merely omitted -
    // merge:true alone would leave pre-existing parent fields untouched.
    expect(parentPayload.disputedBy).toEqual({ __op: "delete" });
    expect(parentPayload.auditLog).toEqual({ __op: "delete" });

    const modSet = setCalls.find((c) => c.ref === modRef)!;
    expect(modSet.opts).toEqual({ merge: true });
    const modPayload = modSet.data as Record<string, unknown>;
    expect(modPayload.disputedBy).toEqual(legacyDisputedBy);
    expect(modPayload.auditLog).toEqual(legacyAuditLog);
  });

  it("merges legacy parent dispute fields into an ALREADY-populated moderation doc without duplicating businessIds or dropping audit entries", async () => {
    const legacyDisputedBy = [
      { businessId: "biz-a", at: "2026-07-01T00:00:00.000Z" },
      { businessId: "biz-legacy-only", at: "2026-07-02T00:00:00.000Z" },
    ];
    const legacyAuditLog = [{ at: "2026-07-01T00:00:00.000Z", action: "disputed", by: "biz-a" }];
    const existing = {
      verificationStatus: "disputed",
      provenanceTier: "ladder_verified_strong",
      disputeCount: 3,
      disputedBy: legacyDisputedBy,
      auditLog: legacyAuditLog,
    };
    const existingModDisputedBy = [
      { businessId: "biz-a", at: "2026-07-20T00:00:00.000Z" },
      { businessId: "biz-c", at: "2026-07-21T00:00:00.000Z" },
    ];
    const existingModAuditLog = [{ at: "2026-07-20T00:00:00.000Z", action: "disputed", by: "biz-a" }];
    const modData = { disputedBy: existingModDisputedBy, auditLog: existingModAuditLog };

    const { tx, setCalls } = makeDisputedTx(existing, modData, true);
    const modRef = makeModRef();
    const parentRef = makeParentRefWithModeration(entry.id, modRef);
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => parentRef) })),
      runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as FirebaseFirestore.Firestore;

    const result = await appendMasterCatalogEntry(entry, { db });
    expect(result).toBe("written");

    const modSet = setCalls.find((c) => c.ref === modRef)!;
    const modPayload = modSet.data as Record<string, unknown>;
    const mergedDisputedBy = modPayload.disputedBy as Array<{ businessId: string }>;
    // Existing moderation entries are preserved as-is; the legacy biz-a is NOT duplicated (it's
    // already recorded in moderation); the legacy-only business is folded in.
    expect(mergedDisputedBy.map((d) => d.businessId)).toEqual(["biz-a", "biz-c", "biz-legacy-only"]);
    const mergedAuditLog = modPayload.auditLog as unknown[];
    expect(mergedAuditLog).toHaveLength(2); // legacy entry + existing moderation entry - neither dropped.

    const parentPayload = setCalls.find((c) => c.ref === parentRef)!.data as Record<string, unknown>;
    expect(parentPayload.disputedBy).toEqual({ __op: "delete" });
    expect(parentPayload.auditLog).toEqual({ __op: "delete" });
  });

  it("allows overwrite (retry idempotency) when the existing doc is NOT human_verified", async () => {
    const { tx, setCalls } = makeMockTx({ provenanceTier: "ladder_verified_strong" }, true);
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ({ id: entry.id })) })),
      runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as FirebaseFirestore.Firestore;

    const result = await appendMasterCatalogEntry(entry, { db });
    expect(result).toBe("written");
    expect(setCalls).toHaveLength(1);
  });

  it("returns 'error' (never throws) when the transaction rejects", async () => {
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ({ id: entry.id })) })),
      runTransaction: vi.fn(async () => {
        throw new Error("firestore down");
      }),
    } as unknown as FirebaseFirestore.Firestore;

    const result = await appendMasterCatalogEntry(entry, { db });
    expect(result).toBe("error");
  });
});

// ---- Task 2 (outcome visibility): KV counter + first-error-per-process console.error ----

/** A minimal in-memory LadderStorage double so these tests never touch the file adapter or Turso. */
function makeMockStorage(): LadderStorage & { kv: Map<string, string> } {
  const kv = new Map<string, string>();
  return {
    kv,
    async readUsage() {
      return { month: "2026-07", used: 0 };
    },
    async writeUsage() {},
    async incrementUsage() {
      return 0;
    },
    async readMissCache() {
      return null;
    },
    async writeMissCache() {},
    async appendArchive() {},
    async appendOutcome() {},
    async get(key: string) {
      return kv.has(key) ? kv.get(key)! : null;
    },
    async set(key: string, value: string) {
      kv.set(key, value);
    },
    async increment(key: string) {
      const n = Number(kv.get(key) ?? "0") + 1;
      kv.set(key, String(n));
      return n;
    },
    async incrementBy(key: string, delta: number) {
      const n = Number(kv.get(key) ?? "0") + delta;
      kv.set(key, String(n));
      return n;
    },
  };
}

function makeTxDb(existingData: Record<string, unknown> | undefined, exists: boolean) {
  const { tx } = makeMockTx(existingData, exists);
  return {
    collection: vi.fn(() => ({ doc: vi.fn(() => ({ id: "gtin_012345678905" })) })),
    runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as FirebaseFirestore.Firestore;
}

describe("appendMasterCatalogEntry outcome counter (Task 2, KV pattern)", () => {
  const entry = buildMasterCatalogEntry(baseInput())!;

  beforeEach(() => {
    __resetMasterAppendErrorLatchForTests();
  });

  it("increments the written counter on a successful write", async () => {
    const storage = makeMockStorage();
    const db = makeTxDb(undefined, false);
    const result = await appendMasterCatalogEntry(entry, { db, storage });
    expect(result).toBe("written");
    // recordOutcome is fire-and-forget (void, not awaited) - flush microtasks before asserting.
    await new Promise((r) => setTimeout(r, 0));
    expect(storage.kv.get("master_catalog_append:written")).toBe("1");
    expect(storage.kv.get("master_catalog_append:error")).toBeUndefined();
  });

  it("increments the skipped_human counter when an existing doc is already human_verified", async () => {
    const storage = makeMockStorage();
    const db = makeTxDb({ provenanceTier: "human_verified" }, true);
    const result = await appendMasterCatalogEntry(entry, { db, storage });
    expect(result).toBe("skipped_human");
    await new Promise((r) => setTimeout(r, 0));
    expect(storage.kv.get("master_catalog_append:skipped_human")).toBe("1");
  });

  it("increments the skipped_rejected counter when an existing doc is owner-rejected", async () => {
    const storage = makeMockStorage();
    const db = makeTxDb({ verificationStatus: "rejected" }, true);
    const result = await appendMasterCatalogEntry(entry, { db, storage });
    expect(result).toBe("skipped_rejected");
    await new Promise((r) => setTimeout(r, 0));
    expect(storage.kv.get("master_catalog_append:skipped_rejected")).toBe("1");
  });

  it("increments the error counter AND records the real error reason + timestamp when the transaction rejects", async () => {
    const storage = makeMockStorage();
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ({ id: entry.id })) })),
      runTransaction: vi.fn(async () => {
        throw new Error("firestore down: DEADLINE_EXCEEDED");
      }),
    } as unknown as FirebaseFirestore.Firestore;

    const result = await appendMasterCatalogEntry(entry, { db, storage });
    expect(result).toBe("error");
    await new Promise((r) => setTimeout(r, 0));
    expect(storage.kv.get("master_catalog_append:error")).toBe("1");
    expect(storage.kv.get("master_catalog_append:last_error_reason")).toBe("firestore down: DEADLINE_EXCEEDED");
    expect(storage.kv.get("master_catalog_append:last_error_at")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("accumulates counts across multiple calls instead of overwriting", async () => {
    const storage = makeMockStorage();
    const db1 = makeTxDb(undefined, false);
    const db2 = makeTxDb(undefined, false);
    await appendMasterCatalogEntry(entry, { db: db1, storage });
    await appendMasterCatalogEntry(entry, { db: db2, storage });
    await new Promise((r) => setTimeout(r, 0));
    expect(storage.kv.get("master_catalog_append:written")).toBe("2");
  });

  it("console.error's the underlying reason on the FIRST error this process, not a generic message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = makeMockStorage();
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ({ id: entry.id })) })),
      runTransaction: vi.fn(async () => {
        throw new Error("permission-denied: missing IAM role");
      }),
    } as unknown as FirebaseFirestore.Firestore;

    await appendMasterCatalogEntry(entry, { db, storage });
    expect(spy).toHaveBeenCalledOnce();
    const loggedArgs = spy.mock.calls[0].join(" ");
    expect(loggedArgs).toContain("permission-denied: missing IAM role");
    spy.mockRestore();
  });

  it("does NOT re-log a second error in the same process (first-error-per-process latch)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = makeMockStorage();
    const failingDb = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ({ id: entry.id })) })),
      runTransaction: vi.fn(async () => {
        throw new Error("error one");
      }),
    } as unknown as FirebaseFirestore.Firestore;
    const failingDb2 = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ({ id: entry.id })) })),
      runTransaction: vi.fn(async () => {
        throw new Error("error two");
      }),
    } as unknown as FirebaseFirestore.Firestore;

    await appendMasterCatalogEntry(entry, { db: failingDb, storage });
    await appendMasterCatalogEntry(entry, { db: failingDb2, storage });
    // Both failures are still counted...
    await new Promise((r) => setTimeout(r, 0));
    expect(storage.kv.get("master_catalog_append:error")).toBe("2");
    // ...but console.error only fired once (the first occurrence this process).
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

});

// ---- admin-db-unavailable (no creds): getAdminDb() itself throws before any transaction runs ----
// Isolated in its own describe block with vi.mock so it never depends on the REAL firebaseAdmin
// module's async credential-resolution behavior (which rejects on a later tick outside any
// synchronous try/catch in a real no-creds environment, rather than throwing synchronously - see
// LESSONS_LEARNED: never assume an SDK failure mode without observing it). Mocking getAdminDb to
// throw synchronously proves the exact contract this module promises: "creds/entry absent -> never
// throws, always resolves 'error', and it must still be counted."
vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminDb: () => {
    throw new Error("admin db unavailable: no credentials configured");
  },
}));

describe("appendMasterCatalogEntry admin-db-unavailable (Task 2, no-creds path)", () => {
  it("returns 'error' (never throws) and counts it when getAdminDb() itself throws", async () => {
    __resetMasterAppendErrorLatchForTests();
    const storage = makeMockStorage();
    const entry = buildMasterCatalogEntry(baseInput())!;
    // No `db` in deps - forces the appendMasterCatalogEntry call path through the mocked getAdminDb().
    const result = await appendMasterCatalogEntry(entry, { storage });
    expect(result).toBe("error");
    await new Promise((r) => setTimeout(r, 0));
    expect(storage.kv.get("master_catalog_append:error")).toBe("1");
    expect(storage.kv.get("master_catalog_append:last_error_reason")).toBe(
      "admin db unavailable: no credentials configured",
    );
  });
});
