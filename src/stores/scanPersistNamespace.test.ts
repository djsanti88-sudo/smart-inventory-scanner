import { describe, it, expect, beforeEach } from "vitest";
import { persistKeyForUid, migrateLegacyBlobOnce } from "./scanPersistNamespace";

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
