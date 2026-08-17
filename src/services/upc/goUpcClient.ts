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
  // 404. `confident` distinguishes a genuine provider answer (well-formed JSON body) from an
  // ambiguous one (empty/non-JSON body, indistinguishable from an outage/error page) - DC2-2
  // (2026-08-13): a bare 404 alone is not proof the code is really not in the provider's DB.
  // Omitted/undefined is treated as confident (legacy callers/tests that never set it).
  | { kind: "miss"; confident?: boolean } // 404: not-in-DB (confident) or ambiguous (not confident)
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
  deps: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal },
): Promise<GoUpcOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${GO_UPC_BASE}/${encodeURIComponent(code)}`;
  // DC-1 fix (2026-08-13): thread the ladder rung's externally-passed abort signal (when given) in
  // ALONGSIDE this function's own internal timeoutMs cap - same AbortSignal.any combinator pattern
  // gptFromScratch.ts/pageFetch.ts already use. By the time this actually fires, GoUpcGate.run has
  // already decided NOT to drop the call (see goUpcThrottle.ts), so a charge has already happened at
  // the caller; this only cancels the in-flight HTTP request itself if the ladder gives up mid-flight.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const fetchSignal = deps.signal ? AbortSignal.any([deps.signal, timeoutSignal]) : timeoutSignal;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${deps.apiKey}` },
      signal: fetchSignal,
    });
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { kind: "transient", detail };
  }

  switch (res.status) {
    case 404: {
      // DC2-2 (2026-08-13): read the body to tell a genuine "not found" answer from an ambiguous
      // one (empty body, non-JSON, unexpected shape - e.g. an outage page or a load-balancer error
      // fronting the real API). Only a body that actually parses as JSON counts as confident; the
      // parsed value itself is not otherwise inspected (Go-UPC's 404 error shape is not contractually
      // specified, so we don't guess at required fields - "it is JSON, not garbage" is the bar).
      try {
        await res.json();
        return { kind: "miss", confident: true };
      } catch {
        return { kind: "miss", confident: false };
      }
    }
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
