// Source trust policy. ONE configurable place to classify a source URL into a tier. Pure, no I/O -
// it only inspects URLs the decode response already returned, so it adds zero latency / no extra calls.
//
// Tier 1 authoritative : official registries / GS1 / manufacturer-grade.
// Tier 2 strong commercial : major retailers / marketplaces / distributors.
// Tier 3 supporting : barcode-lookup DBs, generic UPC sites, unknown hosts (default).
// Tier 4 weak : junk pages (search/cart/login/category), SEO barcode pages, hostless/garbage.

export type SourceTier = "authoritative" | "strong_commercial" | "supporting" | "weak";

export const TIER_RANK: Record<SourceTier, number> = {
  authoritative: 4,
  strong_commercial: 3,
  supporting: 2,
  weak: 1,
};

// --- Configurable host lists (edit here, not scattered across files) ---
export const TIER1_HOSTS = ["gs1.org", "gepir.gs1.org", "gtin.info", "gdsn.gs1.org"];
export const TIER2_HOSTS = [
  "amazon.", "walmart.", "target.", "homedepot.", "lowes.", "bestbuy.", "costco.", "ebay.",
  "kroger.", "walgreens.", "cvs.", "samsclub.", "chewy.", "macys.", "wayfair.", "newegg.",
];
export const TIER3_HOSTS = [
  "go-upc", "upcitemdb", "barcodelookup", "barcodespider", "eandata", "buycott", "barcodesdatabase",
  "barcode", "upc", "ean-search", "gtin",
];

const JUNK_PATH = /\/(search|results?|cart|basket|checkout|login|signin|sign-in|account|register|tag|tags|category|categories|collections?|c|s)(\/|$|\?)/i;
const JUNK_QUERY = /[?&](q|search|query|keyword|term)=/i;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    const m = url.match(/^[a-z]+:\/\/([^/]+)/i);
    return (m?.[1] ?? "").toLowerCase();
  }
}

/** A search/cart/login/category/SEO page is never trustworthy regardless of host. */
export function isJunkSourceUrl(url: string): boolean {
  if (!url || !hostOf(url)) return true;
  return JUNK_PATH.test(url) || JUNK_QUERY.test(url);
}

function hostMatches(host: string, needles: string[]): boolean {
  return needles.some((n) => (n.endsWith(".") ? host.includes(n) : host === n || host.endsWith("." + n) || host.includes(n)));
}

export function classifySource(url: string): SourceTier {
  const host = hostOf(url);
  if (!host) return "weak";
  if (TIER1_HOSTS.some((t) => host === t || host.endsWith("." + t))) return "authoritative";
  // Barcode databases expose products at "/search?q=<code>"-style URLs (e.g. go-upc), so the
  // junk-path heuristic must NOT demote a known barcode-DB host. They are always "supporting".
  if (hostMatches(host, TIER3_HOSTS)) return "supporting";
  if (hostMatches(host, TIER2_HOSTS)) return isJunkSourceUrl(url) ? "weak" : "strong_commercial";
  if (isJunkSourceUrl(url)) return "weak";
  // Unknown host: treat as Tier 3 (supporting), never authoritative (policy rule #5).
  return "supporting";
}

/** Highest (most trusted) tier among the given source URLs. Empty -> weak. */
export function bestTier(urls: string[]): SourceTier {
  let best: SourceTier = "weak";
  for (const u of urls) {
    const t = classifySource(u);
    if (TIER_RANK[t] > TIER_RANK[best]) best = t;
  }
  return best;
}

export function isTrustedTier(tier: SourceTier): boolean {
  return tier === "authoritative" || tier === "strong_commercial";
}
