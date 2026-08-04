const TRUSTED_EXACT_MEMBERSHIP_TTL_MS = 30_000;
const TRUSTED_EXACT_MEMBERSHIP_CACHE_MAX = 1_024;
const trustedExactMembershipCache = new Map<string, number>();

function keyFor(uid: string, businessId: string): string {
  return `${uid}\u0000${businessId}`;
}

export function hasCachedTrustedExactMembership(uid: string, businessId: string, at: number): boolean {
  const key = keyFor(uid, businessId);
  const expiresAt = trustedExactMembershipCache.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt > at) return true;
  trustedExactMembershipCache.delete(key);
  return false;
}

export function cacheTrustedExactMembership(uid: string, businessId: string, at: number): void {
  if (trustedExactMembershipCache.size >= TRUSTED_EXACT_MEMBERSHIP_CACHE_MAX) {
    for (const [key, expiresAt] of trustedExactMembershipCache) {
      if (expiresAt <= at) trustedExactMembershipCache.delete(key);
    }
    if (trustedExactMembershipCache.size >= TRUSTED_EXACT_MEMBERSHIP_CACHE_MAX) {
      const oldestKey = trustedExactMembershipCache.keys().next().value as string | undefined;
      if (oldestKey !== undefined) trustedExactMembershipCache.delete(oldestKey);
    }
  }
  trustedExactMembershipCache.set(keyFor(uid, businessId), at + TRUSTED_EXACT_MEMBERSHIP_TTL_MS);
}

/** Test isolation only; production membership entries remain process-local and expire after 30 seconds. */
export function resetTrustedExactMembershipCacheForTests(): void {
  trustedExactMembershipCache.clear();
}
