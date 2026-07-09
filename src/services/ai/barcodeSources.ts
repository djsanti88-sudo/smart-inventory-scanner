// Broad tiered pool of LEGITIMATE barcode/product databases (owner: "as broad as possible,
// legit sites only", 2026-07-04). A per-code selector picks the best ~8 by code type so
// breadth never costs latency. Trust rules are unchanged: these URLs are candidate FETCH
// targets; a page only counts when the exact code appears in real page text (EvidenceVerifier),
// and the not-found / recycled-UPC guards in pageFetch apply to every host.

export type SourceTier = "us" | "intl" | "case" | "generic";

export interface BarcodeSource {
  host: string;
  tiers: SourceTier[];
  url: (raw: string, gtin13: string, gtin14: string) => string;
}

export const BARCODE_SOURCES: BarcodeSource[] = [
  { host: "go-upc.com", tiers: ["us", "case", "generic"], url: (raw) => `https://go-upc.com/search?q=${encodeURIComponent(raw)}` },
  { host: "meros.io", tiers: ["us", "generic"], url: (raw) => `https://meros.io/${encodeURIComponent(raw)}` },
  { host: "upcitemdb.com", tiers: ["us", "case", "generic"], url: (raw) => `https://www.upcitemdb.com/upc/${encodeURIComponent(raw)}` },
  { host: "barcodelookup.com", tiers: ["us", "generic"], url: (raw) => `https://www.barcodelookup.com/${encodeURIComponent(raw)}` },
  { host: "buycott.com", tiers: ["us"], url: (raw) => `https://www.buycott.com/upc/${encodeURIComponent(raw)}` },
  { host: "barcodesdatabase.org", tiers: ["us", "generic"], url: (_r, g13) => `https://barcodesdatabase.org/barcode/${g13}` },
  { host: "barcodespider.com", tiers: ["us"], url: (raw) => `https://www.barcodespider.com/${encodeURIComponent(raw)}` },
  { host: "ean-search.org", tiers: ["intl", "case", "generic"], url: (_r, g13) => `https://www.ean-search.org/?q=${g13}` },
  { host: "eandata.com", tiers: ["intl"], url: (_r, g13) => `https://eandata.com/feed/?v=3&keycode=&mode=json&find=${g13}` },
  { host: "world.openfoodfacts.org", tiers: ["intl", "us", "case"], url: (_r, g13) => `https://world.openfoodfacts.org/api/v2/product/${g13}.json` },
  { host: "upcdatabase.org", tiers: ["us"], url: (raw) => `https://upcdatabase.org/code/${encodeURIComponent(raw)}` },
  { host: "barcode-list.com", tiers: ["intl"], url: (_r, g13) => `https://barcode-list.com/barcode/EN/Search.htm?barcode=${g13}` },
  { host: "opengtindb.org", tiers: ["intl"], url: (_r, g13) => `https://opengtindb.org/?ean=${g13}&cmd=query&queryid=400000000` },
  { host: "codecheck.info", tiers: ["intl"], url: (_r, g13) => `https://www.codecheck.info/product.search?q=${g13}` },
  { host: "brickseek.com", tiers: ["us"], url: (raw) => `https://brickseek.com/search?q=${encodeURIComponent(raw)}` },
  { host: "gtin.info", tiers: ["generic"], url: (_r, _g13, g14) => `https://gtin.info/check-digit-calculator/?gtin=${g14}` },
];

export function classifyGtin(code: string): "upc_us" | "ean_intl" | "gtin14" | "other" {
  const d = (code ?? "").replace(/\D/g, "");
  if (d.length !== (code ?? "").trim().length) {
    // non-digit characters present -> vendor/part-number shaped
    if (!/^\d+$/.test((code ?? "").trim())) return "other";
  }
  if (d.length === 14) return "gtin14";
  if (d.length === 12 || d.length === 11) return "upc_us";
  if (d.length === 13) return d.startsWith("0") ? "upc_us" : "ean_intl";
  return "other";
}

const TIER_ORDER: Record<ReturnType<typeof classifyGtin>, SourceTier[]> = {
  upc_us: ["us", "generic", "intl"],
  ean_intl: ["intl", "generic", "us"],
  gtin14: ["case", "generic", "us", "intl"],
  other: ["generic", "us"],
};

export function selectBarcodeUrls(code: string, max = 8): string[] {
  const raw = (code ?? "").trim();
  if (!raw) return [];
  const digits = raw.replace(/\D/g, "");
  if (!digits) return []; // pure vendor codes have no barcode-DB URL; the ladder uses AI-cited URLs instead
  const g13 = digits.padStart(13, "0").slice(-13);
  const g14 = digits.padStart(14, "0").slice(-14);
  const kind = classifyGtin(raw);
  const ordered: string[] = [];
  for (const tier of TIER_ORDER[kind]) {
    for (const s of BARCODE_SOURCES) {
      if (s.tiers.includes(tier)) ordered.push(s.url(raw, g13, g14));
    }
  }
  return [...new Set(ordered)].slice(0, max);
}
