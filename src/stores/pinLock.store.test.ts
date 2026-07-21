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

  it("locks -> new scans rotate to a fresh session (never dropped, Phase 3 F1) -> the locked session itself only unlocks with the correct PIN", async () => {
    await st().setOwnerPin("1234");
    const sid = st().currentSession!.id;

    expect(st().lockSession(sid)).toBe(true);
    expect(st().currentSession!.locked).toBe(true);

    // A locked session takes NO new scans itself, but the TOP-LEVEL LAW ("every scan appears and
    // counts") means the scan is never dropped - it rotates into a fresh active session instead.
    const result = st().processScan("049000028904");
    expect(result).not.toBeNull();
    expect(st().currentSession!.id).not.toBe(sid);
    expect(st().currentSession!.locked).toBeFalsy();
    expect(st().finalCounts.filter((c) => c.sessionId === st().currentSession!.id).length).toBe(1);

    // The original session is no longer current (rotated away), but it stays locked in the mock DB
    // and reopening it proves it: wrong PIN never unlocks it, right PIN does.
    st().reopenSession(sid);
    expect(st().currentSession!.locked).toBe(true);
    expect(await st().unlockSession(sid, "0000")).toBe(false);
    expect(st().currentSession!.locked).toBe(true);
    expect(await st().unlockSession(sid, "1234")).toBe(true);
    expect(st().currentSession!.locked).toBe(false);
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
