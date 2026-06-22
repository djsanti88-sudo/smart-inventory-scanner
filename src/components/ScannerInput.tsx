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
  // Brief green border flash on a successful (counted) scan - a big, obvious "it worked" cue.
  const [flash, setFlash] = useState(false);
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

    // Flash the input border green when a scan actually counted - a large, obvious success cue.
    if (ev?.status === "known") {
      setFlash(true);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(false), 900);
    } else {
      setFlash(false);
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
        ? `Counted: ${ev.cleanCode} (${ev.matchType}). New quantity ${ev.quantityAfterScan}.`
        : ev.status === "conflict"
          ? `Conflict: ${ev.cleanCode} matches more than one product. Sent to Needs Review.`
          : `Unknown: ${ev.cleanCode}. Sent to Needs Review.`;
    }
    // Customer view: product-facing only.
    if (ev.status === "known") {
      const product = getProduct(ev.matchedProductId);
      const name = product?.name || "Product";
      const partNumber = product?.primarySku;
      const partLabel = partNumber ? ` (part no. ${partNumber})` : "";
      return `Counted: ${name}${partLabel}. New quantity ${ev.quantityAfterScan}.`;
    }
    if (ev.status === "conflict") {
      return "Conflict: this code matches more than one product. Sent to Needs Review.";
    }
    return "Unknown code. Sent to Needs Review.";
  }

  const counted = lastResult?.status === "known";

  return (
    <div className="w-full">
      <label htmlFor="scanner-input" className="mb-1.5 block text-base font-semibold text-zinc-800">
        Scan a code
      </label>
      <input
        id="scanner-input"
        ref={inputRef}
        type="text"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        placeholder="Click here, then scan or type a code and press Enter"
        onKeyDown={handleKeyDown}
        aria-label="Scan a code"
        data-testid={rest["data-testid"] ?? "scanner-input"}
        className={`w-full rounded-lg border-2 bg-white px-4 py-4 text-xl text-zinc-900 shadow-sm outline-none transition-colors focus:ring-2 focus:ring-blue-200 ${
          flash ? "border-green-500 ring-2 ring-green-200" : "border-zinc-300 focus:border-blue-500"
        }`}
      />

      {/* Large, high-contrast confirmation. A counted scan gets a big green panel + running number so a
          low-vision user can see "it worked" from across the room. Errors are equally large and clear. */}
      {counted ? (
        <div
          className="mt-3 flex items-center justify-between gap-3 rounded-xl border-2 border-green-600 bg-green-50 px-4 py-3"
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
            <div className="text-4xl font-extrabold tabular-nums text-green-700">{lastResult!.quantityAfterScan}</div>
            <div className="text-xs font-medium uppercase tracking-wide text-green-700">on hand</div>
          </div>
        </div>
      ) : lastResult == null ? (
        <p className="mt-3 text-base text-zinc-600" data-testid="scan-status" role="status" aria-live="polite">
          Ready to scan.
        </p>
      ) : (
        <div
          className={`mt-3 rounded-xl border-2 px-4 py-3 text-base font-medium ${
            lastResult.status === "conflict" ? "border-amber-500 bg-amber-50 text-amber-900" : "border-red-500 bg-red-50 text-red-800"
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
