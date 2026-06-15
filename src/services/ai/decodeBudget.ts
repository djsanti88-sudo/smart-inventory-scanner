// Decode time budget bounds. The budget can be set by the owner in Settings, but the value is
// CLIENT-supplied (untrusted), so the server clamps it into a safe range before use - a client must
// never be able to request a 10-minute decode. Pure module (no React / next), unit-testable.

export const DECODE_BUDGET_MIN_MS = 5_000;
export const DECODE_BUDGET_MAX_MS = 20_000;
export const DECODE_BUDGET_DEFAULT_MS = 13_000;

function clampToRange(n: number): number {
  return Math.min(DECODE_BUDGET_MAX_MS, Math.max(DECODE_BUDGET_MIN_MS, Math.round(n)));
}

/**
 * Clamp a (possibly client-supplied / invalid) decode budget into [MIN, MAX].
 * Missing or non-finite/non-positive input falls back to `fallback` (also clamped).
 */
export function clampDecodeBudgetMs(value: unknown, fallback: number = DECODE_BUDGET_DEFAULT_MS): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return clampToRange(fallback);
  return clampToRange(n);
}
