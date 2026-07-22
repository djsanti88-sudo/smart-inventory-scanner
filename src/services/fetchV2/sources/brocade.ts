// Brocade.io structured source (free, no API key). Keyed by GTIN = strong barcode association.
// Same shape/contract as the Open Food Facts source (scripts/fetchv2-benchmark.mts:180-203):
// a StructuredHit or null. Pure module - network is injected (fetchImpl DI); never touches
// globalThis.fetch implicitly beyond the default. 404 / malformed / network error all -> null.
import type { StructuredHit } from "../index";

/**
 * Look up a barcode against brocade.io's free items API.
 * Picks the first 12-14 digit variant, GETs https://www.brocade.io/api/items/<gtin>
 * (free, no key), 6s timeout, and maps { gtin, name, brand_name } into a StructuredHit.
 * Returns null on 404, malformed/non-JSON body, or any network/timeout error.
 */
export async function brocadeLookup(
  variants: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<StructuredHit | null> {
  const gtin = variants.find((v) => /^\d{12,14}$/.test(v));
  if (!gtin) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetchImpl(`https://www.brocade.io/api/items/${gtin}`, {
      headers: { "User-Agent": "SmartInventoryScanner-FetchV2/1.0" },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return null; // 404 and any non-2xx -> not found
    const d = (await res.json()) as { gtin?: string; name?: string; brand_name?: string };
    if (!d?.name) return null;
    return {
      url: `https://www.brocade.io/products/${d.gtin ?? gtin}`,
      name: String(d.name),
      brand: String(d.brand_name ?? "").trim(),
      matchedBarcode: String(d.gtin ?? gtin),
      quality: "medium",
    };
  } catch {
    return null;
  }
}
