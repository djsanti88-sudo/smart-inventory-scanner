import type { InventoryCount, InventorySession } from "@/types";

export function countsForActiveSession(
  counts: InventoryCount[],
  session: Pick<InventorySession, "id" | "businessId"> | null,
): InventoryCount[] {
  if (!session) return [];
  return counts.filter((count) => count.businessId === session.businessId && count.sessionId === session.id);
}
