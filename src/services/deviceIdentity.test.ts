import { describe, it, expect } from "vitest";
import { getOrCreateDeviceId, getOrCreateWindowId, DEVICE_ID_KEY, WINDOW_ID_KEY } from "@/services/deviceIdentity";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe("deviceIdentity", () => {
  it("mints a new device id on first call and persists it under DEVICE_ID_KEY", () => {
    const storage = fakeStorage();
    const id = getOrCreateDeviceId(storage, () => "fixed-device-1");
    expect(id).toBe("fixed-device-1");
    expect(storage.getItem(DEVICE_ID_KEY)).toBe("fixed-device-1");
  });

  it("returns the SAME device id on a second call (does not mint twice)", () => {
    const storage = fakeStorage();
    const first = getOrCreateDeviceId(storage, () => "fixed-device-1");
    const second = getOrCreateDeviceId(storage, () => "different-if-called-again");
    expect(second).toBe(first);
  });

  it("mints a new window id on first call and persists it under WINDOW_ID_KEY", () => {
    const storage = fakeStorage();
    const id = getOrCreateWindowId(storage, () => "fixed-window-1");
    expect(id).toBe("fixed-window-1");
    expect(storage.getItem(WINDOW_ID_KEY)).toBe("fixed-window-1");
  });

  it("device id and window id are independent (different storages, different keys)", () => {
    const storage = fakeStorage();
    const deviceId = getOrCreateDeviceId(storage, () => "dev-1");
    const windowId = getOrCreateWindowId(storage, () => "win-1");
    expect(deviceId).not.toBe(windowId);
    expect(storage.getItem(DEVICE_ID_KEY)).toBe("dev-1");
    expect(storage.getItem(WINDOW_ID_KEY)).toBe("win-1");
  });

  it("uses crypto.randomUUID when no idFactory is given", () => {
    const storage = fakeStorage();
    const id = getOrCreateDeviceId(storage);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});
