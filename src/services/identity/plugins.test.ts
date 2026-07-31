import { describe, expect, it } from "vitest";
import { genericIdentityPlugin, pluginFor } from "./plugins";
import type { IdentityInput, ScopedIdentifier } from "./types";

const identifier = (overrides: Partial<ScopedIdentifier> = {}): ScopedIdentifier => ({
  type: "vendor_sku",
  raw: "000-7",
  normalized: "000-7",
  namespace: "vendor-a",
  source: "import",
  evidenceAuthority: "vendor_import",
  evidenceId: "record-1",
  evidenceVersion: "v1",
  ...overrides,
});

const input = (overrides: Partial<IdentityInput> = {}): IdentityInput => ({
  businessId: "business-1",
  sourceSystem: "shop-ware",
  sourceSignature: "schema-v1",
  vendorId: "vendor-a",
  sourceFileFingerprint: "file-1",
  sourceFileOrdinal: 0,
  sheetName: "Inventory",
  sourceRowNumber: 2,
  identifiers: [identifier()],
  title: "Premium all season tire",
  attributes: {},
  quantity: 1,
  rawRecordFingerprint: "row-1",
  ...overrides,
});

describe("genericIdentityPlugin", () => {
  it("keeps exact typed scoped identifiers collision-safe and preserves leading zeros", () => {
    const keys = genericIdentityPlugin.deterministicKeys(
      input({
        identifiers: [
          identifier({ type: "vendor_sku", namespace: "a|b", normalized: "c", raw: "c" }),
          identifier({ type: "vendor_sku", namespace: "a", normalized: "b|c", raw: "b|c" }),
          identifier(),
        ],
      }),
    );

    expect(keys).toEqual([
      '["vendor_sku","a|b","c"]',
      '["vendor_sku","a","b|c"]',
      '["vendor_sku","vendor-a","000-7"]',
    ]);
    expect(new Set(keys).size).toBe(3);
  });

  it("uses text similarity only as a review-ranking feature", () => {
    const result = genericIdentityPlugin.semanticFeatures(
      input(),
      {
        productId: "product-1",
        category: "general",
        businessScope: "master",
        verificationTier: "suggested",
        automaticEligible: false,
        evidenceId: "catalog-1",
        evidenceVersion: "v1",
        exactCodeEvidence: false,
        identifiers: [],
        title: "Premium all season tire",
        attributes: {},
        catalogVersion: "catalog-v1",
        catalogSnapshotHash: "snapshot-1",
      },
    );

    expect(result).toEqual({
      score: 1,
      orderedFeatureScores: [{ feature: "text_jaccard_review_only", score: 1 }],
      automaticEligible: false,
    });
  });

  it("selects the tire plugin only for a tire category hint", () => {
    expect(pluginFor(input({ categoryHint: "Tires" })).category).toBe("tire");
    expect(pluginFor(input({ categoryHint: "hardware" }))).toBe(genericIdentityPlugin);
  });
});
