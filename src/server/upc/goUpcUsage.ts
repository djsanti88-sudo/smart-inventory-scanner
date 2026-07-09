import "server-only";
import type { LadderStorage } from "./storage";

// Monthly Go-UPC spend gate. SERVER-SIDE ONLY.
//
// Go-UPC bills per lookup, so the ladder must HARD STOP at a monthly cap and warn
// as it approaches it. This is a thin gate over LadderStorage.readUsage/writeUsage
// (Task 5) -- it does NOT touch the filesystem itself, so the Turso adapter swaps in
// (Task 21) without touching this logic.
//
// Month rollover: the stored counter carries the `YYYY-MM` month it was written in.
// When the injected clock's current month differs, `used` is treated as 0 (a new
// billing month) and the next `record()` rewrites the counter to the current month.

/** Default monthly cap; hard-stops the Go-UPC rung once reached. */
const DEFAULT_LIMIT = 4800;
/** Soft-warn threshold; approaching the cap. */
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

/** Resolve the configured monthly limit; env override wins, falls back to the default. */
function resolveLimit(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  return Number(process.env.GO_UPC_MONTHLY_LIMIT ?? DEFAULT_LIMIT);
}

/**
 * Build a Go-UPC monthly usage gate over a `LadderStorage`.
 *
 * @param storage durable usage store (file-backed now, Turso later)
 * @param opts.now injectable clock (tests pass a fixed instant; never `new Date()` in tests)
 * @param opts.limit explicit limit override (else `GO_UPC_MONTHLY_LIMIT` env, else 4800)
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
      const warn = used >= WARN_AT;
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
      const used = await currentUsed(month);
      await storage.writeUsage({ month, used: used + 1 });
    },
  };
}
