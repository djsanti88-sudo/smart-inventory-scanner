import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Aggressive Auto Decode Mode: an unknown scan must AUTOMATICALLY run the live decode pipeline when
// AI lookup is on and a provider key is configured - not sit passively in Needs Review. These tests
// drive that behavior with mocked network so no live tokens are spent.

const VERIFIED = {
  providerNames: ["gpt-5.4-mini"],
  results: [{ productName: "Coca-Cola Classic", brand: "Coca-Cola", upc: "878106003504", sourceUrls: ["https://gs1.org/878106003504"], verifiedFacts: [], guesses: [], aliases: [], confidence: 0.97 }],
  decision: { status: "verified", confidence: 0.97, reason: "Verified AI Decode", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "agree" } },
};
const SUGGESTED = {
  providerNames: ["gpt-5.4-mini"],
  results: [{ productName: "Maybe Snack", brand: "Generic", sourceUrls: [], verifiedFacts: [], guesses: ["guess"], aliases: [], confidence: 0.5 }],
  decision: { status: "suggested", confidence: 0.5, reason: "Suggested, not trusted.", evidenceStrength: "url_only", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "agree" } },
};
const CONFLICT = {
  providerNames: ["gpt-5.4-mini"],
  results: [{ productName: "Creamer", brand: "Laird", sourceUrls: [], verifiedFacts: [], guesses: [], aliases: [], confidence: 0.5 }],
  decision: { status: "conflict", confidence: 0.2, reason: "Providers conflict.", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "conflict" } },
};

function stub(resp: object) {
  const original = globalThis.fetch;
  const spy = vi.fn(async () => ({ ok: true, json: async () => resp })) as unknown as typeof fetch;
  globalThis.fetch = spy;
  return { spy, restore: () => (globalThis.fetch = original) };
}
function failStub() {
  const original = globalThis.fetch;
  const spy = vi.fn(async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  globalThis.fetch = spy;
  return { spy, restore: () => (globalThis.fetch = original) };
}

function aggressiveStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true });
  return store;
}
function lastReview(store: ReturnType<typeof aggressiveStore>) {
  return store.getState().needsReviewQueue.at(-1)!;
}

describe("Aggressive auto-decode on scan (mocked, no live tokens)", () => {
  it("auto-calls live decode for an unknown scan when AI is on and a key is configured", async () => {
    const store = aggressiveStore();
    const { spy, restore } = stub(VERIFIED);
    try {
      store.getState().processScan("878106003504");
      await vi.waitFor(() => expect(lastReview(store).decodeStatus).toBe("verified"));
    } finally {
      restore();
    }
    expect(spy).toHaveBeenCalled();
    const call = (spy as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0];
    expect(JSON.parse(call[1].body).mode).toBe("decode");
  });

  it("sends the configured decode time budget (budgetMs) in the decode request", async () => {
    const store = aggressiveStore();
    store.getState().updateSettings({ decodeBudgetMs: 8000 });
    const { spy, restore } = stub(VERIFIED);
    try {
      store.getState().processScan("878106003504");
      await vi.waitFor(() => expect(lastReview(store).decodeStatus).toBe("verified"));
    } finally {
      restore();
    }
    const calls = (spy as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls;
    const decodeCall = calls.find((c) => JSON.parse(c[1].body).mode === "decode")!;
    expect(JSON.parse(decodeCall[1].body).budgetMs).toBe(8000);
  });

  it("updates the live scan feed row to the final decode status (Verified)", async () => {
    const store = aggressiveStore();
    const { restore } = stub(VERIFIED);
    try {
      store.getState().processScan("878106003504");
      await vi.waitFor(() => expect(store.getState().scanFeed.some((e) => e.decodeStatus === "verified")).toBe(true));
    } finally {
      restore();
    }
  });

  it("provisionally counts a suggested product; it stays in Needs Review", async () => {
    const store = aggressiveStore();
    const { restore } = stub(SUGGESTED);
    try {
      store.getState().processScan("878106003504");
      await vi.waitFor(() => expect(lastReview(store).hasSuggestion).toBe(true));
    } finally {
      restore();
    }
    expect(lastReview(store).status).toBe("suggested"); // owner-ratified 2026-07-14: suggestions bypass Needs Review (Task 9b)
    expect(store.getState().finalCounts).toHaveLength(1);
    const prov = store.getState().products.find((p) => p.name === "Maybe Snack");
    expect(prov).toBeDefined();
    expect(prov!.provisional).toBe(true);
    expect(prov!.verified).toBe(false);
  });

  it("provider conflict -> Conflict status", async () => {
    const store = aggressiveStore();
    const { restore } = stub(CONFLICT);
    try {
      store.getState().processScan("878106003504");
      await vi.waitFor(() => expect(lastReview(store).decodeStatus).toBe("conflict"));
    } finally {
      restore();
    }
  });

  it("live decode failure -> Needs Review WITH a failure reason + retry still possible", async () => {
    const store = aggressiveStore();
    const { restore } = failStub();
    try {
      store.getState().processScan("878106003504");
      await vi.waitFor(() => expect(lastReview(store).decodeStatus).toBe("needs_review"));
    } finally {
      restore();
    }
    expect(lastReview(store).reason.toLowerCase()).toMatch(/fail|error|could not/);
    expect(lastReview(store).status).toBe("open");
  });

  it("still calls server decode when paid-provider keys are missing if the server advertises free corpus/cache rungs", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: true });
    store.getState().setAiStatus({
      openaiConfigured: false,
      freeDecodeAvailable: true,
      missingKeys: ["OPENAI_API_KEY"],
    });
    const { spy, restore } = stub(VERIFIED);
    try {
      store.getState().processScan("878106003504");
      await vi.waitFor(() => expect(lastReview(store).decodeStatus).toBe("verified"));
    } finally {
      restore();
    }
    expect(spy).toHaveBeenCalled();
    const call = (spy as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0];
    expect(JSON.parse(call[1].body).mode).toBe("decode");
  });

  it("keeps the legacy no-key client block when a stale/mocked server status does not advertise free rungs", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: true });
    store.getState().setAiStatus({ openaiConfigured: false, missingKeys: ["OPENAI_API_KEY"] });
    const { spy, restore } = stub(VERIFIED);
    try {
      store.getState().processScan("878106003504");
    } finally {
      restore();
    }
    expect(spy).not.toHaveBeenCalled();
    expect(lastReview(store).decodeStatus).toBe("needs_review");
  });

  it("does NOT auto-decode when AI lookup is OFF (passive, with reason)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setAiStatus({ openaiConfigured: true });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const { spy, restore } = stub(VERIFIED);
    try {
      store.getState().processScan("878106003504");
    } finally {
      restore();
    }
    expect(spy).not.toHaveBeenCalled();
    // The "why" (AI off) is a platformOwner-only decodeNote; the customer-facing reason stays product-safe.
    expect(lastReview(store).decodeNote).toMatch(/off|disabled/i);
    expect(lastReview(store).reason).not.toMatch(/\bai\b|settings/i);
  });

  it("emergency stop blocks auto-decode with a clear reason", () => {
    const store = aggressiveStore();
    store.getState().setEmergencyStop(true);
    const { spy, restore } = stub(VERIFIED);
    try {
      store.getState().processScan("878106003504");
    } finally {
      restore();
    }
    expect(spy).not.toHaveBeenCalled();
    expect((lastReview(store).decodeNote ?? "").toLowerCase()).toMatch(/emergency|stop/);
  });

  it("refreshAiStatus is server-authoritative: stale persisted off/cap-25 -> forced on + cap 200, openai", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    // Simulate a STALE persisted client session from before AI was enabled.
    store.getState().updateSettings({ aiLookupEnabled: false, dailyLookupLimit: 25 });
    const { restore } = stub({ liveEnabled: true, autoDecodeOnScan: true, openaiConfigured: true, dailyLimit: 200, missingKeys: ["FIRECRAWL_API_KEY"] });
    try {
      await store.getState().refreshAiStatus();
    } finally {
      restore();
    }
    const s = store.getState().settings;
    expect(s.aiLookupEnabled).toBe(true);    // forced on by the server confirming a key
    expect(s.dailyLookupLimit).toBe(200);    // adopts AI_LOOKUP_DAILY_LIMIT from the server
  });

  it("refreshAiStatus (Task 6) adopts the GET response's gptDecode spend/call status", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    const { restore } = stub({
      liveEnabled: true, autoDecodeOnScan: true, openaiConfigured: true,
      dailyLimit: 200, missingKeys: [],
      gptDecode: { spentTodayUsd: 0.42, capUsd: 3, callsToday: 5, enabled: true },
    });
    try {
      await store.getState().refreshAiStatus();
    } finally {
      restore();
    }
    expect(store.getState().aiStatus.gptDecode).toEqual({ spentTodayUsd: 0.42, capUsd: 3, callsToday: 5, enabled: true });
  });

  it("refreshAiStatus keeps the PRIOR gptDecode value when a GET response omits the field (older/mocked server)", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.setState((s) => ({ aiStatus: { ...s.aiStatus, gptDecode: { spentTodayUsd: 1, capUsd: 3, callsToday: 2, enabled: true } } }));
    const { restore } = stub({ liveEnabled: true, autoDecodeOnScan: true, openaiConfigured: true, dailyLimit: 200, missingKeys: [] });
    try {
      await store.getState().refreshAiStatus();
    } finally {
      restore();
    }
    expect(store.getState().aiStatus.gptDecode).toEqual({ spentTodayUsd: 1, capUsd: 3, callsToday: 2, enabled: true });
  });

  // Spec 2 (M1, kill-switch visibility): refreshAiStatus must adopt the GET response's killSwitchOn
  // field so Settings can warn when the SERVER (not the client emergencyStop toggle) has disabled AI.
  it("refreshAiStatus (Spec 2) adopts killSwitchOn: true from the GET response", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    const { restore } = stub({ liveEnabled: true, autoDecodeOnScan: true, openaiConfigured: true, dailyLimit: 200, missingKeys: [], killSwitchOn: true });
    try {
      await store.getState().refreshAiStatus();
    } finally {
      restore();
    }
    expect(store.getState().aiStatus.killSwitchOn).toBe(true);
  });

  it("refreshAiStatus (Spec 2) defaults killSwitchOn to false when the GET response omits it", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.setState((s) => ({ aiStatus: { ...s.aiStatus, killSwitchOn: true } }));
    const { restore } = stub({ liveEnabled: true, autoDecodeOnScan: true, openaiConfigured: true, dailyLimit: 200, missingKeys: [] });
    try {
      await store.getState().refreshAiStatus();
    } finally {
      restore();
    }
    expect(store.getState().aiStatus.killSwitchOn).toBe(false);
  });

  // Silent-failure fix (review of 92e9c32c): a single per-mount refreshAiStatus fetch failure must
  // never leave the banner silently reporting "off" while the SERVER kill switch is actually on -
  // it must surface a distinct unknown/stale state instead of defaulting to a false "off".
  it("refreshAiStatus marks killSwitchStatusUnknown: true on a fetch throw, without clobbering the last-known killSwitchOn", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.setState((s) => ({ aiStatus: { ...s.aiStatus, killSwitchOn: true, killSwitchStatusUnknown: false } }));
    const { restore } = failStub();
    try {
      await store.getState().refreshAiStatus();
    } finally {
      restore();
    }
    expect(store.getState().aiStatus.killSwitchStatusUnknown).toBe(true);
    expect(store.getState().aiStatus.killSwitchOn).toBe(true); // last known value preserved, not reset to false
  });

  it("refreshAiStatus marks killSwitchStatusUnknown: true when the GET response is not ok (e.g. 500/503)", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    try {
      await store.getState().refreshAiStatus();
    } finally {
      globalThis.fetch = original;
    }
    expect(store.getState().aiStatus.killSwitchStatusUnknown).toBe(true);
  });

  it("refreshAiStatus clears killSwitchStatusUnknown on the next successful refresh (self-heal)", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.setState((s) => ({ aiStatus: { ...s.aiStatus, killSwitchStatusUnknown: true } }));
    const { restore } = stub({ liveEnabled: true, autoDecodeOnScan: true, openaiConfigured: true, dailyLimit: 200, missingKeys: [], killSwitchOn: false });
    try {
      await store.getState().refreshAiStatus();
    } finally {
      restore();
    }
    expect(store.getState().aiStatus.killSwitchStatusUnknown).toBe(false);
  });

  it("a KNOWN (approved) scan never calls AI", () => {
    const store = aggressiveStore();
    const { spy, restore } = stub(VERIFIED);
    try {
      store.getState().processScan("6419440485331"); // seed-approved alias
    } finally {
      restore();
    }
    expect(spy).not.toHaveBeenCalled();
    expect(store.getState().finalCounts.find((c) => c.productId === "prod-nokian")?.quantity).toBe(1);
  });

  it("re-scanning a human-approved alias never calls AI", () => {
    const store = aggressiveStore();
    store.getState().processScan("NEWCODE1");
    const reviewId = store.getState().needsReviewQueue.at(-1)!.id;
    store.getState().resolveUnknown(reviewId, "link_existing", { productId: "prod-coke" });
    const { spy, restore } = stub(VERIFIED);
    try {
      const ev = store.getState().processScan("NEWCODE1");
      expect(ev?.resolverStatus).toBe("known");
    } finally {
      restore();
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
