// Pluggable discovery providers (candidate URLs ONLY - never proof). Brave default, Firecrawl
// search fallback, per the 2026-07-04 shootout. Every call is wrapped in an abort timeout
// (lesson from the shootout: one un-timed scrape hung 314s). Providers NEVER throw into the
// scan flow - any failure resolves to [].

export interface DiscoveryCandidate {
  url: string;
  title: string;
  snippet: string;
  rank: number;
}

export interface DiscoveryProvider {
  name: string;
  search(code: string): Promise<DiscoveryCandidate[]>;
}

export type MinimalFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const DEFAULT_TIMEOUT_MS = 6000;

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>, fallback: T): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

type RawHit = { url?: string; title?: string; description?: string };

function toCandidates(hits: RawHit[]): DiscoveryCandidate[] {
  return hits
    .map((r, rank) => ({ url: String(r.url ?? ""), title: String(r.title ?? ""), snippet: String(r.description ?? ""), rank }))
    .filter((c) => c.url);
}

export function braveProvider(deps: { apiKey: string; fetchImpl: MinimalFetch; timeoutMs?: number; retryDelayMs?: number }): DiscoveryProvider {
  const query = (q: string, signal: AbortSignal) =>
    deps
      .fetchImpl(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=10`, {
        method: "GET",
        headers: { Accept: "application/json", "X-Subscription-Token": deps.apiKey },
        signal,
      })
      .then(async (res) => {
        if (!res.ok) return [] as RawHit[];
        const d = (await res.json()) as { web?: { results?: RawHit[] } };
        return d.web?.results ?? [];
      });
  return {
    name: "brave",
    search: (code) =>
      withTimeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, async (signal) => {
        // The search query is the web engine's "prompt": a bare code sometimes returns nothing
        // (result variance) or junk for short vendor codes. One contextual retry fixes both cheaply.
        // The retry is PACED - Brave's free tier allows 1 req/s and an instant retry gets a 429
        // (live bug: the 429 cascade ate the whole per-code time budget).
        let hits = await query(code, signal);
        if (hits.length === 0) {
          await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 1100));
          hits = await query(`${code} barcode`, signal);
        }
        return toCandidates(hits);
      }, []),
  };
}

export function firecrawlSearchProvider(deps: { apiKeys: string[]; fetchImpl: MinimalFetch; timeoutMs?: number; retryDelayMs?: number }): DiscoveryProvider {
  return {
    name: "firecrawl",
    search: (code) =>
      withTimeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, async (signal) => {
        // Two passes: 429s during batch bursts are TRANSIENT, not dead keys - one paced retry
        // recovers them (live bug: a burst-rate-limited escalation silently returned [] and the
        // code graded "unknown" while the answer existed).
        let sawRateLimit = false;
        for (let pass = 0; pass < 2; pass++) {
          if (pass === 1) {
            if (!sawRateLimit) return [];
            await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 1500));
          }
          for (const key of deps.apiKeys.filter(Boolean)) {
            const res = await deps.fetchImpl("https://api.firecrawl.dev/v2/search", {
              method: "POST",
              headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
              body: JSON.stringify({ query: code, limit: 8 }),
              signal,
            });
            if (res.status === 429) { sawRateLimit = true; continue; }
            if (res.status === 402) continue; // truly out of credits: rotate
            if (!res.ok) return [];
            const d = (await res.json()) as { data?: { web?: RawHit[] } | RawHit[] };
            const web = (Array.isArray(d?.data) ? d?.data : (d?.data as { web?: RawHit[] })?.web) ?? [];
            return toCandidates(web);
          }
        }
        return [];
      }, []),
  };
}
