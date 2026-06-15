"use client";

import { useEffect, useRef, useState } from "react";
import type { ScanEvent } from "@/types";

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
  const [lastResult, setLastResult] = useState<ScanEvent | null>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
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

  const resultClass =
    lastResult == null
      ? "text-zinc-500"
      : lastResult.status === "known"
        ? "text-green-700"
        : lastResult.status === "conflict"
          ? "text-amber-700"
          : "text-red-700";

  return (
    <div className="w-full">
      <label htmlFor="scanner-input" className="mb-1 block text-sm font-medium text-zinc-700">
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
        className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-4 text-lg text-zinc-900 shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
      />
      <p className={`mt-2 min-h-5 text-sm ${resultClass}`} data-testid="scan-status">
        {lastResult == null
          ? "Ready to scan."
          : lastResult.status === "known"
            ? `Counted: ${lastResult.cleanCode} (${lastResult.matchType}). New quantity ${lastResult.quantityAfterScan}.`
            : lastResult.status === "conflict"
              ? `Conflict: ${lastResult.cleanCode} matches more than one product. Sent to Needs Review.`
              : `Unknown: ${lastResult.cleanCode}. Sent to Needs Review.`}
      </p>
    </div>
  );
}
