import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { StoreHydrator } from "@/components/StoreHydrator";
import { useScanStore } from "@/stores/scanStore";
import { useReconcileStore } from "@/stores/reconcileStore";
import { setBrowserPersistenceStatus } from "@/stores/scanPersistStorage";

beforeEach(() => {
  useScanStore.setState({ _hasHydrated: true });
  setBrowserPersistenceStatus("degraded");
});

afterEach(() => {
  cleanup();
  setBrowserPersistenceStatus("available");
});

describe("StoreHydrator persistence status", () => {
  it("does not hydrate reconcile data during app-wide scan startup", async () => {
    const rehydrate = vi.spyOn(useReconcileStore.persist, "rehydrate");
    render(<StoreHydrator><div>Scanner stays ready</div></StoreHydrator>);

    await waitFor(() => expect(useScanStore.persist.hasHydrated()).toBe(true));
    expect(rehydrate).not.toHaveBeenCalled();
    rehydrate.mockRestore();
  });

  it("shows a non-blocking durable-storage warning while leaving the scan UI available", () => {
    render(<StoreHydrator><div>Scanner stays ready</div></StoreHydrator>);

    expect(screen.getByTestId("persistence-degraded")).toHaveTextContent("Saved in this tab");
    expect(screen.getByText("Scanner stays ready")).toBeInTheDocument();
  });
});
