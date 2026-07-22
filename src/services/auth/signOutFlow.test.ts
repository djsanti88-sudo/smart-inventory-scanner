import { describe, it, expect, vi, beforeEach } from "vitest";

const prepareSignOut = vi.fn();
const resetForSignOut = vi.fn();
const signOut = vi.fn();

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
    expect(unsyncedSignOutMessage(1)).toContain("1 scan could not sync");
    expect(unsyncedSignOutMessage(1)).toContain("discard it permanently");
    expect(unsyncedSignOutMessage(3)).toContain("3 scans could not sync");
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

  it("warns HONESTLY when scans could not sync (confirm receives the discard message)", async () => {
    prepareSignOut.mockResolvedValue(2);
    const confirmFn = vi.fn(() => true);
    await runSignOutFlow(vi.fn(), confirmFn);
    expect(confirmFn).toHaveBeenCalledWith(expect.stringContaining("2 scans could not sync"));
  });

  it("cancel aborts entirely: no reset, no signOut, no redirect", async () => {
    const redirect = vi.fn();
    const proceeded = await runSignOutFlow(redirect, () => false);
    expect(proceeded).toBe(false);
    expect(resetForSignOut).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("wipeAndSignOut", () => {
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
