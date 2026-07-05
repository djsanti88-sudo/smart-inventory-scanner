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
  try {
    fs.writeFileSync(file, JSON.stringify(state));
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
  const file = opts.file ?? counterFile();
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
 * `gptLadderUsd:<dateKey>` in the same counter file as the daily call cap; extends rather than
 * forks that file's read/write pattern.
 */
export function recordGptLadderSpend(usd: number, opts: { file?: string; dateKey?: string } = {}): void {
  const file = opts.file ?? counterFile();
  const date = opts.dateKey ?? todayKey();
  const key = gptLadderKey(date);

  const existing = checkGptLadderBudget({ file, dateKey: date, capUsd: Infinity, worstCaseUsd: 0 });
  const spentUsd = Math.round((existing.spentUsd + usd) * 100) / 100;
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

/** Test-only: clear in-memory state between cases. */
export function __resetForTest(): void {
  ipBuckets.clear();
  memDaily = null;
  memGptLadder.clear();
}
