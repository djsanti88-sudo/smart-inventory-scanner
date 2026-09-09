// Shared client-side fetch backoff helper (bug #28 - "878x429 in the 1,000-code paste stress").
//
// Root cause (see .superpowers/sdd/2026-08-06-canelo-round2-sync-hardening-and-4500-proof/
// r2-scout-p4-backoff.md): every /api/ai-lookup and /api/prefix-floor route already sends a correct
// `Retry-After` header on 429, but the ONLY client-side handler (decodeOnce) capped the honored wait
// at 30s (server window is up to 60s), retried exactly once with NO jitter (so a burst of callers
// that all got 429'd together retried in a synchronized wave and re-tripped the rate limiter), and
// every other call site had inconsistent or no 429 handling at all.
//
// This module is a pure, dependency-free fetch wrapper (no React/next imports - "services stay pure
// and testable" per CLAUDE.md/AGENTS.md) that:
//   1. Honors a 429 `Retry-After` header IN FULL (seconds or HTTP-date form), not capped at 30s -
//      only a generous safety ceiling (`maxRetryAfterMs`, default 90s) guards against a malformed or
//      absurdly large header ever hanging the caller.
//   2. Falls back to jittered exponential backoff (`base * 2^attempt`, capped, then FULL jitter -
//      `random() * delay`) when no `Retry-After` header is present, so a burst of simultaneous 429s
//      does not retry in lockstep.
//   3. Bounds total attempts (`maxAttempts`, default 2 - matches the pre-existing single-retry budget
//      so paid-call cost/latency does not silently grow) and returns the final (possibly still-429)
//      Response to the caller once exhausted, rather than throwing - the caller decides what error/
//      reason to surface, exactly as it did before this helper existed.
//   4. Lets the caller inspect a 429 body via `onRetryDecision` (given a CLONED, unread Response) and
//      veto a retry outright - e.g. a `daily_cap`/`account_daily_cap` reasonCode, which will never
//      clear itself by waiting and must fail fast exactly as before.
//   5. Passes an `AbortSignal` straight through to every fetch attempt AND to the wait between
//      attempts, so an aborted caller (e.g. the existing decode budget timeout) is never blocked by a
//      pending backoff sleep.
//
// TOP-LEVEL LAW note: this helper only changes WHEN/whether an enrichment retry happens. It never
// touches scan-row creation or counting (`ensureProvisionalCount` runs synchronously before any
// network call, entirely outside this module) and it never silently swallows a final failure - it
// always returns the last Response (or throws only for a true fetch/network/abort failure), so the
// existing caller-side catch -> Needs Review with an honest reason is completely preserved.

export interface FetchWithBackoffOptions {
  /** Max total fetch attempts (initial attempt + retries). Default 2 (one retry) - matches the
   *  pre-existing single-retry budget for decode calls. */
  maxAttempts?: number;
  /** Base delay (ms) for the jittered exponential fallback used when a 429 has no Retry-After header. */
  baseDelayMs?: number;
  /** Upper cap (ms) for the exponential fallback delay, before jitter is applied. */
  maxBackoffDelayMs?: number;
  /** Safety ceiling (ms) applied to a server-provided Retry-After value. Only guards against a
   *  malformed/absurd header - never used to shrink a legitimate wait inside the server's real window. */
  maxRetryAfterMs?: number;
  /** Called with a CLONED, unread Response immediately after a 429 is received (before any wait).
   *  Return `{ retry: false }` to stop retrying immediately (e.g. a daily-cap 429 that will never
   *  clear on its own) - the ORIGINAL response is then returned untouched so the caller can read its
   *  body. Omit to always retry (subject to `maxAttempts`). */
  onRetryDecision?: (response: Response) => { retry: boolean } | Promise<{ retry: boolean }>;
  /** Injectable sleep for tests; defaults to a real, AbortSignal-aware setTimeout sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable randomness for deterministic jitter tests; defaults to Math.random. */
  random?: () => number;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_BACKOFF_DELAY_MS = 30000;
const DEFAULT_MAX_RETRY_AFTER_MS = 90000;

/** Parses a `Retry-After` header value (seconds, or an HTTP-date) into a millisecond delay.
 *  Returns null when the header is present but unparseable as either form. */
export function parseRetryAfterMs(headerValue: string): number | null {
  const trimmed = headerValue.trim();
  if (trimmed === "") return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function makeAbortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(makeAbortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(makeAbortError());
    };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    signal?.addEventListener("abort", onAbort);
  });
}

function computeDelayMs(
  res: Response,
  attempt: number,
  cfg: { baseDelayMs: number; maxBackoffDelayMs: number; maxRetryAfterMs: number; random: () => number },
): number {
  const retryAfterHeader = res.headers.get("Retry-After");
  if (retryAfterHeader) {
    const parsed = parseRetryAfterMs(retryAfterHeader);
    if (parsed !== null) return Math.min(parsed, cfg.maxRetryAfterMs);
  }
  // Full jitter: random() in [0,1) times the (capped) exponential delay - so a burst of callers that
  // all got 429'd in the same instant do NOT retry at the identical timestamp (the thundering-herd
  // mechanism the scout report identifies as the actual root cause of the "878x429" storm).
  const exponential = Math.min(cfg.baseDelayMs * 2 ** Math.max(0, attempt - 1), cfg.maxBackoffDelayMs);
  return cfg.random() * exponential;
}

/**
 * Fetch with 429-aware backoff. Returns the final Response (which may still be a 429 if attempts are
 * exhausted or `onRetryDecision` vetoed further retries) - it does not throw on a non-ok/429 status,
 * matching plain `fetch()` semantics so callers keep their existing `if (!res.ok) ...` handling.
 * Throws only for a genuine fetch-level failure (network error, or an AbortSignal firing during the
 * fetch or the wait between attempts).
 */
export async function fetchWithBackoff(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: FetchWithBackoffOptions = {},
): Promise<Response> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxBackoffDelayMs = options.maxBackoffDelayMs ?? DEFAULT_MAX_BACKOFF_DELAY_MS;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const signal = init.signal ?? undefined;

  let attempt = 0;
  for (;;) {
    attempt++;
    const res = await fetch(input, init);
    if (res.status !== 429) return res;
    if (attempt >= maxAttempts) return res; // exhausted - caller surfaces its own honest reason

    if (options.onRetryDecision) {
      const decision = await options.onRetryDecision(res.clone());
      if (!decision.retry) return res; // e.g. daily_cap - never clears by waiting
    }

    const delayMs = computeDelayMs(res, attempt, { baseDelayMs, maxBackoffDelayMs, maxRetryAfterMs, random });
    await sleep(delayMs, signal);
  }
}
