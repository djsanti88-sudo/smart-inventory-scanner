import "server-only";
import type { LadderStorage } from "./storage";

// Monthly Go-UPC spend gate. SERVER-SIDE ONLY.
//
// Go-UPC runs on the owner's paid SUBSCRIPTION (not metered per-call spend), so the
// monthly cap is REMOVED by default -- the gate always allows and usage tracking runs
// purely for OBSERVABILITY (so the owner can see how much of the subscription is used).
// Set GO_UPC_MONTHLY_LIMIT to a positive integer to re-impose a hard cap (a reversible
// lever kept for the future). This is a thin gate over LadderStorage.readUsage/writeUsage
// (Task 5) -- it does NOT touch the filesystem itself, so the Turso adapter swaps in
// (Task 21) without touching this logic.
//
// Month rollover: the stored counter carries the `YYYY-MM` month it was written in.
// When the injected clock's current month differs, `used` is treated as 0 (a new
// billing month) and the next `record()` rewrites the counter to the current month.

/** Default monthly cap when re-capped via GO_UPC_MONTHLY_LIMIT; not used by default (unlimited). */
const DEFAULT_LIMIT = 4800;
/** Soft-warn threshold when a cap is in effect; meaningless (and unused) when unlimited. */
const WARN_AT = 4000;

export interface GoUpcSpendGate {
  allowed: boolean;
  reason?: string;
  used: number;
  limit: number;
  warn: boolean;
}

export interface GoUpcUsage {
  canSpend(): Promise<GoUpcSpendGate>;
  record(): Promise<void>;
}

/** `YYYY-MM` month key from a Date. */
function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/**
 * Resolve the configured monthly limit.
 *
 * Default (no explicit override, no env var) is `Infinity` -- unlimited, since Go-UPC
 * runs on the owner's paid subscription. `GO_UPC_MONTHLY_LIMIT` set to a positive finite
 * number re-imposes a cap (the reversible lever); unset / empty / "0" / "none" /
 * "unlimited" / a non-positive or non-finite value all resolve to unlimited.
 */
function resolveLimit(explicit?: number): number {
  if (typeof explicit === "number") {
    return Number.isFinite(explicit) && explicit > 0 ? explicit : Infinity;
  }
  const raw = process.env.GO_UPC_MONTHLY_LIMIT;
  if (raw === undefined || raw.trim() === "") return Infinity;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "none" || normalized === "unlimited") return Infinity;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity;
}

/**
 * Build a Go-UPC monthly usage gate over a `LadderStorage`.
 *
 * @param storage durable usage store (file-backed now, Turso later)
 * @param opts.now injectable clock (tests pass a fixed instant; never `new Date()` in tests)
 * @param opts.limit explicit limit override (else `GO_UPC_MONTHLY_LIMIT` env, else unlimited)
 */
export function goUpcUsage(
  storage: LadderStorage,
  opts?: { now?: () => Date; limit?: number },
): GoUpcUsage {
  const now = opts?.now ?? (() => new Date());
  const limit = resolveLimit(opts?.limit);

  /** Effective used count for the current month (0 after a rollover). */
  async function currentUsed(month: string): Promise<number> {
    const stored = await storage.readUsage();
    return stored.month === month ? stored.used : 0;
  }

  return {
    async canSpend(): Promise<GoUpcSpendGate> {
      const month = monthKey(now());
      const used = await currentUsed(month);
      const allowed = used < limit;
      // A warn threshold is meaningless with no cap -- only warn when a real cap is set.
      const warn = Number.isFinite(limit) && used >= WARN_AT;
      return {
        allowed,
        used,
        limit,
        warn,
        ...(allowed
          ? {}
          : { reason: `Go-UPC monthly cap reached (${used}/${limit} for ${month})` }),
      };
    },

    async record(): Promise<void> {
      const month = monthKey(now());
      // Atomic increment (never read-then-write): this counter enforces the monthly Go-UPC
      // spend cap, so two concurrent serverless instances must not be able to lose a count.
      await storage.incrementUsage(month);
    },
  };
}
