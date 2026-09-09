import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/sync-database/mock/mockDb";

// Owner-reported live bug (2026-07-21, 310-row review): rows 049000242201 / 049000245462 (real
// TIRES, decoded names carrying descriptive tire text like "Entry level") showed Brand "Coca-Cola" -
// 049000 is Coca-Cola's real GS1 company prefix. Root cause: ensureProvisionalCount (the SYNCHRONOUS,
// pre-decode mint every scan takes per the TOP-LEVEL LAW) writes brand: floor?.brand ?? "" from the
// statistical prefix->brand floor (prefixFloorName) BEFORE any decode runs. When the LATER decode
// lands with a real product name but no separate brand field, the "hasUsableName" upgrade branch
// (scanStore.ts processScan) ran enrichProductIdentity with `existing.brand: p.brand` - and because
// the floor had already written a NON-EMPTY brand, the fill-if-empty contract treated the prefix
// floor's statistical guess as if it were an authoritative, human/decode-set value and refused to
// ever overwrite it - permanently locking in the wrong brand next to the correct decoded name.
//
// Fix rule (owner mandate): a statistical prefix-floor brand may ONLY fill a brand that is empty AND
// only when the name-parse also found no brand; it must NEVER override a scanned/parsed/decode-payload
// brand, and once any OTHER source (a real decode, a human) sets brand, the floor never touches it
// again. A brand that is STILL just the floor's own guess (the row's name is still exactly the floor's
// own placeholder / bare-unidentified label) is not "another source" and must yield to the decode.
//
// This uses seed prefix 0051596 ("United Solutions") - the same anchor prefixFloorCollision.store.test
// uses - so no server-only derived-tier data is needed to reproduce the bug deterministically offline.
function stubDecode(resp: object) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => resp })) as unknown as typeof fetch;
  return { restore: () => (globalThis.fetch = original) };
}

function aiStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true });
  return store;
}

describe("prefix floor brand must never lock out a later decode's real identity", () => {
  it("a code whose GS1 prefix maps to a floor brand, later decoded with a real (differently-branded-or-brandless) product name, does NOT keep the floor's brand forever", async () => {
    const code = "051596000004"; // seed prefix 0051596 -> "United Solutions" floor brand
    const store = aiStore();

    // Decode lands with a REAL, usable product name but NO brand field of its own (the exact owner-
    // reported shape: a name-only decode payload) - and that name shares NOTHING with "United Solutions".
    const DECODE_RESP = {
      providerNames: ["gpt-5.4-mini"],
      results: [{
        productName: "Entry Level All Season Passenger Tire 205/55R16",
        brand: "", category: "", specsShort: "", specsFull: "",
        primarySku: "", primaryBarcode: code, gtin: "", upc: code, ean: "",
        aliases: [], imageUrl: "", productUrl: "", sourceUrls: [], confidence: 0.5,
        verifiedFacts: [], guesses: [],
      }],
      decision: {
        status: "suggested", confidence: 0.5, reason: "unverified", evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider" },
      },
    };
    // The decode fetch fires synchronously (fire-and-forget) INSIDE processScan itself - the stub must
    // be installed BEFORE the scan, not after (a scan/waitFor-then-stub ordering misses the real call
    // and the decode falls through to a genuine network-error path in the test environment).
    const { restore } = stubDecode(DECODE_RESP);
    try {
      // Pre-decode (synchronous, same tick): ensureProvisionalCount mints the row with the floor's brand.
      store.getState().processScan(code);
      const beforeDecode = store.getState().products.find((p) =>
        [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].includes(code),
      );
      expect(beforeDecode, "the scan is counted immediately (TOP-LEVEL LAW)").toBeDefined();
      expect(beforeDecode!.brand, "sanity: the floor's statistical brand guess was written pre-decode").toBe(
        "United Solutions",
      );

      await vi.waitFor(() => {
        const p = store.getState().products.find((prod) =>
          [prod.primaryBarcode, prod.gtin, prod.upc, prod.ean, prod.primarySku].includes(code),
        );
        expect(p?.name).toContain("Entry Level");
      });
    } finally {
      restore();
    }

    const after = store.getState().products.find((p) =>
      [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].includes(code),
    );
    expect(after, "the row still exists after decode").toBeDefined();
    expect(after!.name).toContain("Entry Level");
    // THE KEY ASSERTION: the floor's stale statistical brand guess must NOT survive a real decode that
    // carried no brand of its own and whose name has no relation to "United Solutions".
    expect(
      after!.brand,
      "the prefix floor's guessed brand must not be locked in over a genuinely decoded (brandless) product",
    ).toBe("");
  });
});
