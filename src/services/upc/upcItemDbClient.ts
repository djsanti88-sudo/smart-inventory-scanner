// Pure UPCitemdb REST wrapper with typed outcomes.
//
// FREE RUNG (Task 3.3, 2026-07-12 plan): keyless "trial" tier of UPCitemdb.
//  - GET https://api.upcitemdb.com/prod/trial/lookup?upc=<code>
//  - No API key / no Authorization header (keyless trial tier).
//  - Default 5s timeout via AbortSignal.timeout.
//  - Status -> outcome mapping mirrors goUpcClient.ts's shape for consistency.
//  - `items[0]` maps to identity; `offers` are intentionally IGNORED (brief: "offers ignored" -
//    this is a suggestion-only free rung, never a pricing source).
//
// This module is PURE: it reads no environment variables (the trial tier is keyless - there is no
// key to inject) and imports nothing from server/. The fetch implementation is injected by the
// caller, so the same code runs identically under test (mocked fetchImpl) and in the server rung.

export type UpcItemDbOutcome =
  | { kind: "hit"; item: UpcItemDbItem; raw: unknown }
  | { kind: "miss" } // 404, or 200 with an empty items array: genuine not-in-DB
  | { kind: "bad_format" } // 400
  | { kind: "quota" } // 429: burst/daily limit hit at the provider itself
  | { kind: "transient"; detail: string }; // timeout / 5xx / malformed JSON

export interface UpcItemDbItem {
  title: string;
  brand: string;
  category: string;
  upc?: string;
  ean?: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

const UPCITEMDB_BASE = "https://api.upcitemdb.com/prod/trial/lookup";
const DEFAULT_TIMEOUT_MS = 5_000;

function toItem(raw: unknown): UpcItemDbItem {
  const p = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const item: UpcItemDbItem = {
    title: str(p.title),
    brand: str(p.brand),
    category: str(p.category),
  };
  if (p.upc != null) item.upc = str(p.upc);
  if (p.ean != null) item.ean = str(p.ean);
  return item;
}

export async function upcItemDbLookup(
  code: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<UpcItemDbOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${UPCITEMDB_BASE}?upc=${encodeURIComponent(code)}`;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "GET",
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
  // UPCitemdb's own "code" field signals request-level outcome (OK / INVALID_UPC / etc); a
  // non-OK code with no items is treated as a miss, never a throw.
  const items = Array.isArray(obj.items) ? obj.items : [];
  if (items.length === 0) {
    return { kind: "miss" };
  }
  const item = toItem(items[0]);
  return { kind: "hit", item, raw: body };
}
