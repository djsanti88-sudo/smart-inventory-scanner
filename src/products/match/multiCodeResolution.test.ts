import { describe, it, expect } from "vitest";
import type { Alias } from "@/types";
import { resolveRawScan } from "@/products/match/resolver";

// Phase 1 proof: a product's codes resolve to the SAME product regardless of separators, and the
// no-separator variant fixes the "2881-6861 found nothing, 28816861 found it" miss. Ambiguous
// normalized matches must NOT auto-resolve (they go to conflict -> Needs Review).

const BIZ = "biz-test";

function alias(productId: string, cleanCode: string, normalizedCode: string, id = `${productId}-${cleanCode}`): Alias {
  return {
    id, businessId: BIZ, productId, rawCodeExample: cleanCode, cleanCode, normalizedCode,
    aliasType: "sku", source: "human_review", confidence: 1, approved: true,
    createdAt: "t", updatedAt: "t", createdBy: "test", lastSeenAt: "t", syncStatus: "synced", idempotencyKey: `k-${id}`,
  };
}

describe("multi-code tire resolution (separators)", () => {
  it("alias stored WITHOUT dash resolves a scan WITH a dash", () => {
    const aliases = [alias("prod-falken", "28816861", "28816861")];
    const res = resolveRawScan("2881-6861", [], aliases, BIZ);
    expect(res.resolverStatus).toBe("known");
    expect(res.productId).toBe("prod-falken");
  });

  it("alias stored WITH a dash resolves a scan WITHOUT the dash", () => {
    const aliases = [alias("prod-falken", "2881-6861", "28816861")];
    const res = resolveRawScan("28816861", [], aliases, BIZ);
    expect(res.resolverStatus).toBe("known");
    expect(res.productId).toBe("prod-falken");
  });

  it("a space-separated scan resolves to the no-separator alias", () => {
    const aliases = [alias("prod-falken", "28816861", "28816861")];
    const res = resolveRawScan("2881 6861", [], aliases, BIZ);
    expect(res.resolverStatus).toBe("known");
    expect(res.productId).toBe("prod-falken");
  });

  it("a product with BOTH a barcode and a part-number alias resolves from either code", () => {
    const aliases = [
      alias("prod-falken", "848983012906", "848983012906", "a1"), // retail barcode
      alias("prod-falken", "2881-6861", "28816861", "a2"), // part number
    ];
    expect(resolveRawScan("848983012906", [], aliases, BIZ).productId).toBe("prod-falken");
    expect(resolveRawScan("2881-6861", [], aliases, BIZ).productId).toBe("prod-falken");
    expect(resolveRawScan("28816861", [], aliases, BIZ).productId).toBe("prod-falken");
  });

  it("AMBIGUOUS normalized match does NOT auto-resolve (routes to conflict)", () => {
    const aliases = [
      alias("prod-a", "2881-6861", "28816861", "a1"),
      alias("prod-b", "2881 6861", "28816861", "b1"), // different product, same normalized form
    ];
    const res = resolveRawScan("28816861", [], aliases, BIZ);
    expect(res.resolverStatus).toBe("conflict"); // never silently picks one
    expect(res.productId).toBeNull();
  });

  it("exact approved alias still wins and preserves the raw code", () => {
    const aliases = [alias("prod-falken", "2881-6861", "28816861")];
    const res = resolveRawScan("2881-6861", [], aliases, BIZ);
    expect(res.matchType).toBe("exact_alias");
    expect(res.rawCode).toBe("2881-6861");
  });
});
