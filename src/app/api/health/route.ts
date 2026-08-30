import "server-only";

import { NextResponse } from "next/server";
import { checkRateLimit, intEnv } from "@/decoding/limits/aiSpendGuard";
import { logServerEvent } from "@/decoding/server/log";
import { tireJsonIndexStatus } from "@/decoding/server/knowledge/tire/tireKnowledgeIndex";

// Public, unauthenticated uptime-monitor endpoint (spec: docs/superpowers/specs/2026-07-29-m1-
// engineering-specs.md section 4). Booleans-only JSON, no secrets, no keys, no URLs, no internal
// error messages - only presence/reachability. Every dependency check degrades to `false` on any
// error or timeout; this route must NEVER throw or 500 - a 200 with ok:false IS the signal an
// external monitor reads. Fast (<2s): each dependency check races a short timeout.

export const runtime = "nodejs"; // Admin SDK requires the Node runtime.
export const dynamic = "force-dynamic"; // health checks must never be cached/stale.

const HEALTH_RATE_LIMIT_DEFAULT = 60;

function json(body: unknown, init: number | ResponseInit): NextResponse {
  const resolved = typeof init === "number" ? { status: init } : init;
  return NextResponse.json(body, { ...resolved, headers: { ...resolved.headers, "Cache-Control": "no-store" } });
}

// Any run of 20+ token characters (alnum/-/_) is treated as secret-shaped and redacted outright -
// long enough that ordinary English/error words never hit it, but auth tokens, API keys, and JWTs
// reliably do. Credentials embedded in a URL (scheme://user:pass@host) are stripped first so the
// generic redaction below never needs to parse URL structure.
const SECRET_LIKE_TOKEN = /[A-Za-z0-9_-]{20,}/g;

/**
 * Bind a caught health-check error into a short, sanitized, human-readable detail string so an
 * on-call engineer can tell a config problem (bad credential, missing env var) apart from a
 * transient outage (ECONNREFUSED, ETIMEDOUT) from the log line alone - without ever leaking a
 * secret value. Never throws; always returns a string (log.ts truncates further to 200 chars).
 */
function sanitizeHealthError(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const noCreds = raw.replace(/:\/\/[^\s/]+@/g, "://[redacted]@");
  return noCreds.replace(SECRET_LIKE_TOKEN, "[redacted]");
}

/** Race a promise against a short timeout. Rejects (never hangs) if the timeout wins. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("health check timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** Cheap Firestore reachability check via the Admin SDK. Never throws - degrades to false. */
async function checkFirestore(): Promise<boolean> {
  const timeoutMs = intEnv(process.env.HEALTH_FIRESTORE_TIMEOUT_MS, 3000);
  try {
    const { getAdminDb } = await import("@/lib/firebaseAdmin");
    const { COLLECTIONS } = await import("@/sync-database/types");
    await withTimeout(getAdminDb().collection(COLLECTIONS.catalogEntries).limit(1).get(), timeoutMs);
    return true;
  } catch (err) {
    // Never leak the underlying error (connection string, credential detail) to the HTTP caller -
    // this is an untrusted, unauthenticated endpoint. The bound, sanitized detail goes server-side
    // log only, at ERROR severity: this failure always flips the overall `ok` to false, so it must
    // never quietly log as a routine warn just because the HTTP response itself stays 200.
    logServerEvent({
      route: "/api/health",
      event: "firestore_unreachable",
      reasonCode: "firestore_error",
      status: 200,
      severity: "error",
      detail: sanitizeHealthError(err),
    });
    return false;
  }
}

/** Cheap Turso decode-storage reachability check with a short timeout. Never throws - degrades to false. */
async function checkTurso(): Promise<boolean> {
  const timeoutMs = intEnv(process.env.HEALTH_TURSO_TIMEOUT_MS, 3000);
  try {
    const { decodeStorage } = await import("@/decoding/server/pipeline/storage");
    const storage = await withTimeout(decodeStorage(), timeoutMs);
    await withTimeout(storage.get("__health_check__"), timeoutMs);
    return true;
  } catch (err) {
    logServerEvent({
      route: "/api/health",
      event: "turso_unreachable",
      reasonCode: "turso_error",
      status: 200,
      severity: "error",
      detail: sanitizeHealthError(err),
    });
    return false;
  }
}

// GET reports reachability/config booleans only - never key values, connection strings, or raw
// error messages. No auth required (external uptime monitors cannot authenticate); rate-limited
// per IP so this public endpoint cannot be scraped/flooded unbounded.
export async function GET(request: Request): Promise<Response> {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local";
  try {
    const rl = await checkRateLimit(`HEALTH:${ip}`, { limit: intEnv(process.env.HEALTH_RATE_LIMIT, HEALTH_RATE_LIMIT_DEFAULT) });
    if (!rl.allowed) {
      logServerEvent({ route: "/api/health", event: "rate_limited", reasonCode: "rate_limited", status: 429 });
      return json(
        { error: "Too many requests. Slow down and try again." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
      );
    }
  } catch {
    // A rate-limiter fault must never take the health endpoint down - fall through unthrottled.
    logServerEvent({ route: "/api/health", event: "rate_limit_unavailable", reasonCode: "storage_error", status: 200 });
  }

  const [firestore, turso] = await Promise.all([checkFirestore(), checkTurso()]);

  // aiKeys: presence-only signal for the one paid decode provider. Advisory,
  // not critical - the app functions in mock/degraded mode without them, so it never flips `ok`.
  const aiKeys = Boolean(process.env.OPENAI_API_KEY);

  // ok reflects only the CRITICAL checks (data reachability). Missing provider keys or other
  // advisory config never flip ok to false - the app is designed to degrade gracefully there.
  const ok = firestore && turso;

  // Fix-wave 2026-08-04: this is a public, unauthenticated endpoint - tireJsonIndexStatus().message
  // carries raw exception text (a config problem or a bad file) that must never reach an external
  // caller. state/barcodeRows are safe presence/count signals; the full message stays server-side
  // only (tireJsonIndexStatus() itself is still available for server-side logging elsewhere).
  const tireStatus = tireJsonIndexStatus();

  return json(
    {
      ok,
      firestore,
      turso,
      aiKeys,
      tireJsonIndex: { state: tireStatus.state, barcodeRows: tireStatus.barcodeRows },
      // Short build identifier only, never a secret. Vercel sets VERCEL_GIT_COMMIT_SHA
      // automatically; GIT_COMMIT_SHA is an optional manual override for non-Vercel hosts.
      version: (process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "dev").slice(0, 40),
      timestamp: new Date().toISOString(),
    },
    200
  );
}
