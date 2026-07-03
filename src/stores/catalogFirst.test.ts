import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { sanitizeCatalogEntry } from "@/services/catalog/sanitizeCatalog";
import type { CatalogEntry, ShopOverride } from "@/services/catalog/catalogTypes";
import { DEMO_BUSINESS_ID } from "@/seed/seedData";

const NOW = "2026-06-14T00:00:00.000Z";
const CODE = "111222333444"; // not a seed alias -> resolver returns needs_review

const SUGGESTED = {
  providerNames: ["gemini", "openai"],
  results: [{ productName: "Maybe Snack", brand: "Generic", sourceUrls: [], verifiedFacts: [], guesses: ["g"], aliases: [], confidence: 0.5 }],
  decision: { status: "suggested", confidence: 0.5, reason: "Suggested", evidenceStrength: "url_only", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "agree" } },
};

function stub(resp: object) {
  const original = globalThis.fetch;
  const spy = vi.fn(async () => ({ ok: true, json: async () => resp })) as unknown as typeof fetch;
  globalThis.fetch = spy;
  return { spy, restore: () => (globalThis.fetch = original) };
}
function aiOnStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true });
  return store;
}
function verifiedEntry(code: string, name: string): CatalogEntry {
  return sanitizeCatalogEntry(
    { barcode: code, normalizedBarcode: code, name, confidence: 0.9 },
    { now: NOW, verificationStatus: "verified", verifiedBy: "owner", by: "owner" },
  );
}

describe("catalog-first lookup (saves AI tokens; offline-first)", () => {
  it("a verified catalog hit resolves + counts WITHOUT any AI call", () => {
    const store = aiOnStore();
    store.setState({ catalog: [verifiedEntry(CODE, "Catalog Cola")] });
    const { spy, restore } = stub(SUGGESTED);
    try {
      store.getState().processScan(CODE);
    } finally {
      restore();
    }
    expect(spy).not.toHaveBeenCalled(); // AI never consulted
    const prod = store.getState().products.find((p) => p.name === "Catalog Cola");
    expect(prod).toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === prod!.id)?.quantity).toBe(1);
    expect(store.getState().feedbackEvents.some((e) => e.type === "found_from_catalog")).toBe(true);
  });

  it("FIX 3: the synchronous catalog-first path flips the feed badge to 'verified' (not stuck on 'suggested')", () => {
    const store = aiOnStore();
    store.setState({ catalog: [verifiedEntry(CODE, "Catalog Cola")] });
    const { restore } = stub(SUGGESTED);
    try {
      store.getState().processScan(CODE);
    } finally {
      restore();
    }
    const row = store.getState().scanFeed.find((e) => e.cleanCode === CODE);
    expect(row, "feed row exists for the scan").toBeDefined();
    expect(row!.decodeStatus, "catalog-first match shows Verified").toBe("verified");
  });

  it("FIX 3: a low-confidence / no-match fast decode flips the feed badge OFF 'suggested' to 'needs_review'", async () => {
    const NO_MATCH = {
      providerNames: ["gemini", "openai"],
      results: [{ productName: "", brand: "", category: "", gtin: "", upc: "", ean: "", sourceUrls: [], verifiedFacts: [], guesses: [], aliases: [], confidence: 0.2 }],
      decision: { status: "needs_review", confidence: 0.2, reason: "No match found", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "weak" } },
    };
    const store = aiOnStore();
    const { restore } = stub(NO_MATCH);
    try {
      store.getState().processScan(CODE);
      // The scan counts synchronously (badge starts "suggested"); the async fast decode must then flip
      // the badge to reflect the REAL no-match outcome instead of leaving it stuck on "suggested".
      await vi.waitFor(() => {
        const row = store.getState().scanFeed.find((e) => e.cleanCode === CODE);
        expect(row?.decodeStatus).toBe("needs_review");
      });
    } finally {
      restore();
    }
    const row = store.getState().scanFeed.find((e) => e.cleanCode === CODE);
    expect(row?.decodeStatus, "badge reflects the decode outcome, not the placeholder").not.toBe("suggested");
  });

  it("a verified shop override wins over the global catalog (and skips AI)", () => {
    const store = aiOnStore();
    const override: ShopOverride = {
      businessId: DEMO_BUSINESS_ID, normalizedBarcode: CODE, name: "Shop Special", brand: "", category: "",
      size: "", imageUrl: "", productUrl: "", note: "private note", verified: true, createdAt: NOW, updatedAt: NOW, createdBy: "human",
    };
    store.setState({ catalog: [verifiedEntry(CODE, "Catalog Cola")], shopOverrides: [override] });
    const { spy, restore } = stub(SUGGESTED);
    try {
      store.getState().processScan(CODE);
    } finally {
      restore();
    }
    expect(spy).not.toHaveBeenCalled();
    expect(store.getState().products.some((p) => p.name === "Shop Special")).toBe(true);
    expect(store.getState().products.some((p) => p.name === "Catalog Cola")).toBe(false);
  });

  it("a catalog miss falls through to the AI path", async () => {
    const store = aiOnStore();
    const { spy, restore } = stub(SUGGESTED);
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.hasSuggestion).toBe(true));
    } finally {
      restore();
    }
    expect(spy).toHaveBeenCalled(); // AI was used because catalog had no hit
  });

  it("a non-exact AI product provisionally counts; Needs Review stays open + PENDING catalog entry", async () => {
    const store = aiOnStore();
    const { restore } = stub(SUGGESTED);
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.hasSuggestion).toBe(true));
    } finally {
      restore();
    }
    expect(store.getState().needsReviewQueue.at(-1)!.status).toBe("open"); // review stays open
    expect(store.getState().finalCounts).toHaveLength(1);
    const prov = store.getState().products.find((p) => p.name === "Maybe Snack");
    expect(prov).toBeDefined();
    expect(prov!.provisional).toBe(true);
    expect(prov!.verified).toBe(false);
    const entry = store.getState().catalog.find((e) => e.name === "Maybe Snack");
    expect(entry?.verificationStatus).toBe("pending"); // global catalog stays pending
    expect(entry?.verifiedBy).toBeNull();
  });

  it("a human approval writes a VERIFIED catalog entry + records feedback", () => {
    const store = createTestScanStore({ db: new MockDb() }); // AI off by default
    store.getState().processScan(CODE);
    const review = store.getState().needsReviewQueue.at(-1)!;
    store.getState().resolveUnknown(review.id, "create_new", { newProduct: { name: "Hand Added" }, applyToCount: true });

    const entry = store.getState().catalog.find((e) => e.name === "Hand Added");
    expect(entry).toBeDefined();
    expect(entry!.verificationStatus).toBe("verified");
    expect(entry!.verifiedBy).toBe("owner");
    expect(store.getState().feedbackEvents.some((e) => e.type === "product_approved")).toBe(true);
  });
});

describe("cloud global catalog lookup (Option 1 wiring)", () => {
  // Shared helpers
  const CLOUD_CODE = "555666777888"; // not a seed alias -> resolver returns needs_review

  function cloudEntry(code: string, name: string, status: "verified" | "pending" = "verified"): CatalogEntry {
    return sanitizeCatalogEntry(
      { barcode: code, normalizedBarcode: code, name, confidence: 0.9 },
      { now: NOW, verificationStatus: status, verifiedBy: "trusted_source", by: "trusted_source" },
    );
  }

  it("cloud verified hit (in-memory empty) resolves + counts 'found_from_catalog' with NO AI fetch", async () => {
    const cloudEntry_ = cloudEntry(CLOUD_CODE, "Cloud Tire LX275");
    const lookupGlobalCatalog = vi.fn(async () =>cloudEntry_);
    const store = createTestScanStore({ db: new MockDb(), lookupGlobalCatalog });
    store.setState({ online: true });

    const { spy, restore } = stub(SUGGESTED);
    try {
      store.getState().processScan(CLOUD_CODE);
      await vi.waitFor(() =>
        expect(store.getState().feedbackEvents.some((e) => e.type === "found_from_catalog")).toBe(true),
      );
    } finally {
      restore();
    }

    // Product created from cloud catalog entry
    const prod = store.getState().products.find((p) => p.name === "Cloud Tire LX275");
    expect(prod).toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === prod!.id)?.quantity).toBe(1);
    // AI never called
    expect(spy).not.toHaveBeenCalled();
    // cloud lookup was called
    expect(lookupGlobalCatalog).toHaveBeenCalled();
    // entry cached into in-memory catalog for repeat scans
    expect(store.getState().catalog.some((e) => e.name === "Cloud Tire LX275")).toBe(true);
  });

  it("cloud miss (returns null) -> AI path runs", async () => {
    const lookupGlobalCatalog = vi.fn(async () =>null);
    const store = createTestScanStore({ db: new MockDb(), lookupGlobalCatalog });
    store.setState({ online: true });
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true });

    const { spy, restore } = stub(SUGGESTED);
    try {
      store.getState().processScan(CLOUD_CODE);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.hasSuggestion).toBe(true));
    } finally {
      restore();
    }

    // AI fetch was called
    expect(spy).toHaveBeenCalled();
    expect(lookupGlobalCatalog).toHaveBeenCalled();
  });

  it("cloud hit whose identity conflicts with tire scanContext -> firewall routes to Needs Review, NOT auto-counted", async () => {
    // Return a non-tire product from the cloud catalog while in tire scan context
    const nonTireEntry = cloudEntry(CLOUD_CODE, "Coca-Cola Can 330ml");
    const lookupGlobalCatalog = vi.fn(async () =>nonTireEntry);
    const store = createTestScanStore({ db: new MockDb(), lookupGlobalCatalog });
    store.setState({ online: true });
    store.getState().updateSettings({ scanContext: "tire" });

    const { restore } = stub(SUGGESTED);
    try {
      store.getState().processScan(CLOUD_CODE);
      // Wait for the async cloud resolve to complete (firewall fires; no count)
      await vi.waitFor(() => {
        // The cloud lookup was called but count is still 0 (firewall blocked)
        return lookupGlobalCatalog.mock.calls.length > 0;
      });
      // Give a tick for the async path to settle
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      restore();
    }

    // The firewall blocked the CONFLICTING cloud identity: no "Coca-Cola" product is auto-created and no
    // found_from_catalog resolution happens (the tire-context scan never becomes a can of soda).
    expect(store.getState().products.find((p) => p.name === "Coca-Cola Can 330ml")).toBeUndefined();
    expect(store.getState().feedbackEvents.some((e) => e.type === "found_from_catalog")).toBe(false);
    // scan N = count N: the scan is still provisionally counted as a safe "Unidentified item" placeholder
    // (never as the blocked identity) so the physical count is never silently dropped.
    expect(store.getState().finalCounts).toHaveLength(1);
    const prov = store.getState().products.find((p) => p.primaryBarcode === CLOUD_CODE && p.provisional === true);
    expect(prov, "firewall-blocked scan still counts as a provisional Unidentified item").toBeDefined();
    expect(prov!.name).toMatch(/Unidentified item/);
    expect(prov!.name).not.toMatch(/coca-cola/i);
  });

  it("shop-owned approved alias still counts into the shop's product (cloud lookup NOT consulted)", () => {
    // Seed the store with a shop-owned product/alias so the deterministic resolver hits first
    const lookupGlobalCatalog = vi.fn(async () =>null);
    const store = createTestScanStore({ db: new MockDb(), lookupGlobalCatalog });
    store.setState({ online: true });

    // Manually inject a product + approved alias for CLOUD_CODE (all Product fields required by type)
    const shopProduct = {
      id: "shop-prod-1", name: "Shop Tire", brand: "ShopBrand", verified: true, status: "active" as const,
      businessId: DEMO_BUSINESS_ID, category: "", imageUrl: "", primaryBarcode: CLOUD_CODE, primarySku: "",
      specsShort: "", specsFull: "", productUrl: "", location: "", notes: "", gtin: "", upc: "", ean: "",
      vendorCodes: [], aliases: [CLOUD_CODE], source: "manual" as const, confidence: 1,
      createdAt: NOW, updatedAt: NOW, createdBy: "human", updatedBy: "human",
    };
    const shopAlias = {
      id: "alias-1", productId: "shop-prod-1", businessId: DEMO_BUSINESS_ID,
      rawCodeExample: CLOUD_CODE, cleanCode: CLOUD_CODE, normalizedCode: CLOUD_CODE,
      aliasType: "barcode" as const, source: "manual" as const, confidence: 1,
      approved: true, createdAt: NOW, updatedAt: NOW, createdBy: "human",
      lastSeenAt: NOW, syncStatus: "synced" as const, idempotencyKey: "k1",
    };
    store.setState((s) => ({ products: [...s.products, shopProduct], aliases: [...s.aliases, shopAlias] }));
    store.getState().processScan(CLOUD_CODE);

    // Deterministic resolver hit -> product counted into the shop's product
    expect(store.getState().finalCounts.find((c) => c.productId === "shop-prod-1")?.quantity).toBe(1);
    // No Needs Review queue entry (it was a known scan)
    expect(store.getState().needsReviewQueue).toHaveLength(0);
    // Cloud lookup NOT called because the deterministic resolver resolved it before the catalog block
    expect(lookupGlobalCatalog).not.toHaveBeenCalled();
  });

  it("offline -> cloud lookup skipped -> AI / Needs-Review path", async () => {
    const lookupGlobalCatalog = vi.fn(async () =>cloudEntry(CLOUD_CODE, "Offline Tire"));
    const store = createTestScanStore({ db: new MockDb(), lookupGlobalCatalog });
    store.setState({ online: false }); // OFFLINE

    const { spy, restore } = stub(SUGGESTED);
    try {
      store.getState().processScan(CLOUD_CODE);
      // Settle any async
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      restore();
    }

    // Cloud lookup NOT called (offline guard)
    expect(lookupGlobalCatalog).not.toHaveBeenCalled();
    // Landed in Needs Review (no AI keys configured, so not auto-decoded either)
    expect(store.getState().needsReviewQueue.some((r) => r.cleanCode === CLOUD_CODE)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("in-memory verified hit still resolves WITHOUT calling lookupGlobalCatalog (no regression)", () => {
    const lookupGlobalCatalog = vi.fn(async () =>null);
    const store = createTestScanStore({ db: new MockDb(), lookupGlobalCatalog });
    store.setState({ online: true, catalog: [cloudEntry(CLOUD_CODE, "Memory Tire")] });

    store.getState().processScan(CLOUD_CODE);

    // Resolved from in-memory catalog immediately (synchronous path)
    const prod = store.getState().products.find((p) => p.name === "Memory Tire");
    expect(prod).toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === prod!.id)?.quantity).toBe(1);
    // Cloud lookup NOT called because in-memory hit resolved it first
    expect(lookupGlobalCatalog).not.toHaveBeenCalled();
  });
});
