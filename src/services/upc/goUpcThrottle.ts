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
  // Shared in-flight call state keyed by dedup key. `signals` accumulates every registered caller's
  // AbortSignal as they join the dedup (DC-2 fix, 2026-08-13); `hasUnsignaled` is set once any caller
  // joins with no signal at all, meaning the call must never be dropped for abandonment.
  private readonly inFlight = new Map<
    string,
    { shared: Promise<unknown>; signals: Set<AbortSignal>; hasUnsignaled: boolean }
  >();

  constructor(opts?: GoUpcGateOptions) {
    this.minGapMs = opts?.minGapMs ?? 500;
    this.now = opts?.now ?? Date.now;
  }

  /**
   * @param signal DC-1 fix (2026-08-13, money-leak remediation), corrected by DC-2 (same day, clean-room
   *   review): every concurrent caller for a key registers its own signal (or lack of one) against the
   *   SAME shared underlying call. Right before `fn()` fires (i.e. immediately before the real network
   *   egress + charge), the call is DROPPED only when EVERY caller who has joined by then registered a
   *   signal AND every one of those signals is aborted - so one caller giving up never cancels a
   *   DIFFERENT caller's still-wanted call. A caller who joins with no signal at all (or whose own
   *   signal never aborts) always keeps the underlying call alive for the whole group.
   *
   *   Each caller still gets a promise that reflects ITS OWN wishes: if a caller's own signal aborts -
   *   whether before the shared call starts or while it's still in flight - THAT caller's returned
   *   promise rejects with AbortError immediately, even though the shared call may keep running (or
   *   already succeeded) for the other callers. Once `fn()` has actually started, only the DROP decision
   *   is fixed by the group's abort state at that instant; the per-caller rejection race stays live for
   *   the lifetime of the promise.
   *
   *   The spacing slot is still consumed on schedule either way (the drop check runs AFTER
   *   `acquireSlot()`, so later queued callers still see the same minGapMs spacing as before - this
   *   fix changes only whether/how `fn` settles for each caller, never the queue's timing for others).
   */
  run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      // Join the existing shared call: register this caller's signal (or note it has none) so the
      // group's abandonment check at fn-fire time sees every current caller's wishes.
      if (signal) existing.signals.add(signal);
      else existing.hasUnsignaled = true;
      return this.ownAbortRace(existing.shared as Promise<T>, signal);
    }

    const signals = new Set<AbortSignal>();
    if (signal) signals.add(signal);
    const entry: { shared: Promise<unknown>; signals: Set<AbortSignal>; hasUnsignaled: boolean } = {
      shared: Promise.resolve(), // placeholder; replaced below once `spaced` exists (needed for its own closure)
      signals,
      hasUnsignaled: !signal,
    };

    const spaced = this.acquireSlot().then(() => {
      // Drop only when EVERY registered caller has a signal and every one of them is aborted. Any
      // caller with no signal, or any signal that is not aborted, keeps the call alive for the group.
      const allAbandoned = !entry.hasUnsignaled && entry.signals.size > 0 && [...entry.signals].every((s) => s.aborted);
      if (allAbandoned) {
        throw new DOMException(
          "Go-UPC call dropped: every caller waiting on this queued turn had already abandoned it",
          "AbortError",
        );
      }
      return fn();
    });
    // Clear the slot once settled so a later call re-invokes `fn` (success OR failure).
    const shared = spaced.finally(() => {
      if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
    });
    // Every caller's actual result comes through `ownAbortRace` below, which attaches its own handler
    // to `shared` UNLESS this caller's signal was already aborted at call time (in which case it never
    // waits on `shared` at all). Without a standing handler here, a group drop or a `fn` rejection could
    // leave `shared` with zero attached handlers - an unhandled rejection - when every joined caller's
    // own signal happened to already be aborted. This no-op catch only marks the rejection observed; it
    // never swallows anything callers actually see (they still get their own reaction from `ownAbortRace`).
    shared.catch(() => {});
    entry.shared = shared;
    this.inFlight.set(key, entry);
    return this.ownAbortRace(shared as Promise<T>, signal);
  }

  /**
   * Wrap the shared promise so THIS caller's own signal can reject it early with AbortError without
   * affecting the shared promise itself (other callers still await the real settlement).
   */
  private ownAbortRace<T>(shared: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return shared;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(new DOMException("Go-UPC call aborted by its own caller before it settled", "AbortError"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      shared.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
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
