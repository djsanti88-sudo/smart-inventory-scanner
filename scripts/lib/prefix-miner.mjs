// prefix-miner.mjs - pure, deterministic, no AI. Derives GS1 company prefixes from a brand's real
// barcodes (longest-common-prefix within a leading-digit block; >=N distinct barcodes confirm).
export function normalizeToGtin13(code) {
  const d = String(code ?? "").replace(/\D/g, "");
  if (d.length === 12) return "0" + d;
  if (d.length === 13) return d;
  if (d.length === 14) return d.slice(1);
  return null;
}

export function longestCommonPrefix(strings) {
  if (!strings.length) return "";
  let p = strings[0];
  for (const s of strings.slice(1)) {
    let i = 0;
    while (i < p.length && i < s.length && p[i] === s[i]) i++;
    p = p.slice(0, i);
    if (!p) break;
  }
  return p;
}

export function deriveBrandPrefixes(barcodes, opts = {}) {
  const minConfirm = opts.minConfirm ?? 2;
  const blockLen = opts.blockLen ?? 6;
  const blocks = new Map(); // leading-blockLen -> Set of GTIN-13
  for (const raw of barcodes) {
    const g = normalizeToGtin13(raw);
    if (!g || g.length !== 13) continue;
    const b = g.slice(0, blockLen);
    if (!blocks.has(b)) blocks.set(b, new Set());
    blocks.get(b).add(g);
  }
  const out = [];
  for (const [, set] of blocks) {
    const distinct = [...set];
    if (distinct.length < minConfirm) continue;
    out.push({ prefix: longestCommonPrefix(distinct), count: distinct.length, examples: distinct.slice(0, 2) });
  }
  return out.sort((a, b) => a.prefix.localeCompare(b.prefix));
}
