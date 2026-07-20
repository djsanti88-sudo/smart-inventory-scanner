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
 * `windowMs` boundary), using the SAME atomic `LadderStorage.increment`/`.get` seam as
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
  opts: { limit?: number; windowMs?: number; now?: number; storage?: RateLimitStorage } = {}
): Promise<{ allowed: boolean; retryAfterMs: number; remaining: number }> {
  const limit = opts.limit ?? intEnv(process.env.AI_LOOKUP_RATE_LIMIT, 120);
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
    console.warn("[checkRateLimit] storage error, falling back to in-memory:", err);
    return checkRateLimitInMemory(key, limit, windowMs, now);
  }
}

type DailyState = { date: string; count: number };
let memDaily: DailyState | null = null;

function counterFile(): string {
  return process.env.AI_LOOKUP_COUNTER_FILE || path.resolve(".ai-lookup-usage.json");
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
// `used = used + 1` on Turso, exclusive-lock file update locally; see LadderStorage.increment in
// src/server/upc/storage.ts) so concurrent serverless instances can never lose an increment to a
// race. Callers MUST call chargeDailySlot exactly once, at the first paid provider call of a
// request (never at the route gate) - see route.ts's LAZY DAILY CAP GATE.

const DAILY_KEY_PREFIX = "ai_daily_cap:";

/** Minimal storage surface chargeDailySlot/readDailyUsed need: get/set for reads, an atomic increment for the write. */
export type DailyCapStorage = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  increment(key: string): Promise<number>;
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
 * Atomically charge one daily-cap slot. Call this ONLY at the moment the first paid provider call
 * of a request actually starts (Go-UPC lookup, paid Fetch V2 stage, or the GPT ladder rung -
 * whichever runs first) - never at the route gate, and never more than once per request (a
 * `charged` flag at the call site prevents a later rung in the same request from charging again).
 */
export async function chargeDailySlot(
  storage: DailyCapStorage,
  opts: { limit?: number; dateKey?: string } = {},
): Promise<{ used: number; limit: number }> {
  const limit = opts.limit ?? intEnv(process.env.AI_LOOKUP_DAILY_LIMIT, 500);
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
// GPT ladder dollar guard (B1, 2026-07-20): migrated onto the SAME durable LadderStorage KV seam as
// chargeDailySlot/readDailyUsed (get/set/increment - see DailyCapStorage above and LadderStorage in
// src/server/upc/storage.ts). This is a DOLLAR cap, not a call counter, so it cannot use `increment`
// directly (that only atomically adds 1): dollar amounts are stored as INTEGER CENTS (a tenth-of-a-
// cent would need fractional increments the storage seam does not support) and persisted via an
// atomic get-then-set loop with a bounded retry, matching the file adapter's single-process
// read-modify-write safety and accepting the same small race window the file adapter always had
// (Turso is one round-trip; a genuine concurrent double-write here undercounts by at most one call's
// worth of cents, which the worstCaseUsd headroom in checkGptLadderBudget already exists to absorb).
// The file-based path (below) stays as the dev/no-storage fallback and is used whenever no `storage`
// option is passed (matching checkRateLimit's fallback discipline: never fail-closed on missing/
// erroring storage - fall back to file/memory instead).
// ---------------------------------------------------------------------------

type GptLadderState = { date: string; spentUsd: number };
const memGptLadder = new Map<string, GptLadderState>();

function gptLadderKey(dateKey: string): string {
  return `gptLadderUsd:${dateKey}`;
}

/**
 * Minimal storage surface the GPT ladder $-guard needs. `incrementBy` (Fix 2, P6 ultra-review) is
 * an atomic arbitrary-delta increment - required so recordGptLadderSpend never does a JS-side
 * get-then-set, which could silently lose one call's spend to a race between two concurrent GPT
 * ladder rungs writing to the same day's key.
 */
export type GptLadderStorage = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  increment(key: string): Promise<number>;
  incrementBy(key: string, delta: number): Promise<number>;
};

const GPT_SPEND_CENTS_PREFIX = "gpt_ladder_usd_cents:";
const GPT_CALLS_PREFIX = "gpt_ladder_calls:";

/** usd -> integer TENTH-OF-A-CENT units (not whole cents): a searchless call can cost ~$0.003, and
 * rounding to whole cents would zero it out and permanently undercount real spend (cost-truth rule). */
function usdToTenthCents(usd: number): number {
  return Math.round(usd * 1000);
}
function tenthCentsToUsd(tenthCents: number): number {
  return tenthCents / 1000;
}

/**
 * Dedicated storage file for the GPT ladder dollar guard (dev/no-storage fallback only). Deliberately
 * its OWN file (not counterFile()'s legacy path), same directory-resolution pattern (env override,
 * else path.resolve of a dotfile in cwd).
 */
function gptLadderFile(): string {
  return process.env.AI_LOOKUP_GPT_LADDER_FILE || path.resolve(".gpt-ladder-usage.json");
}

function readGptLadderSpendFromFile(file: string, date: string, key: string): number {
  let spentUsd = 0;
  const mem = memGptLadder.get(key);
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
 * Daily DOLLAR guard for the paid GPT ladder rung. DURABLE when `opts.storage` is supplied: reads
 * the integer-tenth-of-a-cent counter via `storage.get`. Falls back to the file/in-memory guard
 * (dev/no-storage, or on a storage error - fail OPEN to the fallback, never fail-closed) otherwise.
 */
export async function checkGptLadderBudget(
  opts: { capUsd?: number; file?: string; dateKey?: string; worstCaseUsd?: number; storage?: GptLadderStorage } = {}
): Promise<{ allowed: boolean; spentUsd: number; capUsd: number }> {
  const capUsd = opts.capUsd ?? Number(process.env.GPT_LADDER_DAILY_USD ?? 3);
  const worstCaseUsd = opts.worstCaseUsd ?? 0.39;
  const date = opts.dateKey ?? todayKey();
  const key = gptLadderKey(date);

  let spentUsd: number;
  if (opts.storage) {
    try {
      const raw = await opts.storage.get(GPT_SPEND_CENTS_PREFIX + date);
      const tenthCents = raw ? Number(raw) : 0;
      spentUsd = Number.isFinite(tenthCents) && tenthCents >= 0 ? tenthCentsToUsd(tenthCents) : 0;
    } catch (err) {
      console.warn("[checkGptLadderBudget] storage error, falling back to file/memory:", err);
      spentUsd = readGptLadderSpendFromFile(opts.file ?? gptLadderFile(), date, key);
    }
  } else {
    spentUsd = readGptLadderSpendFromFile(opts.file ?? gptLadderFile(), date, key);
  }

  return { allowed: spentUsd + worstCaseUsd <= capUsd, spentUsd, capUsd };
}

/**
 * Records actual GPT ladder spend for the day. DURABLE when `opts.storage` is supplied: dollar
 * amounts are stored as integer tenth-of-a-cent units so the guard never rounds sub-cent spend to
 * zero. Uses the ATOMIC `incrementBy` (Fix 2, P6 ultra-review) - never a JS-side get-then-set - so
 * two concurrent GPT ladder rungs recording spend against the SAME day's key both land (summed),
 * instead of the loser's write silently clobbering the winner's under the old get-then-set. Falls
 * back to file/memory (dev/no-storage, or on a storage error).
 */
export async function recordGptLadderSpend(
  usd: number,
  opts: { file?: string; dateKey?: string; storage?: GptLadderStorage } = {}
): Promise<void> {
  const date = opts.dateKey ?? todayKey();
  const key = gptLadderKey(date);

  if (opts.storage) {
    try {
      const centsKey = GPT_SPEND_CENTS_PREFIX + date;
      await opts.storage.incrementBy(centsKey, usdToTenthCents(usd));
      return;
    } catch (err) {
      console.warn("[recordGptLadderSpend] storage error, falling back to file/memory:", err);
      // fall through to the file/memory path below
    }
  }

  const file = opts.file ?? gptLadderFile();
  const existing = readGptLadderSpendFromFile(file, date, key);
  // Round to a TENTH OF A CENT (4 decimal places), not whole cents. A searchless GPT call can
  // cost as little as ~$0.003; rounding to 2 decimals would zero it out and permanently undercount
  // real spend against the daily dollar cap. Cost-truth rule: never undercount actual spend.
  const spentUsd = Math.round((existing + usd) * 10000) / 10000;
  memGptLadder.set(key, { date, spentUsd });

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

function gptLadderCallsKey(dateKey: string): string {
  return `gptLadderCalls:${dateKey}`;
}

const memGptLadderCalls = new Map<string, number>();

function readGptLadderCallsFromFile(file: string, date: string, key: string): number {
  let calls = 0;
  const mem = memGptLadderCalls.get(key);
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
 * Read-only peek at today's GPT ladder call count. DURABLE when `opts.storage` is supplied (reads
 * the atomic call-count key). Falls back to file/memory otherwise (dev/no-storage, or a storage error).
 */
async function gptLadderCallCount(opts: { file?: string; dateKey?: string; storage?: GptLadderStorage } = {}): Promise<number> {
  const date = opts.dateKey ?? todayKey();
  const key = gptLadderCallsKey(date);
  if (opts.storage) {
    try {
      const raw = await opts.storage.get(GPT_CALLS_PREFIX + date);
      const n = raw ? Number(raw) : 0;
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch (err) {
      console.warn("[gptLadderCallCount] storage error, falling back to file/memory:", err);
      return readGptLadderCallsFromFile(opts.file ?? gptLadderFile(), date, key);
    }
  }
  return readGptLadderCallsFromFile(opts.file ?? gptLadderFile(), date, key);
}

/**
 * Records one GPT ladder call for the day. DURABLE when `opts.storage` is supplied: uses the
 * ATOMIC `storage.increment` (a plain +1 counter, unlike the dollar guard - no cents math needed),
 * the exact same seam chargeDailySlot uses. Falls back to file/memory otherwise.
 */
export async function recordGptLadderCall(opts: { file?: string; dateKey?: string; storage?: GptLadderStorage } = {}): Promise<void> {
  const date = opts.dateKey ?? todayKey();
  const key = gptLadderCallsKey(date);

  if (opts.storage) {
    try {
      await opts.storage.increment(GPT_CALLS_PREFIX + date);
      return;
    } catch (err) {
      console.warn("[recordGptLadderCall] storage error, falling back to file/memory:", err);
      // fall through to the file/memory path below
    }
  }

  const file = opts.file ?? gptLadderFile();
  const calls = readGptLadderCallsFromFile(file, date, key) + 1;
  memGptLadderCalls.set(key, calls);

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
 * cap, call count, and whether the budget currently allows another ladder call. Composes the
 * existing budget check + call-count peek; makes NO writes and spends nothing.
 */
export async function getGptLadderStatus(
  opts: { capUsd?: number; file?: string; dateKey?: string; worstCaseUsd?: number; storage?: GptLadderStorage } = {}
): Promise<{ spentUsd: number; capUsd: number; calls: number; allowed: boolean }> {
  const budget = await checkGptLadderBudget(opts);
  const calls = await gptLadderCallCount(opts);
  return { spentUsd: budget.spentUsd, capUsd: budget.capUsd, calls, allowed: budget.allowed };
}

/** Test-only: clear in-memory state between cases. */
export function __resetForTest(): void {
  ipBuckets.clear();
  memDaily = null;
  memGptLadder.clear();
  memGptLadderCalls.clear();
}
