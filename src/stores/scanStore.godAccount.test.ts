import { describe, it, expect, afterEach, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// GOD CLIENT (owner-approved 2026-08-07, impl-boss-god-rate.md #3): evaluateAutoDecode must not
// self-block the platform owner's own scans on the cap/breaker/emergency-stop gates - the client
// platformOwner hint (SAME allowlist `useAccessLevel`/`useIsPlatformOwner` already expose, keyed off
// NEXT_PUBLIC_PLATFORM_OWNER_UIDS/EMAILS) lets the client always attempt a decode; the SERVER remains
// the real security authority (isGod re-derived there from a verified token, per inv-god-account.md).
// Every other client gate (AI off, server live-disabled, auto-decode off, offline, missing keys) still
// applies unchanged for god and non-god alike - those are real preconditions, not caps/breaker/emergency.

const GOD_UID = "nDPz45mqDMaaucovnl4y5v5vhSH3"; // fixture uid from security.test.ts (the owner's real identity)
const FIXED_NOW_ISO = "2026-06-12T10:00:00.000Z";
const FIXED_NOW_MS = Date.parse(FIXED_NOW_ISO);

const VERIFIED = {
  providerNames: ["gemini", "openai"],
  results: [{ productName: "Coca-Cola Classic", brand: "Coca-Cola", upc: "878106003504", sourceUrls: ["https://gs1.org/878106003504"], verifiedFacts: [], guesses: [], aliases: [], confidence: 0.97 }],
  decision: { status: "verified", confidence: 0.97, reason: "Verified AI Decode", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "agree" } },
};

function stub(resp: object) {
  const original = globalThis.fetch;
  const spy = vi.fn(async () => ({ ok: true, json: async () => resp })) as unknown as typeof fetch;
  globalThis.fetch = spy;
  return { spy: spy as unknown as ReturnType<typeof vi.fn>, restore: () => (globalThis.fetch = original) };
}

function baseStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true, scanContext: "any" });
  return store;
}

function lastReview(store: ReturnType<typeof baseStore>) {
  return store.getState().needsReviewQueue.at(-1)!;
}

function setGodIdentity(store: ReturnType<typeof baseStore>) {
  process.env.NEXT_PUBLIC_PLATFORM_OWNER_UIDS = GOD_UID;
  store.setState({ userId: GOD_UID });
}

function setNonGodIdentity(store: ReturnType<typeof baseStore>) {
  process.env.NEXT_PUBLIC_PLATFORM_OWNER_UIDS = GOD_UID; // allowlist still set...
  store.setState({ userId: "some-other-customer-uid" }); // ...but this identity is not on it
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_PLATFORM_OWNER_UIDS;
  delete process.env.NEXT_PUBLIC_PLATFORM_OWNER_EMAILS;
  delete process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER;
});

describe("GOD CLIENT: platformOwner bypasses client-side cap/breaker/emergency-stop pre-blocks", () => {
  it("emergency stop: platformOwner still attempts decode; a non-owner is blocked", async () => {
    const godStore = baseStore();
    setGodIdentity(godStore);
    godStore.getState().setEmergencyStop(true);
    const { spy, restore } = stub(VERIFIED);
    try {
      godStore.getState().processScan("878106003504");
      await vi.waitFor(() => expect(lastReview(godStore).decodeStatus).toBe("verified"));
    } finally {
      restore();
    }
    expect(spy.mock.calls.length).toBeGreaterThan(0); // FAILS red until the bypass exists

    const custStore = baseStore();
    setNonGodIdentity(custStore);
    custStore.getState().setEmergencyStop(true);
    const { spy: spy2, restore: restore2 } = stub(VERIFIED);
    try {
      custStore.getState().processScan("878106003504");
    } finally {
      restore2();
    }
    expect(spy2.mock.calls.length).toBe(0); // non-god unaffected: still blocked
    expect((lastReview(custStore).decodeNote ?? "").toLowerCase()).toMatch(/emergency|stop/);
  });

  it("daily cap reached: platformOwner still attempts decode; a non-owner is blocked", async () => {
    const godStore = baseStore();
    setGodIdentity(godStore);
    godStore.getState().updateSettings({ dailyLookupLimit: 5, dailyLookupCount: 5, lastResetDate: "2026-06-12" });
    const { spy, restore } = stub(VERIFIED);
    try {
      godStore.getState().processScan("878106003504");
      await vi.waitFor(() => expect(lastReview(godStore).decodeStatus).toBe("verified"));
    } finally {
      restore();
    }
    expect(spy.mock.calls.length).toBeGreaterThan(0); // FAILS red until the bypass exists

    const custStore = baseStore();
    setNonGodIdentity(custStore);
    custStore.getState().updateSettings({ dailyLookupLimit: 5, dailyLookupCount: 5, lastResetDate: "2026-06-12" });
    const { spy: spy2, restore: restore2 } = stub(VERIFIED);
    try {
      custStore.getState().processScan("878106003504");
    } finally {
      restore2();
    }
    expect(spy2.mock.calls.length).toBe(0);
    expect(lastReview(custStore).decodeNote ?? "").toMatch(/daily/i);
  });

  it("circuit breaker open: platformOwner still attempts decode; a non-owner is blocked", async () => {
    const godStore = baseStore();
    setGodIdentity(godStore);
    godStore.setState({ breaker: { state: "open", failures: 12, openedAt: FIXED_NOW_MS } });
    const { spy, restore } = stub(VERIFIED);
    try {
      godStore.getState().processScan("878106003504");
      await vi.waitFor(() => expect(lastReview(godStore).decodeStatus).toBe("verified"));
    } finally {
      restore();
    }
    expect(spy.mock.calls.length).toBeGreaterThan(0); // FAILS red until the bypass exists

    const custStore = baseStore();
    setNonGodIdentity(custStore);
    custStore.setState({ breaker: { state: "open", failures: 12, openedAt: FIXED_NOW_MS } });
    const { spy: spy2, restore: restore2 } = stub(VERIFIED);
    try {
      custStore.getState().processScan("878106003504");
    } finally {
      restore2();
    }
    expect(spy2.mock.calls.length).toBe(0);
    expect((lastReview(custStore).decodeNote ?? "").toLowerCase()).toMatch(/breaker/i);
  });

  it("does NOT bypass real preconditions: platformOwner is still blocked when AI lookup is off", () => {
    const godStore = baseStore();
    setGodIdentity(godStore);
    godStore.getState().updateSettings({ aiLookupEnabled: false });
    const { spy, restore } = stub(VERIFIED);
    try {
      godStore.getState().processScan("878106003504");
    } finally {
      restore();
    }
    expect(spy.mock.calls.length).toBe(0); // AI-off is a real precondition, not cap/breaker/emergency
  });
});

// FINDING 1 (adversarial review, 2026-08-07): the primary scan-time path (evaluateAutoDecode +
// runLiveDecodeOnce's internal re-check) was bypassed for platformOwner, but two OTHER decode-execution
// paths - the manual "Retry live decode" action (`lookupUnknown`) and the background deep-verify
// follow-up (`backgroundVerifyDeep`) - still called the un-bypassed `evaluateAiGate` directly,
// contradicting owner intent ("god account has no caps, limits, or anything"). These tests prove BOTH
// paths now bypass cap/breaker for a platformOwner and stay enforced for a non-owner.

function openReview(store: ReturnType<typeof baseStore>, code: string) {
  store.getState().processScan(code); // AI is off in baseStore() until enabled below -> passive review
  return store.getState().needsReviewQueue.find((r) => r.cleanCode === code && r.status === "open")!;
}

function tripBreaker(store: ReturnType<typeof baseStore>) {
  store.setState({ breaker: { state: "open", failures: 12, openedAt: FIXED_NOW_MS } });
}

describe("FINDING 1: lookupUnknown (manual retry) and backgroundVerifyDeep also bypass for platformOwner", () => {
  it("lookupUnknown: platformOwner with an OPEN circuit breaker still attempts the fetch; a non-owner is blocked", async () => {
    const godStore = createTestScanStore({ db: new MockDb() });
    const review = openReview(godStore, "086699998551");
    setGodIdentity(godStore);
    godStore.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    godStore.getState().updateSettings({ aiLookupEnabled: true });
    tripBreaker(godStore);
    const { spy, restore } = stub({ providerName: "mock", result: { productName: "X", brand: "", sourceUrls: [], verifiedFacts: [], guesses: [], aliases: [], confidence: 0 } });
    try {
      await godStore.getState().lookupUnknown(review.id);
    } finally {
      restore();
    }
    expect(spy.mock.calls.length).toBeGreaterThan(0); // FAILS red until the bypass exists

    const custStore = createTestScanStore({ db: new MockDb() });
    const review2 = openReview(custStore, "086699998552");
    setNonGodIdentity(custStore);
    custStore.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    custStore.getState().updateSettings({ aiLookupEnabled: true });
    tripBreaker(custStore);
    const { spy: spy2, restore: restore2 } = stub({});
    try {
      await custStore.getState().lookupUnknown(review2.id);
    } finally {
      restore2();
    }
    expect(spy2.mock.calls.length).toBe(0); // non-god unaffected: still blocked
  });

  it("backgroundVerifyDeep: platformOwner with an OPEN circuit breaker still attempts the fetch; a non-owner is blocked", async () => {
    const godStore = createTestScanStore({ db: new MockDb() });
    const review = openReview(godStore, "086699998553");
    setGodIdentity(godStore);
    godStore.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    godStore.getState().updateSettings({ aiLookupEnabled: true });
    tripBreaker(godStore);
    const { spy, restore } = stub({ providerNames: [], results: [], decision: { status: "needs_review", confidence: 0, reason: "no fixture" } });
    try {
      await godStore.getState().backgroundVerifyDeep(review.id);
    } finally {
      restore();
    }
    expect(spy.mock.calls.length).toBeGreaterThan(0); // FAILS red until the bypass exists

    const custStore = createTestScanStore({ db: new MockDb() });
    const review2 = openReview(custStore, "086699998554");
    setNonGodIdentity(custStore);
    custStore.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    custStore.getState().updateSettings({ aiLookupEnabled: true });
    tripBreaker(custStore);
    const { spy: spy2, restore: restore2 } = stub({});
    try {
      await custStore.getState().backgroundVerifyDeep(review2.id);
    } finally {
      restore2();
    }
    expect(spy2.mock.calls.length).toBe(0); // non-god unaffected: still blocked
  });
});

// FINDING 2 (adversarial review, 2026-08-07): the gate-bypass hint must depend ONLY on the real
// platform-owner allowlist (NEXT_PUBLIC_PLATFORM_OWNER_UIDS/EMAILS), never on
// NEXT_PUBLIC_E2E_PLATFORM_OWNER=1 (the unrelated mock-E2E full-UI-access override the 11 mock
// Playwright specs set). Otherwise every E2E mock run would silently grant the cap/breaker/emergency-
// stop bypass to an arbitrary non-owner identity.
describe("FINDING 2: NEXT_PUBLIC_E2E_PLATFORM_OWNER never grants the gate bypass", () => {
  it("E2E mock full-access flag set, but uid is NOT on the real owner allowlist: cap/breaker still enforced", async () => {
    process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER = "1"; // UI-role override only
    delete process.env.NEXT_PUBLIC_PLATFORM_OWNER_UIDS; // no real owner allowlist match
    delete process.env.NEXT_PUBLIC_PLATFORM_OWNER_EMAILS;

    const store = baseStore();
    store.setState({ userId: "some-arbitrary-e2e-mock-uid" });
    store.getState().setEmergencyStop(true);
    const { spy, restore } = stub(VERIFIED);
    try {
      store.getState().processScan("878106003504");
    } finally {
      restore();
    }
    expect(spy.mock.calls.length).toBe(0); // must stay blocked - the E2E flag is a UI-role hint only
    expect((lastReview(store).decodeNote ?? "").toLowerCase()).toMatch(/emergency|stop/);

    // Manual retry + background deep-verify paths must ALSO stay blocked under the same E2E flag.
    const review = openReview(store, "086699998555");
    tripBreaker(store);
    const { spy: spy2, restore: restore2 } = stub({});
    try {
      await store.getState().lookupUnknown(review.id);
    } finally {
      restore2();
    }
    expect(spy2.mock.calls.length).toBe(0);
  });
});
