import { describe, it, expect, beforeEach } from "vitest";
import { useScanStore } from "@/stores/scanStore";

const st = () => useScanStore.getState();

beforeEach(() => {
  st().startSession("Test", "Main"); // fresh active session, empty counts
  useScanStore.setState((s) => ({ settings: { ...s.settings, ownerPinHash: "" } })); // no PIN
});

describe("owner PIN lock", () => {
  it("cannot lock a session until an owner PIN is set", () => {
    const sid = st().currentSession!.id;
    expect(st().lockSession(sid)).toBe(false); // no PIN -> refused
    expect(st().currentSession!.locked).toBeFalsy();
  });

  it("rejects an invalid PIN format", async () => {
    expect(await st().setOwnerPin("12")).toBe(false); // too short
    expect(await st().setOwnerPin("12ab")).toBe(false); // non-digit
    expect(st().hasOwnerPin()).toBe(false);
    expect(await st().setOwnerPin("1234")).toBe(true);
    expect(st().hasOwnerPin()).toBe(true);
  });

  it("locks -> blocks new scans -> unlocks only with the correct PIN", async () => {
    await st().setOwnerPin("1234");
    const sid = st().currentSession!.id;

    expect(st().lockSession(sid)).toBe(true);
    expect(st().currentSession!.locked).toBe(true);

    // a locked session takes NO new scans
    expect(st().processScan("049000028904")).toBeNull();
    expect(st().finalCounts.length).toBe(0);

    // wrong PIN keeps it locked
    expect(await st().unlockSession(sid, "0000")).toBe(false);
    expect(st().currentSession!.locked).toBe(true);

    // correct PIN unlocks; scanning works again
    expect(await st().unlockSession(sid, "1234")).toBe(true);
    expect(st().currentSession!.locked).toBe(false);
    expect(st().processScan("049000028904")).not.toBeNull();
    expect(st().finalCounts.length).toBe(1);
  });

  it("a locked session blocks count edits (remove + correct)", async () => {
    await st().setOwnerPin("2468");
    // count one item first (unlocked)
    st().processScan("049000028904");
    const pid = st().finalCounts[0].productId;
    // lock, then edits must be no-ops
    st().lockSession(st().currentSession!.id);
    st().removeFromCount(pid);
    expect(st().finalCounts.length).toBe(1); // not removed
    st().correctProduct(pid, { name: "HACKED" });
    expect(st().products.find((p) => p.id === pid)?.name).not.toBe("HACKED");
  });

  it("resetOwnerPin clears the PIN and unlocks everything (forgot-PIN escape hatch)", async () => {
    await st().setOwnerPin("4321");
    st().lockSession(st().currentSession!.id);
    expect(st().currentSession!.locked).toBe(true);
    st().resetOwnerPin();
    expect(st().hasOwnerPin()).toBe(false);
    expect(st().currentSession!.locked).toBe(false); // unlocked so a forgotten PIN never traps a count
  });
});
