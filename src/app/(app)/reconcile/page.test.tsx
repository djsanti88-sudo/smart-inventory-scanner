import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import ReconcilePage from "@/app/(app)/reconcile/page";
import { useReconcileStore } from "@/stores/reconcileStore";

vi.mock("@/components/ReconcilePanel", () => ({ ReconcilePanel: () => <div>Reconcile</div> }));

describe("ReconcilePage hydration", () => {
  it("hydrates reconcile data only when the reconcile route mounts", async () => {
    const rehydrate = vi.spyOn(useReconcileStore.persist, "rehydrate");
    render(<ReconcilePage />);
    await waitFor(() => expect(rehydrate).toHaveBeenCalledOnce());
    rehydrate.mockRestore();
  });
});
