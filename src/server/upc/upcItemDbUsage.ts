import "server-only";
import type { LadderStorage } from "./storage";

// Daily UPCitemdb (free trial tier) usage gate. SERVER-SIDE ONLY.
//
// UPCitemdb's keyless trial tier is capped at 100 combined requests/day per IP (their FREE plan
// docs, verified 2026-07-12 via devs.upcitemdb.com's rate-limits page). This is a SELF-OWNED daily
// counter, entirely separate from the paid Go-UPC monthly cap and the paid daily AI-lookup cap
// (LESSONS_LEARNED L12: never charge the same request on two paths / never share a counter across
// unrelated spend gates). A free rung must never touch the paid daily cap counter.
//
// Uses the SAME generic get/set/increment KV seam on LadderStorage that the paid daily AI cap uses
// (see src/services/security/aiSpendGuard.ts), but under its OWN key namespace so the two counters
// never collide.
//
// Day rollover: the stored counter carries the `YYYY-MM-DD` day it was written in. When the
// injected clock's current day differs, `used` is treated as 0 (a new day) and the next
// `record()` call writes the counter under the new day's key.

/** Local hard cap: 90/day, a buffer under UPCitemdb's documented 100/day free-tier limit. */
const DEFAULT_LOCAL_DAILY_CAP = 90;

const KV_KEY_PREFIX = "upcitemdb-usage:";

export interface UpcItemDbSpendGate {
  allowed: boolean;
  reason?: string;
  used: number;
  limit: number;
}

export interface UpcItemDbUsage {
  canSpend(): Promise<UpcItemDbSpendGate>;
  record(): Promise<void>;
}

/** `YYYY-MM-DD` day key from a Date (UTC, stable and test-deterministic). */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Resolve the configured local daily cap; env override wins, falls back to the default. */
function resolveLimit(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  const envVal = Number(process.env.UPCITEMDB_DAILY_LIMIT ?? DEFAULT_LOCAL_DAILY_CAP);
  return Number.isFinite(envVal) ? envVal : DEFAULT_LOCAL_DAILY_CAP;
}

/**
 * Build a UPCitemdb daily usage gate over a `LadderStorage`'s generic KV seam.
 *
 * @param storage durable KV store (file-backed now, Turso later; shared seam, own key namespace)
 * @param opts.now injectable clock (tests pass a fixed instant; never `new Date()` in tests)
 * @param opts.limit explicit limit override (else `UPCITEMDB_DAILY_LIMIT` env, else 90)
 */
export function upcItemDbUsage(
  storage: LadderStorage,
  opts?: { now?: () => Date; limit?: number },
): UpcItemDbUsage {
  const now = opts?.now ?? (() => new Date());
  const limit = resolveLimit(opts?.limit);

  async function currentUsed(day: string): Promise<number> {
    const raw = await storage.get(`${KV_KEY_PREFIX}${day}`);
    if (raw == null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  return {
    async canSpend(): Promise<UpcItemDbSpendGate> {
      const day = dayKey(now());
      const used = await currentUsed(day);
      const allowed = used < limit;
      return {
        allowed,
        used,
        limit,
        ...(allowed ? {} : { reason: `UPCitemdb local daily limit reached (${used}/${limit} for ${day})` }),
      };
    },

    async record(): Promise<void> {
      const day = dayKey(now());
      // Atomic increment (never read-then-write): mirrors goUpcUsage's record() contract - two
      // concurrent serverless instances must never lose a count.
      await storage.increment(`${KV_KEY_PREFIX}${day}`);
    },
  };
}
