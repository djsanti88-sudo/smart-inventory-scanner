// Pure Go-UPC REST wrapper with typed outcomes.
//
// Owner contract (plan Task 3, 2026-07-08):
//  - GET https://go-upc.com/api/v1/code/<encoded code>
//  - Authorization: Bearer header ONLY (never a key= query param).
//  - Default 10s timeout via AbortSignal.timeout.
//  - Status -> outcome mapping is exact (see below).
//  - The full parsed 200 body is preserved verbatim in hit.raw.
//
// This module is PURE: it reads no environment variables and imports nothing
// from server/. The API key and fetch implementation are injected by the caller,
// so the same code runs identically under test (mocked fetchImpl) and in the
// server rung that owns the real key + throttle.

export type GoUpcOutcome =
  | { kind: "hit"; inferred: boolean; product: GoUpcProduct; raw: unknown }
  | { kind: "miss" } // 404: genuine not-in-DB
  | { kind: "bad_format" } // 400
  | { kind: "auth_failed" } // 401
  | { kind: "quota" } // 429
  | { kind: "transient"; detail: string }; // timeout / 5xx / malformed JSON

export interface GoUpcProduct {
  name: string;
  brand: string;
  description: string;
  imageUrl: string;
  category: string;
  specs: [string, string][];
  upc?: string;
  ean?: string;
}

// Copied verbatim from gptFromScratch.ts:44 (owner-directed shared helper shape).
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

const GO_UPC_BASE = "https://go-upc.com/api/v1/code";
const DEFAULT_TIMEOUT_MS = 10_000;

function toSpecs(v: unknown): [string, string][] {
  if (!Array.isArray(v)) return [];
  const out: [string, string][] = [];
  for (const entry of v) {
    if (Array.isArray(entry) && entry.length >= 2) {
      out.push([str(entry[0]), str(entry[1])]);
    }
  }
  return out;
}

function toProduct(raw: unknown): GoUpcProduct {
  const p = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const product: GoUpcProduct = {
    name: str(p.name),
    brand: str(p.brand),
    description: str(p.description),
    imageUrl: str(p.imageUrl),
    category: str(p.category),
    specs: toSpecs(p.specs),
  };
  if (p.upc != null) product.upc = str(p.upc);
  if (p.ean != null) product.ean = str(p.ean);
  return product;
}

export async function goUpcLookup(
  code: string,
  deps: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<GoUpcOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${GO_UPC_BASE}/${encodeURIComponent(code)}`;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${deps.apiKey}` },
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
    case 401:
      return { kind: "auth_failed" };
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
  const inferred = obj.inferred === true;
  const product = toProduct(obj.product);
  return { kind: "hit", inferred, product, raw: body };
}
