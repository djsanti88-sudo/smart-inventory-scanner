export interface TrustedExactMembershipCacheOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  maxInFlight?: number;
}

interface PositiveEntry {
  expiresAt: number;
}

const MAX_TTL_MS = 30_000;
const MAX_ENTRIES = 2_000;

/**
 * Per-process cache for a verified Firebase identity's positive business membership.
 * It deliberately stores only the uid/business key and expiry: never a token, code, or email.
 * Authorization still verifies the Firebase token on every request before consulting this cache.
 */
export class TrustedExactMembershipCache {
  private readonly positive = new Map<string, PositiveEntry>();
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxInFlight: number;

  constructor(options: TrustedExactMembershipCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.min(MAX_TTL_MS, Math.max(0, options.ttlMs ?? MAX_TTL_MS));
    this.maxEntries = Math.min(MAX_ENTRIES, Math.max(1, Math.floor(options.maxEntries ?? MAX_ENTRIES)));
    this.maxInFlight = Math.min(MAX_ENTRIES, Math.max(1, Math.floor(options.maxInFlight ?? MAX_ENTRIES)));
  }

  get size(): number {
    return this.positive.size;
  }

  clear(): void {
    this.positive.clear();
    this.inFlight.clear();
  }

  async get(uid: string, businessId: string, readMembership: () => Promise<boolean>): Promise<boolean> {
    const key = `${uid}\u0000${businessId}`;
    const current = this.positive.get(key);
    const now = this.now();
    if (current && current.expiresAt > now) {
      this.positive.delete(key);
      this.positive.set(key, current);
      return true;
    }
    if (current) this.positive.delete(key);

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    // Fail closed during a high-cardinality membership-read pileup. Never evict an unrelated
    // authorization check or start an unbounded Firestore read: the caller receives `false` and can
    // retry on a later request. Same-identity requests above still coalesce before this guard.
    if (this.inFlight.size >= this.maxInFlight) return false;

    const lookup = (async () => {
      const member = await readMembership();
      if (member) {
        this.positive.set(key, { expiresAt: this.now() + this.ttlMs });
        this.bound();
      }
      return member;
    })();
    this.inFlight.set(key, lookup);
    try {
      return await lookup;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private bound(): void {
    while (this.positive.size > this.maxEntries) {
      const oldest = this.positive.keys().next().value;
      if (typeof oldest !== "string") return;
      this.positive.delete(oldest);
    }
  }
}

export const trustedExactMembershipCache = new TrustedExactMembershipCache();

export function __resetTrustedExactMembershipCacheForTest(): void {
  trustedExactMembershipCache.clear();
}
