import "server-only";
import type { LadderStorage } from "./storage";

// Per-minute Open Food Facts throttle gate. SERVER-SIDE ONLY.
//
// OFF's public API guidelines cap read queries at ~15 req/min/IP (verified 2026-07-12 via
// openfoodfacts.github.io/openfoodfacts-server/api/). This is a SELF-OWNED local throttle counter,
// entirely separate from the paid Go-UPC monthly cap, the UPCitemdb daily cap, and the paid daily
// AI-lookup cap (LESSONS_LEARNED L12: never charge the same request on two paths / never share a
// counter across unrelated spend gates). A free rung must never touch the paid daily cap counter.
//
// Uses the SAME generic get/set/increment KV seam on LadderStorage that the other free-rung
// counters use, under its OWN key namespace so none of the counters collide.
//
// Minute rollover: the stored counter carries the `YYYY-MM-DDTHH:mm` minute it was written in.
// When the injected clock's current minute differs, `used` is treated as 0 (a new minute window)
// and the next `record()` call writes the counter under the new minute's key.

/** Local hard cap: 10/min, a buffer under OFF's documented ~15 req/min/IP read-query limit. */
const DEFAULT_LOCAL_PER_MINUTE_CAP = 10;

const KV_KEY_PREFIX = "openfoodfacts-usage:";

export interface OpenFoodFactsSpendGate {
  allowed: boolean;
  reason?: string;
  used: number;
  limit: number;
}

export interface OpenFoodFactsUsage {
  canSpend(): Promise<OpenFoodFactsSpendGate>;
  record(): Promise<void>;
}

/** `YYYY-MM-DDTHH:mm` minute key from a Date (UTC, stable and test-deterministic). */
function minuteKey(d: Date): string {
  return d.toISOString().slice(0, 16);
}

/** Resolve the configured local per-minute cap; env override wins, falls back to the default. */
function resolveLimit(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  const envVal = Number(process.env.OPENFOODFACTS_PER_MINUTE_LIMIT ?? DEFAULT_LOCAL_PER_MINUTE_CAP);
  return Number.isFinite(envVal) ? envVal : DEFAULT_LOCAL_PER_MINUTE_CAP;
}

/**
 * Build an Open Food Facts per-minute usage gate over a `LadderStorage`'s generic KV seam.
 *
 * @param storage durable KV store (file-backed now, Turso later; shared seam, own key namespace)
 * @param opts.now injectable clock (tests pass a fixed instant; never `new Date()` in tests)
 * @param opts.limit explicit limit override (else `OPENFOODFACTS_PER_MINUTE_LIMIT` env, else 10)
 */
export function openFoodFactsUsage(
  storage: LadderStorage,
  opts?: { now?: () => Date; limit?: number },
): OpenFoodFactsUsage {
  const now = opts?.now ?? (() => new Date());
  const limit = resolveLimit(opts?.limit);

  async function currentUsed(minute: string): Promise<number> {
    const raw = await storage.get(`${KV_KEY_PREFIX}${minute}`);
    if (raw == null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  return {
    async canSpend(): Promise<OpenFoodFactsSpendGate> {
      const minute = minuteKey(now());
      const used = await currentUsed(minute);
      const allowed = used < limit;
      return {
        allowed,
        used,
        limit,
        ...(allowed
          ? {}
          : { reason: `Open Food Facts local per-minute limit reached (${used}/${limit} for ${minute})` }),
      };
    },

    async record(): Promise<void> {
      const minute = minuteKey(now());
      // Atomic increment (never read-then-write): mirrors goUpcUsage/upcItemDbUsage's record()
      // contract - two concurrent serverless instances must never lose a count.
      await storage.increment(`${KV_KEY_PREFIX}${minute}`);
    },
  };
}
