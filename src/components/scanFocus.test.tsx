import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ScanPage from "@/app/(app)/scan/page";
import SettingsPage from "@/app/(app)/settings/page";
import { useScanStore } from "@/stores/scanStore";

// Scanner focus + no-focus-steal regression tests. A barcode scanner types fast then sends Enter;
// if any other control (e.g. a Clear Cache button) has focus, that Enter activates it instead of
// submitting the scan. The Scan page must therefore never host such a control, and the scan input
// must auto-focus on load and refocus after every scan.

beforeEach(() => {
  // Clean, deterministic store state for each test.
  useScanStore.getState().clearLocalCache();
});
afterEach(cleanup);

describe("Scan page focus safety", () => {
  it("registers the local boot session so counted scans remain discoverable in History", async () => {
    window.localStorage.clear();
    useScanStore.setState({
      businessContextReady: true,
      businessDataLoaded: true,
      sessionId: "session-local-boot",
      currentSession: {
        id: "session-local-boot",
        businessId: "demo-business",
        name: "Default Session",
        location: "Main",
        status: "active",
        startedAt: new Date().toISOString(),
        completedAt: null,
        createdBy: "demo",
        notes: "",
        syncStatus: "synced",
      },
    });

    render(<ScanPage />);

    await waitFor(() => {
      expect(useScanStore.getState().currentSession?.deviceId).toBeTruthy();
    });
    expect(useScanStore.getState().currentSession?.id).toBe("session-local-boot");
  });

  it("auto-focuses the scan input on page load", () => {
    render(<ScanPage />);
    expect(screen.getByTestId("scanner-input")).toHaveFocus();
  });

  it("does NOT render a Clear Cache control on the Scan page (it would steal the scanner Enter)", () => {
    render(<ScanPage />);
    expect(screen.queryByTestId("clear-cache")).toBeNull();
    expect(screen.queryByText(/clear cache/i)).toBeNull();
  });

  it("refocuses the scan input after a KNOWN scan", async () => {
    const user = userEvent.setup();
    render(<ScanPage />);
    const input = screen.getByTestId("scanner-input") as HTMLInputElement;
    await user.type(input, "6419440485331{Enter}");
    // Customer-safe: the feed shows the resolved PRODUCT (raw/clean code columns are platformOwner-only).
    expect(screen.getByTestId("scan-feed-body")).toHaveTextContent("Nokian");
    expect(input).toHaveFocus();
    expect(input.value).toBe("");
  });

  it("refocuses the scan input after an UNKNOWN scan routed to Needs Review", async () => {
    const user = userEvent.setup();
    render(<ScanPage />);
    const input = screen.getByTestId("scanner-input") as HTMLInputElement;
    await user.type(input, "UNKNOWNXYZ{Enter}");
    expect(input).toHaveFocus();
    await waitFor(() => {
      expect(useScanStore.getState().needsReviewQueue.some((r) => r.cleanCode === "UNKNOWNXYZ")).toBe(true);
    }, { timeout: 5_000 });
    expect(input).toHaveFocus();
  });

  it("supports continuous scanning - input stays focused across several scans", async () => {
    const user = userEvent.setup();
    render(<ScanPage />);
    const input = screen.getByTestId("scanner-input") as HTMLInputElement;
    for (const code of ["6419440485331", "T432119", "UNKNOWN1", "848983012906"]) {
      await user.type(input, `${code}{Enter}`);
      expect(input).toHaveFocus();
    }
  });
});

describe("Settings page keeps Clear Cache", () => {
  it("renders the Clear Cache control on Settings (the only place it lives)", () => {
    render(<SettingsPage />);
    expect(screen.getByTestId("clear-cache")).toBeInTheDocument();
  });
});
