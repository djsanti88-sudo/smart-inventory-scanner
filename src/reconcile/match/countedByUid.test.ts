import { describe, it, expect } from "vitest";
import { deriveCountedByUid } from "./countedByUid";
import type { MatchResult } from "./identityMatcher";
import type { ExpectedInventoryRow } from "../types";
import type { Product, Alias, InventoryCount } from "@/types";

// Task 7: the wiring bridge from reconcile MatchResults (corpus uids) to the session's finalCounts
// (scanStore productIds). DETERMINISTIC + trust-gated: a corpus candidate maps to a counted product
// ONLY through the existing resolver (approved alias or verified product identifier) - never fuzzy,
// never through unverified suggestions. A matched product the resolver cannot bridge stays out of
// countedByUid, so the report honestly calls it expected_not_counted (AM-R8).

function product(over: Partial<Product> & { id: string }): Product {
  return {
    businessId: "biz-1", name: "Test", brand: "", category: "", specsShort: "", specsFull: "",
    primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [],
    imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "human_review",
    confidence: 1, verified: true, createdAt: "", updatedAt: "", createdBy: "h", updatedBy: "h",
    ...over,
  };
}

function count(productId: string, quantity: number): InventoryCount {
  return {
    id: `c-${productId}`, businessId: "biz-1", sessionId: "s", productId, quantity,
    lastScannedAt: "", aliasesSeen: [], scanEventIds: [], createdAt: "", updatedAt: "",
    syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
  };
}

function alias(over: Partial<Alias> & { productId: string; cleanCode: string }): Alias {
  return {
    id: `a-${over.cleanCode}`, businessId: "biz-1", rawCodeExample: over.cleanCode,
    normalizedCode: over.cleanCode, aliasType: "barcode", source: "human_review", confidence: 1,
    approved: true, createdAt: "", updatedAt: "", createdBy: "h", lastSeenAt: "",
    syncStatus: "synced", idempotencyKey: "k",
    ...over,
  };
}

function matched(uid: string, opts: { barcode?: string; partNumber?: string } = {}): MatchResult {
  const row: ExpectedInventoryRow = { externalId: uid, partNumbers: [opts.partNumber ?? "PN"], qty: 4, raw: {} };
  return {
    row,
    status: "matched",
    reason: "test",
    candidate: { uid, brand: "Cooper", name: "Discoverer", barcode: opts.barcode, partNumber: opts.partNumber },
  };
}

describe("deriveCountedByUid", () => {
  it("bridges a candidate barcode to a counted product via an APPROVED alias", () => {
    const p = product({ id: "p1" });
    const a = alias({ productId: "p1", cleanCode: "029142869870" });
    const out = deriveCountedByUid(
      [matched("uid-1", { barcode: "029142869870" })],
      [p], [a], [count("p1", 7)], "biz-1",
    );
    expect(out).toEqual({ "uid-1": 7 });
  });

  it("bridges a candidate part number to a counted product via a VERIFIED product identifier", () => {
    const p = product({ id: "p2", primarySku: "90000027117", verified: true });
    const out = deriveCountedByUid(
      [matched("uid-2", { partNumber: "90000027117" })],
      [p], [], [count("p2", 3)], "biz-1",
    );
    expect(out).toEqual({ "uid-2": 3 });
  });

  it("does NOT bridge through an UNAPPROVED alias (trust gate holds)", () => {
    const p = product({ id: "p3", verified: false });
    const a = alias({ productId: "p3", cleanCode: "111222333444", approved: false });
    const out = deriveCountedByUid(
      [matched("uid-3", { barcode: "111222333444" })],
      [p], [a], [count("p3", 9)], "biz-1",
    );
    expect(out).toEqual({});
  });

  it("a resolved product with NO count this session contributes nothing (AM-R8 boundary)", () => {
    const p = product({ id: "p4", primarySku: "SKU4" });
    const out = deriveCountedByUid([matched("uid-4", { partNumber: "SKU4" })], [p], [], [], "biz-1");
    expect(out).toEqual({});
  });

  it("non-matched results and matched results without candidate codes are skipped", () => {
    const unmatchedResult: MatchResult = {
      row: { externalId: "x", partNumbers: ["Z"], qty: 1, raw: {} },
      status: "unmatched",
      reason: "no hit",
    };
    const bareCandidate = matched("uid-5");
    bareCandidate.candidate = { uid: "uid-5", brand: "B", name: "N" };
    const out = deriveCountedByUid([unmatchedResult, bareCandidate], [], [], [count("p", 2)], "biz-1");
    expect(out).toEqual({});
  });
});
