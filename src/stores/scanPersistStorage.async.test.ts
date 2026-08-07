import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAsyncCoalescedFailSoftPersistStorage } from "./scanPersistStorage";
import type { AsyncBacking } from "./idbBacking";

function makeFakeBacking(overrides: Partial<AsyncBacking> = {}) {
  const data = new Map<string, string>();
  const backing: AsyncBacking = {
    getItem: vi.fn(async (n: string) => data.get(n) ?? null),
    setItem: vi.fn(async (n: string, v: string) => { data.set(n, v); }),
    removeItem: vi.fn(async (n: string) => { data.delete(n); }),
    ...overrides,
  };
  return { backing, data };
}

const VALUE = { state: { scanFeed: [{ id: "s1" }] }, version: 7 };

describe("createAsyncCoalescedFailSoftPersistStorage", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst of setItem calls into one backing write", async () => {
    const { backing } = makeFakeBacking();
    const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing);
    for (let i = 0; i < 6; i++) storage.setItem("sis-scan-v1", { ...VALUE, version: i });
    await vi.runAllTimersAsync();
    expect(backing.setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse((backing.setItem as ReturnType<typeof vi.fn>).mock.calls[0][1]).version).toBe(5);
  });

  it("swallows backing write rejection (fail-soft, warns, never throws)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { backing } = makeFakeBacking({ setItem: vi.fn(async () => { throw new Error("quota"); }) });
    const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing);
    storage.setItem("sis-scan-v1", VALUE);
    await vi.runAllTimersAsync();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("getItem returns parsed value from the async backing", async () => {
    const { backing, data } = makeFakeBacking();
    data.set("sis-scan-v1", JSON.stringify(VALUE));
    const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing);
    await expect(storage.getItem("sis-scan-v1")).resolves.toEqual(VALUE);
  });

  it("migrates from legacy storage on IDB miss and clears legacy only after copy succeeds", async () => {
    const { backing, data } = makeFakeBacking();
    const legacy = {
      getItem: vi.fn(() => JSON.stringify(VALUE)),
      removeItem: vi.fn(),
    };
    const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
    await expect(storage.getItem("sis-scan-v1")).resolves.toEqual(VALUE);
    await vi.runAllTimersAsync();
    expect(data.get("sis-scan-v1")).toBe(JSON.stringify(VALUE)); // copied into IDB
    expect(legacy.removeItem).toHaveBeenCalledWith("sis-scan-v1"); // cleared AFTER copy
  });

  it("does NOT clear legacy storage when the migration copy fails", async () => {
    const legacy = { getItem: vi.fn(() => JSON.stringify(VALUE)), removeItem: vi.fn() };
    const { backing } = makeFakeBacking({ setItem: vi.fn(async () => { throw new Error("idb down"); }) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
    await storage.getItem("sis-scan-v1");
    await vi.runAllTimersAsync();
    expect(legacy.removeItem).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("removeItem cancels the pending write and removes from backing AND legacy", async () => {
    const { backing } = makeFakeBacking();
    const legacy = { getItem: vi.fn(() => null), removeItem: vi.fn() };
    const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
    storage.setItem("sis-scan-u1", VALUE);
    storage.removeItem("sis-scan-u1");
    await vi.runAllTimersAsync();
    expect(backing.setItem).not.toHaveBeenCalled(); // pending write cancelled
    expect(backing.removeItem).toHaveBeenCalledWith("sis-scan-u1");
    expect(legacy.removeItem).toHaveBeenCalledWith("sis-scan-u1");
  });
});
