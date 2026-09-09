/**
 * Bounded decode queues (Task 5): ordinary decode retains its two-wide FIFO lane. Authenticated
 * deterministic-only trusted-exact probes use a separate four-wide FIFO lane so a corpus burst cannot
 * sit behind general enrichment. Counting/persistence NEVER waits on either queue -
 * `ensureProvisionalCount` already ran SYNCHRONOUSLY at scan time, before `liveDecode` is ever invoked.
 */
const MAX_CONCURRENT_DECODES = 2;
const MAX_CONCURRENT_TRUSTED_EXACT_DECODES = 4;

type DecodeTask = { run: () => Promise<void>; resolve: () => void; reject: (e: unknown) => void };

/**
 * BULK PACER (owner-approved 2026-08-07): a light client-side token bucket so a 500-2000 code paste
 * self-throttles the RATE of decode dispatch instead of firing every queued request the instant a slot
 * frees up. `MAX_CONCURRENT_DECODES` already bounds concurrency (how many requests are in flight at
 * once) but not RATE (how fast slots turn over) - a fast-miss corpus round-trip (free rungs only, no
 * network) can turn slots over fast enough to burst past `AI_LOOKUP_RATE_LIMIT`, whose SERVER DEFAULT
 * is 600/60s = 10 requests/second (aiSpendGuard.checkRateLimit's AI_LOOKUP_RATE_LIMIT fallback). The
 * client default is pinned to that same 10/s (S6 fix, see GENERAL_DECODE_RATE_PER_SEC below) and is
 * raised by env only where the deployment has actually raised the server limit. Anything faster than
 * the server bucket just converts a bulk paste into a 429 storm on the very next window.
 * Only the GENERAL queue is paced: the trusted-exact probe queue is
 * server-side FREE of the rate limit (route.ts returns before `checkRateLimit` for `deterministicOnly`
 * requests - see inv-bulk-ratelimit.md #1) and pacing it would only slow down decode with no rate-limit
 * benefit. TOP LAW unaffected: counting already happened synchronously in `ensureProvisionalCount`
 * before any code ever reaches this queue - the pacer only paces the decode POST cadence, never a row's
 * appearance or count.
 */
// S6 (deep review 2026-08-09): the client default now MATCHES the server default. The comment above
// used to claim a 20000/60s server ceiling, but aiSpendGuard.checkRateLimit's actual default is
// 600/60s = 10 requests/second (aiSpendGuard.ts, the AI_LOOKUP_RATE_LIMIT fallback). Pacing at 50/s
// against a 10/s bucket drains it in about 12 seconds and then 429-storms in ANY environment that has
// not raised AI_LOOKUP_RATE_LIMIT. Defaulting to the server default makes the safe case the DEFAULT
// case; a deployment that genuinely raises AI_LOOKUP_RATE_LIMIT (production does) raises the client
// pacer with the env override below, so proven production behavior is unchanged. Both values must be
// NEXT_PUBLIC_* to be readable in the browser bundle.
function decodePacerEnvNumber(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const GENERAL_DECODE_RATE_PER_SEC = decodePacerEnvNumber(process.env.NEXT_PUBLIC_DECODE_RATE_PER_SEC, 10);
// Burst allowance: one second's worth of the sustained rate. Kept at the same scale as the rate so an
// ordinary handful-of-scans session never touches the pacer (it dispatches instantly out of the burst),
// while a genuine bulk paste settles onto the sustained rate immediately after the burst is spent.
const GENERAL_DECODE_BURST = decodePacerEnvNumber(process.env.NEXT_PUBLIC_DECODE_BURST, 10);

type TokenBucket = {
  capacity: number;
  tokens: number;
  refillPerMs: number;
  lastRefillAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

function makeTokenBucket(ratePerSec: number, burst: number): TokenBucket {
  return { capacity: burst, tokens: burst, refillPerMs: ratePerSec / 1000, lastRefillAt: Date.now(), timer: null };
}

/** Exported for tests only: resets a bucket's live time reference so fake-timer tests get deterministic
 *  refill math instead of depending on wall-clock Date.now() drift between store construction and test run. */
function resetTokenBucket(bucket: TokenBucket, nowMs: number): void {
  bucket.tokens = bucket.capacity;
  bucket.lastRefillAt = nowMs;
  if (bucket.timer) {
    clearTimeout(bucket.timer);
    bucket.timer = null;
  }
}

type DecodeQueue = {
  pendingIds: string[];
  tasks: Map<string, DecodeTask>;
  active: number;
  limit: number;
  pacer?: TokenBucket;
};
const generalDecodeQueue: DecodeQueue = {
  pendingIds: [],
  tasks: new Map(),
  active: 0,
  limit: MAX_CONCURRENT_DECODES,
  pacer: makeTokenBucket(GENERAL_DECODE_RATE_PER_SEC, GENERAL_DECODE_BURST),
};
const trustedExactDecodeQueue: DecodeQueue = {
  pendingIds: [],
  tasks: new Map(),
  active: 0,
  limit: MAX_CONCURRENT_TRUSTED_EXACT_DECODES,
};
// Dedupe within each stage: a review already queued OR in flight resolves to the SAME promise instead
// of being queued twice. The stage is part of the key because an exact miss must be allowed to enqueue
// exactly one ordinary decode for the same review without either stage duplicating itself.
const decodeTaskPromises = new Map<string, Promise<void>>();

function drainDecodeQueue(queue: DecodeQueue): void {
  while (queue.active < queue.limit && queue.pendingIds.length > 0) {
    const pacer = queue.pacer;
    if (pacer) {
      const nowMs = Date.now();
      const elapsedMs = Math.max(0, nowMs - pacer.lastRefillAt);
      pacer.tokens = Math.min(pacer.capacity, pacer.tokens + elapsedMs * pacer.refillPerMs);
      pacer.lastRefillAt = nowMs;
      if (pacer.tokens < 1) {
        // Not enough budget to dispatch another request yet. Schedule exactly one resume once at
        // least one token will exist, then stop dispatching for this tick - never drop or lose a
        // queued review, it just waits its turn (still counted; only the decode POST is deferred).
        if (!pacer.timer) {
          const msUntilToken = (1 - pacer.tokens) / pacer.refillPerMs;
          pacer.timer = setTimeout(() => {
            pacer.timer = null;
            drainDecodeQueue(queue);
          }, Math.max(1, Math.ceil(msUntilToken)));
        }
        return;
      }
      pacer.tokens -= 1;
    }
    const reviewId = queue.pendingIds.shift()!;
    const task = queue.tasks.get(reviewId);
    queue.tasks.delete(reviewId);
    if (!task) continue;
    queue.active++;
    task
      .run()
      .then(task.resolve, task.reject)
      .finally(() => {
        queue.active--;
        drainDecodeQueue(queue);
      });
  }
}

function enqueueDecode(reviewId: string, run: () => Promise<void>, deterministicOnly = false): Promise<void> {
  const taskKey = `${deterministicOnly ? "trusted-exact" : "general"}:${reviewId}`;
  const existing = decodeTaskPromises.get(taskKey);
  if (existing) return existing;
  const queue = deterministicOnly ? trustedExactDecodeQueue : generalDecodeQueue;
  const promise = new Promise<void>((resolve, reject) => {
    queue.pendingIds.push(reviewId);
    queue.tasks.set(reviewId, { run, resolve, reject });
  });
  decodeTaskPromises.set(taskKey, promise);
  const cleanup = () => decodeTaskPromises.delete(taskKey);
  promise.then(cleanup, cleanup);
  drainDecodeQueue(queue);
  return promise;
}
export { enqueueDecode, generalDecodeQueue, resetTokenBucket };
