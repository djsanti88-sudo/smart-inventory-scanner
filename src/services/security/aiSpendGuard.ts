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
  const limit = opts.limit ?? intEnv(process.env.AI_LOOKUP_RATE_LIMIT, 30);
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

/** Test-only: clear in-memory state between cases. */
export function __resetForTest(): void {
  ipBuckets.clear();
  memDaily = null;
}
