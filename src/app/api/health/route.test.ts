import { beforeEach, describe, expect, it, vi } from "vitest";

// /api/health is a public, unauthenticated uptime-monitor endpoint. It must NEVER leak secret
// values, must never throw (a hung/degraded dependency reports false, not a 500), and must stay
// fast. These tests mock the Admin SDK and Turso-backed decode storage the same way
// src/app/api/account/export/route.test.ts and src/app/api/ai-lookup/route.d4.test.ts do - no live
// Firestore/Turso involved.

const mocks = vi.hoisted(() => ({
  firestoreGet: vi.fn(),
  tursoGet: vi.fn(),
}));

vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminDb: () => ({
    collection: () => ({
      limit: () => ({
        get: mocks.firestoreGet,
      }),
    }),
  }),
}));

vi.mock("@/server/decode/storage", () => ({
  decodeStorage: async () => ({ get: mocks.tursoGet }),
}));

const ORIG_ENV = { ...process.env };

beforeEach(async () => {
  vi.resetModules();
  mocks.firestoreGet.mockReset().mockResolvedValue({ docs: [] });
  mocks.tursoGet.mockReset().mockResolvedValue(null);
  process.env = { ...ORIG_ENV };
  delete process.env.OPENAI_API_KEY;
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  delete process.env.GIT_COMMIT_SHA;
  const { __resetForTest } = await import("@/services/security/aiSpendGuard");
  __resetForTest();
});

describe("GET /api/health", () => {
  it("returns 200 with ok:true and boolean-only fields when firestore/turso are reachable and keys are present", async () => {
    process.env.OPENAI_API_KEY = "sk-real-openai-secret-value-67890";
    process.env.VERCEL_GIT_COMMIT_SHA = "abc1234";
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x/api/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.firestore).toBe(true);
    expect(body.turso).toBe(true);
    expect(body.aiKeys).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(typeof body.timestamp).toBe("string");
    expect(new Date(body.timestamp).toString()).not.toBe("Invalid Date");
    expect(body.version).toBe("abc1234");
  });

  it("degrades to firestore:false and ok:false (never throws / never 500) when Firestore is unreachable", async () => {
    mocks.firestoreGet.mockRejectedValue(new Error("ECONNREFUSED: firestore down"));
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x/api/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.firestore).toBe(false);
    expect(body.ok).toBe(false);
  });

  it("degrades to turso:false and ok:false (never throws) when decode storage is unreachable", async () => {
    mocks.tursoGet.mockRejectedValue(new Error("Turso: connection reset"));
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x/api/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.turso).toBe(false);
    expect(body.ok).toBe(false);
  });

  it("degrades to turso:false on a slow/hung backend (timeout, not a hang)", async () => {
    process.env.HEALTH_TURSO_TIMEOUT_MS = "5";
    mocks.tursoGet.mockImplementation(() => new Promise(() => {})); // never resolves
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x/api/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.turso).toBe(false);
  });

  it("reports aiKeys:false when no server AI provider keys are configured, without failing ok on that alone", async () => {
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x/api/health"));
    const body = await res.json();
    expect(body.aiKeys).toBe(false);
    // aiKeys is advisory only - firestore/turso (both reachable in this test's default mocks)
    // are the critical checks, so ok stays true even with no keys configured.
    expect(body.ok).toBe(true);
  });

  it("never leaks the raw value of any secret/env var in the response body", async () => {
    process.env.OPENAI_API_KEY = "sk-super-secret-openai-value-should-never-leak";
    process.env.TURSO_DATABASE_URL = "libsql://super-secret-host.example.com";
    process.env.TURSO_AUTH_TOKEN = "super-secret-turso-auth-token-value";
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{"private_key":"super-secret-pem-value"}';
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x/api/health"));
    const rawText = await res.text();
    expect(rawText).not.toContain("super-secret");
    expect(rawText).not.toContain("libsql://");
    expect(rawText).not.toContain("private_key");
    // booleans/numbers/short strings only - never an env var VALUE.
    const parsed = JSON.parse(rawText);
    for (const value of Object.values(parsed)) {
      if (typeof value === "string") {
        expect(value.length).toBeLessThan(64);
      }
    }
  });

  it("rate-limits repeated requests from the same IP (429 with Retry-After), and never spends a Firestore/Turso check on a blocked request", async () => {
    process.env.HEALTH_RATE_LIMIT = "2";
    const { GET } = await import("./route");
    const req = () => new Request("http://x/api/health", { headers: { "x-forwarded-for": "9.9.9.9" } });
    const first = await GET(req());
    const second = await GET(req());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    mocks.firestoreGet.mockClear();
    mocks.tursoGet.mockClear();
    const third = await GET(req());
    expect(third.status).toBe(429);
    expect(third.headers.get("Retry-After")).toBeTruthy();
    expect(mocks.firestoreGet).not.toHaveBeenCalled();
    expect(mocks.tursoGet).not.toHaveBeenCalled();
  });

  it("binds the Firestore error and logs a sanitized detail at ERROR severity (ok:false), never the raw secret-bearing message", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.firestoreGet.mockRejectedValue(
        new Error("Firebase: Invalid credential at libsql://user:sk-secret-token-value-1234567890@bad.example.com")
      );
      const { GET } = await import("./route");
      await GET(new Request("http://x/api/health"));

      const call = errorSpy.mock.calls.find((c) => String(c[0]).includes("firestore_unreachable"));
      expect(call).toBeTruthy(); // must escalate to error, not warn, since it flips ok:false
      const parsed = JSON.parse(call![0] as string);
      expect(parsed.detail).toContain("Invalid credential"); // enough for on-call to distinguish cause
      expect(parsed.detail).not.toContain("sk-secret-token-value-1234567890"); // never leak the secret
      expect(parsed.detail).not.toContain("user:sk-secret-token-value-1234567890@");
      // no warn-level emission of this same event
      expect(warnSpy.mock.calls.find((c) => String(c[0]).includes("firestore_unreachable"))).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("binds the Turso error and logs a sanitized detail at ERROR severity (ok:false), never the raw secret-bearing message", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.tursoGet.mockRejectedValue(new Error("connect ETIMEDOUT to libsql://user:auth-token-super-secret-abcdef@host.example.com"));
      const { GET } = await import("./route");
      await GET(new Request("http://x/api/health"));

      const call = errorSpy.mock.calls.find((c) => String(c[0]).includes("turso_unreachable"));
      expect(call).toBeTruthy();
      const parsed = JSON.parse(call![0] as string);
      expect(parsed.detail).toContain("ETIMEDOUT");
      expect(parsed.detail).not.toContain("auth-token-super-secret-abcdef");
      expect(warnSpy.mock.calls.find((c) => String(c[0]).includes("turso_unreachable"))).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("responds well under 2 seconds even when a dependency hangs", async () => {
    process.env.HEALTH_TURSO_TIMEOUT_MS = "50";
    process.env.HEALTH_FIRESTORE_TIMEOUT_MS = "50";
    mocks.tursoGet.mockImplementation(() => new Promise(() => {}));
    mocks.firestoreGet.mockImplementation(() => new Promise(() => {}));
    const { GET } = await import("./route");
    const start = Date.now();
    await GET(new Request("http://x/api/health"));
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
