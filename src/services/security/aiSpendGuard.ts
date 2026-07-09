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

/** Per-IP fixed-window rate limit. Local-first (per process). */
export function checkRateLimit(
  ip: string,
  opts: { limit?: number; windowMs?: number; now?: number } = {}
): { allowed: boolean; retryAfterMs: number; remaining: number } {
  const limit = opts.limit ?? intEnv(process.env.AI_LOOKUP_RATE_LIMIT, 120);
  const windowMs = opts.windowMs ?? intEnv(process.env.AI_LOOKUP_RATE_WINDOW_MS, 60_000);
  const now = opts.now ?? Date.now();
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
  const limit = opts.limit ?? intEnv(process.env.AI_LOOKUP_DAILY_LIMIT, 200);
  const used = await storage.increment(DAILY_KEY_PREFIX + (opts.dateKey ?? todayKey()));
  return { used, limit };
}

/**
 * Hard daily cap. Increments and persists the day's count; once the limit is reached it returns
 * allowed:false so the caller makes ZERO provider calls. Resets automatically on a new date.
 */
export function checkAndIncrementDaily(
  opts: { limit?: number; file?: string; dateKey?: string } = {}
): { allowed: boolean; used: number; limit: number } {
  const limit = opts.limit ?? intEnv(process.env.AI_LOOKUP_DAILY_LIMIT, 200);
  const file = opts.file ?? counterFile();
  const date = opts.dateKey ?? todayKey();
  let state: DailyState | null = memDaily;
  if (!state || state.date !== date) {
    state = { date, count: 0 };
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && raw.date === date && typeof raw.count === "number") state = raw as DailyState;
    } catch {
      // no file yet / unreadable -> start fresh for today
    }
  }
  if (state.count >= limit) {
    memDaily = state;
    return { allowed: false, used: state.count, limit };
  }
  state.count++;
  memDaily = state;
  // Merge-write, not overwrite: this file is shared with other local-first guards (e.g. the GPT
  // ladder dollar guard below keeps its own `gptLadderUsd:<dateKey>` top-level key in the same
  // JSON document when a caller points both guards at the same file). A blind
  // `writeFileSync(file, JSON.stringify(state))` here would clobber those other keys on every
  // daily-counter increment. Read-modify-write instead: read whatever is on disk, tolerate a
  // corrupt or missing file by starting from {}, then only touch this guard's own `date`/`count`
  // keys.
  let onDisk: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object") onDisk = parsed as Record<string, unknown>;
  } catch {
    // no file yet / unreadable -> start fresh, do not lose other guards' keys we can't read anyway
  }
  onDisk.date = state.date;
  onDisk.count = state.count;
  try {
    fs.writeFileSync(file, JSON.stringify(onDisk));
  } catch {
    // best-effort persistence; in-memory still enforces within this process
  }
  return { allowed: true, used: state.count, limit };
}

/** Read-only peek used by the GET status endpoint (does not increment). */
export function dailyUsage(opts: { file?: string; dateKey?: string } = {}): DailyState {
  const file = opts.file ?? counterFile();
  const date = opts.dateKey ?? todayKey();
  if (memDaily && memDaily.date === date) return { ...memDaily };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && raw.date === date && typeof raw.count === "number") return raw as DailyState;
  } catch {
    // fall through
  }
  return { date, count: 0 };
}

type GptLadderState = { date: string; spentUsd: number };
const memGptLadder = new Map<string, GptLadderState>();

function gptLadderKey(dateKey: string): string {
  return `gptLadderUsd:${dateKey}`;
}

/**
 * Dedicated storage file for the GPT ladder dollar guard. Deliberately its OWN file (not
 * counterFile()'s `.ai-lookup-usage.json`), same directory-resolution pattern (env override,
 * else path.resolve of a dotfile in cwd). This guard used to piggyback on the daily-counter file
 * via an additive top-level key, but `checkAndIncrementDaily` writes that file with a plain
 * `JSON.stringify(state)` on every call once its in-memory state is warm - that overwrite
 * silently clobbered this guard's key on disk on essentially every decode request. A dedicated
 * file removes the shared-file hazard entirely; `checkAndIncrementDaily`'s write path is also
 * hardened to merge instead of overwrite as defense in depth for any caller that still points
 * both guards at the same file (e.g. via opts.file in tests).
 */
function gptLadderFile(): string {
  return process.env.AI_LOOKUP_GPT_LADDER_FILE || path.resolve(".gpt-ladder-usage.json");
}

/**
 * Daily DOLLAR guard for the paid GPT ladder rung. Same local-first pattern as
 * checkAndIncrementDaily (in-memory per process + best-effort JSON file persistence, same
 * serverless caveats: per-instance memory, possibly read-only FS on Vercel). The FILE is the
 * source of truth across "restarts" - checkGptLadderBudget always re-reads the file and takes
 * the max of file vs in-memory spend, so a fresh process picks up spend recorded before it started.
 */
export function checkGptLadderBudget(
  opts: { capUsd?: number; file?: string; dateKey?: string; worstCaseUsd?: number } = {}
): { allowed: boolean; spentUsd: number; capUsd: number } {
  const capUsd = opts.capUsd ?? Number(process.env.GPT_LADDER_DAILY_USD ?? 3);
  const worstCaseUsd = opts.worstCaseUsd ?? 0.39;
  const file = opts.file ?? gptLadderFile();
  const date = opts.dateKey ?? todayKey();
  const key = gptLadderKey(date);

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

  return { allowed: spentUsd + worstCaseUsd <= capUsd, spentUsd, capUsd };
}

/**
 * Records actual GPT ladder spend for the day. Best-effort JSON persistence under
 * `gptLadderUsd:<dateKey>` in this guard's own dedicated file (see gptLadderFile()) - kept
 * separate from the daily call-cap counter file so the two guards' writes can never clobber
 * each other.
 */
export function recordGptLadderSpend(usd: number, opts: { file?: string; dateKey?: string } = {}): void {
  const file = opts.file ?? gptLadderFile();
  const date = opts.dateKey ?? todayKey();
  const key = gptLadderKey(date);

  const existing = checkGptLadderBudget({ file, dateKey: date, capUsd: Infinity, worstCaseUsd: 0 });
  // Round to a TENTH OF A CENT (4 decimal places), not whole cents. A searchless GPT call can
  // cost as little as ~$0.003; rounding to 2 decimals would zero it out and permanently undercount
  // real spend against the daily dollar cap. Cost-truth rule: never undercount actual spend.
  const spentUsd = Math.round((existing.spentUsd + usd) * 10000) / 10000;
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

/**
 * Read-only peek at today's GPT ladder call count. Same file (gptLadderFile()), same
 * max-of-memory-vs-file pattern as checkGptLadderBudget, so a fresh process (memory cleared)
 * still sees calls recorded before it started, and a warm process never regresses below what
 * it already knows.
 */
function gptLadderCallCount(opts: { file?: string; dateKey?: string } = {}): number {
  const file = opts.file ?? gptLadderFile();
  const date = opts.dateKey ?? todayKey();
  const key = gptLadderCallsKey(date);

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
 * Records one GPT ladder call for the day. Lives in the SAME dedicated file as the dollar spend
 * guard (gptLadderFile()), under its OWN top-level key (`gptLadderCalls:<dateKey>`), so the two
 * counters can never clobber each other. Merge-write, not overwrite: read whatever is on disk
 * (tolerating a missing/corrupt file), touch only this key, write the whole document back - the
 * same defense used by recordGptLadderSpend and checkAndIncrementDaily after the earlier clobber bug.
 */
export function recordGptLadderCall(opts: { file?: string; dateKey?: string } = {}): void {
  const file = opts.file ?? gptLadderFile();
  const date = opts.dateKey ?? todayKey();
  const key = gptLadderCallsKey(date);

  const calls = gptLadderCallCount({ file, dateKey: date }) + 1;
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
export function getGptLadderStatus(
  opts: { capUsd?: number; file?: string; dateKey?: string; worstCaseUsd?: number } = {}
): { spentUsd: number; capUsd: number; calls: number; allowed: boolean } {
  const budget = checkGptLadderBudget(opts);
  const calls = gptLadderCallCount(opts);
  return { spentUsd: budget.spentUsd, capUsd: budget.capUsd, calls, allowed: budget.allowed };
}

/** Test-only: clear in-memory state between cases. */
export function __resetForTest(): void {
  ipBuckets.clear();
  memDaily = null;
  memGptLadder.clear();
  memGptLadderCalls.clear();
}
