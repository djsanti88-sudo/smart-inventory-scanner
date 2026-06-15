import { cleanScanCode } from "@/services/scanCleaner";

// Smart code normalization. PURE (no React, no next/*, no network). The RAW scanned value is ALWAYS
// preserved; normalization only ADDS safe search variants. Tire part numbers / SKUs frequently print
// with dashes, spaces, or slashes (e.g. "2881-6861"), so a scan must also try the no-separator variant
// (e.g. "28816861") before giving up. This is the single source of truth for variant generation; the
// deterministic matcher and the external/AI lookup both build their search keys from here.

export interface NormalizedCode {
  raw: string; // exactly as scanned (never mutated)
  clean: string; // invisible chars / line breaks removed, trimmed (from scanCleaner)
  uppercase: string; // clean, uppercased
  noWhitespace: string; // clean with all whitespace removed
  noSeparators: string; // clean with separators (-, space, /, \, _, .) removed
  digitsOnly: string; // only 0-9 (empty if none)
  alphanumericOnly: string; // only [A-Za-z0-9], uppercased
  displayValue: string; // what to show a human: the clean value
  /**
   * Ordered, de-duplicated list of candidate keys to try, most-specific first. Safe by construction:
   * each is a deterministic transform of the scanned value, never a guess. Ambiguity (a variant
   * matching more than one product) is resolved downstream by the matcher (-> conflict / Needs Review),
   * never auto-picked here.
   */
  searchVariants: string[];
}

const SEPARATORS = /[-\s/\\_.]+/g;

function dedupe(values: Array<string | undefined | null>): string[] {
  const out: string[] = [];
  for (const v of values) {
    const t = (v ?? "").trim();
    if (t.length > 0 && !out.includes(t)) out.push(t);
  }
  return out;
}

export function normalizeCode(rawInput: string): NormalizedCode {
  const cleaned = cleanScanCode(rawInput);
  const clean = cleaned.cleanCode;
  const uppercase = clean.toUpperCase();
  const noWhitespace = clean.replace(/\s+/g, "");
  const noSeparators = clean.replace(SEPARATORS, "");
  const digitsOnly = clean.replace(/\D/g, "");
  const alphanumericOnly = clean.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

  // Most-specific first. Reuse scanCleaner's normalizedCandidates (handles vendor "%" labels, hyphen
  // strip, whitespace strip) and layer the additional safe variants. Order matters: exact/clean first.
  const searchVariants = dedupe([
    clean,
    ...cleaned.normalizedCandidates,
    uppercase,
    noWhitespace,
    noSeparators,
    // digitsOnly only when it differs and the code is "mostly" numeric (avoid turning an alpha SKU into a
    // misleading numeric fragment). Safe to include as a LAST-resort variant; matcher guards ambiguity.
    digitsOnly && digitsOnly.length >= 6 ? digitsOnly : "",
  ]);

  return { raw: cleaned.rawCode, clean, uppercase, noWhitespace, noSeparators, digitsOnly, alphanumericOnly, displayValue: clean, searchVariants };
}
