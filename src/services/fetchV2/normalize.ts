// THE consolidated safe-variant generator for Fetch V2 (single home for logic previously duplicated
// across evidenceVerifier/pageFetch/verifyCodeOnPage/retailKnowledgeIndex/barcodeDbProvider).
// Rule: never over-normalize - two different real codes must never share a primary.
import type { FetchV2IdType, NormalizedValues } from "./types";

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|msclkid|ref$|ref_|mc_)/i;
const UPPER_TYPES = new Set<FetchV2IdType>(["asin", "fnsku_like", "vendor_sku"]);

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hostname = u.hostname.toLowerCase();
    u.protocol = u.protocol.toLowerCase();
    u.hash = "";
    const keep: [string, string][] = [];
    u.searchParams.forEach((v, k) => { if (!TRACKING_PARAMS.test(k)) keep.push([k, v]); });
    u.search = "";
    for (const [k, v] of keep.sort((a, b) => a[0].localeCompare(b[0]))) u.searchParams.append(k, v);
    let s = u.toString();
    if (u.pathname !== "/" && s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

export function normalizeVariants(raw: string, idType: FetchV2IdType): NormalizedValues {
  const trimmed = (raw ?? "").trim();
  const empty: NormalizedValues = { primary: trimmed, upcA: "", ean13: "", gtin14: "", withoutSeparators: "", all: trimmed ? [trimmed] : [] };
  if (!trimmed) return { ...empty, primary: "", all: [] };

  if (idType === "url") {
    const primary = normalizeUrl(trimmed);
    return { primary, upcA: "", ean13: "", gtin14: "", withoutSeparators: primary, all: [primary] };
  }

  const withoutSeparators = trimmed.replace(/[\s\-_.]/g, "");
  const upper = UPPER_TYPES.has(idType) ? withoutSeparators.toUpperCase() : withoutSeparators;
  const digits = withoutSeparators.replace(/\D/g, "");
  const isPublic = idType === "upc_a" || idType === "ean_13" || idType === "gtin_14";

  let upcA = "", ean13 = "", gtin14 = "";
  if (isPublic && digits.length >= 12 && digits.length <= 14) {
    const g14 = digits.padStart(14, "0");
    gtin14 = g14;
    ean13 = g14.slice(1);
    // A 13/14-digit code only "contains" a UPC-A when its extra leading digits are zeros.
    upcA = g14.startsWith("00") ? g14.slice(2) : "";
    if (digits.length === 12) upcA = digits;
  }

  const stripped = isPublic && digits.length >= 12 ? digits.replace(/^0+/, "") : "";
  const primary = UPPER_TYPES.has(idType) ? upper : withoutSeparators;
  const all = [primary, upcA, ean13, gtin14, stripped.length >= 8 ? stripped : ""].filter(
    (v, i, arr) => v && arr.indexOf(v) === i,
  );
  return { primary, upcA, ean13, gtin14, withoutSeparators: primary === upper ? upper : withoutSeparators, all };
}
