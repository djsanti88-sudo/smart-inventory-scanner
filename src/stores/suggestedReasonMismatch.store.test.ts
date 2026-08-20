import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Regression for the owner-reported live-preview bug (BUG 3, 115-code run):
//
//   Code 840139632174 (present in the tire corpus as Fortune FSR602): the feed row showed
//   Product = "Unidentified item", Brand = "-", Status = "Suggested", YET Reason = "Verified from the
//   trusted tire knowledge base (exact barcode). No AI lookup needed." - a corpus decode that settled
//   as VERIFIED with a full identity, but whose review could not cleanly resolve (identity-merge
//   suggest_link / dedup conflict), left the feed row displaying a "Verified..." reason string over a
//   badge that says "Suggested" - a direct contradiction of the same invariant verifiedNameBurst.store
//   .test.ts pins for the NAME (never show the placeholder name under a "verified" badge). This test
//   pins the REASON/BADGE consistency invariant: the reason text must always match the badge's tier -
//   never a "Verified..."/"No AI lookup needed" reason under a "suggested" (or any non-verified) badge.
//
// ROOT CAUSE (traced, not assumed): runLiveDecodeOnce (scanStore.ts) writes the scanFeed row's `reason`
// unconditionally from the raw decode `decision.reason` the INSTANT the decode response lands (see the
// scanFeed map ~line 2258), even though the SAME block downgrades a raw "verified" decodeStatus to
// "suggested" for display purposes ("BUG FIX (verified-shows-Unidentified, burst report)" comment).
// That leaves the row broadcasting the corpus's "Verified... No AI lookup needed." text under a
// "suggested" badge from the moment the response lands - a contradiction that PERSISTS unless
// resolveUnknown's identity-merge suggest_link branch (~line 3358) or dedup-conflict branch (~line
// 3382) later corrects the reason. Neither branch touches scanFeed's `reason` field, only
// needsReviewQueue fields (suggestedLinkProductId/decodeStatus) or scanFeed's `status`/`decodeStatus` -
// so the stale "Verified..." reason string survives untouched on the feed row forever.
describe("scanStore - a corpus-verified decode that cannot cleanly resolve never shows a Verified reason on a non-verified badge", () => {
  it("second same-brand/similar-name tire (identity-merge suggest_link) shows a suggested-tier reason, never the corpus verified reason, on its suggested-badged row", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true, scanContext: "tire" });

    const FIRST_CODE = "029142712886"; // valid UPC-A check digit
    const SECOND_CODE = "029142712909"; // different valid UPC-A, same brand/model family

    function verifiedCorpusResponse(opts: { code: string; productName: string }) {
      return {
        providerNames: ["tire-corpus"],
        results: [
          {
            productName: opts.productName,
            brand: "Cooper",
            category: "Tire",
            specsShort: "265/70R17",
            specsFull: "265/70R17 112T",
            primarySku: "",
            primaryBarcode: opts.code,
            gtin: "",
            upc: opts.code,
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

    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const code: string = body.cleanCode ?? body.rawCode ?? "";
      if (code === FIRST_CODE) {
        return { ok: true, json: async () => verifiedCorpusResponse({ code: FIRST_CODE, productName: "Discoverer AT3 XLT" }) };
      }
      if (code === SECOND_CODE) {
        // Same corpus name/brand/size as the first tire (two different case-pack/encoding barcodes
        // resolving to the identical corpus row) - a realistic identity-merge suggest_link trigger
        // (Jaccard 1.0, same size, DIFFERENT barcode so no canonical-GTIN auto_link is possible).
        return { ok: true, json: async () => verifiedCorpusResponse({ code: SECOND_CODE, productName: "Discoverer AT3 XLT" }) };
      }
      return { ok: true, json: async () => ({ providerNames: [], results: [], decision: { status: "needs_review", confidence: 0, reason: "no fixture" } }) };
    }) as unknown as typeof fetch;

    try {
      // Scan the first tire and let it fully resolve (mints a real, verified, non-provisional product).
      store.getState().processScan(FIRST_CODE);
      await vi.waitFor(() => {
        const row = store.getState().scanFeed.find((e) => e.cleanCode === FIRST_CODE);
        expect(row?.decodeStatus === "verified" || row?.decodeStatus === "suggested").toBe(true);
      }, { timeout: 10000, interval: 25 });

      // Scan the second, similarly-named same-brand tire. Its corpus decode also settles "verified", but
      // findIdentityMerge should route it to suggest_link (fuzzy brand+name match against the first tire,
      // never auto-linked) - the review stays open with a one-tap suggestion instead of counting a fresh
      // verified product. The scanFeed row must therefore show a "suggested" (or otherwise non-verified)
      // badge, and critically, its `reason` field must NEVER be the raw corpus "Verified... No AI lookup
      // needed" string once the badge is not "verified".
      store.getState().processScan(SECOND_CODE);
      await vi.waitFor(() => {
        const row = store.getState().scanFeed.find((e) => e.cleanCode === SECOND_CODE);
        expect(row?.decodeStatus).not.toBe("decoding");
      }, { timeout: 10000, interval: 25 });

      const secondRow = store.getState().scanFeed.find((e) => e.cleanCode === SECOND_CODE);
      expect(secondRow, "scan feed row for the second code must exist").toBeTruthy();

      if (secondRow!.decodeStatus !== "verified") {
        expect(
          secondRow!.reason ?? "",
          `row badge is "${secondRow!.decodeStatus}" but reason is "${secondRow!.reason}" - a non-verified badge must never carry the corpus's "Verified...No AI lookup needed" reason`,
        ).not.toMatch(/No AI lookup needed/i);
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});
