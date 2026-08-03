import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Phase 8C - the scan-context firewall must guard the DETERMINISTIC count path, not just the AI decode
// path. The seed includes verified products + approved aliases: prod-coke ("Coca-Cola 12 pack...", UPC
// 049000028904 - a clearly non-tire item) and prod-nokian (a real tire). The poisoned-identity scenario
// is simulated by scanning the verified non-tire product while the business scan context is "tire" -
// exactly the side door the AI-only firewall used to miss.

function countFor(store: ReturnType<typeof createTestScanStore>, productId: string) {
  return store.getState().finalCounts.find((c) => c.productId === productId)?.quantity ?? 0;
}

describe("Phase 8C side-door firewall - deterministic count path", () => {
  it("does NOT count a non-tire deterministic match in TIRE context; routes to Needs Review", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ scanContext: "tire" });

    // Verified seed product (Coca-Cola) matched deterministically - would have counted before Phase 8C.
    const ev = store.getState().processScan("049000028904");

    expect(countFor(store, "prod-coke")).toBe(0); // blocked - not counted
    expect(ev?.status).toBe("needs_review");
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "049000028904");
    expect(review?.status).toBe("open");
    expect(review?.reason ?? "").toMatch(/category conflict/i);
  });

  it("still counts the SAME product in ANY (default) context - the firewall is opt-in to tire", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const ev = store.getState().processScan("049000028904");
    expect(ev?.status).toBe("known");
    expect(countFor(store, "prod-coke")).toBe(1);
  });

  const linkedCode = "855724007602";

  function linkCrossCategoryAlias(
    store: ReturnType<typeof createTestScanStore>,
    origin?: "human" | "ai" | "auto_verify",
  ) {
    store.getState().updateSettings({ scanContext: "tire" });
    store.getState().processScan(linkedCode);
    const review = store.getState().needsReviewQueue.find((item) => item.cleanCode === linkedCode && item.status === "open")!;
    store.getState().resolveUnknown(review.id, "link_existing", {
      productId: "prod-coke",
      applyToCount: true,
      ...(origin ? { origin } : {}),
    });
    return store.getState().aliases.find((alias) => alias.cleanCode === linkedCode && alias.productId === "prod-coke")!;
  }

  function expectRescanBlocked(store: ReturnType<typeof createTestScanStore>) {
    store.getState().processScan(linkedCode);
    expect(countFor(store, "prod-coke")).toBe(1);
    expect(store.getState().scanFeed).toHaveLength(2);
    expect(store.getState().scanFeed[0].matchedProductId).not.toBe("prod-coke");
    expect(store.getState().finalCounts.reduce((total, count) => total + count.quantity, 0)).toBe(2);
  }

  it("an AI-origin approved alias keeps non-human provenance and cannot bypass the tire firewall", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const alias = linkCrossCategoryAlias(store, "ai");

    expect(alias.approved).toBe(true);
    expect(alias.source).toBe("ai_mock");
    expect(alias.createdBy).toBe("ai");
    expectRescanBlocked(store);
  });

  it("an auto_verify-origin approved alias keeps non-human provenance and cannot bypass the tire firewall", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const alias = linkCrossCategoryAlias(store, "auto_verify");

    expect(alias.approved).toBe(true);
    expect(alias.source).toBe("catalog");
    expect(alias.createdBy).toBe("auto_verify");
    expectRescanBlocked(store);
  });

  it("a genuine human confirmation upgrades one existing automatic alias in place and the next physical scan totals two", async () => {
    const db = new MockDb();
    const audit = vi.fn();
    let tick = 0;
    const store = createTestScanStore({
      db,
      audit,
      now: () => `2026-06-12T10:00:00.${String(tick++).padStart(3, "0")}Z`,
    });
    store.setState({ userId: "audit-user" });
    const automaticAlias = linkCrossCategoryAlias(store, "ai");
    const originalCreatedAt = automaticAlias.createdAt;
    const originalUpdatedAt = automaticAlias.updatedAt;
    const originalKey = automaticAlias.idempotencyKey;
    const reviewId = store.getState().reopenNeedsReview(linkedCode, "Owner confirms the existing mapping")!;

    store.getState().resolveUnknown(reviewId, "link_existing", {
      productId: "prod-coke",
      applyToCount: false,
    });

    const matching = store.getState().aliases.filter(
      (alias) =>
        alias.businessId === store.getState().businessId &&
        alias.cleanCode === linkedCode &&
        alias.productId === "prod-coke",
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      id: automaticAlias.id,
      createdAt: originalCreatedAt,
      source: "human_review",
      createdBy: "human_link_existing",
      approved: true,
    });
    expect(matching[0].updatedAt).not.toBe(originalUpdatedAt);
    expect(matching[0].lastSeenAt).toBe(matching[0].updatedAt);
    expect(matching[0].idempotencyKey).not.toBe(originalKey);
    await vi.waitFor(() =>
      expect(db.getAlias(store.getState().businessId, linkedCode, "prod-coke")).toMatchObject({
        id: automaticAlias.id,
        source: "human_review",
        createdBy: "human_link_existing",
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "Alias",
        entityId: automaticAlias.id,
        action: "alias_approved",
        metadata: expect.objectContaining({ origin: "human", confirmation: "existing_alias" }),
      }),
    );

    store.getState().processScan(linkedCode);
    expect(countFor(store, "prod-coke")).toBe(2);
    expect(store.getState().scanFeed).toHaveLength(2);
    expect(store.getState().finalCounts.reduce((total, count) => total + count.quantity, 0)).toBe(2);
  });

  it("human confirmation never upgrades a foreign-tenant alias and creates current-tenant provenance", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const automaticAlias = linkCrossCategoryAlias(store, "ai");
    store.setState((state) => ({
      aliases: state.aliases.map((alias) =>
        alias.id === automaticAlias.id ? { ...alias, businessId: "other-business" } : alias,
      ),
    }));
    const reviewId = store.getState().reopenNeedsReview(linkedCode, "Owner selects a current-tenant mapping")!;

    store.getState().resolveUnknown(reviewId, "link_existing", {
      productId: "prod-coke",
      applyToCount: false,
    });

    const foreign = store.getState().aliases.find((alias) => alias.id === automaticAlias.id)!;
    expect(foreign).toMatchObject({
      businessId: "other-business",
      productId: "prod-coke",
      source: "ai_mock",
      createdBy: "ai",
    });
    const current = store.getState().aliases.find(
      (alias) => alias.businessId === store.getState().businessId && alias.cleanCode === linkedCode,
    );
    expect(current).toMatchObject({
      productId: "prod-coke",
      source: "human_review",
      createdBy: "human_link_existing",
    });
  });

  it("human confirmation never upgrades an existing alias for a different product", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const automaticAlias = linkCrossCategoryAlias(store, "ai");
    const reviewId = store.getState().reopenNeedsReview(linkedCode, "Owner selects a different product")!;

    store.getState().resolveUnknown(reviewId, "link_existing", {
      productId: "prod-nokian",
      applyToCount: false,
    });

    expect(store.getState().aliases.find((alias) => alias.id === automaticAlias.id)).toMatchObject({
      productId: "prod-coke",
      source: "ai_mock",
      createdBy: "ai",
    });
    expect(
      store.getState().aliases.find(
        (alias) =>
          alias.businessId === store.getState().businessId &&
          alias.cleanCode === linkedCode &&
          alias.productId === "prod-nokian",
      ),
    ).toMatchObject({ source: "human_review", createdBy: "human_link_existing" });
  });

  it("automatic actions, revoked aliases, and ambiguous same-product duplicates cannot upgrade provenance", () => {
    const automaticStore = createTestScanStore({ db: new MockDb() });
    const automaticAlias = linkCrossCategoryAlias(automaticStore, "ai");
    const automaticReview = automaticStore.getState().reopenNeedsReview(linkedCode, "automatic replay")!;
    automaticStore.getState().resolveUnknown(automaticReview, "link_existing", {
      productId: "prod-coke",
      applyToCount: false,
      origin: "auto_verify",
    });
    expect(automaticStore.getState().aliases.find((alias) => alias.id === automaticAlias.id)).toMatchObject({
      source: "ai_mock",
      createdBy: "ai",
    });

    const revokedStore = createTestScanStore({ db: new MockDb() });
    const revokedAlias = linkCrossCategoryAlias(revokedStore, "ai");
    revokedStore.setState((state) => ({
      aliases: state.aliases.map((alias) =>
        alias.id === revokedAlias.id ? { ...alias, approved: false } : alias,
      ),
    }));
    const revokedReview = revokedStore.getState().reopenNeedsReview(linkedCode, "human confirmation")!;
    revokedStore.getState().resolveUnknown(revokedReview, "link_existing", {
      productId: "prod-coke",
      applyToCount: false,
    });
    expect(revokedStore.getState().aliases.find((alias) => alias.id === revokedAlias.id)).toMatchObject({
      approved: false,
      source: "ai_mock",
      createdBy: "ai",
    });

    const ambiguousStore = createTestScanStore({ db: new MockDb() });
    const ambiguousAlias = linkCrossCategoryAlias(ambiguousStore, "ai");
    ambiguousStore.setState((state) => ({
      aliases: [
        ...state.aliases,
        {
          ...ambiguousAlias,
          id: "duplicate-automatic-alias",
          idempotencyKey: "duplicate-automatic-alias",
        },
      ],
    }));
    const ambiguousReview = ambiguousStore.getState().reopenNeedsReview(linkedCode, "human confirmation")!;
    ambiguousStore.getState().resolveUnknown(ambiguousReview, "link_existing", {
      productId: "prod-coke",
      applyToCount: false,
    });
    const ambiguous = ambiguousStore.getState().aliases.filter(
      (alias) => alias.businessId === ambiguousStore.getState().businessId && alias.cleanCode === linkedCode,
    );
    expect(ambiguous).toHaveLength(2);
    expect(ambiguous.some((alias) => alias.createdBy === "human_link_existing")).toBe(false);
  });

  it("a foreign-tenant human-looking alias cannot lend its provenance to the current tenant's automatic alias", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const automaticAlias = linkCrossCategoryAlias(store, "ai");
    store.setState((state) => ({
      aliases: [
        ...state.aliases,
        {
          ...automaticAlias,
          id: "foreign-human-looking-alias",
          businessId: "other-business",
          source: "human_review",
          createdBy: "human_link_existing",
          idempotencyKey: "foreign-human-looking-alias",
        },
      ],
    }));

    expectRescanBlocked(store);
  });

  it("unapproved human provenance and an ambiguous current mapping cannot bypass the tire firewall", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const automaticAlias = linkCrossCategoryAlias(store, "ai");
    store.setState((state) => ({
      aliases: [
        ...state.aliases.map((alias) =>
          alias.id === automaticAlias.id ? { ...alias, source: "catalog" as const, createdBy: "auto_verify" } : alias,
        ),
        {
          ...automaticAlias,
          id: "revoked-human-alias",
          source: "human_review",
          createdBy: "human_link_existing",
          approved: false,
          idempotencyKey: "revoked-human-alias",
        },
        {
          ...automaticAlias,
          id: "ambiguous-current-alias",
          productId: "prod-nokian",
          source: "human_review",
          createdBy: "human_link_existing",
          approved: true,
          idempotencyKey: "ambiguous-current-alias",
        },
      ],
    }));

    store.getState().processScan(linkedCode);
    expect(countFor(store, "prod-coke")).toBe(1);
    expect(countFor(store, "prod-nokian")).toBe(0);
    expect(store.getState().scanFeed).toHaveLength(2);
    expect(store.getState().finalCounts.reduce((total, count) => total + count.quantity, 0)).toBe(2);
  });

  it("still counts a real tire in TIRE context (no false block)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ scanContext: "tire" });
    const ev = store.getState().processScan("T432119"); // Nokian Outpost APT
    expect(ev?.status).toBe("known");
    expect(countFor(store, "prod-nokian")).toBe(1);
  });

  it("FIX 2 (scan N = count N): a known-but-context-conflicted scan STILL counts provisionally + review stays open", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ scanContext: "tire" });
    // F5 bundle-surgery (wave 2, 2026-07-20): 049000028904's Coca-Cola prefix lives in the
    // DERIVED-tier map, which is server-only now - the brand name arrives via the async
    // /api/prefix-floor enrichment (mocked here) instead of a synchronous client lookup.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      if (String(url).includes("/api/prefix-floor")) {
        return { ok: true, json: async () => ({ floor: { name: "Coca-Cola / product unconfirmed", brand: "Coca-Cola", familyLabel: null } }) } as Response;
      }
      throw new Error("unexpected fetch");
    }) as unknown as typeof fetch;

    try {
      // Verified Coca-Cola matched deterministically but blocked by the tire firewall.
      store.getState().processScan("049000028904");

      // The SUSPECT/poisoned product is never counted...
      expect(countFor(store, "prod-coke")).toBe(0);
      // ...but the physical scan is NOT lost: it counts once against a SAFE provisional placeholder,
      // IMMEDIATELY and synchronously (TOP-LEVEL LAW - enrichment never gates counting).
      const totalCounted = store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);
      expect(totalCounted, "the scan counts exactly once (owner rule scan N = count N)").toBe(1);
      const placeholder = store.getState().products.find((p) => p.provisional && p.primaryBarcode === "049000028904");
      expect(placeholder, "a safe placeholder holds the count").toBeDefined();
      expect(countFor(store, placeholder!.id)).toBe(1);
      expect(placeholder!.verified).toBe(false);

      // PREFIX FLOOR (Plan C Task 3 + F5 async enrichment): the placeholder upgrades to the
      // brand-confident floor name once the enrichment lands - it still never claims the specific
      // SUSPECT product identity, and stays unverified.
      await vi.waitFor(() => {
        const p = store.getState().products.find((x) => x.id === placeholder!.id);
        expect(p!.name).toBe("Coca-Cola / product unconfirmed");
      });
      const upgraded = store.getState().products.find((x) => x.id === placeholder!.id);
      expect(upgraded!.brand).toBe("Coca-Cola");
      expect(upgraded!.verified).toBe(false);

      // The review is still open with the suspect identity surfaced for a human to confirm.
      const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "049000028904");
      expect(review?.status).toBe("open");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("counts each physical conflict scan (F-02, TOP-LAW): repeated context-conflict scans count every physical scan", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ scanContext: "tire" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      if (String(url).includes("/api/prefix-floor")) {
        return { ok: true, json: async () => ({ floor: { name: "Coca-Cola / product unconfirmed", brand: "Coca-Cola", familyLabel: null } }) } as Response;
      }
      throw new Error("unexpected fetch");
    }) as unknown as typeof fetch;

    try {
      // Freeze sync so the pending queue is inspectable before MockDb's synchronous auto-drain
      // consumes it (same technique as correctProductSync.store.test.ts) - counting itself is local
      // and synchronous regardless of sync success (TOP-LEVEL LAW), so this does not affect the
      // count/feed assertions below.
      store.getState().setSimulateSyncFailure(true);

      // Same context-conflicted code, scanned TWICE (two physical items on the shelf).
      store.getState().processScan("049000028904");
      store.getState().processScan("049000028904");

      // Counting half of the TOP-LEVEL LAW: 2 physical scans = count 2, never against the poisoned
      // prod-coke identity.
      const total = store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);
      expect(total, "the scan counts exactly twice (owner rule scan N = count N)").toBe(2);
      expect(countFor(store, "prod-coke"), "the suspect/poisoned product is never counted").toBe(0);

      // Visibility half of the law: both physical scans appear on the feed.
      expect(store.getState().scanFeed.length).toBe(2);

      // Durability: two DISTINCT counting events must be queued for sync - no reused counting key.
      const incrs = store.getState().pendingSyncQueue.filter((q) => q.operation === "INCREMENT_COUNT");
      expect(incrs.length, "two distinct INCREMENT_COUNT sync ops queued").toBe(2);
      expect(new Set(incrs.map((q) => q.idempotencyKey)).size, "distinct idempotency keys, never reused").toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Phase 8C markWrong - clears verified identity so it cannot re-match", () => {
  it("un-verifies the wrong product; a re-scan of the same code does NOT deterministically re-count it", async () => {
    const store = createTestScanStore({ db: new MockDb() });

    // 1. Count it the normal way (default context).
    store.getState().processScan("049000028904");
    expect(countFor(store, "prod-coke")).toBe(1);

    // 2. Owner marks it wrong.
    await store.getState().markWrong("prod-coke", { reason: "test-wrong" });

    // 3. The product is now un-verified and the session count is gone.
    expect(store.getState().products.find((p) => p.id === "prod-coke")?.verified).toBe(false);
    expect(countFor(store, "prod-coke")).toBe(0);

    // 4. Re-scanning the same barcode must NOT re-match DETERMINISTICALLY to the wrong product: the
    //    approved alias was deactivated AND the product was un-verified, so matchProductByIdentifiers
    //    can no longer hit prod-coke. Without the Phase 8C un-verify, the verified product's
    //    primaryBarcode would re-match prod-coke directly and re-count against it.
    //    D2 (markWrong quantity transfer) means the first markWrong call already moved the physical
    //    quantity onto a new "Unidentified item" provisional keyed by this same code (never destroyed -
    //    see markWrongTransfer.store.test.ts), so this second scan legitimately counts again, but
    //    against that SAFE provisional, never against prod-coke.
    const ev = store.getState().processScan("049000028904");
    expect(countFor(store, "prod-coke"), "the wrong product itself never re-counts").toBe(0);
    expect(ev?.matchedProductId).not.toBe("prod-coke");
    const provisional = store.getState().products.find(
      (p) => p.provisional === true && p.primaryBarcode === "049000028904",
    );
    expect(provisional, "the transfer provisional exists and is unverified").toBeDefined();
    expect(provisional!.verified).toBe(false);
    expect(ev?.matchedProductId).toBe(provisional!.id);
  });
});
