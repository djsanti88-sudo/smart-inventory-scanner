import { describe, it, expect, beforeEach } from "vitest";
import { persistKeyForUid, hasLegacyBlob, migrateLegacyBlobOnce } from "./scanPersistNamespace";

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

describe("persistKeyForUid", () => {
  it("keeps the legacy global key for anon/mock (null uid)", () => {
    expect(persistKeyForUid(null)).toBe("sis-scan-v1");
  });
  it("namespaces by uid for a signed-in user", () => {
    expect(persistKeyForUid("abc123")).toBe("sis-scan-abc123");
  });
});

describe("hasLegacyBlob", () => {
  it("is false when no legacy blob exists at all", () => {
    const s = new MemStorage();
    expect(hasLegacyBlob(s as unknown as Storage)).toBe(false);
  });

  it("N2: is FALSE for an effectively-empty blob (sign-out residue: no scans/counts/reviews)", () => {
    const s = new MemStorage();
    // What resetForSignOut's wipe write deposits: session/snapshot residue but empty tenant collections.
    s.setItem(
      "sis-scan-v1",
      JSON.stringify({ state: { scanFeed: [], finalCounts: [], needsReviewQueue: [], sessionId: "", currentSession: null }, version: 8 }),
    );
    expect(hasLegacyBlob(s as unknown as Storage)).toBe(false);
    // Also false for a bare "{}" (no state, nothing to adopt).
    s.setItem("sis-scan-v1", "{}");
    expect(hasLegacyBlob(s as unknown as Storage)).toBe(false);
  });

  it("N2: is TRUE when the blob carries real tenant data (any of scans / counts / reviews)", () => {
    const s = new MemStorage();
    s.setItem("sis-scan-v1", JSON.stringify({ state: { scanFeed: [{ id: "e1" }], finalCounts: [], needsReviewQueue: [] }, version: 8 }));
    expect(hasLegacyBlob(s as unknown as Storage)).toBe(true);
  });

  it("N2: stays TRUE (conservative) for a present-but-unreadable blob", () => {
    const s = new MemStorage();
    s.setItem("sis-scan-v1", "{not valid json");
    expect(hasLegacyBlob(s as unknown as Storage)).toBe(true);
  });
});

describe("migrateLegacyBlobOnce", () => {
  let s: MemStorage;
  beforeEach(() => { s = new MemStorage(); });

  it("copies into the per-uid key, normalizes quantityDelta:0, and DELETES the legacy blob", () => {
    const legacy = {
      state: { scanFeed: [{ id: "e1", quantityDelta: 0 }, { id: "e2", quantityDelta: 3 }], businessId: "b1" },
      version: 7,
    };
    s.setItem("sis-scan-v1", JSON.stringify(legacy));
    migrateLegacyBlobOnce("abc123", s as unknown as Storage);
    const copied = JSON.parse(s.getItem("sis-scan-abc123")!);
    expect(copied.state.scanFeed[0].quantityDelta).toBe(1); // 0 -> 1
    expect(copied.state.scanFeed[1].quantityDelta).toBe(3); // untouched
    expect(s.getItem("sis-scan-v1")).toBeNull(); // consumed: cannot be double-inherited
  });

  it("does not overwrite an existing per-uid key and leaves the legacy blob alone (idempotent)", () => {
    s.setItem("sis-scan-v1", JSON.stringify({ state: { scanFeed: [] }, version: 7 }));
    s.setItem("sis-scan-abc123", JSON.stringify({ state: { marker: "keep" }, version: 8 }));
    migrateLegacyBlobOnce("abc123", s as unknown as Storage);
    expect(JSON.parse(s.getItem("sis-scan-abc123")!).state.marker).toBe("keep");
    expect(s.getItem("sis-scan-v1")).not.toBeNull(); // no copy happened, so nothing was consumed
  });

  it("is a no-op when there is no legacy blob", () => {
    migrateLegacyBlobOnce("abc123", s as unknown as Storage);
    expect(s.getItem("sis-scan-abc123")).toBeNull();
  });
});
