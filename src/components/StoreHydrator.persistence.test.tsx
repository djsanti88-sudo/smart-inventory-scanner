import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StoreHydrator } from "@/components/StoreHydrator";
import { useScanStore } from "@/stores/scanStore";
import { setBrowserPersistenceStatus } from "@/stores/scanPersistStorage";

beforeEach(() => {
  useScanStore.setState({ _hasHydrated: true });
  setBrowserPersistenceStatus("degraded");
});

afterEach(() => {
  setBrowserPersistenceStatus("available");
});

describe("StoreHydrator persistence status", () => {
  it("shows a non-blocking durable-storage warning while leaving the scan UI available", () => {
    render(<StoreHydrator><div>Scanner stays ready</div></StoreHydrator>);

    expect(screen.getByTestId("persistence-degraded")).toHaveTextContent("Saved in this tab");
    expect(screen.getByText("Scanner stays ready")).toBeInTheDocument();
  });
});
