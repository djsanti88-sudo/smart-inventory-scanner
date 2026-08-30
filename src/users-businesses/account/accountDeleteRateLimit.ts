import "server-only";

// Firestore-backed rate limiter for the account-deletion route (D2). Deliberately decoupled from
// the decoder's Turso/libsql storage (`src/server/decode/storage.ts`): account deletion is a
// GDPR/CCPA erasure obligation, and the decode cache DB being down or missing its env vars must
// never 503 an unrelated, irreversible-action route. This limiter shares the SAME failure domain
// as the deletion operation itself - the Firestore Admin SDK, which the route already requires to
// authenticate the caller, verify membership/role, and perform the delete. "Limiter down" now
// means "Firestore is down", which is exactly "deletion is impossible anyway" - the correct
// coupling.
//
// Fixed-window semantics, same shape as aiSpendGuard.checkRateLimit's storage-backed path: one doc
// per key at `_rateLimits/{key}` holding { windowStart, count }. A Firestore transaction makes the
// read-check-increment atomic across concurrent requests (no separate read-then-write race). Like
// the storage-backed checkRateLimit, a request that will be REJECTED still increments the counter
// (the limiter's job is to count attempts, including abusive ones) and `resetAt` is derived from
// the stored windowStart rather than persisted separately.
//
// `_rateLimits` is Admin-SDK-only: firestore.rules has no explicit rule opening this collection, so
// the default-deny catch-all (`match /{document=**} { allow read, write: if false; }`) covers it -
// no client (and no security rule change) can read or write these documents.
import { getAdminDb } from "@/lib/firebaseAdmin";

const COLLECTION = "_rateLimits";

export interface AccountDeleteRateLimitOptions {
  limit?: number;
  windowMs?: number;
  now?: number;
}

export interface AccountDeleteRateLimitDeps {
  db?: FirebaseFirestore.Firestore;
}

export interface AccountDeleteRateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
}

type RateLimitDocData = { windowStart?: number; count?: number };

/**
 * Atomically checks + records one attempt against a fixed-window limit (default 3/hour, matching
 * the route's prior default). Fails CLOSED on any Firestore error - the error propagates to the
 * caller rather than being swallowed, so route.ts's existing try/catch still turns a Firestore
 * outage into a 503 and refuses the irreversible delete rather than allowing an unmetered one.
 */
export async function checkAccountDeleteRateLimit(
  key: string,
  opts: AccountDeleteRateLimitOptions = {},
  deps: AccountDeleteRateLimitDeps = {},
): Promise<AccountDeleteRateLimitResult> {
  const limit = opts.limit ?? 3;
  const windowMs = opts.windowMs ?? 3_600_000;
  const now = opts.now ?? Date.now();
  const db = deps.db ?? getAdminDb();
  const ref = db.collection(COLLECTION).doc(key);

  return db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? ((snap.data() as RateLimitDocData | undefined) ?? {}) : {};

    const windowExpired =
      typeof data.windowStart !== "number" || now >= data.windowStart + windowMs;
    const windowStart = windowExpired ? now : data.windowStart!;
    const priorCount = windowExpired ? 0 : (data.count ?? 0);
    const count = priorCount + 1;
    const resetAt = windowStart + windowMs;

    tx.set(ref, { windowStart, count, updatedAt: new Date(now).toISOString() });

    if (count > limit) {
      return { allowed: false, retryAfterMs: Math.max(0, resetAt - now), remaining: 0 };
    }
    return { allowed: true, retryAfterMs: 0, remaining: Math.max(0, limit - count) };
  });
}
