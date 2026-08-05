import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";

// TASK T8b (see route.test.ts): route.ts's GET handler calls ladderStorage() (no dir arg), which
// defaults to `process.cwd()` - the REAL repo root - for its rate-limit/cap/spend counters.
// Redirect ladderStorage() at a per-process tmp dir so this suite never writes into the repo tree.
vi.mock("@/server/upc/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/upc/storage")>();
  const tmpLadderDir = path.join(os.tmpdir(), `ladder-storage-status-trusted-exact-test-${process.pid}`);
  return {
    ...actual,
    ladderStorage: async () => actual.fileLadderStorage(tmpLadderDir),
  };
});

// Save/restore idiom (per scout-route-harness.md): mutate the allowlist env var directly inside each
// test, then restore the ORIGINAL value afterward so this suite never leaks state into other test files.
const ORIG_ALLOWLIST = process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS;
afterEach(() => {
  if (ORIG_ALLOWLIST === undefined) delete process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS;
  else process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = ORIG_ALLOWLIST;
});

describe("status GET exposes trusted exact configuration", () => {
  it("reports allowlistConfigured=false when the env allowlist is unset", async () => {
    delete process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS;
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/api/ai-lookup"));
    const body = await res.json();
    expect(body.trustedExact).toEqual({ allowlistConfigured: false });
  });

  it("reports allowlistConfigured=true when set, without leaking ids", async () => {
    process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = "some-biz-id";
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/api/ai-lookup"));
    const body = await res.json();
    expect(body.trustedExact).toEqual({ allowlistConfigured: true });
    expect(JSON.stringify(body)).not.toContain("some-biz-id");
  });
});
