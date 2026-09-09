import { describe, expect, it } from "vitest";
import type { InventoryCount } from "@/types";
import { countsForActiveSession } from "./sessionCounts";

const count = (businessId: string, sessionId: string): InventoryCount => ({
  id: `${businessId}-${sessionId}`, businessId, sessionId, productId: "p", quantity: 1,
  lastScannedAt: "", aliasesSeen: [], scanEventIds: [], createdAt: "", updatedAt: "",
  syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
});

describe("countsForActiveSession", () => {
  const counts = [count("b1", "s1"), count("b1", "s2"), count("b2", "s1")];

  it("returns only the active tenant session", () => {
    expect(countsForActiveSession(counts, { id: "s1", businessId: "b1" })).toEqual([counts[0]]);
  });

  it("fails closed without a matching active session", () => {
    expect(countsForActiveSession(counts, null)).toEqual([]);
    expect(countsForActiveSession(counts, { id: "s1", businessId: "b2" })).toEqual([counts[2]]);
  });
});
