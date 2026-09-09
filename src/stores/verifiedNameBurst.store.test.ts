import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/sync-database/mock/mockDb";

// Regression for the owner-reported burst bug: scanning ~100 tire barcodes rapidly against the Vercel
// preview showed MANY feed rows with Product = "Unidentified item (barcode <CODE>)" while
// Status = "Verified match" / Reason = "Verified from the trusted tire knowledge base (exact barcode).
// No AI lookup needed." The corpus/decode result for these codes has a full resolved identity
// (brand/model/specs) - the row's displayed NAME should be that resolved identity, never the
// provisional placeholder text, once decodeStatus is "verified".
//
// Root cause candidate under investigation: `ensureProvisionalCount` (scanStore.ts) synchronously flips
// a scan's feed row `status` to "known" and counts it against a provisional "Unidentified item" product.
// The LATER verified-decode auto-count path calls `resolveUnknown(reviewId, "create_new", ...)`, which
// (in the common case) finds the review's own placeholder via `provOrphanId` and upgrades that SAME
// product row in place (id unchanged) - so the feed row's `matchedProductId` lookup naturally shows the
// new name with no relink needed. But `resolveUnknown`'s explicit scanFeed relink block only rewrites
// rows whose `status` is "unknown" | "needs_review" | "conflict" - never "known" - so if `provOrphanId`
// ever fails to resolve to the SAME row under burst conditions, a FRESH product is minted with a
// different id, and the original feed row (still pointing at the OLD placeholder id) is left permanently
// showing the placeholder name while `markFeedRowVerified` (called right after) flips its badge to
// "Verified match" - producing exactly the owner's symptom.
//
// This test drives a REAL burst of N distinct verified-tire decodes concurrently (bounded decode queue,
// MAX_CONCURRENT_DECODES = 2, exactly like production) and asserts EVERY resolved feed row's DISPLAYED
// product name (via matchedProductId -> product.name, the same lookup LiveScanFeed.tsx uses) is the real
// decoded tire name - never the "Unidentified item" placeholder - whenever decodeStatus is "verified".

interface TireFixture {
  code: string;
  productName: string;
  brand: string;
  specsShort: string;
}

function upcCheckDigit(first11: string): string {
  let sumOdd = 0;
  let sumEven = 0;
  for (let i = 0; i < 11; i++) {
    const d = Number(first11[i]);
    if (i % 2 === 0) sumOdd += d;
    else sumEven += d;
  }
  const total = sumOdd * 3 + sumEven;
  return String((10 - (total % 10)) % 10);
}

const TIRES: TireFixture[] = Array.from({ length: 24 }, (_, i) => {
  const n = i + 1;
  const first11 = `0291427${String(10000 + n).slice(1)}`; // 7 fixed digits + 4-digit running index = 11 digits
  const code = first11 + upcCheckDigit(first11);
  return {
    code,
    productName: `Cooper Discoverer A/T3 30${n}/70R16 124/121R`,
    brand: "Cooper",
    specsShort: `30${n}/70R16 124/121R`,
  };
});

function verifiedResponseFor(t: TireFixture) {
  return {
    providerNames: ["tire-corpus"],
    results: [
      {
        productName: t.productName,
        brand: t.brand,
        category: "Tire",
        specsShort: t.specsShort,
        specsFull: "",
        primarySku: "",
        primaryBarcode: t.code,
        gtin: "",
        upc: t.code,
        ean: "",
        aliases: [],
        imageUrl: "",
        productUrl: "",
        sourceUrls: ["trusted-corpus"],
        confidence: 0.95,
        verifiedFacts: [],
        guesses: [],
      },
    ],
    decision: {
      status: "verified",
      confidence: 0.95,
      reason: "Verified from the trusted tire knowledge base (exact barcode). No AI lookup needed.",
      evidenceStrength: "fetched_source",
      exactCodeEvidenceVerifiedByApp: true,
      crossCheck: { decision: "single_provider" },
    },
  };
}

function stubPerCode(fixtures: TireFixture[]) {
  const byCode = new Map(fixtures.map((t) => [t.code, t]));
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const code: string = body.cleanCode ?? body.rawCode ?? "";
    const t = byCode.get(code);
    if (!t) {
      return {
        ok: true,
        json: async () => ({ providerNames: [], results: [], decision: { status: "needs_review", confidence: 0, reason: "no fixture" } }),
      };
    }
    return { ok: true, json: async () => verifiedResponseFor(t) };
  }) as unknown as typeof fetch;
  return { restore: () => (globalThis.fetch = original) };
}

function tireAiStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true, scanContext: "tire" });
  return store;
}

describe("scanStore - rapid burst of verified tire decodes never leaves a feed row showing the Unidentified placeholder", () => {
  it("scans N distinct tire codes back-to-back (no waiting between scans) and every VERIFIED row displays its real resolved name", async () => {
    const store = tireAiStore();
    const { restore } = stubPerCode(TIRES);
    try {
      // Fire every scan synchronously, back-to-back, exactly like a scanner gun burst - no await between
      // scans. This is the real-world condition: ensureProvisionalCount runs synchronously for each, then
      // the bounded decode queue (2 concurrent) works through the backlog asynchronously.
      for (const t of TIRES) {
        store.getState().processScan(t.code);
      }

      // Wait until the bounded decode queue has fully drained (every review has left "decoding" /
      // the transient "suggested" placeholder state the fast pass leaves while a fetch is in flight).
      // NOTE: this does NOT require every review to end up "resolved" - many of these fixture tires
      // share the same brand+model (only the size token differs), so the identity-merge fuzzy
      // suggest_link path is EXPECTED to leave most of them open for a human "link to existing
      // product?" decision once the first one resolves. That is correct, intentional behavior (never
      // auto-guess a fuzzy match) - the bug under test is specifically about the BADGE lying about
      // rows that stayed open, not about how many end up open.
      await vi.waitFor(
        () => {
          const stillDecoding = store
            .getState()
            .needsReviewQueue.some((r) => r.status === "open" && r.decodeStatus === "decoding");
          expect(stillDecoding).toBe(false);
        },
        { timeout: 15000, interval: 25 },
      );
      // Small grace period: the last in-flight resolveUnknown/markFeedRowVerified pair runs
      // synchronously within the same microtask as the fetch resolution, so no extra wait is needed
      // beyond the queue-drained signal above.
    } finally {
      restore();
    }

    const getProduct = store.getState().getProduct;
    const failures: string[] = [];
    for (const t of TIRES) {
      const rows = store.getState().scanFeed.filter((e) => e.cleanCode === t.code);
      expect(rows.length, `exactly one feed row for code ${t.code}`).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        if (row.decodeStatus !== "verified") continue;
        const product = getProduct(row.matchedProductId);
        const displayName = product?.name ?? "-";
        // THE CORE REGRESSION CHECK: a row badged "Verified match" must never display the provisional
        // placeholder text - the exact owner-reported symptom. (We don't require byte-exact equality to
        // the raw decoded productName: the app legitimately restructures a redundant brand prefix out of
        // the display name via safeStructuredFieldsFor - e.g. "Cooper Discoverer A/T3 ..." -> name
        // "Discoverer A/T3" + structuredBrand "Cooper". That is correct, unrelated behavior.)
        if (displayName.includes("Unidentified item")) {
          failures.push(
            `code ${t.code}: decodeStatus=verified reason="${row.reason}" but displayName="${displayName}" (still the placeholder - expected the real tire "${t.productName}")`,
          );
        }
      }
    }
    expect(failures, `every Verified row must display its real resolved product name, never the placeholder:\n${failures.join("\n")}`).toEqual([]);
  });
});
