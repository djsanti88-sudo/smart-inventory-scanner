type Status = "idle" | "hit" | "miss" | "rate_limited" | "error";
let _last: Status = "idle";
export function getLastBarcodeDbStatus(): Status { return _last; }

function variants(code: string): string[] {
  const s = code.replace(/^0+/, "") || "0";
  const v = new Set([code, s]);
  for (const b of [code, s]) { if (b.length <= 13) v.add(b.padStart(13, "0")); if (b.length <= 12) v.add(b.padStart(12, "0")); }
  return [...v];
}

export async function lookupBarcodeDb(code: string, deps?: { fetch?: typeof fetch }): Promise<{ name: string; brand: string; sourceUrl: string } | null> {
  const f = deps?.fetch ?? fetch;
  for (const v of variants(code.trim())) {
    let res: Response;
    try { res = await f(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(v)}`, { headers: { "User-Agent": "inventory-scanner" } }); }
    catch { _last = "error"; return null; }
    if (res.status === 429) { _last = "rate_limited"; return null; }
    if (!res.ok) { _last = "error"; continue; }
    const data = (await res.json()) as { items?: Array<{ title?: string; brand?: string; offers?: Array<{ link?: string }> }> };
    const item = data.items?.[0];
    if (item?.title) { _last = "hit"; return { name: item.title, brand: item.brand ?? "", sourceUrl: item.offers?.[0]?.link ?? "" }; }
  }
  _last = "miss";
  return null;
}
