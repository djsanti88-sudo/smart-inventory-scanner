import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Bug: scanFeed[].decodeNote is set once, synchronously at scan time, to "Decoding with AI..."
// (evaluateAutoDecode's allowed:true reason) and is never refreshed once the decode settles. The
// needsReviewQueue row's decodeNote IS updated on settle (see the gptSkipNote path in
// scanStore.gptLadder.test.ts), but the scanFeed row that LiveScanFeed actually renders for
// platformOwner is not - so the note stays stuck forever, even after the row shows a final
// status/reason. See .superpowers/sdd/goupc-cap-rootcause.md item 3.

const VERIFIED = {
  providerNames: ["gemini", "openai"],
  results: [
    {
      productName: "Coca-Cola Classic",
      brand: "Coca-Cola",
      upc: "878106003504",
      sourceUrls: ["https://gs1.org/878106003504"],
      verifiedFacts: [],
      guesses: [],
      aliases: [],
      confidence: 0.97,
    },
  ],
  decision: {
    status: "verified",
    confidence: 0.97,
    reason: "Verified AI Decode",
    evidenceStrength: "snippet",
    exactCodeEvidenceVerifiedByApp: true,
    crossCheck: { decision: "agree" },
  },
};
const SUGGESTED = {
  providerNames: ["gemini", "openai"],
  results: [
    {
      productName: "Maybe Snack",
      brand: "Generic",
      sourceUrls: [],
      verifiedFacts: [],
      guesses: ["guess"],
      aliases: [],
      confidence: 0.5,
    },
  ],
  decision: {
    status: "suggested",
    confidence: 0.5,
    reason: "Suggested, not trusted.",
    evidenceStrength: "url_only",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: { decision: "agree" },
  },
};
const NEEDS_REVIEW = {
  providerNames: ["gemini"],
  results: [{ productName: "", brand: "", sourceUrls: [], verifiedFacts: [], guesses: [], aliases: [], confidence: 0 }],
  decision: {
    status: "needs_review",
    confidence: 0,
    reason: "No provider returned a usable product",
    evidenceStrength: "none",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: { decision: "single_provider" },
  },
};

function stub(resp: object) {
  const original = globalThis.fetch;
  const spy = vi.fn(async () => ({ ok: true, json: async () => resp })) as unknown as typeof fetch;
  globalThis.fetch = spy;
  return { spy, restore: () => (globalThis.fetch = original) };
}

function aggressiveStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true });
  return store;
}

function feedRow(store: ReturnType<typeof aggressiveStore>, code: string) {
  return store.getState().scanFeed.find((e) => e.cleanCode === code);
}

describe("scanFeed decodeNote must not stay stuck on 'Decoding with AI...' after settle", () => {
  it("while the decode is genuinely in flight, the scanFeed row shows the in-flight note", () => {
    const store = aggressiveStore();
    const { spy, restore } = stub(VERIFIED);
    try {
      store.getState().processScan("DN0000000001");
      // Synchronously right after processScan, before the mocked fetch has resolved, the row is
      // still "decoding" and the in-flight note is the honest, non-stale state.
      const row = feedRow(store, "DN0000000001")!;
      expect(row.decodeStatus).toBe("decoding");
      expect(row.decodeNote).toBe("Decoding with AI...");
    } finally {
      restore();
    }
    void spy;
  });

  it("a needs_review settle (no suggestion) clears the stale 'Decoding with AI...' scanFeed decodeNote", async () => {
    const store = aggressiveStore();
    const { restore } = stub(NEEDS_REVIEW);
    try {
      store.getState().processScan("DN0000000002");
      await vi.waitFor(() => expect(feedRow(store, "DN0000000002")!.decodeStatus).toBe("needs_review"));
    } finally {
      restore();
    }
    const row = feedRow(store, "DN0000000002")!;
    expect(row.decodeNote).not.toBe("Decoding with AI...");
  });

  it("a suggested-tier settle clears the stale scanFeed decodeNote", async () => {
    const store = aggressiveStore();
    const { restore } = stub(SUGGESTED);
    try {
      store.getState().processScan("DN0000000003");
      await vi.waitFor(() => expect(feedRow(store, "DN0000000003")!.decodeStatus).toBe("suggested"));
    } finally {
      restore();
    }
    const row = feedRow(store, "DN0000000003")!;
    expect(row.decodeNote).not.toBe("Decoding with AI...");
  });

  it("an auto-count verified settle clears the stale scanFeed decodeNote (markFeedRowVerified path)", async () => {
    const store = aggressiveStore();
    const { restore } = stub(VERIFIED);
    try {
      store.getState().processScan("878106003504");
      await vi.waitFor(() => expect(feedRow(store, "878106003504")!.decodeStatus).toBe("verified"));
    } finally {
      restore();
    }
    const row = feedRow(store, "878106003504")!;
    expect(row.decodeNote).not.toBe("Decoding with AI...");
  });
});
