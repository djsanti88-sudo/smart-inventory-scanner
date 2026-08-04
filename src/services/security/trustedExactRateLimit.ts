export interface TrustedExactRateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

export interface TrustedExactRateLimiterOptions {
  limit?: number;
  windowMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  count: number;
  windowStartedAt: number;
}

export class TrustedExactRateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: TrustedExactRateLimiterOptions = {}) {
    this.limit = options.limit ?? 600;
    this.windowMs = options.windowMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 2_000;
    this.now = options.now ?? Date.now;
  }

  check(uid: string, businessId: string): TrustedExactRateLimitResult {
    const now = this.now();
    const key = `${uid}\u0000${businessId}`;
    const current = this.entries.get(key);
    const entry = !current || now - current.windowStartedAt >= this.windowMs
      ? { count: 0, windowStartedAt: now }
      : current;
    if (entry.count >= this.limit) {
      this.entries.set(key, entry);
      return { allowed: false, retryAfterMs: Math.max(1, this.windowMs - (now - entry.windowStartedAt)) };
    }
    entry.count += 1;
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
    return { allowed: true, retryAfterMs: 0 };
  }
}

export const trustedExactRateLimiter = new TrustedExactRateLimiter();
