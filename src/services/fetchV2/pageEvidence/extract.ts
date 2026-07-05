// Structured product-data extraction: JSON-LD Product first, product detail tables second,
// OG/page title only as a flagged fallback that carries NO gtin evidence by itself.
// Pure string/JSON work - no DOM, no network, server-safe.

export interface ExtractedProduct {
  source: "json_ld" | "detail_table" | "og_title";
  name: string;
  brand: string;
  gtins: string[]; // every gtin/gtin8/gtin12/gtin13/gtin14/upc/ean found, digits only
  sku: string;
  description: string;
  imageUrl: string;
}

const LD_JSON_RE = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const GTIN_KEYS = ["gtin", "gtin8", "gtin12", "gtin13", "gtin14", "upc", "ean"] as const;
// Table/definition rows labelled UPC/EAN/GTIN/barcode with a nearby digit run.
const TABLE_CODE_RE = /(?:>|\b)(UPC|EAN|GTIN|GTIN-?1[234]|Barcode)\s*:?\s*(?:<[^>]*>\s*)*([0-9][0-9 \-]{6,18}[0-9])/gi;

function str(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  return "";
}

function brandOf(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object") return str((v as { name?: unknown }).name);
  return "";
}

function imageOf(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return str(v[0]);
  if (v && typeof v === "object") return str((v as { url?: unknown }).url);
  return "";
}

/** Recursively collect every @type=Product node (handles @graph, arrays, nesting). */
function collectProductNodes(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) { for (const n of node) collectProductNodes(n, out); return; }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  const t = o["@type"];
  const types = Array.isArray(t) ? t.map(String) : [String(t ?? "")];
  if (types.some((x) => x.toLowerCase() === "product")) out.push(o);
  for (const key of ["@graph", "mainEntity", "itemListElement", "item"]) {
    if (o[key]) collectProductNodes(o[key], out);
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function firstMatch(html: string, re: RegExp): string {
  const m = html.match(re);
  return m ? stripTags(m[1]) : "";
}

export function extractProducts(html: string): ExtractedProduct[] {
  const out: ExtractedProduct[] = [];
  const h = html ?? "";

  // 1) JSON-LD Product blocks (malformed JSON is silently skipped - untrusted input).
  for (const m of h.matchAll(LD_JSON_RE)) {
    let parsed: unknown;
    try { parsed = JSON.parse(m[1]); } catch { continue; }
    const nodes: Record<string, unknown>[] = [];
    collectProductNodes(parsed, nodes);
    for (const p of nodes) {
      const gtins = GTIN_KEYS.map((k) => str(p[k]).replace(/\D/g, "")).filter((d) => d.length >= 8);
      out.push({
        source: "json_ld",
        name: str(p.name),
        brand: brandOf(p.brand),
        gtins: [...new Set(gtins)],
        sku: str(p.sku) || str(p.mpn),
        description: str(p.description),
        imageUrl: imageOf(p.image),
      });
    }
  }

  // 2) Product detail table rows (UPC/EAN/GTIN/Barcode label -> digits). Identity = h1, else <title>.
  const tableGtins = [...h.matchAll(TABLE_CODE_RE)]
    .map((m) => m[2].replace(/\D/g, ""))
    .filter((d) => d.length >= 8 && d.length <= 14);
  if (tableGtins.length > 0) {
    const name = firstMatch(h, /<h1[^>]*>([\s\S]*?)<\/h1>/i) || firstMatch(h, /<title[^>]*>([\s\S]*?)<\/title>/i);
    out.push({ source: "detail_table", name, brand: "", gtins: [...new Set(tableGtins)], sku: "", description: "", imageUrl: "" });
  }

  // 3) OG/title fallback ONLY when nothing structured exists - and it carries zero gtin evidence.
  if (out.length === 0) {
    const og = firstMatch(h, /<meta[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["']/i)
      || firstMatch(h, /<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:title["']/i);
    if (og) out.push({ source: "og_title", name: og, brand: "", gtins: [], sku: "", description: "", imageUrl: "" });
  }

  return out;
}
