import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScannerInput } from "@/components/ScannerInput";
import { useScanStore } from "@/stores/scanStore";
import type { ScanEvent } from "@/types";

afterEach(cleanup);

function fakeEvent(raw: string): ScanEvent {
  return {
    id: "e",
    businessId: "biz",
    sessionId: "sess",
    rawCode: raw,
    cleanCode: raw,
    normalizedCandidates: [raw],
    matchedProductId: "prod-nokian",
    matchType: "exact_alias",
    status: "known",
    resolverStatus: "known",
    codeType: "alpha_sku",
    reason: "",
    quantityDelta: 1,
    quantityAfterScan: 1,
    createdAt: "",
    source: "scan",
    notes: "",
    syncStatus: "pending",
    syncError: null,
    idempotencyKey: "k",
  };
}

describe("ScannerInput buffer", () => {
  it("captures a full rapid scan and submits on Enter without truncation", async () => {
    const onScan = vi.fn((raw: string) => fakeEvent(raw));
    const user = userEvent.setup();
    render(<ScannerInput onScan={onScan} submitMode="enter" />);

    const input = screen.getByTestId("scanner-input");
    await user.type(input, "6419440485331{Enter}");

    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan).toHaveBeenCalledWith("6419440485331"); // full code, not truncated
  });

  it("preserves a messy vendor string exactly", async () => {
    const onScan = vi.fn((raw: string) => fakeEvent(raw));
    const user = userEvent.setup();
    render(<ScannerInput onScan={onScan} submitMode="enter" />);
    await user.type(screen.getByTestId("scanner-input"), "T432119%RU1%{Enter}");
    expect(onScan).toHaveBeenCalledWith("T432119%RU1%");
  });

  it("clears the input and stays focused after submit", async () => {
    const onScan = vi.fn((raw: string) => fakeEvent(raw));
    const user = userEvent.setup();
    render(<ScannerInput onScan={onScan} submitMode="enter" />);
    const input = screen.getByTestId("scanner-input") as HTMLInputElement;
    await user.type(input, "28816861{Enter}");
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
  });

  it("does NOT capture keystrokes typed into an unrelated field", async () => {
    const onScan = vi.fn((raw: string) => fakeEvent(raw));
    const user = userEvent.setup();
    render(
      <div>
        <ScannerInput onScan={onScan} submitMode="enter" />
        <input data-testid="product-name" aria-label="product name" />
      </div>,
    );
    const other = screen.getByTestId("product-name");
    await user.type(other, "Some Product Name{Enter}");
    expect(onScan).not.toHaveBeenCalled();
  });

  it("supports the debounce fallback for scanners that do not send Enter", () => {
    vi.useFakeTimers();
    try {
      const onScan = vi.fn((raw: string) => fakeEvent(raw));
      render(<ScannerInput onScan={onScan} submitMode="debounce" debounceMs={50} />);
      const input = screen.getByTestId("scanner-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "ABC12345" } });
      fireEvent.keyDown(input, { key: "5" });
      expect(onScan).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60);
      expect(onScan).toHaveBeenCalledWith("ABC12345");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ScannerInput status line reset to Ready", () => {
  afterEach(() => {
    useScanStore.setState({ scanFeed: [] });
  });

  it("resets to 'Ready to scan.' 5s after the feed entry reaches a terminal decodeStatus", async () => {
    vi.useFakeTimers();
    try {
      const decodingEvent: ScanEvent = { ...fakeEvent("UNKNOWN1"), status: "needs_review", decodeStatus: "decoding" };
      useScanStore.setState({ scanFeed: [decodingEvent] });
      const onScan = vi.fn(() => decodingEvent);
      render(<ScannerInput onScan={onScan} submitMode="enter" />);
      const input = screen.getByTestId("scanner-input");

      fireEvent.change(input, { target: { value: "UNKNOWN1" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(screen.queryByText("Ready to scan.")).toBeNull();

      // Decode settles to a terminal state on the live feed entry.
      act(() => {
        useScanStore.setState({
          scanFeed: [{ ...decodingEvent, decodeStatus: "verified" }],
        });
      });

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(screen.getByText("Ready to scan.")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT reset while decodeStatus stays 'decoding', even after 5s", async () => {
    vi.useFakeTimers();
    try {
      const decodingEvent: ScanEvent = { ...fakeEvent("UNKNOWN2"), status: "needs_review", decodeStatus: "decoding" };
      useScanStore.setState({ scanFeed: [decodingEvent] });
      const onScan = vi.fn(() => decodingEvent);
      render(<ScannerInput onScan={onScan} submitMode="enter" />);
      const input = screen.getByTestId("scanner-input");

      fireEvent.change(input, { target: { value: "UNKNOWN2" } });
      fireEvent.keyDown(input, { key: "Enter" });

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(screen.queryByText("Ready to scan.")).toBeNull();
      expect(screen.getByText("Looking up this product... Check the feed below in a moment.")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces provisional review feedback when trusted exact identity settles", () => {
    const provisional: ScanEvent = { ...fakeEvent("BOSS-EXACT"), status: "needs_review", decodeStatus: "decoding" };
    useScanStore.setState({ scanFeed: [provisional] });
    render(<ScannerInput onScan={() => provisional} submitMode="enter" />);
    const input = screen.getByTestId("scanner-input");
    fireEvent.change(input, { target: { value: "BOSS-EXACT" } });
    fireEvent.keyDown(input, { key: "Enter" });

    act(() => {
      useScanStore.setState({
        scanFeed: [{ ...provisional, status: "known", resolverStatus: "known", decodeStatus: "verified" }],
      });
    });

    expect(screen.getByText("Added.")).toBeTruthy();
    expect(screen.queryByText("Counted. Sent to review.")).toBeNull();
    expect(screen.queryByText("New code. Check the review list to identify it.")).toBeNull();
    expect(screen.getByTestId("scan-success")).toBeTruthy();
  });
});

describe("ScannerInput settled live-feed feedback", () => {
  afterEach(() => {
    useScanStore.setState({ scanFeed: [] });
  });

  it("replaces a provisional lookup with the settled verified product confirmation", () => {
    const provisional: ScanEvent = {
      ...fakeEvent("TRUSTED-EXACT"),
      status: "unknown",
      decodeStatus: "decoding",
      matchedProductId: null,
      quantityAfterScan: 1,
    };
    const settled: ScanEvent = {
      ...provisional,
      status: "known",
      decodeStatus: "verified",
      matchedProductId: "prod-nokian",
      quantityAfterScan: 2,
    };
    const onScan = vi.fn(() => provisional);
    render(<ScannerInput onScan={onScan} submitMode="enter" />);
    const input = screen.getByTestId("scanner-input");

    fireEvent.change(input, { target: { value: "TRUSTED-EXACT" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("Looking up this product... Check the feed below in a moment.")).toBeTruthy();
    expect(input.className).not.toContain("border-red-400");
    expect(input.className).not.toContain("shake");

    act(() => {
      useScanStore.setState({ scanFeed: [settled] });
    });

    expect(screen.getByTestId("scan-counted").textContent).toContain("Counted:");
    expect(screen.getByTestId("scan-counted").textContent).toContain("Quantity is now 2.");
    expect(screen.queryByText(/Check the review list/)).toBeNull();
  });
});

describe("ScannerInput every-status feedback panel (TOP-LEVEL LAW: every scan counts and shows it)", () => {
  function eventWith(status: ScanEvent["status"], quantityAfterScan: number): ScanEvent {
    return { ...fakeEvent("CODE1"), status, quantityAfterScan };
  }

  it.each([
    ["known", 4],
    ["unknown", 7],
    ["needs_review", 3],
    ["resolved", 9],
    ["ignored", 2],
    ["conflict", 5],
  ] as const)(
    "renders the full-weight counted panel with the running quantity for status '%s'",
    async (status, qty) => {
      const ev = eventWith(status, qty);
      const onScan = vi.fn(() => ev);
      render(<ScannerInput onScan={onScan} submitMode="enter" />);
      const input = screen.getByTestId("scanner-input");

      fireEvent.change(input, { target: { value: "CODE1" } });
      fireEvent.keyDown(input, { key: "Enter" });

      // Every outcome renders the shared full-weight panel testid (not the generic amber fallback).
      const panel = screen.getByTestId("scan-counted");
      expect(panel).toBeTruthy();
      // The running quantity must be visible for EVERY status, not just "known".
      expect(panel.textContent).toContain(String(qty));

      if (status === "known") {
        // known keeps the pre-existing testid too, so any existing known-scan test stays green.
        expect(screen.getByTestId("scan-success")).toBeTruthy();
      }
    },
  );

  it("still shows the pre-existing 'scan-success' testid and 'Added.' heading for a known scan (regression guard)", () => {
    const ev = eventWith("known", 1);
    const onScan = vi.fn(() => ev);
    render(<ScannerInput onScan={onScan} submitMode="enter" />);
    const input = screen.getByTestId("scanner-input");
    fireEvent.change(input, { target: { value: "CODE1" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByTestId("scan-success")).toBeTruthy();
    expect(screen.getByText("Added.")).toBeTruthy();
  });

  it("keeps the red shake for a terminal unknown scan", () => {
    const ev = eventWith("unknown", 1);
    const onScan = vi.fn(() => ev);
    render(<ScannerInput onScan={onScan} submitMode="enter" />);
    const input = screen.getByTestId("scanner-input");

    fireEvent.change(input, { target: { value: "UNKNOWN" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.className).toContain("border-red-400");
    expect(input.className).toContain("shake");
  });
});
