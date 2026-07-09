// Discount Tire harvest: pure batch-selection helpers (Task 5 Step 1's pure parts).
// No I/O, no Playwright, no network - safe to unit test directly. The resumable batch
// driver (run-batch.mjs) uses these to decide which urls to fetch this run.

/**
 * Select up to `limit` urls from `urls` that are not already marked done, optionally
 * restricted to one deterministic shard of a sharded parallel run.
 *
 * Shard partitioning: url at index i belongs to shard k of n iff i % n === k (0-based).
 * Applying the shard filter BEFORE the done-skip and the limit cap keeps partitioning
 * deterministic across workers regardless of how much of the corpus is already done.
 *
 * @param {string[]} urls - the full discovered url list, in stable order.
 * @param {Record<string, true> | undefined} done - map of url -> true for completed urls.
 * @param {{ limit: number, shard?: { k: number, n: number } }} options
 * @returns {string[]}
 */
export function selectUrls(urls, done, { limit, shard } = {}) {
  if (!Array.isArray(urls) || urls.length === 0) return [];
  if (!Number.isFinite(limit) || limit <= 0) return [];

  const doneMap = done || {};
  const selected = [];

  for (let i = 0; i < urls.length; i++) {
    if (shard && i % shard.n !== shard.k) continue;
    const url = urls[i];
    if (doneMap[url]) continue;
    selected.push(url);
    if (selected.length >= limit) break;
  }

  return selected;
}

const ALLOWED_HOSTS = new Set(["discounttire.com", "www.discounttire.com"]);

/**
 * Hard host allowlist: only https:// discounttire.com or www.discounttire.com urls are
 * ever fetched. Rejects lookalike hosts (discounttire.com.evil.com, notdiscounttire.com),
 * other subdomains, http (non-https), and malformed input - never throws.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function hostAllowed(url) {
  if (typeof url !== "string" || url.length === 0) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}
