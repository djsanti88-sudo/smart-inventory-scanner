import { describe, it, expect, beforeEach } from "vitest";
import { useScanStore } from "@/stores/scanStore";
import { getMockDb } from "@/services/mockDb";
import type { InventorySession } from "@/types";

const BID = useScanStore.getState().businessId;
type ApplyItem = Parameters<ReturnType<typeof getMockDb>["apply"]>[0];
const seed = (operation: string, payload: unknown, key: string) =>
  getMockDb().apply({ operation, payload, idempotencyKey: key } as unknown as ApplyItem);

function session(id: string, over: Partial<InventorySession> = {}): InventorySession {
  return {
    id, businessId: BID, name: id, location: "Main", status: "completed",
    startedAt: "2026-07-01T10:00:00.000Z", completedAt: null, createdBy: "t", notes: "",
    syncStatus: "synced", locked: false, lockedAt: null, ...over,
  };
}

beforeEach(() => {
  getMockDb().reset();
  useScanStore.setState({ businessId: BID });
});

describe("browse + reopen saved sessions", () => {
  it("listSessions returns saved sessions newest-first for this business", () => {
    seed("SAVE_SESSION", session("sess-A", { startedAt: "2026-07-01T09:00:00.000Z" }), "a");
    seed("SAVE_SESSION", session("sess-B", { startedAt: "2026-07-02T09:00:00.000Z" }), "b");
    // a different business's session must NOT leak into the list
    seed("SAVE_SESSION", session("sess-X", { businessId: "other-biz" }), "x");
    const ids = useScanStore.getState().listSessions().map((s) => s.id);
    expect(ids).toEqual(["sess-B", "sess-A"]); // newest first, other-biz excluded
  });

  it("reopenSession loads that session's counts into the live view", () => {
    seed("SAVE_SESSION", session("sess-A"), "a");
    seed("INCREMENT_COUNT", { businessId: BID, sessionId: "sess-A", productId: "p1", scanEventId: "e1", quantityDelta: 3, idempotencyKey: "c1" }, "c1");

    const ok = useScanStore.getState().reopenSession("sess-A");
    expect(ok).toBe(true);
    const st = useScanStore.getState();
    expect(st.currentSession?.id).toBe("sess-A");
    expect(st.sessionId).toBe("sess-A");
    expect(st.finalCounts.find((c) => c.productId === "p1")?.quantity).toBe(3);
  });

  it("reopenSession refuses an unknown session and another business's session", () => {
    seed("SAVE_SESSION", session("sess-X", { businessId: "other-biz" }), "x");
    expect(useScanStore.getState().reopenSession("nope")).toBe(false);
    expect(useScanStore.getState().reopenSession("sess-X")).toBe(false); // wrong business
  });
});
