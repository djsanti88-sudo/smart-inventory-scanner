import { createHash } from "node:crypto";

export interface TrustedExactAuthorization {
  uid: string;
  platformOwner: boolean;
  hasVerifiedMembership: boolean;
}

export interface TrustedExactAuthorizationCacheOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
}

interface Entry extends TrustedExactAuthorization {
  expiresAt: number;
}

const MAX_TTL_MS = 30_000;
const MAX_ENTRIES = 2_000;

/**
 * Briefly caches only successful live authorization decisions. Keys contain a SHA-256 token digest
 * plus the claimed business id; raw Firebase tokens are never retained and a different tenant can
 * never reuse the decision. The caller must cap tokenExpiresAtMs to the verified token's own expiry.
 */
export class TrustedExactAuthorizationCache {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: TrustedExactAuthorizationCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.min(MAX_TTL_MS, Math.max(0, options.ttlMs ?? MAX_TTL_MS));
    this.maxEntries = Math.min(MAX_ENTRIES, Math.max(1, Math.floor(options.maxEntries ?? MAX_ENTRIES)));
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  get(idToken: string, businessId: string): TrustedExactAuthorization | null {
    const key = this.key(idToken, businessId);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return {
      uid: entry.uid,
      platformOwner: entry.platformOwner,
      hasVerifiedMembership: entry.hasVerifiedMembership,
    };
  }

  set(
    idToken: string,
    businessId: string,
    authorization: TrustedExactAuthorization,
    tokenExpiresAtMs: number,
  ): void {
    const now = this.now();
    const expiresAt = Math.min(now + this.ttlMs, tokenExpiresAtMs);
    if (!idToken || !businessId || !authorization.uid || !Number.isFinite(expiresAt) || expiresAt <= now) return;
    const key = this.key(idToken, businessId);
    this.entries.delete(key);
    this.entries.set(key, { ...authorization, expiresAt });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
  }

  private key(idToken: string, businessId: string): string {
    return `${createHash("sha256").update(idToken).digest("hex")}\u0000${businessId}`;
  }
}

export const trustedExactAuthorizationCache = new TrustedExactAuthorizationCache();

export function __resetTrustedExactAuthorizationCacheForTest(): void {
  trustedExactAuthorizationCache.clear();
}
