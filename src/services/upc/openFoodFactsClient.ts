// Pure Open Food Facts REST wrapper with typed outcomes.
//
// FREE RUNG (Task 3.4, 2026-07-12 plan): keyless, ODbL-licensed live API.
//  - GET https://world.openfoodfacts.org/api/v2/product/<gtin>.json
//  - No API key (keyless public API).
//  - REQUIRES a descriptive User-Agent per OFF API guidelines (verified against
//    openfoodfacts.github.io/openfoodfacts-server/api/ - format "AppName/Version (ContactEmail)").
//  - Default 5s timeout via AbortSignal.timeout.
//  - `product.product_name` + `brands` + `categories_tags[0]` map to identity; everything else
//    (nutrition, ingredients, prices) is intentionally IGNORED - this is a suggestion-only free
//    rung, never a nutrition/pricing source.
//
// This module is PURE: it reads no environment variables and imports nothing from server/. The
// fetch implementation is injected by the caller, so the same code runs identically under test
// (mocked fetchImpl) and in the server rung.

export type OpenFoodFactsOutcome =
  | { kind: "hit"; product: OpenFoodFactsProduct; raw: unknown }
  | { kind: "miss" } // status 0 (not found) or 404: genuine not-in-DB
  | { kind: "bad_format" } // 400
  | { kind: "quota" } // 429: throttle hit at the provider itself
  | { kind: "transient"; detail: string }; // timeout / 5xx / malformed JSON

export interface OpenFoodFactsProduct {
  name: string;
  brand: string;
  category: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

const OFF_BASE = "https://world.openfoodfacts.org/api/v2/product";
const DEFAULT_TIMEOUT_MS = 5_000;

/** Required per OFF API guidelines: a descriptive User-Agent identifying the app + a contact. */
export const OFF_USER_AGENT = "SmartInventoryScanner/1.0 (djsanti88@gmail.com)";

function firstBrand(brandsField: unknown): string {
  const s = str(brandsField);
  if (!s) return "";
  // OFF's `brands` field is a comma-separated string (e.g. "Danone,Activia"); the first is primary.
  return s.split(",")[0]?.trim() ?? "";
}

function firstCategory(tags: unknown): string {
  if (!Array.isArray(tags) || tags.length === 0) return "";
  const raw = str(tags[0]);
  // OFF category tags look like "en:dairies" - strip the language prefix for a clean display value.
  const idx = raw.indexOf(":");
  return idx >= 0 ? raw.slice(idx + 1) : raw;
}

function toProduct(raw: unknown): OpenFoodFactsProduct {
  const p = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  return {
    name: str(p.product_name),
    brand: firstBrand(p.brands),
    category: firstCategory(p.categories_tags),
  };
}

export async function openFoodFactsLookup(
  code: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<OpenFoodFactsOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${OFF_BASE}/${encodeURIComponent(code)}.json`;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: { "User-Agent": OFF_USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { kind: "transient", detail };
  }

  switch (res.status) {
    case 404:
      return { kind: "miss" };
    case 400:
      return { kind: "bad_format" };
    case 429:
      return { kind: "quota" };
  }

  if (res.status < 200 || res.status >= 300) {
    return { kind: "transient", detail: `http ${res.status}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    const detail = err instanceof Error ? `malformed JSON: ${err.message}` : "malformed JSON";
    return { kind: "transient", detail };
  }

  const obj = (body && typeof body === "object" ? (body as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  // OFF's v2 API returns `status: 0` (not `1`) for a genuine miss, with HTTP 200 either way.
  const statusOk = obj.status === 1;
  const rawProduct = obj.product;
  if (!statusOk || !rawProduct || typeof rawProduct !== "object") {
    return { kind: "miss" };
  }
  const product = toProduct(rawProduct);
  if (!product.name) {
    // A product record with no usable name is not an identity worth surfacing.
    return { kind: "miss" };
  }
  return { kind: "hit", product, raw: body };
}
