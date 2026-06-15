import { describe, it, expect } from "vitest";
import { resolveScanForRole } from "@/services/security/resolveScanServer";
import type { Product, Alias } from "@/types";

// Sec-5 contract: the server resolve helper returns product-facing fields ONLY to a customer
// ("business"), and the full internal result to platformOwner. This is the proof that "customer
// API responses do not include sensitive fields" at the resolution boundary.

const BID = "biz-1";

const product: Product = {
  id: "prod-1",
  businessId: BID,
  name: "Falken Wildpeak A/T3W",
  brand: "Falken",
  category: "tire",
  specsShort: "265/70R17",
  specsFull: "265/70R17 115T",
  primarySku: "2881-6861",
  primaryBarcode: "0123456789012",
  gtin: "00123456789012",
  upc: "123456789012",
  ean: "0123456789012",
  vendorCodes: ["X001ABCD"],
  aliases: ["2881-6861", "28816861"],
  imageUrl: "",
  productUrl: "",
  location: "Bay 3",
  notes: "",
  status: "active",
  source: "human_review",
  confidence: 1,
  verified: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdBy: "human",
  updatedBy: "human",
};

const alias: Alias = {
  id: "alias-1",
  businessId: BID,
  productId: "prod-1",
  rawCodeExample: "2881-6861",
  cleanCode: "2881-6861",
  normalizedCode: "28816861",
  aliasType: "sku",
  source: "human_review",
  confidence: 1,
  approved: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdBy: "human",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
  syncStatus: "synced",
  idempotencyKey: "k1",
};

// The exact set of keys a customer is allowed to receive from a scan resolution.
const ALLOWED_CUSTOMER_KEYS = [
  "matchedProductId",
  "productName",
  "brand",
  "category",
  "partNumber",
  "specs",
  "matchStatus",
  "quantityAfterScan",
  "reason",
].sort();

const FORBIDDEN_SUBSTRINGS = [
  "rawCode",
  "cleanCode",
  "normalizedCode",
  "normalizedCandidates",
  "barcode",
  "gtin",
  "upc",
  "ean",
  "vendorCodes",
  "aliases",
  "sourceUrls",
  "provider",
  "evidence",
  "decodeTrace",
];

describe("resolveScanForRole (Sec-5 server resolution contract)", () => {
  it("customer (business) gets product-facing fields ONLY - no codes/aliases/provider", () => {
    // Scan the dashed part number; normalized alias resolves it to the Falken tire.
    const out = resolveScanForRole({
      rawInput: "2881-6861",
      businessId: BID,
      level: "business",
      products: [product],
      aliases: [alias],
    }) as Record<string, unknown>;

    expect(Object.keys(out).sort()).toEqual(ALLOWED_CUSTOMER_KEYS);
    expect(out.matchedProductId).toBe("prod-1");
    expect(out.productName).toBe("Falken Wildpeak A/T3W");
    expect(out.brand).toBe("Falken");
    expect(out.partNumber).toBe("2881-6861"); // primarySku is product-facing (allowed)
    expect(out.matchStatus).toBe("known");

    // The serialized payload must not carry ANY code/alias/provider field, even nested.
    const blob = JSON.stringify(out).toLowerCase();
    for (const term of FORBIDDEN_SUBSTRINGS) {
      expect(blob).not.toContain(term.toLowerCase());
    }
    // The raw barcode/gtin/normalized values themselves must be absent from the payload.
    expect(blob).not.toContain("0123456789012");
    expect(blob).not.toContain("28816861"); // normalized code never leaks
    expect(blob).not.toContain("x001abcd"); // vendor code never leaks
  });

  it("platformOwner (platform) gets the full internal result including codes", () => {
    const out = resolveScanForRole({
      rawInput: "2881-6861",
      businessId: BID,
      level: "platform",
      products: [product],
      aliases: [alias],
    }) as Record<string, unknown>;

    expect(out.resolverStatus).toBe("known");
    expect(out.productId).toBe("prod-1");
    // Full internal fields are present for the platform owner.
    expect(out).toHaveProperty("rawCode");
    expect(out).toHaveProperty("cleanCode");
    expect(out).toHaveProperty("matchType");
  });

  it("unknown code -> customer sees needs_review with no product, still no codes leaked", () => {
    const out = resolveScanForRole({
      rawInput: "999-no-match-999",
      businessId: BID,
      level: "business",
      products: [product],
      aliases: [alias],
    }) as Record<string, unknown>;

    expect(Object.keys(out).sort()).toEqual(ALLOWED_CUSTOMER_KEYS);
    expect(out.matchedProductId).toBeNull();
    expect(out.matchStatus).toBe("needs_review");
    const blob = JSON.stringify(out).toLowerCase();
    expect(blob).not.toContain("999-no-match-999"); // the raw scanned code is never echoed back
  });
});
