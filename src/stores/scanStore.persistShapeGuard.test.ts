import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useScanStore, sanitizePersistedScanShape, DEFAULT_SETTINGS } from "@/stores/scanStore";
import { getMockDb } from "@/services/mockDb";
import type { InventoryCount, Product } from "@/types";

// TOP-LEVEL LAW regression guard, fast/store-level companion to
// e2e/persist-corruption-recovery.spec.ts's "wrong-shape value" case.
//
// That E2E proved a REAL defect: seeding a wrong-SHAPE value into the app's IndexedDB persist record
// (products: "not-an-array") at the CURRENT persist version (14, so zustand's `migrate` is skipped
// entirely and the bad value flows straight into the default shallow merge) made
// `collectAllIdentifierHits` (src/services/aliasMatcher.ts:160, `products.filter is not a function`)
// throw INSIDE processScan, so the scan was silently dropped - "0 scans", count 0.
//
// Two layers close this, and this file proves both, fast (no browser, no IndexedDB):
//   LAYER A - sanitizePersistedScanShape must coerce any non-array collection field to [] (with a
//     warning), so a wrong-shape blob can never reach the live store shape in the first place.
//   LAYER B - even if a wrong-shape value DID reach the store (any other future path, defense in
//     depth), processScan must never let a downstream throw delete the row: the scan must still
//     appear on scanFeed and still count.

beforeEach(() => {
  getMockDb().reset();
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("LAYER A: sanitizePersistedScanShape coerces wrong-shape collections to []", () => {
  it("replaces a non-array 'products' field with [] and warns, leaving other fields untouched", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const wrongShape = {
      products: "not-an-array",
      aliases: [],
      scanFeed: [],
      finalCounts: [],
      needsReviewQueue: [],
      pendingSyncQueue: [],
      settings: { businessId: "demo-business" },
    };

    const sanitized = sanitizePersistedScanShape(wrongShape);

    expect(sanitized.products).toEqual([]);
    expect(sanitized.aliases).toEqual([]);
    expect(sanitized.settings).toEqual({ businessId: "demo-business" });
    expect(warn).toHaveBeenCalled();
  });

  it("leaves genuinely valid array fields alone", () => {
    const valid = {
      products: [{ id: "p1" }],
      aliases: [{ id: "a1" }],
      scanFeed: [],
    };
    const sanitized = sanitizePersistedScanShape(valid);
    expect(sanitized.products).toEqual([{ id: "p1" }]);
    expect(sanitized.aliases).toEqual([{ id: "a1" }]);
  });

  it("keeps exact top-level array references when valid nested-array fields need no repair", () => {
    const products = [{ id: "p1", vendorCodes: ["v1"], aliases: ["a1"] }];
    const scanFeed = [{ id: "e1", normalizedCandidates: [] }];
    const finalCounts = [{ id: "c1", scanEventIds: [], aliasesSeen: [], appliedIdempotencyKeys: [] }];
    const needsReviewQueue = [{
      id: "r1",
      normalizedCandidates: [],
      suggestedAliases: [],
      sourceUrls: [],
      verifiedFacts: [],
      guesses: [],
    }];

    const sanitized = sanitizePersistedScanShape({ products, scanFeed, finalCounts, needsReviewQueue });

    expect(sanitized.products).toBe(products);
    expect(sanitized.scanFeed).toBe(scanFeed);
    expect(sanitized.finalCounts).toBe(finalCounts);
    expect(sanitized.needsReviewQueue).toBe(needsReviewQueue);
  });

  it("does not log a live wrong-shape repair for a valid store during processScan", () => {
    useScanStore.setState({
      products: [],
      aliases: [],
      scanFeed: [],
      finalCounts: [],
      needsReviewQueue: [],
      pendingSyncQueue: [],
      settings: DEFAULT_SETTINGS,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    useScanStore.getState().processScan("049000028905");

    expect(error.mock.calls.some((call) => String(call[0]).includes("wrong-shape field(s)"))).toBe(false);
  });

  it("tolerates a non-object input (never throws)", () => {
    expect(() => sanitizePersistedScanShape(null)).not.toThrow();
    expect(() => sanitizePersistedScanShape("garbage")).not.toThrow();
    expect(sanitizePersistedScanShape(null)).toEqual({});
  });
});

describe("LAYER B: processScan survives a wrong-shape 'products' state without dropping the scan", () => {
  it("still appends the scan to scanFeed and counts it, even when products is not an array", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    // Simulate corrupted state having reached the live store (defense in depth: whatever path put it
    // there, processScan itself must not be able to lose the row).
    useScanStore.setState({ products: "not-an-array" as never });

    const before = useScanStore.getState().scanFeed.length;

    let event:
      | (ReturnType<(typeof useScanStore)["getState"]>["processScan"] extends (
          i: string,
        ) => infer R
          ? R
          : never)
      | undefined;
    expect(() => {
      event = useScanStore.getState().processScan("049000028904");
    }).not.toThrow();

    const st = useScanStore.getState();
    // TOP-LEVEL LAW: the row appears...
    expect(st.scanFeed.length).toBe(before + 1);
    expect(event).not.toBeNull();
    // ...and it counts (either as a fresh provisional "unidentified" row or a needs-review row, but the
    // physical scan is never silently gone).
    const totalQty = st.finalCounts.reduce((sum, c) => sum + (c.quantity ?? 0), 0);
    expect(totalQty).toBeGreaterThan(0);
    // The failure was logged loudly (never silently swallowed).
    expect(error).toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------------------------
// THIRD-REVIEW HARDENING (2026-08-16): an independent clean-room review found the class was not
// closed. Root cause: "shape validation that only checks the TOP LEVEL", with three variants:
//   1. Wrong-type whole field (`products: "not-an-array"`)               - already fixed above.
//   2. Wrong-type OBJECT field (`settings: null`)                        - closed below.
//   3. A valid array containing MALFORMED MEMBERS (`[null]`, `["x"]`)    - closed below.
// Plus a genuinely unanticipated throw (neither 1, 2, nor 3) must still never drop a scan - the
// OUTER SAFETY NET section below proves that too.
// -----------------------------------------------------------------------------------------------

// NOTE ON BASELINE: some fixtures (currentSession: null) legitimately trigger processScan's own
// ensureAutoSession rotation (session-scoped scanFeed reset is expected product behavior, not a
// defect), so a raw cross-test "scanFeed.length before/after" delta is not a reliable signal here.
// Each test uses a UNIQUE code (see codeCounter below), so the TOP-LEVEL LAW is instead proven the
// direct way: the store never throws, the scanned code's own row exists on the feed afterward, and
// SOME quantity is counted store-wide (the row's own contribution, at minimum).
function scanAndAssertLawHolds(code: string) {
  let event: (ReturnType<typeof useScanStore.getState>["processScan"] extends (i: string) => infer R ? R : never) | undefined;
  expect(() => {
    event = useScanStore.getState().processScan(code);
  }).not.toThrow();
  const st = useScanStore.getState();
  expect(Array.isArray(st.scanFeed)).toBe(true);
  const ownRow = st.scanFeed.find((e) => e.cleanCode === code);
  expect(ownRow).toBeTruthy();
  expect(Array.isArray(st.finalCounts)).toBe(true);
  const totalQty = st.finalCounts.reduce((sum, c) => sum + (c.quantity ?? 0), 0);
  expect(totalQty).toBeGreaterThan(0);
  return event;
}

describe("VARIANT 2: settings persisted as null / wrong shape", () => {
  it("sanitizePersistedScanShape resets a null settings field to DEFAULT_SETTINGS and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sanitized = sanitizePersistedScanShape({ settings: null });
    expect(sanitized.settings).toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalled();
  });

  it("sanitizePersistedScanShape resets a non-object settings field (string) to DEFAULT_SETTINGS and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sanitized = sanitizePersistedScanShape({ settings: "not-an-object" });
    expect(sanitized.settings).toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalled();
  });

  it("leaves a genuinely valid (even partial) settings object untouched", () => {
    const sanitized = sanitizePersistedScanShape({ settings: { businessId: "demo-business" } });
    expect(sanitized.settings).toEqual({ businessId: "demo-business" });
  });

  it("processScan still appears and counts when live settings is null (RED before the fix: settings.scanContext throws before ensureProvisionalCount runs)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    useScanStore.setState({ settings: null as never });
    scanAndAssertLawHolds("049000028910");
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining("Cannot read"), expect.anything());
  });

  it("processScan still appears and counts when live settings is a non-object primitive", () => {
    useScanStore.setState({ settings: "not-an-object" as never });
    scanAndAssertLawHolds("049000028911");
  });
});

describe("VARIANT 3: a persisted array containing malformed MEMBERS (not just a malformed container)", () => {
  it("drops null/undefined/non-object members from object-array fields, keeps valid ones, and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sanitized = sanitizePersistedScanShape({
      products: [{ id: "p1" }, null, "garbage", undefined, { id: "p2" }],
      needsReviewQueue: [null, { id: "r1" }],
    });
    expect(sanitized.products).toEqual([{ id: "p1" }, { id: "p2" }]);
    expect(sanitized.needsReviewQueue).toEqual([{ id: "r1" }]);
    expect(warn).toHaveBeenCalled();
  });

  it("keeps a plain object member even when it is missing expected fields (never over-strips)", () => {
    const sanitized = sanitizePersistedScanShape({ products: [{}] });
    expect(sanitized.products).toEqual([{}]);
  });

  it("drops non-string members from string-array fields (syncedScanEventIds, recentLocations)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sanitized = sanitizePersistedScanShape({
      syncedScanEventIds: ["id1", null, 42, "id2"],
      recentLocations: [{ bad: true }, "Bay 3"],
    });
    expect(sanitized.syncedScanEventIds).toEqual(["id1", "id2"]);
    expect(sanitized.recentLocations).toEqual(["Bay 3"]);
    expect(warn).toHaveBeenCalled();
  });

  it("processScan survives a live 'products' array containing a null member (RED before the fix: p.status throws at 3272-3283, outside the old try/catch)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useScanStore.setState({ products: [null, { id: "existing-x" }] as never });
    scanAndAssertLawHolds("049000028912");
  });

  it("processScan survives a live 'needsReviewQueue' array containing a string member", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useScanStore.setState({ needsReviewQueue: ["garbage-entry"] as never });
    scanAndAssertLawHolds("049000028913");
  });
});

describe("GENERIC CLASS GUARD: every persisted field survives a hostile value, table-driven", () => {
  // The real deliverable (per owner order): this closes the CLASS ("shape validation only checks
  // the top level"), not one instance. Every field the store persists is exercised with every
  // hostile shape a corrupted IndexedDB/localStorage record could plausibly contain.
  const HOSTILE_VALUES: Array<[label: string, value: unknown]> = [
    ["null", null],
    ["a string", "garbage"],
    ["a number", 42],
    ["an empty object", {}],
  ];

  const FIELDS = [
    "products",
    "aliases",
    "scanFeed",
    "finalCounts",
    "needsReviewQueue",
    "pendingSyncQueue",
    "syncedScanEventIds",
    "catalog",
    "shopOverrides",
    "feedbackEvents",
    "countSnapshots",
    "sessionHistory",
    "recentLocations",
    "settings",
    "currentSession",
    "lastCleanupBackup",
  ] as const;

  let codeCounter = 900000;

  for (const field of FIELDS) {
    for (const [label, value] of HOSTILE_VALUES) {
      it(`field '${field}' hydrated as ${label} still lets the next scan appear and count`, () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        useScanStore.setState({ [field]: value } as never);
        codeCounter += 1;
        scanAndAssertLawHolds(`0490000${codeCounter}`);
      });
    }
  }
});

describe("OUTER SAFETY NET: processScan survives a genuinely unanticipated throw (not a known shape defect)", () => {
  it("never drops a scan even when a field passes shape validation but throws on property access", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // A Proxy IS a plain object as far as any shape check can tell (typeof "object", not null, not
    // an array) - so no sanitizer can catch this case by construction. This simulates a future bug
    // class the shape guard cannot anticipate: the property read itself throws.
    const poisoned = new Proxy(
      {},
      {
        get(_target, prop) {
          throw new Error(`simulated unexpected failure reading '${String(prop)}'`);
        },
      },
    );
    useScanStore.setState({ settings: poisoned as never });
    scanAndAssertLawHolds("049000028920");
    expect(error).toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------------------------
// FOURTH-REVIEW HARDENING (independent Codex clean-room review, 2026-08-16): the safety net closed
// three prior variants but had two more CRITICAL holes:
//   FINDING 1 - the net did not cover SESSION INITIALIZATION. processScan called ensureAutoSession
//     (which calls getOrCreateDeviceId -> raw localStorage.getItem/setItem) BEFORE the outer Layer C
//     try/catch even started. A throw there (Safari private mode, blocked cookies, full quota) escaped
//     processScan entirely: no Layer C log, no fallback row, no count. The scan was lost completely.
//   FINDING 2 - the fallback TRUSTED the very data that broke it. ensureProvisionalCount's "already
//     counted" shortcut only checked "does SOME count exist for a product carrying this code", never
//     whether THIS scan's own event was ever applied - so a corrupted/stale ledger entry (e.g.
//     scanEventIds: null) could make the fallback silently no-op on a genuinely new physical scan.
// -----------------------------------------------------------------------------------------------

describe("FINDING 1: the safety net now covers session initialization (ensureAutoSession)", () => {
  it("processScan survives ensureAutoSession itself throwing (RED before the fix: the outer try started AFTER session init, so this throw escaped processScan entirely)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Force the session-init branch to run (no current session), then make ensureAutoSession itself
    // throw - simulating an unrecoverable failure during session/device-id setup that survives even
    // the fail-soft deviceIdentity.ts fix (a genuinely unanticipated cause, same spirit as the OUTER
    // SAFETY NET Proxy test above, but specifically targeting the session-init call site).
    useScanStore.setState({ sessionId: null, currentSession: null } as never);
    const originalEnsureAutoSession = useScanStore.getState().ensureAutoSession;
    useScanStore.setState({
      ensureAutoSession: () => {
        throw new Error("simulated unrecoverable failure during session initialization");
      },
    } as never);
    try {
      scanAndAssertLawHolds("049000029001");
    } finally {
      // Restore the real action so later tests in this file are not polluted by this override.
      useScanStore.setState({ ensureAutoSession: originalEnsureAutoSession } as never);
    }
    expect(error).toHaveBeenCalled();
  });
  // NOTE: the direct "real Storage.getItem/setItem throws" fail-soft behavior is proven reliably at
  // the unit level in src/services/deviceIdentity.test.ts (a plain fake Storage object, not jsdom's
  // Proxy-backed window.localStorage, which vi.spyOn cannot reliably intercept for this purpose - a
  // spy attempt here was flaky/no-signal in both the pre-fix and post-fix code and was removed rather
  // than kept as a false-confidence test). This describe block's other test proves the OUTER boundary
  // move (ensureAutoSession itself throwing, of any cause, is still caught by Layer C).
});

describe("FINDING 2: a corrupted/stale existing count for the same code must not fool the recovery fallback", () => {
  // Establish a DEFINITE, stable, active/unlocked session before each test in this block - the prior
  // FINDING 1 describe block can leave sessionId/currentSession null (a throwing ensureAutoSession
  // override never completes session setup), which would otherwise make THIS block's own processScan
  // call silently ROTATE to a brand-new session (a real, unrelated product behavior - see the
  // TOP-LEVEL LAW / Phase 3 defect F1 comment on processScan), leaving the seeded broken ledger row
  // orphaned under the OLD session id and producing a false failure unrelated to Finding 2 itself.
  beforeEach(() => {
    const now = new Date().toISOString();
    useScanStore.setState({
      sessionId: "finding2-session",
      currentSession: {
        id: "finding2-session",
        businessId: useScanStore.getState().businessId,
        name: "Finding 2 Test Session",
        location: "",
        status: "active",
        startedAt: now,
        completedAt: null,
        createdBy: "test",
        notes: "",
        syncStatus: "synced",
        locked: false,
      },
    } as never);
  });

  function seedKnownProductWithBrokenLedger(code: string, quantity: number) {
    const state = useScanStore.getState();
    const product: Product = {
      id: `prod-finding2-${code}`,
      businessId: state.businessId,
      name: "Finding 2 Known Product",
      brand: "",
      category: "",
      specsShort: "",
      specsFull: "",
      primarySku: "",
      primaryBarcode: code,
      gtin: "",
      upc: "",
      ean: "",
      vendorCodes: [],
      aliases: [],
      imageUrl: "",
      productUrl: "",
      location: "",
      notes: "",
      status: "active",
      source: "manual",
      confidence: 1,
      verified: true,
      provisional: false,
      provenanceTier: "human_verified",
      createdAt: "2026-08-16T00:00:00.000Z",
      createdBy: "owner",
      updatedAt: "2026-08-16T00:00:00.000Z",
      updatedBy: "owner",
    } as Product;
    // A count row already exists for this product/code, but its nested arrays are corrupted (the
    // exact shape Finding 2's repro specifies: `scanEventIds: null`). This is the "very data that
    // broke it" the fallback must not blindly trust as proof the CURRENT physical scan landed.
    const brokenCount = {
      id: `count-finding2-${code}`,
      businessId: state.businessId,
      sessionId: state.sessionId,
      productId: product.id,
      quantity,
      lastScannedAt: "2026-08-16T00:00:00.000Z",
      aliasesSeen: null,
      scanEventIds: null,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
      syncStatus: "synced",
      syncError: null,
      appliedIdempotencyKeys: null,
    } as unknown as InventoryCount;
    useScanStore.setState((s) => ({
      products: [...s.products, product],
      finalCounts: [...s.finalCounts, brokenCount],
    }));
    return product;
  }

  it("a KNOWN scan for a product with a null scanEventIds ledger entry still appears and its OWN contribution counts (RED before the fix: applyScanEventOnce throws, then ensureProvisionalCount's shortcut sees the code already 'counted' and silently no-ops)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = "049000029050";
    const product = seedKnownProductWithBrokenLedger(code, 3);

    let event: (ReturnType<typeof useScanStore.getState>["processScan"] extends (i: string) => infer R ? R : never) | undefined;
    expect(() => {
      event = useScanStore.getState().processScan(code);
    }).not.toThrow();

    const st = useScanStore.getState();
    // TOP-LEVEL LAW: the row for THIS scan appears...
    expect(event).toBeTruthy();
    const ownRow = st.scanFeed.find((e) => e.id === event!.id);
    expect(ownRow).toBeTruthy();
    // ...and this scan's own event is recorded in the ledger, not just an unrelated stale count. There
    // may be more than one finalCounts row for this productId (e.g. across sessions) - the requirement
    // is that SOME row actually carries this scan's own event id.
    const rowsForProduct = st.finalCounts.filter((c) => c.productId === product.id);
    expect(rowsForProduct.length).toBeGreaterThan(0);
    const ownEventLanded = rowsForProduct.some(
      (c) => Array.isArray(c.scanEventIds) && c.scanEventIds.includes(event!.id),
    );
    expect(ownEventLanded).toBe(true);
    // The total quantity across all rows for this product actually grew from the pre-existing
    // (corrupted) 3 - it must not stay stuck at 3, which is what "the fallback trusted the existing
    // count and did nothing" looks like.
    const totalQty = rowsForProduct.reduce((sum, c) => sum + (c.quantity ?? 0), 0);
    expect(totalQty).toBeGreaterThan(3);
  });

  it("a repeat scan of an UNKNOWN code with a corrupted provisional ledger entry still counts the new physical scan, not just the old one", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = "0490000290999999";
    // Seed a provisional (unverified) product already "counted" under a corrupted ledger row for this
    // exact code, simulating an earlier scan that left the ledger damaged.
    const state = useScanStore.getState();
    const provisional: Product = {
      id: "prod-finding2-provisional",
      businessId: state.businessId,
      name: "Unidentified item",
      brand: "",
      category: "",
      specsShort: "",
      specsFull: "",
      primarySku: "",
      primaryBarcode: code,
      gtin: "",
      upc: "",
      ean: "",
      vendorCodes: [],
      aliases: [],
      imageUrl: "",
      productUrl: "",
      location: "",
      notes: "",
      status: "active",
      source: "ai_gemini",
      confidence: 0,
      verified: false,
      provisional: true,
      provenanceTier: "provisional",
      createdAt: "2026-08-16T00:00:00.000Z",
      createdBy: "ai",
      updatedAt: "2026-08-16T00:00:00.000Z",
      updatedBy: "ai",
    } as Product;
    const brokenCount = {
      id: "count-finding2-provisional",
      businessId: state.businessId,
      sessionId: state.sessionId,
      productId: provisional.id,
      quantity: 1,
      lastScannedAt: "2026-08-16T00:00:00.000Z",
      aliasesSeen: null,
      scanEventIds: null,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
      syncStatus: "synced",
      syncError: null,
      appliedIdempotencyKeys: null,
    } as unknown as InventoryCount;
    useScanStore.setState((s) => ({
      products: [...s.products, provisional],
      finalCounts: [...s.finalCounts, brokenCount],
    }));

    const before = useScanStore.getState().finalCounts.find((c) => c.productId === provisional.id)?.quantity ?? 0;
    let event: (ReturnType<typeof useScanStore.getState>["processScan"] extends (i: string) => infer R ? R : never) | undefined;
    expect(() => {
      event = useScanStore.getState().processScan(code);
    }).not.toThrow();

    const st = useScanStore.getState();
    expect(event).toBeTruthy();
    expect(st.scanFeed.some((e) => e.id === event!.id)).toBe(true);
    const totalQtyForCode = st.finalCounts
      .filter((c) => [provisional.id].includes(c.productId))
      .reduce((sum, c) => sum + (c.quantity ?? 0), 0);
    expect(totalQtyForCode).toBeGreaterThan(before);
  });
});
