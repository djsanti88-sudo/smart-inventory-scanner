import { describe, it, expect, vi, afterEach } from "vitest";
import { MockDb } from "@/services/mockDb";

// Catalog revocation round (design §2.3): markWrong fires a best-effort, non-blocking dispute
// report to POST /api/catalog-dispute, mirroring how correctionRecheck is invoked as a trailing
// side-effect (never delaying or failing the local count-transfer correction). Local `fetch` is
// stubbed for every call this store makes (ai-lookup's correctionRecheck AND the new dispute
// call) so this suite never touches the network or burns AI tokens. getSession() is mocked to a
// signed-in user (unit tests run with no real Firebase Auth session - getSession() genuinely
// resolves null here otherwise, which would make every dispute call a silent, untested no-op).

const mockUser = { getIdToken: vi.fn().mockResolvedValue("fake-id-token") };
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSession: vi.fn().mockResolvedValue(mockUser) };
});

// Imported AFTER the mock so scanStore picks up the mocked getSession.
const { createTestScanStore } = await import("@/stores/scanStore");

function seedKnown(store: ReturnType<typeof createTestScanStore>, code: string) {
  const s = store.getState();
  const productId = "seed-wrong-dispute-1";
  store.setState((prev) => ({
    products: [...prev.products, {
      id: productId, businessId: s.businessId, name: "Wrongly Mapped Tire", brand: "Cooper", category: "tire",
      specsShort: "", specsFull: "", primarySku: "", primaryBarcode: code, gtin: "", upc: "", ean: "",
      vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active",
      source: "seed", confidence: 1, verified: true, createdAt: s.sessionId, updatedAt: s.sessionId, createdBy: "seed", updatedBy: "seed",
    }],
    aliases: [...prev.aliases, {
      id: "alias-wrong-dispute-1", businessId: s.businessId, productId, rawCodeExample: code, cleanCode: code,
      normalizedCode: code, aliasType: "barcode", source: "seed", confidence: 1, approved: true,
      createdAt: s.sessionId, updatedAt: s.sessionId, createdBy: "seed", lastSeenAt: s.sessionId,
      syncStatus: "synced", idempotencyKey: "seed-alias-wrong-dispute-1",
    }],
  }));
  return productId;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("markWrong fires a fire-and-forget /api/catalog-dispute report", () => {
  it("calls fetch('/api/catalog-dispute') exactly once with the scanned code and businessId in the body", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    globalThis.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      calls.push({ url: u, body: String(init?.body ?? "") });
      if (u.includes("/api/ai-lookup")) {
        return Promise.resolve(new Response(JSON.stringify({ decision: { status: "insufficient_evidence" }, results: [] }), { status: 200 }));
      }
      if (u.includes("/api/catalog-dispute")) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, disputeCount: 1, changed: true }), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const code = "049000006346";
    const productId = seedKnown(store, code);
    store.getState().processScan(code);

    await store.getState().markWrong(productId, { reason: "test" });
    // Fire-and-forget: allow the trailing microtask to run.
    await new Promise((r) => setTimeout(r, 0));

    const disputeCalls = calls.filter((c) => c.url.includes("/api/catalog-dispute"));
    expect(disputeCalls).toHaveLength(1);
    const body = JSON.parse(disputeCalls[0].body);
    expect(body.normalizedBarcode).toBe(code);
    expect(body.businessId).toBe(store.getState().businessId);
  });

  it("markWrong still completes its local state transition even when the dispute fetch rejects/times out", async () => {
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/api/catalog-dispute")) {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve(new Response(JSON.stringify({ decision: { status: "insufficient_evidence" }, results: [] }), { status: 200 }));
    }) as unknown as typeof fetch;

    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const code = "049000006346";
    const productId = seedKnown(store, code);
    store.getState().processScan(code);
    store.getState().processScan(code);

    const total = () => store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);
    expect(total()).toBe(2);

    await expect(store.getState().markWrong(productId, { reason: "test" })).resolves.not.toThrow();
    await new Promise((r) => setTimeout(r, 0));

    // Local correction (count transfer to the Unidentified provisional) still happened.
    expect(total(), "physical quantity is invariant even when the dispute report fails").toBe(2);
    expect(store.getState().finalCounts.some((c) => c.productId === productId)).toBe(false);
  });

  it("does not call the dispute endpoint when there is no resolvable code", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      calls.push(u);
      return Promise.resolve(new Response(JSON.stringify({ decision: { status: "insufficient_evidence" }, results: [] }), { status: 200 }));
    }) as unknown as typeof fetch;

    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    // A product with no counted quantity / no seen codes and no primaryBarcode - markWrong's
    // existing `code` derivation (seenCodes[0] || product?.primaryBarcode || "") resolves to "".
    const s = store.getState();
    const productId = "seed-no-code";
    store.setState((prev) => ({
      products: [...prev.products, {
        id: productId, businessId: s.businessId, name: "No Barcode Product", brand: "", category: "",
        specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "",
        vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active",
        source: "seed", confidence: 1, verified: true, createdAt: s.sessionId, updatedAt: s.sessionId, createdBy: "seed", updatedBy: "seed",
      }],
    }));

    await store.getState().markWrong(productId, { reason: "test" });
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.some((u) => u.includes("/api/catalog-dispute"))).toBe(false);
  });

  it("no session available: markWrong still completes locally and never calls the dispute endpoint", async () => {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValueOnce(null);

    const calls: string[] = [];
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      calls.push(u);
      return Promise.resolve(new Response(JSON.stringify({ decision: { status: "insufficient_evidence" }, results: [] }), { status: 200 }));
    }) as unknown as typeof fetch;

    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const code = "049000006346";
    const productId = seedKnown(store, code);
    store.getState().processScan(code);

    await store.getState().markWrong(productId, { reason: "test" });
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.some((u) => u.includes("/api/catalog-dispute"))).toBe(false);
    expect(store.getState().finalCounts.some((c) => c.productId === productId)).toBe(false);
  });
});
