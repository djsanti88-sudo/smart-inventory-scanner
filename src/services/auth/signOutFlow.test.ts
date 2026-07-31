import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAsyncDurableStorage, type AsyncKeyValueDatabase } from "@/stores/scanPersistStorage";

const prepareSignOut = vi.fn();
const resetForSignOut = vi.fn();
const signOut = vi.fn();

class DelayedClearDatabase implements AsyncKeyValueDatabase {
  private notifyRemoveStarted: (() => void) | undefined;
  private releaseRemove: (() => void) | undefined;
  readonly removeStarted = new Promise<void>((resolve) => { this.notifyRemoveStarted = resolve; });
  private readonly removeMayFinish = new Promise<void>((resolve) => { this.releaseRemove = resolve; });
  async get() { return null; }
  async set() {}
  async remove() { this.notifyRemoveStarted?.(); await this.removeMayFinish; }
  release() { this.releaseRemove?.(); }
}

vi.mock("@/stores/scanStore", () => ({
  useScanStore: { getState: () => ({ prepareSignOut, resetForSignOut }) },
}));
vi.mock("@/lib/auth", () => ({ signOut: (...a: unknown[]) => signOut(...a) }));

import { runSignOutFlow, wipeAndSignOut, unsyncedSignOutMessage } from "@/services/auth/signOutFlow";

beforeEach(() => {
  prepareSignOut.mockReset().mockResolvedValue(0);
  resetForSignOut.mockReset();
  signOut.mockReset().mockResolvedValue(undefined);
});

describe("unsyncedSignOutMessage", () => {
  it("clean copy when nothing is unsynced", () => {
    expect(unsyncedSignOutMessage(0)).toContain("counts are saved");
  });
  it("honest discard warning, singular vs plural", () => {
    expect(unsyncedSignOutMessage(1)).toContain("1 queued change could not sync");
    expect(unsyncedSignOutMessage(1)).toContain("across your businesses");
    expect(unsyncedSignOutMessage(1)).toContain("discard it permanently");
    expect(unsyncedSignOutMessage(3)).toContain("3 queued changes could not sync");
    expect(unsyncedSignOutMessage(3)).toContain("across your businesses");
    expect(unsyncedSignOutMessage(3)).toContain("discard them permanently");
  });
});

describe("runSignOutFlow", () => {
  it("proceeds: reset THEN signOut THEN redirect, in order", async () => {
    const order: string[] = [];
    resetForSignOut.mockImplementation(() => order.push("reset"));
    signOut.mockImplementation(async () => {
      order.push("signOut");
    });
    const redirect = vi.fn(() => order.push("redirect"));

    const proceeded = await runSignOutFlow(redirect, () => true);

    expect(proceeded).toBe(true);
    expect(order).toEqual(["reset", "signOut", "redirect"]);
  });

  it("waits for the durable local-state clear before signing out or redirecting", async () => {
    const order: string[] = [];
    const database = new DelayedClearDatabase();
    const storage = createAsyncDurableStorage({
      database,
      getLegacyStorage: () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }),
    });
    resetForSignOut.mockImplementation(() => Promise.resolve(storage.removeItem("sis-scan-user")).then(() => {
      order.push("clear-complete");
    }));
    signOut.mockImplementation(async () => { order.push("signOut"); });
    const redirect = vi.fn(() => order.push("redirect"));

    const flow = runSignOutFlow(redirect, () => true);
    await database.removeStarted;

    expect(signOut).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
    database.release();
    await flow;

    expect(order).toEqual(["clear-complete", "signOut", "redirect"]);
  });

  it("warns HONESTLY when queued changes across businesses could not sync", async () => {
    prepareSignOut.mockResolvedValue(2);
    const confirmFn = vi.fn(() => true);
    await runSignOutFlow(vi.fn(), confirmFn);
    expect(confirmFn).toHaveBeenCalledWith(expect.stringContaining("2 queued changes could not sync"));
  });

  it("cancel aborts entirely: no reset, no signOut, no redirect", async () => {
    const redirect = vi.fn();
    const proceeded = await runSignOutFlow(redirect, () => false);
    expect(proceeded).toBe(false);
    expect(resetForSignOut).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("does not sign out or redirect when the local clear is not authoritative", async () => {
    resetForSignOut.mockResolvedValue({ cleared: false });
    const redirect = vi.fn();

    await expect(runSignOutFlow(redirect, () => true)).resolves.toBe(false);

    expect(signOut).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("wipeAndSignOut", () => {
  it("returns false and leaves auth active when the clear is not authoritative", async () => {
    resetForSignOut.mockResolvedValue({ cleared: false });

    await expect(wipeAndSignOut()).resolves.toBe(false);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("wipes then signs out, no confirm invoked", async () => {
    const order: string[] = [];
    resetForSignOut.mockImplementation(() => order.push("reset"));
    signOut.mockImplementation(async () => {
      order.push("signOut");
    });
    await wipeAndSignOut();
    expect(order).toEqual(["reset", "signOut"]);
  });
});
