// Persistent decode cache (L2) — file-fallback mode only (no Turso in CI). Proves: result roundtrip,
// receipt storage/retrieval, upsert-by-code semantics, corruption tolerance (never throws), and
// best-effort write failure tolerance. Route-level peek/write-through/forceRetry wiring is proven in
// src/app/api/ai-lookup/route.test.ts (the consumer of this module).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tursoMocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@libsql/client", () => ({
  createClient: (...args: unknown[]) => tursoMocks.createClient(...args),
}));

import { getPersistedDecode, persistDecode, deletePersistedDecode, __resetForTest, type PersistedDecode } from "@/server/decodeCacheStore";

describe("decodeCacheStore (file-fallback mode; no Turso configured)", () => {
  const keys = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "DECODE_CACHE_FILE"];
  const saved: Record<string, string | undefined> = {};
  let tmpFile: string;

  beforeEach(() => {
    __resetForTest();
    tursoMocks.createClient.mockReset();
    for (const k of keys) saved[k] = process.env[k];
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    tmpFile = path.join(os.tmpdir(), `decode-cache-store-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
    process.env.DECODE_CACHE_FILE = tmpFile;
  });

  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    try { fs.unlinkSync(tmpFile); } catch { /* not created */ }
    __resetForTest();
  });

  it("returns null for a code that was never persisted", async () => {
    expect(await getPersistedDecode("000000000000")).toBeNull();
  });

  it("result roundtrip: persists a verified result and reads it back byte-identical", async () => {
    const entry: PersistedDecode = {
      code: "111111111111",
      kind: "result",
      payload: JSON.stringify({ decision: { status: "verified" }, results: [{ productName: "Widget" }] }),
      tier: "verified",
      createdAt: 1700000000000,
    };
    await persistDecode(entry);
    const got = await getPersistedDecode("111111111111");
    expect(got).not.toBeNull();
    expect(got!.kind).toBe("result");
    expect(got!.tier).toBe("verified");
    expect(got!.createdAt).toBe(1700000000000);
    expect(JSON.parse(got!.payload).decision.status).toBe("verified");
  });

  it("upsert semantics: persisting the same code twice overwrites, never duplicates", async () => {
    await persistDecode({ code: "222222222222", kind: "result", payload: "a", tier: "verified", createdAt: 1 });
    await persistDecode({ code: "222222222222", kind: "result", payload: "b", tier: "suggested", createdAt: 2 });
    const got = await getPersistedDecode("222222222222");
    expect(got!.payload).toBe("b");
    expect(got!.tier).toBe("suggested");
    expect(got!.createdAt).toBe(2);
    const raw = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
    expect(Object.keys(raw)).toEqual(["222222222222"]);
  });

  it("receipt short-circuit: a no_result_receipt is retrievable with its permanent kind + reason", async () => {
    await persistDecode({
      code: "333333333333",
      kind: "no_result_receipt",
      payload: JSON.stringify({ decision: { status: "needs_review" } }),
      tier: "gpt_none",
      createdAt: Date.now(),
    });
    const got = await getPersistedDecode("333333333333");
    expect(got!.kind).toBe("no_result_receipt");
    expect(got!.tier).toBe("gpt_none");
  });

  it("forceRetry bypass overwrites a receipt with a fresh result", async () => {
    await persistDecode({ code: "666666666666", kind: "no_result_receipt", payload: "old", tier: "gpt_none", createdAt: 1 });
    // Simulates the route's forceRetry path: it recomputes, then overwrites unconditionally.
    await persistDecode({ code: "666666666666", kind: "result", payload: "new", tier: "verified", createdAt: 2 });
    const got = await getPersistedDecode("666666666666");
    expect(got!.kind).toBe("result");
    expect(got!.payload).toBe("new");
  });

  it("corrupted file is tolerated: returns null, never throws, and self-heals on next write", async () => {
    fs.writeFileSync(tmpFile, "{ not valid json ][");
    await expect(getPersistedDecode("444444444444")).resolves.toBeNull();
    await persistDecode({ code: "444444444444", kind: "result", payload: "x", tier: "verified", createdAt: 1 });
    const got = await getPersistedDecode("444444444444");
    expect(got!.payload).toBe("x");
  });

  it("a corrupted per-code entry (wrong shape) is tolerated as a miss, not a throw", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ "777777777777": { garbage: true } }));
    await expect(getPersistedDecode("777777777777")).resolves.toBeNull();
  });

  it("persistDecode never throws even when the write target is impossible (best-effort)", async () => {
    // tmpFile does not exist as a directory, so writing "<tmpFile>/nested/impossible.json" must ENOENT.
    process.env.DECODE_CACHE_FILE = path.join(tmpFile, "nested", "impossible.json");
    await expect(
      persistDecode({ code: "555555555555", kind: "result", payload: "x", tier: "verified", createdAt: 1 }),
    ).resolves.toBeUndefined();
  });

  // Catalog revocation round (design §4, "Independent replay layers below the master rung"): the
  // dispute endpoint purges the L2 persisted decode cache entry for a disputed code so the ladder's
  // own cache layer never keeps replaying the pre-dispute (possibly wrong) decode after the master
  // catalog entry itself has already been demoted to "disputed".
  it("deletePersistedDecode removes a persisted entry so a later read is a genuine miss", async () => {
    await persistDecode({ code: "888888888888", kind: "result", payload: "x", tier: "verified", createdAt: 1 });
    expect(await getPersistedDecode("888888888888")).not.toBeNull();
    await deletePersistedDecode("888888888888");
    expect(await getPersistedDecode("888888888888")).toBeNull();
  });

  it("deletePersistedDecode is a no-op (never throws) for a code that was never persisted", async () => {
    await expect(deletePersistedDecode("999999999999")).resolves.toBeUndefined();
  });

  it("deletePersistedDecode never throws even when the file target is impossible (best-effort)", async () => {
    process.env.DECODE_CACHE_FILE = path.join(tmpFile, "nested", "impossible.json");
    await expect(deletePersistedDecode("101010101010")).resolves.toBeUndefined();
  });

  it("deletePersistedDecode is a no-op for an empty/blank code", async () => {
    await expect(deletePersistedDecode("")).resolves.toBeUndefined();
    await expect(deletePersistedDecode("   ")).resolves.toBeUndefined();
  });

  it("empty/blank code is a no-op for both read and write", async () => {
    expect(await getPersistedDecode("")).toBeNull();
    expect(await getPersistedDecode("   ")).toBeNull();
    await expect(persistDecode({ code: "  ", kind: "result", payload: "x", tier: "verified", createdAt: 1 })).resolves.toBeUndefined();
    const raw = fs.existsSync(tmpFile) ? JSON.parse(fs.readFileSync(tmpFile, "utf8")) : {};
    expect(Object.keys(raw)).not.toContain("  ");
    expect(Object.keys(raw)).not.toContain("");
  });

  it("never logs Turso URLs, tokens, driver messages, SQL, or row details on any failure path", async () => {
    const privateUrl = "libsql://private-host.example.invalid/db";
    const privateToken = "decode-cache-secret-token";
    const leakedDriverText = `${privateUrl} authToken=${privateToken} SQL SELECT secret-row LEAK_SENTINEL`;
    process.env.TURSO_DATABASE_URL = privateUrl;
    process.env.TURSO_AUTH_TOKEN = privateToken;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const assertRedacted = () => {
      const output = warn.mock.calls.flat().join(" ");
      expect(output).not.toContain(privateUrl);
      expect(output).not.toContain(privateToken);
      expect(output).not.toContain("LEAK_SENTINEL");
      expect(output).not.toContain("secret-row");
      warn.mockClear();
    };

    __resetForTest();
    tursoMocks.createClient.mockImplementation(() => { throw new Error(leakedDriverText); });
    await getPersistedDecode("111111111111");
    assertRedacted();

    const failingClient = (failSql: RegExp) => ({
      execute: vi.fn(async ({ sql }: { sql: string }) => {
        if (failSql.test(sql)) throw new Error(leakedDriverText);
        return { rows: [] };
      }),
    });

    __resetForTest();
    tursoMocks.createClient.mockReset().mockReturnValue(failingClient(/^CREATE /));
    await getPersistedDecode("222222222222");
    assertRedacted();

    __resetForTest();
    tursoMocks.createClient.mockReset().mockReturnValue(failingClient(/^SELECT /));
    await getPersistedDecode("333333333333");
    assertRedacted();

    __resetForTest();
    tursoMocks.createClient.mockReset().mockReturnValue(failingClient(/^INSERT /));
    await persistDecode({ code: "444444444444", kind: "result", payload: "x", tier: "verified", createdAt: 1 });
    assertRedacted();

    __resetForTest();
    tursoMocks.createClient.mockReset().mockReturnValue(failingClient(/^DELETE /));
    await deletePersistedDecode("555555555555");
    assertRedacted();

    warn.mockRestore();
  });
});
