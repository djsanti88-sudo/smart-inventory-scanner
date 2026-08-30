import type { Alias, InventoryCount, Product } from "@/types";
import type { CatalogEntry } from "@/products/catalog/catalogTypes";
import { isUsableProductName } from "@/decoding/decode";

// Recommendation-FIRST cleanup. This engine only DESCRIBES what could be removed and why; it never
// removes anything. The store applies the owner's selected items (with backup + Undo). Pure module.

export type CleanupReason =
  | "barcode_lookup_site"
  | "store_nav_text"
  | "search_result_title"
  | "website_title"
  | "pre_firewall_junk"
  | "orphaned_junk_product"
  | "too_generic"
  | "low_evidence_ai"
  | "duplicate_candidate"
  | "conflicts_verified_barcode";

export type CleanupConfidence = "high" | "medium" | "low";

export interface CleanupRecommendation {
  id: string; // the InventoryCount.id (stable selection key)
  reason: CleanupReason;
  reasonLabel: string;
  explanation: string;
  confidence: CleanupConfidence;
  defaultChecked: boolean;
  productId: string;
  productName: string;
  quantity: number;
  aliasIds: string[];
  scanEventIds: string[];
  sourceUrls: string[];
  removesProduct: boolean; // true only if no surviving good count references this product
}

export interface CleanupRecommendationGroup {
  reason: CleanupReason;
  reasonLabel: string;
  confidence: CleanupConfidence;
  items: CleanupRecommendation[];
}

const REASON_META: Record<CleanupReason, { label: string; confidence: CleanupConfidence }> = {
  barcode_lookup_site: { label: "Barcode lookup website detected", confidence: "high" },
  store_nav_text: { label: "Store navigation text detected", confidence: "high" },
  search_result_title: { label: "Search/result page title detected", confidence: "high" },
  website_title: { label: "Website title detected", confidence: "high" },
  pre_firewall_junk: { label: "Old pre-firewall junk row", confidence: "high" },
  orphaned_junk_product: { label: "Orphaned junk product (no product record)", confidence: "high" },
  too_generic: { label: "Product name too generic", confidence: "medium" },
  low_evidence_ai: { label: "Low-evidence AI result", confidence: "medium" },
  duplicate_candidate: { label: "Duplicate product candidate", confidence: "medium" },
  conflicts_verified_barcode: { label: "Conflicts with a verified barcode", confidence: "low" },
};

const SITE = /\b(go-?upc|upcitemdb|barcode ?lookup|upc barcode search|barcodespider|barcode ?finder|barcodes? ?database|ean-?search|eandata|barcodes?\.(com|net|org)|gtin ?lookup|buy ?upc|product ?lookup|barcodable|scandit)\b/i;
const NAV = /\b(add to cart|your cart|shopping cart|view cart|all categories|shop all|my account|sign in|checkout)\b/i;
const SEARCH = /\b(search results|results for|page not found|404 (not found|error)|error 404|no results)\b/i;
const GENERIC = /^\s*(product|item|misc|miscellaneous|stuff|thing|generic|unknown item)\s*$/i;
const DOMAINISH = /\b[a-z0-9-]+\.(com|net|org|io)\b/i;
const AI_SOURCES = new Set(["ai_mock", "ai_openai", "ai_openai"]);

const normName = (n: string) => n.trim().toLowerCase().replace(/\s+/g, " ");
function isProtected(p: Product): boolean {
  // Genuinely-real products are never recommended for removal. A junk NAME overrides the verified
  // flag (auto-added junk carries verified=true), so name-junk reasons still apply below.
  return p.source === "seed" || p.source === "manual";
}

function classifyName(name: string): { reason: CleanupReason } | null {
  if (isUsableProductName(name)) {
    if (GENERIC.test(name)) return { reason: "too_generic" };
    return null;
  }
  if (SITE.test(name)) return { reason: "barcode_lookup_site" };
  if (NAV.test(name)) return { reason: "store_nav_text" };
  if (SEARCH.test(name)) return { reason: "search_result_title" };
  if (DOMAINISH.test(name)) return { reason: "website_title" };
  return { reason: "pre_firewall_junk" };
}

export interface CleanupInput {
  finalCounts: InventoryCount[];
  products: Product[];
  aliases: Alias[];
  catalog?: CatalogEntry[];
}

export function buildCleanupRecommendations(input: CleanupInput): {
  recommendations: CleanupRecommendation[];
  groups: CleanupRecommendationGroup[];
} {
  const { finalCounts, products, aliases, catalog = [] } = input;
  const byId = new Map(products.map((p) => [p.id, p] as const));
  const nameGroups = new Map<string, Product[]>();
  for (const p of products) {
    const k = normName(p.name);
    if (!k) continue;
    nameGroups.set(k, [...(nameGroups.get(k) ?? []), p]);
  }
  const verifiedCatalogByCode = new Map<string, CatalogEntry>();
  for (const e of catalog) {
    if (e.verificationStatus !== "verified") continue;
    for (const c of [e.normalizedBarcode, ...e.aliases]) verifiedCatalogByCode.set(c, e);
  }

  const flagged: Array<{ count: InventoryCount; reason: CleanupReason }> = [];

  for (const count of finalCounts) {
    const product = byId.get(count.productId);
    if (!product) {
      flagged.push({ count, reason: "orphaned_junk_product" });
      continue;
    }
    if (isProtected(product)) continue;

    const nameVerdict = classifyName(product.name);

    // Conflict: this code is a verified catalog barcode for a DIFFERENT product name.
    const codes = [product.primaryBarcode, ...count.aliasesSeen].filter(Boolean);
    const conflict = codes
      .map((c) => verifiedCatalogByCode.get(c))
      .find((e) => e && normName(e.name) !== normName(product.name));

    if (nameVerdict) {
      flagged.push({ count, reason: nameVerdict.reason });
    } else if (conflict) {
      flagged.push({ count, reason: "conflicts_verified_barcode" });
    } else if (AI_SOURCES.has(product.source) && (product.confidence ?? 1) < 0.6) {
      flagged.push({ count, reason: "low_evidence_ai" });
    } else {
      const group = nameGroups.get(normName(product.name)) ?? [];
      const isDuplicate = group.length > 1 && group.some((other) => other.id !== product.id && (other.source === "seed" || other.source === "human_review"));
      if (isDuplicate) flagged.push({ count, reason: "duplicate_candidate" });
    }
  }

  const flaggedCountIds = new Set(flagged.map((f) => f.count.id));
  const survivingProductIds = new Set(
    finalCounts.filter((c) => !flaggedCountIds.has(c.id)).map((c) => c.productId),
  );

  const recommendations: CleanupRecommendation[] = flagged.map(({ count, reason }) => {
    const product = byId.get(count.productId);
    const meta = REASON_META[reason];
    const removesProduct = !!product && !survivingProductIds.has(product.id);
    return {
      id: count.id,
      reason,
      reasonLabel: meta.label,
      explanation: explain(reason, product?.name ?? "(missing product)", count.quantity),
      confidence: meta.confidence,
      defaultChecked: meta.confidence === "high",
      productId: count.productId,
      productName: product?.name ?? "(missing product)",
      quantity: count.quantity,
      aliasIds: removesProduct ? aliases.filter((a) => a.productId === count.productId).map((a) => a.id) : [],
      scanEventIds: count.scanEventIds,
      sourceUrls: [],
      removesProduct,
    };
  });

  const order: CleanupReason[] = [
    "barcode_lookup_site", "store_nav_text", "search_result_title", "website_title",
    "pre_firewall_junk", "orphaned_junk_product", "too_generic", "low_evidence_ai",
    "duplicate_candidate", "conflicts_verified_barcode",
  ];
  const groups: CleanupRecommendationGroup[] = order
    .map((reason) => ({
      reason,
      reasonLabel: REASON_META[reason].label,
      confidence: REASON_META[reason].confidence,
      items: recommendations.filter((r) => r.reason === reason),
    }))
    .filter((g) => g.items.length > 0);

  return { recommendations, groups };
}

function explain(reason: CleanupReason, name: string, qty: number): string {
  switch (reason) {
    case "barcode_lookup_site":
      return `"${name}" is the title of a barcode-lookup website, not a real product.`;
    case "store_nav_text":
      return `"${name}" is store navigation text (cart/menu), not a product.`;
    case "search_result_title":
      return `"${name}" is a search/error page title, not a product.`;
    case "website_title":
      return `"${name}" looks like a website title (contains a domain), not a product.`;
    case "pre_firewall_junk":
      return `"${name}" failed the product-name firewall and was likely saved before it existed.`;
    case "orphaned_junk_product":
      return `This count (qty ${qty}) points to a product record that no longer exists.`;
    case "too_generic":
      return `"${name}" is too generic to be a useful product entry.`;
    case "low_evidence_ai":
      return `"${name}" came from a low-confidence AI result with weak evidence.`;
    case "duplicate_candidate":
      return `"${name}" duplicates another product that looks more authoritative.`;
    case "conflicts_verified_barcode":
      return `This barcode is verified in the catalog under a different product name than "${name}". Review before removing.`;
  }
}
