import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportMenu } from "@/components/ExportMenu";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { useScanStore } from "@/stores/scanStore";
import type { PendingSyncItem } from "@/types";

vi.mock("@/services/security/useAccessLevel", () => ({
  useAccessLevel: () => "platform",
  useIsPlatformOwner: () => true,
}));

function pending(id: string, businessId: string): PendingSyncItem {
  return {
    id,
    businessId,
    sessionId: "session-1",
    entityType: "Product",
    entityId: `product-${id}`,
    operation: "SAVE_PRODUCT",
    payload: { id: `product-${id}`, businessId },
    status: "pending",
    retryCount: 0,
    lastError: null,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    idempotencyKey: `${businessId}:${id}`,
    scanEventId: null,
  };
}

beforeEach(() => {
  useScanStore.setState({
    businessId: "business-a",
    pendingSyncQueue: [pending("mine", "business-a"), pending("foreign", "business-b")],
    lastSyncError: null,
  });
});

afterEach(() => {
  cleanup();
  useScanStore.setState({ pendingSyncQueue: [] });
});

describe("tenant-scoped queue presentation", () => {
  it("shows only the active business pending count and enables retry for that partition", () => {
    render(<SyncStatusBar />);

    expect(screen.getByTestId("pending-count")).toHaveTextContent("1");
    expect(screen.getByTestId("retry-sync")).toBeEnabled();
  });

  it("reports and exports only the active business pending partition", () => {
    render(<ExportMenu />);
    fireEvent.click(screen.getByTestId("export-menu-trigger"));

    expect(screen.getByTitle("Items waiting to sync (1)")).toBeInTheDocument();
  });
});
