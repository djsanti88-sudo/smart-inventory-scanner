import { describe, expect, it, vi } from "vitest";
import { createAsyncDurableStorage, type AsyncKeyValueDatabase } from "@/stores/scanPersistStorage";

class Db implements AsyncKeyValueDatabase {
  values = new Map<string, string>(); fail = false;
  async get(k: string) { return this.values.get(k) ?? null; }
  async set(k: string, v: string) { if (this.fail) throw new Error("blocked"); this.values.set(k, v); }
  async remove(k: string) { if (this.fail) throw new Error("blocked"); this.values.delete(k); }
}
function legacy() { const values = new Map<string, string>(); return { values, getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) }; }

describe("active async persistence adapter", () => {
  it("migrates legacy bytes into durable storage", async () => {
    const db = new Db(), local = legacy(); local.values.set("sis-scan-owner", '{"version":14}');
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    await expect(storage.getItem("sis-scan-owner")).resolves.toBe('{"version":14}');
    expect(await db.get("sis-scan-owner")).toBe('{"version":14}');
  });
  it("coalesces burst writes to the latest snapshot", async () => {
    const db = new Db(), local = legacy(), set = vi.spyOn(db, "set");
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    await Promise.all([storage.setItem("sis-scan-owner", "a"), storage.setItem("sis-scan-owner", "b")]);
    expect(set).toHaveBeenCalledTimes(1); expect(await db.get("sis-scan-owner")).toBe("b");
  });
  it("tombstones failed deletion so stale data cannot rehydrate", async () => {
    const db = new Db(), local = legacy(); await db.set("sis-scan-owner", "old"); db.fail = true;
    await createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).removeItem("sis-scan-owner");
    db.fail = false;
    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner")).resolves.toBeNull();
  });
  it("fails soft when both stores are unavailable", async () => {
    const db = new Db(); db.fail = true;
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => { throw new Error("private"); } });
    await expect(storage.setItem("sis-scan-owner", "scan")).resolves.toBeUndefined();
  });
});
