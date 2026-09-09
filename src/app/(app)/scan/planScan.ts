// Pure, framework-free helper for scan/page.tsx's bulk-scan feature. No React, no next/*, no store
// imports - just string planning so it is trivially unit-testable in the node vitest project.
//
// BULK SCAN lets a user paste/type several codes separated by whitespace and have each become its
// own scan row. That assumption breaks for a domain where a SINGLE code legitimately contains an
// internal space (e.g. a tire part number printed "2881 6861", one of several separator shapes -
// see src/scanning/clean/scanCleaner.ts buildNormalizedCandidates and the Falken seed alias). Splitting
// on whitespace unconditionally turns that one valid code into two garbage halves that resolve to
// nothing.
//
// The fix: try the WHOLE trimmed string as a single code first. Only fall back to splitting into N
// scans when the whole string does NOT resolve as one known code. This preserves genuine bulk
// pastes (multiple distinct codes, none of which form a valid single code together) while making
// "2881 6861" behave exactly like its dash/slash/underscore/dot siblings.
export function planScanBatch(raw: string, resolvesAsSingleCode: (code: string) => boolean): string[] {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return [];

  // No internal whitespace at all: always a single scan (the common hardware-scanner case).
  if (!/\s/.test(trimmed)) return [trimmed];

  // Contains whitespace: try it as ONE code first. A hardware-scanned barcode never contains
  // whitespace, so this only matters for pasted/typed input - exactly where a legitimate
  // space-separated part number also lives.
  if (resolvesAsSingleCode(trimmed)) return [trimmed];

  // Whole string didn't resolve as a single code -> treat as a genuine multi-code paste.
  return trimmed
    .split(/\s+/)
    .map((c) => c.trim())
    .filter(Boolean);
}
