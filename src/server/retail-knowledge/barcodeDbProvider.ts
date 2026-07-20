type Status = "idle" | "hit" | "miss" | "rate_limited" | "error";
let _last: Status = "idle";
export function getLastBarcodeDbStatus(): Status { return _last; }

function variants(code: string): string[] {
  const s = code.replace(/^0+/, "") || "0";
  const v = new Set([code, s]);
  for (const b of [code, s]) { if (b.length <= 13) v.add(b.padStart(13, "0")); if (b.length <= 12) v.add(b.padStart(12, "0")); }
  return [...v];
}

export async function lookupBarcodeDb(
  code: string,
  deps?: { fetch?: typeof fetch; backoffMs?: number; skipExact?: boolean }
): Promise<{ name: string; brand: string; sourceUrl: string } | null> {
  const f = deps?.fetch ?? fetch;
  // UPCitemdb trial burst-limits aggressively (especially from shared Vercel egress IPs) and this vote is
  // load-bearing for consensus recall: a transient 429 gets ONE short-backoff retry before giving up.
  const backoffMs = deps?.backoffMs ?? 1200;
  let retried = false;
  const trimmed = code.trim();
  // D8 follow-up (P5, 2026-07-20): a caller that already tried the exact code itself (decode pipeline
  // rung-0) sets skipExact so this lookup goes straight to the zero-pad variants instead of wastefully
  // re-fetching the identical exact-code URL against the keyless ~90-100/day trial budget.
  const queue = deps?.skipExact ? variants(trimmed).filter((v) => v !== trimmed) : variants(trimmed);
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i];
    let res: Response;
    try { res = await f(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(v)}`, { headers: { "User-Agent": "inventory-scanner" } }); }
    catch { _last = "error"; return null; }
    if (res.status === 429) {
      if (retried) { _last = "rate_limited"; return null; }
      retried = true;
      await new Promise((r) => setTimeout(r, backoffMs));
      i--; // retry the SAME variant once after the backoff
      continue;
    }
    if (!res.ok) { _last = "error"; continue; }
    const data = (await res.json()) as { items?: Array<{ title?: string; brand?: string; offers?: Array<{ link?: string }> }> };
    const item = data.items?.[0];
    if (item?.title) { _last = "hit"; return { name: item.title, brand: item.brand ?? "", sourceUrl: item.offers?.[0]?.link ?? "" }; }
  }
  _last = "miss";
  return null;
}
