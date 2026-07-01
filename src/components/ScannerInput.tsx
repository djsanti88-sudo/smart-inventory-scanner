"use client";

import { useEffect, useRef, useState } from "react";
import type { ScanEvent } from "@/types";
import { useScanStore } from "@/stores/scanStore";
import { useIsPlatformOwner } from "@/services/security/useAccessLevel";

// Dedicated hardware-scanner input.
//
// Design (per the spec's preferred option): the buffer is attached DIRECTLY to this input, so it
// works while this input is focused and CANNOT hijack keystrokes typed into other fields
// (product name, notes, search) - those inputs never call this onKeyDown.
//
// The "buffer" is the uncontrolled input's own DOM value (a ref, not per-character React state),
// so rapid keystroke injection (every 10-20ms) is never dropped by heavy onChange work. Matching
// runs only when the scan is complete: on Enter, or via a short debounce fallback for scanners
// that do not send Enter.

export interface ScannerInputProps {
  onScan: (raw: string) => ScanEvent | null;
  submitMode?: "enter" | "debounce" | "both";
  debounceMs?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  "data-testid"?: string;
}

export function ScannerInput({
  onScan,
  submitMode = "both",
  debounceMs = 80,
  disabled = false,
  autoFocus = true,
  ...rest
}: ScannerInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lastResult, setLastResult] = useState<ScanEvent | null>(null);
  // Brief green border flash on a successful (counted) scan; red shake on unknown/error.
  const [flash, setFlash] = useState<false | "success" | "error">(false);
  // Role-aware scan confirmation. platformOwner sees the technical detail (clean code + match type);
  // a customer ("business") must NEVER see the raw/clean code (denylisted) or internal match type - they
  // see the product NAME + PART NUMBER (primarySku) instead, so the confirmation matches the rest of the
  // customer-safe UI. Data-access truth is still server/serializer-enforced; this only shapes the message.
  const isPlatform = useIsPlatformOwner();
  const getProduct = useScanStore((s) => s.getProduct);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, [autoFocus]);

  function submit() {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    const el = inputRef.current;
    if (!el) return;
    const raw = el.value;
    if (raw.trim().length === 0) return;

    const ev = onScan(raw); // preserve the raw value exactly; cleaning happens downstream
    setLastResult(ev);

    // Flash the input border green when a scan counted; shake on unknown/error.
    if (ev?.status === "known") {
      setFlash("success");
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(false), 900);
    } else if (ev) {
      setFlash("error");
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(false), 400);
    }

    el.value = "";
    el.focus(); // refocus so the next scan lands here
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (submitMode === "enter" || submitMode === "both") submit();
      return;
    }
    // Debounce fallback for scanners that do not send Enter.
    if (submitMode === "debounce" || submitMode === "both") {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(submit, debounceMs);
    }
  }

  // Build the confirmation text. Customer messages carry NO raw/clean code and NO internal match type.
  function statusMessage(ev: ScanEvent): string {
    if (isPlatform) {
      return ev.status === "known"
        ? `Counted: ${ev.cleanCode}. Quantity is now ${ev.quantityAfterScan}.`
        : ev.status === "conflict"
          ? `Conflict: ${ev.cleanCode} matches more than one product. Sent to review.`
          : `New code: ${ev.cleanCode}. Sent to review for identification.`;
    }
    // Customer view: product-facing only.
    if (ev.status === "known") {
      const product = getProduct(ev.matchedProductId);
      const name = product?.name || "Product";
      const partNumber = product?.primarySku;
      const partLabel = partNumber ? ` (part no. ${partNumber})` : "";
      return `Counted: ${name}${partLabel}. Quantity is now ${ev.quantityAfterScan}.`;
    }
    if (ev.status === "conflict") {
      return "This code matches more than one product. Check the review list.";
    }
    return "New code. Check the review list to identify it.";
  }

  const counted = lastResult?.status === "known";
  const isDecoding = lastResult?.decodeStatus === "decoding";

  return (
    <div className="w-full">
      <label htmlFor="scanner-input" className="mb-1.5 block text-base font-semibold text-zinc-800">
        Scan a barcode
      </label>
      <input
        id="scanner-input"
        ref={inputRef}
        type="text"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder="Scan or type a code"
        onKeyDown={handleKeyDown}
        aria-label="Scan a code"
        data-testid={rest["data-testid"] ?? "scanner-input"}
        className={`w-full rounded-lg border-2 bg-white px-4 py-4 text-xl text-zinc-900 shadow-sm outline-none transition-colors focus:ring-2 focus:ring-blue-200 ${
          flash === "success"
            ? "animate-[flash-green_900ms_ease-out] border-green-500 ring-2 ring-green-200"
            : flash === "error"
              ? "animate-[shake_300ms_ease-in-out] border-red-400"
              : "border-zinc-300 focus:border-blue-500"
        }`}
      />

      {/* Large, high-contrast confirmation. A counted scan gets a big green panel + running number so a
          low-vision user can see "it worked" from across the room. Errors are equally large and clear. */}
      {counted ? (
        <div
          className="mt-3 flex min-h-[72px] animate-[panel-in_150ms_ease-out] items-center justify-between gap-3 rounded-lg border-2 border-green-600 bg-green-50 px-4 py-3"
          data-testid="scan-success"
          role="status"
          aria-live="polite"
        >
          <div className="min-w-0">
            <p className="text-lg font-bold text-green-800">Added.</p>
            <p className="truncate text-base text-green-900" data-testid="scan-status">
              {statusMessage(lastResult!)}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <div className="animate-[count-tick_300ms_ease-out] text-4xl font-extrabold tabular-nums text-green-700">{lastResult!.quantityAfterScan}</div>
            <div className="text-xs font-medium uppercase tracking-wide text-green-700">on hand</div>
          </div>
        </div>
      ) : lastResult == null ? (
        <p className="mt-3 min-h-[72px] text-base text-zinc-600" data-testid="scan-status" role="status" aria-live="polite">
          Ready to scan.
        </p>
      ) : isDecoding ? (
        <div
          className="mt-3 min-h-[72px] animate-[panel-in_150ms_ease-out] rounded-lg border-2 border-blue-400 bg-blue-50 px-4 py-3 text-base font-medium text-blue-800"
          data-testid="scan-status"
          role="status"
          aria-live="polite"
        >
          Looking up this product... Check the feed below in a moment.
        </div>
      ) : (
        <div
          className={`mt-3 min-h-[72px] animate-[panel-in_150ms_ease-out] rounded-lg border-2 px-4 py-3 text-base font-medium ${
            lastResult.status === "conflict" ? "border-amber-500 bg-amber-50 text-amber-900" : "border-amber-400 bg-amber-50 text-amber-900"
          }`}
          data-testid="scan-status"
          role="status"
          aria-live="polite"
        >
          {statusMessage(lastResult)}
        </div>
      )}
    </div>
  );
}
