import "server-only";

import { NextResponse } from "next/server";
import { checkRateLimit, intEnv } from "@/services/security/aiSpendGuard";
import { logServerEvent } from "@/server/log";

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
    const { COLLECTIONS } = await import("@/services/db/types");
    await withTimeout(getAdminDb().collection(COLLECTIONS.catalogEntries).limit(1).get(), timeoutMs);
    return true;
  } catch {
    // Never leak the underlying error (connection string, credential detail) to the caller -
    // this is an untrusted, unauthenticated endpoint. Server-side log only.
    logServerEvent({ route: "/api/health", event: "firestore_unreachable", reasonCode: "firestore_error", status: 200 });
    return false;
  }
}

/** Cheap Turso/ladder-storage reachability check with a short timeout. Never throws - degrades to false. */
async function checkTurso(): Promise<boolean> {
  const timeoutMs = intEnv(process.env.HEALTH_TURSO_TIMEOUT_MS, 3000);
  try {
    const { ladderStorage } = await import("@/server/upc/storage");
    const storage = await withTimeout(ladderStorage(), timeoutMs);
    await withTimeout(storage.get("__health_check__"), timeoutMs);
    return true;
  } catch {
    logServerEvent({ route: "/api/health", event: "turso_unreachable", reasonCode: "turso_error", status: 200 });
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

  // aiKeys: presence-only signal for the core paid decode providers (Gemini/OpenAI). Advisory,
  // not critical - the app functions in mock/degraded mode without them, so it never flips `ok`.
  const aiKeys = Boolean(process.env.GEMINI_API_KEY) || Boolean(process.env.OPENAI_API_KEY);

  // ok reflects only the CRITICAL checks (data reachability). Missing provider keys or other
  // advisory config never flip ok to false - the app is designed to degrade gracefully there.
  const ok = firestore && turso;

  return json(
    {
      ok,
      firestore,
      turso,
      aiKeys,
      // Short build identifier only, never a secret. Vercel sets VERCEL_GIT_COMMIT_SHA
      // automatically; GIT_COMMIT_SHA is an optional manual override for non-Vercel hosts.
      version: (process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "dev").slice(0, 40),
      timestamp: new Date().toISOString(),
    },
    200
  );
}
