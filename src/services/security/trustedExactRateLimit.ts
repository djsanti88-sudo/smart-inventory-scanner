export interface TrustedExactRateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

export interface TrustedExactRateLimitAnomaly {
  uid: string;
  businessId: string;
  retryAfterMs: number;
}

export interface TrustedExactRateLimiterOptions {
  limit?: number;
  windowMs?: number;
  maxEntries?: number;
  now?: () => number;
  onLimit?: (event: TrustedExactRateLimitAnomaly) => void;
}

interface Entry {
  count: number;
  windowStartedAt: number;
  touchedAt: number;
}

const DEFAULT_LIMIT = 600;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 2_000;

export function maskTrustedExactIdentifier(value: string): string {
  return value.length <= 3 ? "***" : `${value.slice(0, 3)}…${value.slice(-3)}`;
}

/**
 * Process-local defense in depth for the privileged trusted-exact path. Authorization remains the
 * boundary; this intentionally does not read storage or make network calls.
 */
export class TrustedExactRateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly onLimit?: (event: TrustedExactRateLimitAnomaly) => void;

  constructor(options: TrustedExactRateLimiterOptions = {}) {
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    this.onLimit = options.onLimit;
  }

  get size(): number {
    return this.entries.size;
  }

  check(uid: string, businessId: string): TrustedExactRateLimitResult {
    const now = this.now();
    this.expire(now);
    const key = `${uid}\u0000${businessId}`;
    const current = this.entries.get(key);
    const entry = !current || now - current.windowStartedAt >= this.windowMs
      ? { count: 0, windowStartedAt: now, touchedAt: now }
      : current;
    if (entry.count >= this.limit) {
      const retryAfterMs = Math.max(1, this.windowMs - (now - entry.windowStartedAt));
      entry.touchedAt = now;
      this.entries.set(key, entry);
      this.onLimit?.({
        uid: maskTrustedExactIdentifier(uid),
        businessId: maskTrustedExactIdentifier(businessId),
        retryAfterMs,
      });
      return { allowed: false, retryAfterMs };
    }
    entry.count += 1;
    entry.touchedAt = now;
    this.entries.set(key, entry);
    this.bound();
    return { allowed: true, retryAfterMs: 0 };
  }

  private expire(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.windowStartedAt >= this.windowMs) this.entries.delete(key);
    }
  }

  private bound(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") return;
      this.entries.delete(oldest);
    }
  }
}

export const trustedExactRateLimiter = new TrustedExactRateLimiter();
