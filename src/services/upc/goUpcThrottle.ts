/**
 * GoUpcGate — a pure, framework-free rate gate for the Go-UPC rung.
 *
 * Two independent guarantees:
 *  1. Spacing: successive `fn()` invocations start at least `minGapMs` apart (default 500ms => 2 req/s).
 *     Enforced with a single promise-chain tail; each new call waits behind the previous one's slot,
 *     then delays only the remaining time since the last release.
 *  2. In-flight dedup: two concurrent `run(key, fn)` calls with the SAME key share ONE `fn()`
 *     invocation and both resolve (or reject) with its result. Once that in-flight promise settles,
 *     the slot is cleared so the next `run` for that key invokes `fn` afresh — including after a
 *     rejection (a failure never poisons the key).
 *
 * `now` is injectable so tests can drive spacing with a controllable clock; production uses Date.now.
 * No env, no React/next imports — safe to instantiate as a server-side singleton.
 */
export interface GoUpcGateOptions {
  minGapMs?: number;
  now?: () => number;
}

export class GoUpcGate {
  private readonly minGapMs: number;
  private readonly now: () => number;

  // Serialization tail: each queued task chains off this, guaranteeing FIFO order + spacing.
  private tail: Promise<void> = Promise.resolve();
  // Timestamp (per `now`) at which the last task was released to run.
  private lastReleaseAt = Number.NEGATIVE_INFINITY;
  // Shared in-flight promises keyed by dedup key.
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(opts?: GoUpcGateOptions) {
    this.minGapMs = opts?.minGapMs ?? 500;
    this.now = opts?.now ?? Date.now;
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Dedup: an existing in-flight call for this key is shared by every concurrent caller.
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const spaced = this.acquireSlot().then(() => fn());
    // Clear the slot once settled so a later call re-invokes `fn` (success OR failure).
    const shared = spaced.finally(() => {
      if (this.inFlight.get(key) === shared) this.inFlight.delete(key);
    });
    this.inFlight.set(key, shared);
    return shared;
  }

  /** Wait our turn in the serialized tail, then delay any remaining gap before releasing. */
  private acquireSlot(): Promise<void> {
    const slot = this.tail.then(async () => {
      const waitMs = this.minGapMs - (this.now() - this.lastReleaseAt);
      if (waitMs > 0) await delay(waitMs);
      this.lastReleaseAt = this.now();
    });
    // The tail must never reject, or it would wedge the queue; swallow here (callers see their own errors).
    this.tail = slot.catch(() => {});
    return slot;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
