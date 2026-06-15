import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScannerInput } from "@/components/ScannerInput";
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
