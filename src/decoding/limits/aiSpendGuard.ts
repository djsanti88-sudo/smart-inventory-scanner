// Local-first abuse + spend guard for the /api/ai-lookup route. Login is intentionally DEFERRED;
// this bounds the bill-drain risk WITHOUT auth via three independent controls:
//   1. kill switch  - an env flag that hard-stops all AI lookup (returns 503, zero provider calls)
//   2. rate limit   - per-IP fixed window (returns 429 when exceeded)
//   3. daily cap    - a hard server-side daily call cap (returns blocked, zero provider calls)
//
// Storage is no-dependency, local-first: in-memory per process + best-effort JSON file persistence.
// IMPORTANT serverless caveat: on Vercel the in-memory state is per-instance and the file write may be
// a no-op (read-only FS), so a deployed multi-instance setup needs a SHARED store (Upstash / Vercel KV)
// to be authoritative. The owner chose no-dependency local-first for now; this file is the single place
// to swap in that shared store later. Pure module: no React, no next/* imports (kept testable).
import fs from "node:fs";
import path from "node:path";

/**
 * Parse an integer env var. A MISSING, blank, or non-numeric value falls back to the default.
 * Guards the production failure mode where the var is present-but-EMPTY (e.g. a Vercel "sensitive"
 * var that does not decrypt on pull): `Number("" ?? 200)` evaluates to 0, which would silently set a
 * 0 daily cap / 0 rate limit and block EVERY decode before any provider call. An explicit numeric
 * value (including 0) is honored; only blank/invalid falls back. To DISABLE lookups, use the kill switch.
 */
export function intEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function killSwitchOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.AI_LOOKUP_KILL_SWITCH;
  return v === "1" || v === "true";
}

type Bucket = { count: number; resetAt: number };
const ipBuckets = new Map<string, Bucket>();

/**
 * In-memory fixed-window rate limit (per process). This is the DEV/NO-STORAGE fallback used when
 * `checkRateLimit` is called without a `storage` option, or when the storage-backed path fails (fail
 * OPEN to memory, never fail-closed on a storage hiccup - see checkRateLimit below).
 */
function checkRateLimitInMemory(
  ip: string,
  limit: number,
  windowMs: number,
  now: number
): { allowed: boolean; retryAfterMs: number; remaining: number } {
  const key = ip || "unknown";
  const b = ipBuckets.get(key);
  if (!b || now >= b.resetAt) {
    ipBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0, remaining: Math.max(0, limit - 1) };
  }
  if (b.count >= limit) return { allowed: false, retryAfterMs: b.resetAt - now, remaining: 0 };
  b.count++;
  return { allowed: true, retryAfterMs: 0, remaining: Math.max(0, limit - b.count) };
}

/** Minimal storage surface checkRateLimit needs: get/set for reads, an atomic increment for the write. */
export type RateLimitStorage = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  increment(key: string): Promise<number>;
};

const RATE_LIMIT_KEY_PREFIX = "ratelimit:";

/**
 * Per-IP fixed-window rate limit. DURABLE when `opts.storage` is supplied: each fixed window is
 * modeled as a key `ratelimit:<scope-ip>:<windowStartMs>` (window start = now rounded down to a
 * `windowMs` boundary), using the SAME atomic `DecodeStorage.increment`/`.get` seam as
 * chargeDailySlot/readDailyUsed (src/server/upc/storage.ts) - so a serverless multi-instance
 * deployment shares one real counter instead of each warm instance keeping its own in-memory bucket.
 * `resetAt` is always computed from the window boundary, never stored, so no extra key is needed for it.
 *
 * Fail OPEN to the in-memory fallback on any storage error (a Turso hiccup must never 429 the whole
 * app) - never fail-closed. Without `opts.storage` this behaves exactly as the prior in-memory-only
 * version (the documented dev/no-storage fallback).
 */
export async function checkRateLimit(
  ip: string,
  opts: {
    limit?: number;
    windowMs?: number;
    now?: number;
    storage?: RateLimitStorage;
    failClosedOnStorageError?: boolean;
  } = {}
): Promise<{ allowed: boolean; retryAfterMs: number; remaining: number }> {
  // Default 600/window (window default 60s): a real bulk-scan session (owner report: a fast
  // 300-code run) mass-429'd under the old 120 default. 600 = ~10 scans/second sustained - well
  // above any human scanner, still abuse-protective against a runaway client. Override via
  // AI_LOOKUP_RATE_LIMIT (blank/invalid falls back to this default - see intEnv).
  const limit = opts.limit ?? intEnv(process.env.AI_LOOKUP_RATE_LIMIT, 600);
  const windowMs = opts.windowMs ?? intEnv(process.env.AI_LOOKUP_RATE_WINDOW_MS, 60_000);
  const now = opts.now ?? Date.now();
  const key = ip || "unknown";

  if (!opts.storage) return checkRateLimitInMemory(key, limit, windowMs, now);

  try {
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const resetAt = windowStart + windowMs;
    const storageKey = `${RATE_LIMIT_KEY_PREFIX}${key}:${windowStart}`;
    // Read-then-conditionally-increment would race across concurrent instances; instead always
    // increment atomically and treat "count after this call" as the total (the same pattern
    // chargeDailySlot uses). This means a request that will be REJECTED still increments the
    // durable counter by one; that is acceptable here (unlike the daily $ cap) because the rate
    // limiter's job is exactly to count attempts, not just genuine spend - rejected requests are
    // still attempts worth counting.
    const count = await opts.storage.increment(storageKey);
    if (count > limit) return { allowed: false, retryAfterMs: Math.max(0, resetAt - now), remaining: 0 };
    return { allowed: true, retryAfterMs: 0, remaining: Math.max(0, limit - count) };
  } catch (err) {
    if (opts.failClosedOnStorageError) throw err;
    console.warn("[checkRateLimit] storage error, falling back to in-memory:", err);
    return checkRateLimitInMemory(key, limit, windowMs, now);
  }
}

function todayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Daily cap v2: atomic, storage-backed. Replaces the per-process JSON-file counter above
// (checkAndIncrementDaily/dailyUsage), which was per-instance on Vercel (racy across concurrent
// function instances) and - the live bug - incremented even on a REJECTED request, hitting
// 232/200 while only ~27 genuine paid provider calls happened.
//
// readDailyUsed is a pure READ (used by both route gates and the GET status endpoint - never
// writes, so a blocked/rejected request can never inflate the counter). chargeDailySlot is the
// ONLY write, and it delegates to storage.increment - an atomic in-storage counter (in-SQL
// `used = used + 1` on Turso, exclusive-lock file update locally; see DecodeStorage.increment in
// src/server/upc/storage.ts) so concurrent serverless instances can never lose an increment to a
// race. Callers MUST call chargeDailySlot exactly once, at the first paid provider call of a
// request (never at the route gate) - see route.ts's LAZY DAILY CAP GATE.

const DAILY_KEY_PREFIX = "ai_daily_cap:";

/** Minimal storage surface chargeDailySlot/readDailyUsed need: get/set for reads, an atomic increment for the write. */
export type DailyCapStorage = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  increment(key: string): Promise<number>;
  /** Atomic conditional charge: increment ONLY while below `limit`; see DecodeStorage.incrementIfBelow. */
  incrementIfBelow(key: string, limit: number): Promise<{ value: number; granted: boolean }>;
};

/**
 * Read-only peek at today's (or `dateKey`'s) daily-cap usage. Makes NO writes - safe to call from
 * a route gate on every request (including ones that will be rejected for other reasons) and from
 * the GET status endpoint, without ever inflating the counter.
 */
export async function readDailyUsed(storage: DailyCapStorage, dateKey: string = todayKey()): Promise<number> {
  const raw = await storage.get(DAILY_KEY_PREFIX + dateKey);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Atomically charge one daily-cap slot at the paid GPT egress boundary. Never call this from the
 * route gate because deterministic and cached answers must remain available after a cap is reached.
 */
export async function chargeDailySlot(
  storage: DailyCapStorage,
  opts: { limit?: number; dateKey?: string } = {},
): Promise<{ used: number; limit: number }> {
  const limit = opts.limit ?? intEnv(process.env.AI_LOOKUP_DAILY_LIMIT, 2000);
  const used = await storage.increment(DAILY_KEY_PREFIX + (opts.dateKey ?? todayKey()));
  return { used, limit };
}

/**
 * Per-account daily-cap key. Distinct namespace from the global `ai_daily_cap:<date>` so a per-account
 * layer never collides with (or double-counts against) the global counter. Charged only alongside the
 * global charge on the SAME genuine-paid-compute signal, exactly once per request (L12).
 */
export function perAccountDailyKey(businessId: string, dateKey: string = todayKey()): string {
  return `${DAILY_KEY_PREFIX}${businessId}:${dateKey}`;
}

/** Read-only peek at a single account's daily usage. Never inflates the counter. */
export async function readDailyUsedForAccount(
  storage: DailyCapStorage,
  businessId: string,
  dateKey: string = todayKey(),
): Promise<number> {
  const raw = await storage.get(perAccountDailyKey(businessId, dateKey));
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Atomically charge one account daily slot. Same one-charge-per-request discipline as chargeDailySlot. */
export async function chargeDailySlotForAccount(
  storage: DailyCapStorage,
  businessId: string,
  dateKey: string = todayKey(),
): Promise<number> {
  return storage.increment(perAccountDailyKey(businessId, dateKey));
}

// ---------------------------------------------------------------------------
// Daily cap v3 (item 1, 2026-08-09): atomic CONDITIONAL charge. chargeDailySlot/chargeDailySlotForAccount
// above are UNCONDITIONAL (always increment, return the new total) - correct for the god charged-but-
// never-blocked path, and for any caller that has already decided to proceed. The conditional variants
// below fold the cap CHECK and the CHARGE into ONE atomic storage op (incrementIfBelow), so N concurrent
// tenant requests racing at the boundary grant at most `limit - current` slots and never overshoot -
// eliminating the bounded-but-real TOCTOU window the old readDailyUsed-then-chargeDailySlot dance had.
// A `granted:false` result means the slot was NOT charged and the caller must treat the request as
// cap-blocked (429 / Needs Review), exactly the honest-reason path today's read-check already drives.
// ---------------------------------------------------------------------------

/**
 * Atomically charge one GLOBAL daily-cap slot IFF today's usage is still below `limit`. Returns the
 * resulting `used` count, the effective `limit`, and whether the slot was `granted`. On a denied
 * result the counter is unchanged and no slot was consumed. Same once-per-genuine-compute discipline
 * as chargeDailySlot - call it at the single paid-charge site, never at a pure read gate.
 */
export async function chargeDailySlotConditional(
  storage: DailyCapStorage,
  opts: { limit?: number; dateKey?: string } = {},
): Promise<{ used: number; limit: number; granted: boolean }> {
  const limit = opts.limit ?? intEnv(process.env.AI_LOOKUP_DAILY_LIMIT, 2000);
  const { value, granted } = await storage.incrementIfBelow(
    DAILY_KEY_PREFIX + (opts.dateKey ?? todayKey()),
    limit,
  );
  return { used: value, limit, granted };
}

/**
 * Refund ONE global daily-cap slot (atomic -1). Used when a request charged the global slot but is then
 * BLOCKED for another reason (deep-review Finding 4: an authoritative per-account denial under a burst)
 * - without the refund, N account-denied requests would each leave a phantom +1 on the shared global
 * backstop and could starve other tenants. Best-effort by convention at the call site: a refund failure
 * at worst leaves the prior conservative over-count, never an under-count of the bill.
 */
export async function refundDailySlot(
  storage: { incrementBy(key: string, delta: number): Promise<number> },
  opts: { dateKey?: string } = {},
): Promise<void> {
  await storage.incrementBy(DAILY_KEY_PREFIX + (opts.dateKey ?? todayKey()), -1);
}

/**
 * Atomically charge one PER-ACCOUNT daily-cap slot IFF that account's usage is still below `limit`.
 * Same conditional semantics as chargeDailySlotConditional but scoped to the account key namespace.
 */
export async function chargeDailySlotForAccountConditional(
  storage: DailyCapStorage,
  businessId: string,
  limit: number,
  dateKey: string = todayKey(),
): Promise<{ used: number; granted: boolean }> {
  const { value, granted } = await storage.incrementIfBelow(perAccountDailyKey(businessId, dateKey), limit);
  return { used: value, granted };
}

// ---------------------------------------------------------------------------
// GPT decode dollar guard on the same durable counter seam as the daily cap.
// chargeDailySlot/readDailyUsed (get/set/increment - see DailyCapStorage above and DecodeStorage in
// src/decoding/server/pipeline/storage.ts). This is a DOLLAR cap, not a call counter, so it cannot use `increment`
// directly (that only atomically adds 1): dollar amounts are stored as INTEGER CENTS (a tenth-of-a-
// cent would need fractional increments the storage seam does not support) and persisted via an
// atomic get-then-set loop with a bounded retry, matching the file adapter's single-process
// read-modify-write safety and accepting the same small race window the file adapter always had
// (Turso is one round-trip; a genuine concurrent double-write here undercounts by at most one call's
// worth of cents, which the worstCaseUsd headroom in checkGptDecodeBudget already exists to absorb).
// The file-based path (below) stays as the dev/no-storage fallback and is used whenever no `storage`
// option is passed (matching checkRateLimit's fallback discipline: never fail-closed on missing/
// erroring storage - fall back to file/memory instead).
// ---------------------------------------------------------------------------

type GptDecodeState = { date: string; spentUsd: number };
const memGptDecode = new Map<string, GptDecodeState>();

function gptDecodeKey(dateKey: string): string {
  return `gptDecodeUsd:${dateKey}`;
}

/**
 * Minimal storage surface the GPT decode budget needs. `incrementBy` is
 * an atomic arbitrary-delta increment - required so recordGptDecodeSpend never does a JS-side
 * get-then-set, which could silently lose one call's spend to a race between two concurrent GPT
 * provider calls writing to the same day's key.
 */
export type GptDecodeStorage = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  increment(key: string): Promise<number>;
  incrementBy(key: string, delta: number): Promise<number>;
};

const GPT_DECODE_SPEND_UNITS_PREFIX = "gpt_decode_usd_cents:";
const GPT_DECODE_CALLS_PREFIX = "gpt_decode_calls:";

/** usd -> integer TENTH-OF-A-CENT units (not whole cents): a searchless call can cost ~$0.003, and
 * rounding to whole cents would zero it out and permanently undercount real spend (cost-truth rule). */
function usdToTenthCents(usd: number): number {
  return Math.round(usd * 1000);
}
function tenthCentsToUsd(tenthCents: number): number {
  return tenthCents / 1000;
}

/**
 * Dedicated storage file for the GPT decode dollar guard (dev/no-storage fallback only). Deliberately
 * its OWN file (not the daily cap's legacy path), same directory-resolution pattern (env override,
 * else path.resolve of a dotfile in cwd).
 */
function gptDecodeFile(): string {
  return process.env.AI_LOOKUP_GPT_DECODE_FILE || path.resolve(".gpt-decode-usage.json");
}

function readGptDecodeSpendFromFile(file: string, date: string, key: string): number {
  let spentUsd = 0;
  const mem = memGptDecode.get(key);
  if (mem && mem.date === date) spentUsd = mem.spentUsd;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const fileSpent = raw && raw[key] && raw[key].date === date ? Number(raw[key].spentUsd) : 0;
    if (Number.isFinite(fileSpent) && fileSpent > spentUsd) spentUsd = fileSpent;
  } catch {
    // no file yet / unreadable -> fall back to in-memory (or 0)
  }
  return spentUsd;
}

/**
 * Daily dollar guard for GPT decode. Durable when `opts.storage` is supplied: reads
 * the integer-tenth-of-a-cent counter via `storage.get`. Falls back to the file/in-memory guard
 * (dev/no-storage, or on a storage error - fail OPEN to the fallback, never fail-closed) otherwise.
 */
export async function checkGptDecodeBudget(
  opts: { capUsd?: number; file?: string; dateKey?: string; worstCaseUsd?: number; storage?: GptDecodeStorage } = {}
): Promise<{ allowed: boolean; spentUsd: number; capUsd: number }> {
  const capUsd = opts.capUsd ?? Number(process.env.GPT_DECODE_DAILY_USD ?? 3);
  const worstCaseUsd = opts.worstCaseUsd ?? 0.39;
  const date = opts.dateKey ?? todayKey();
  const key = gptDecodeKey(date);

  let spentUsd: number;
  if (opts.storage) {
    try {
      const raw = await opts.storage.get(GPT_DECODE_SPEND_UNITS_PREFIX + date);
      const tenthCents = raw ? Number(raw) : 0;
      spentUsd = Number.isFinite(tenthCents) && tenthCents >= 0 ? tenthCentsToUsd(tenthCents) : 0;
    } catch (err) {
      console.warn("[checkGptDecodeBudget] storage error, falling back to file/memory:", err);
      spentUsd = readGptDecodeSpendFromFile(opts.file ?? gptDecodeFile(), date, key);
    }
  } else {
    spentUsd = readGptDecodeSpendFromFile(opts.file ?? gptDecodeFile(), date, key);
  }

  return { allowed: spentUsd + worstCaseUsd <= capUsd, spentUsd, capUsd };
}

/**
 * Records the response-observable spend floor for the day. Durable when `opts.storage` is supplied: dollar
 * amounts are stored as integer tenth-of-a-cent units so the guard never rounds sub-cent spend to
 * zero. Uses the ATOMIC `incrementBy` (Fix 2, P6 ultra-review) - never a JS-side get-then-set - so
 * two concurrent GPT calls recording spend against the same day's key both land (summed),
 * instead of the loser's write silently clobbering the winner's under the old get-then-set. Falls
 * back to file/memory (dev/no-storage, or on a storage error).
 */
export async function recordGptDecodeSpend(
  usdComputedFloor: number,
  opts: { file?: string; dateKey?: string; storage?: GptDecodeStorage } = {}
): Promise<void> {
  const date = opts.dateKey ?? todayKey();
  const key = gptDecodeKey(date);

  if (opts.storage) {
    const centsKey = GPT_DECODE_SPEND_UNITS_PREFIX + date;
    const tenthCentsDelta = usdToTenthCents(usdComputedFloor);
    try {
      await opts.storage.incrementBy(centsKey, tenthCentsDelta);
      return;
    } catch {
      // FINDING A (P6 fix wave, cost-truth): a transient error on the WRITE alone (while reads still hit
      // the durable Turso counter) permanently undercounts real spend if we silently reroute this call's
      // dollars to the file (a documented no-op on Vercel's read-only FS). RETRY the atomic incrementBy
      // ONCE before falling back, then, if the durable write still fails, do the file fallback AND emit a
      // structured, single-line-JSON divergence event so the undercount is owner-visible, not a silent warn.
      //
      // ACCEPTED TRADE-OFF (adjudicated, agy review 2026-07-20): if the FIRST incrementBy succeeded
      // server-side but the client saw a timeout, this retry adds the delta AGAIN - a rare ack-lost
      // OVERCOUNT. Deliberate: the cost-truth rule is "never UNDERcount actual spend"; overcounting the
      // The budget guard stops GPT early (conservative direction), so we do
      // not attempt idempotent dedup here.
      try {
        await opts.storage.incrementBy(centsKey, tenthCentsDelta);
        return;
      } catch (retryErr) {
        // Structured divergence signal. aiSpendGuard is a pure service (no server-only import allowed by
        // project law), so we emit the same shape logServerEvent would - a single-line JSON via
        // console.error - instead of importing the server logger and violating the service/server boundary.
        console.error(
          JSON.stringify({
            src: "scanbin",
            route: "aiSpendGuard.recordGptDecodeSpend",
            event: "spend_write_diverged",
            tenthCentsDelta,
            dateKey: date,
            ts: new Date().toISOString(),
            detail: "durable GPT decode spend write failed twice; rerouted to file fallback (may no-op on read-only FS)",
          })
        );
        console.warn("[recordGptDecodeSpend] storage error, falling back to file/memory:", retryErr);
        // fall through to the file/memory path below
      }
    }
  }

  const file = opts.file ?? gptDecodeFile();
  const existing = readGptDecodeSpendFromFile(file, date, key);
  // Round to a TENTH OF A CENT (4 decimal places), not whole cents. A searchless GPT call can
  // cost as little as ~$0.003; rounding to 2 decimals would zero it out and permanently undercount
  // real spend against the daily dollar cap. Cost-truth rule: never undercount actual spend.
  const spentUsd = Math.round((existing + usdComputedFloor) * 10000) / 10000;
  memGptDecode.set(key, { date, spentUsd });

  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // no file yet / unreadable -> start fresh
  }
  all[key] = { date, spentUsd };
  try {
    fs.writeFileSync(file, JSON.stringify(all));
  } catch {
    // best-effort persistence; in-memory still enforces within this process
  }
}

function gptDecodeCallsKey(dateKey: string): string {
  return `gptDecodeCalls:${dateKey}`;
}

const memGptDecodeCalls = new Map<string, number>();

function readGptDecodeCallsFromFile(file: string, date: string, key: string): number {
  let calls = 0;
  const mem = memGptDecodeCalls.get(key);
  if (typeof mem === "number") calls = mem;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const fileCalls = raw && raw[key] && raw[key].date === date ? Number(raw[key].calls) : 0;
    if (Number.isFinite(fileCalls) && fileCalls > calls) calls = fileCalls;
  } catch {
    // no file yet / unreadable -> fall back to in-memory (or 0)
  }
  return calls;
}

/**
 * Read-only peek at today's GPT decode call count. Durable when `opts.storage` is supplied (reads
 * the atomic call-count key). Falls back to file/memory otherwise (dev/no-storage, or a storage error).
 */
async function gptDecodeCallCount(opts: { file?: string; dateKey?: string; storage?: GptDecodeStorage } = {}): Promise<number> {
  const date = opts.dateKey ?? todayKey();
  const key = gptDecodeCallsKey(date);
  if (opts.storage) {
    try {
      const raw = await opts.storage.get(GPT_DECODE_CALLS_PREFIX + date);
      const n = raw ? Number(raw) : 0;
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch (err) {
      console.warn("[gptDecodeCallCount] storage error, falling back to file/memory:", err);
      return readGptDecodeCallsFromFile(opts.file ?? gptDecodeFile(), date, key);
    }
  }
  return readGptDecodeCallsFromFile(opts.file ?? gptDecodeFile(), date, key);
}

/**
 * Records one GPT decode call for the day. Durable when `opts.storage` is supplied: uses the
 * ATOMIC `storage.increment` (a plain +1 counter, unlike the dollar guard - no cents math needed),
 * the exact same seam chargeDailySlot uses. Falls back to file/memory otherwise.
 */
export async function recordGptDecodeCall(opts: { file?: string; dateKey?: string; storage?: GptDecodeStorage } = {}): Promise<void> {
  const date = opts.dateKey ?? todayKey();
  const key = gptDecodeCallsKey(date);

  if (opts.storage) {
    try {
      await opts.storage.increment(GPT_DECODE_CALLS_PREFIX + date);
      return;
    } catch (err) {
      console.warn("[recordGptDecodeCall] storage error, falling back to file/memory:", err);
      // fall through to the file/memory path below
    }
  }

  const file = opts.file ?? gptDecodeFile();
  const calls = readGptDecodeCallsFromFile(file, date, key) + 1;
  memGptDecodeCalls.set(key, calls);

  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // no file yet / unreadable -> start fresh
  }
  all[key] = { date, calls };
  try {
    fs.writeFileSync(file, JSON.stringify(all));
  } catch {
    // best-effort persistence; in-memory still enforces within this process
  }
}

/**
 * Combined read-only status for the Settings spend panel + GET /api/ai-lookup: today's spend,
 * cap, call count, and whether the budget currently allows another GPT call. Composes the
 * existing budget check + call-count peek; makes NO writes and spends nothing.
 */
export async function getGptDecodeStatus(
  opts: { capUsd?: number; file?: string; dateKey?: string; worstCaseUsd?: number; storage?: GptDecodeStorage } = {}
): Promise<{ spentUsd: number; capUsd: number; calls: number; allowed: boolean }> {
  const budget = await checkGptDecodeBudget(opts);
  const calls = await gptDecodeCallCount(opts);
  return { spentUsd: budget.spentUsd, capUsd: budget.capUsd, calls, allowed: budget.allowed };
}

/** Test-only: clear in-memory state between cases. */
export function __resetForTest(): void {
  ipBuckets.clear();
  memGptDecode.clear();
  memGptDecodeCalls.clear();
}
