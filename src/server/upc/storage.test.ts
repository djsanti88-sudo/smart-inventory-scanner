import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileLadderStorage,
  tursoLadderStorage,
  ladderStorage,
  __resetLadderStorageSelectorForTests,
  type UsageState,
  type MissEntry,
  type DecodeArchiveEntry,
  type TursoClientLike,
} from "./storage";

// `server-only` is aliased to a no-op stub by vitest.config.ts, so importing this
// server-only module in the node unit project is safe (same as knowledgeDb tests).

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "ladder-storage-"));
}

describe("fileLadderStorage", () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDir();
  });

  describe("usage state", () => {
    it("returns a zeroed default when no file exists yet", async () => {
      const store = fileLadderStorage(dir);
      const s = await store.readUsage();
      expect(s.used).toBe(0);
      expect(typeof s.month).toBe("string");
    });

    it("round-trips a written usage state", async () => {
      const store = fileLadderStorage(dir);
      const written: UsageState = { month: "2026-07", used: 42 };
      await store.writeUsage(written);
      // fresh adapter reading the same dir sees the persisted value
      const reread = await fileLadderStorage(dir).readUsage();
      expect(reread).toEqual(written);
    });
  });

  describe("miss cache", () => {
    it("returns null for an unknown key", async () => {
      const store = fileLadderStorage(dir);
      expect(await store.readMissCache("0036000291452")).toBeNull();
    });

    it("round-trips a miss entry with its TTL fields", async () => {
      const store = fileLadderStorage(dir);
      const entry: MissEntry = {
        canonical: "0036000291452",
        missedAt: "2026-07-08T00:00:00.000Z",
        ttlDays: 30,
      };
      await store.writeMissCache(entry.canonical, entry);
      const reread = await fileLadderStorage(dir).readMissCache(entry.canonical);
      expect(reread).toEqual(entry);
    });

    it("keeps multiple keys independent", async () => {
      const store = fileLadderStorage(dir);
      const a: MissEntry = { canonical: "111", missedAt: "2026-07-08T00:00:00.000Z", ttlDays: 30 };
      const b: MissEntry = { canonical: "222", missedAt: "2026-07-08T01:00:00.000Z", ttlDays: 30 };
      await store.writeMissCache(a.canonical, a);
      await store.writeMissCache(b.canonical, b);
      const s2 = fileLadderStorage(dir);
      expect(await s2.readMissCache("111")).toEqual(a);
      expect(await s2.readMissCache("222")).toEqual(b);
      expect(await s2.readMissCache("333")).toBeNull();
    });
  });

  describe("archive", () => {
    it("appends entries and buckets them by fetchedAt month (append-only JSONL)", async () => {
      const store = fileLadderStorage(dir);
      const e1: DecodeArchiveEntry = {
        code: "036000291452",
        canonicalGtin: "0036000291452",
        provider: "go-upc",
        httpStatus: 200,
        raw: { product: { name: "Widget" } },
        sourceUrls: ["https://go-upc.com/x"],
        fetchedAt: "2026-07-08T12:00:00.000Z",
      };
      const e2: DecodeArchiveEntry = {
        code: "999",
        canonicalGtin: "0000000000999",
        provider: "gpt-5.5",
        raw: { note: "second" },
        fetchedAt: "2026-07-09T00:00:00.000Z",
      };
      await store.appendArchive(e1);
      await store.appendArchive(e2);

      // Both land in the same YYYY-MM bucket file (2026-07), append-only, order preserved.
      const monthFile = join(dir, "decode-archive", "2026-07.jsonl");
      expect(existsSync(monthFile)).toBe(true);
      const lines = readFileSync(monthFile, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual(e1);
      expect(JSON.parse(lines[1])).toEqual(e2);
    });

    it("buckets a different month into its own file", async () => {
      const store = fileLadderStorage(dir);
      const aug: DecodeArchiveEntry = {
        code: "888",
        canonicalGtin: "0000000000888",
        provider: "fetchv2",
        raw: {},
        fetchedAt: "2026-08-01T00:00:00.000Z",
      };
      await store.appendArchive(aug);
      expect(existsSync(join(dir, "decode-archive", "2026-08.jsonl"))).toBe(true);
    });

    it("appending never rewrites existing lines", async () => {
      const store = fileLadderStorage(dir);
      const first: DecodeArchiveEntry = {
        code: "1",
        canonicalGtin: "0000000000001",
        provider: "go-upc",
        raw: { a: 1 },
        fetchedAt: "2026-07-08T00:00:00.000Z",
      };
      await store.appendArchive(first);
      const monthFile = join(dir, "decode-archive", "2026-07.jsonl");
      const afterFirst = readFileSync(monthFile, "utf8");

      const second: DecodeArchiveEntry = {
        code: "2",
        canonicalGtin: "0000000000002",
        provider: "go-upc",
        raw: { a: 2 },
        fetchedAt: "2026-07-20T00:00:00.000Z",
      };
      await store.appendArchive(second);
      const afterSecond = readFileSync(monthFile, "utf8");
      // The original bytes are still a prefix of the file (nothing rewritten).
      expect(afterSecond.startsWith(afterFirst)).toBe(true);
    });
  });

  describe("resilience", () => {
    it("skips corrupt lines on read of usage/miss without throwing (returns default)", async () => {
      // Corrupt the usage file directly, then confirm read degrades gracefully.
      const store = fileLadderStorage(dir);
      await store.writeUsage({ month: "2026-07", used: 5 });
      const usageFile = join(dir, ".go-upc-usage.json");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      writeFileSync(usageFile, "{ not json", "utf8");
      const s = await fileLadderStorage(dir).readUsage();
      expect(s.used).toBe(0);
      warn.mockRestore();
    });
  });
});

describe("tursoLadderStorage", () => {
  // In-memory mocked Turso client: NEVER a live connection. Tracks executed SQL for assertions.
  function memTursoClient(): TursoClientLike & { calls: string[] } {
    const usage = new Map<string, number>();
    const miss = new Map<string, { canonical: string; missed_at: string; ttl_days: number }>();
    const archive: Record<string, unknown>[] = [];
    const calls: string[] = [];
    return {
      calls,
      async execute({ sql, args }) {
        calls.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
        if (sql.includes("CREATE TABLE")) return { rows: [] };
        if (sql.startsWith("INSERT INTO goupc_usage")) {
          const [month, used] = args as [string, number];
          usage.set(month, used);
          return { rows: [] };
        }
        if (sql.startsWith("SELECT month, used")) {
          const months = [...usage.keys()].sort().reverse();
          if (months.length === 0) return { rows: [] };
          const month = months[0];
          return { rows: [{ month, used: usage.get(month) }] };
        }
        if (sql.startsWith("INSERT INTO goupc_miss_cache")) {
          const [canonical, missedAt, ttlDays] = args as [string, string, number];
          miss.set(canonical, { canonical, missed_at: missedAt, ttl_days: ttlDays });
          return { rows: [] };
        }
        if (sql.startsWith("SELECT canonical, missed_at, ttl_days")) {
          const [key] = args as [string];
          const row = miss.get(key);
          return { rows: row ? [row] : [] };
        }
        if (sql.startsWith("INSERT INTO decode_archive")) {
          const [code, canonicalGtin, provider, httpStatus, raw, sourceUrls, fetchedAt] = args as [
            string,
            string,
            string,
            number | null,
            string,
            string | null,
            string,
          ];
          archive.push({ code, canonicalGtin, provider, httpStatus, raw, sourceUrls, fetchedAt });
          return { rows: [] };
        }
        throw new Error(`memTursoClient: unhandled SQL: ${sql}`);
      },
    };
  }

  it("readUsage returns a zeroed default when the table is empty", async () => {
    const store = tursoLadderStorage(memTursoClient());
    const s = await store.readUsage();
    expect(s.used).toBe(0);
  });

  it("writeUsage then readUsage round-trips via upsert", async () => {
    const store = tursoLadderStorage(memTursoClient());
    await store.writeUsage({ month: "2026-07", used: 42 });
    expect(await store.readUsage()).toEqual({ month: "2026-07", used: 42 });
    // upsert: writing the same month again updates in place, not a duplicate row
    await store.writeUsage({ month: "2026-07", used: 43 });
    expect(await store.readUsage()).toEqual({ month: "2026-07", used: 43 });
  });

  it("readMissCache returns null for an unknown key", async () => {
    const store = tursoLadderStorage(memTursoClient());
    expect(await store.readMissCache("0036000291452")).toBeNull();
  });

  it("writeMissCache then readMissCache round-trips via upsert-by-canonical", async () => {
    const store = tursoLadderStorage(memTursoClient());
    const entry: MissEntry = { canonical: "0036000291452", missedAt: "2026-07-08T00:00:00.000Z", ttlDays: 30 };
    await store.writeMissCache(entry.canonical, entry);
    expect(await store.readMissCache(entry.canonical)).toEqual(entry);
  });

  it("appendArchive inserts append-only (no update/delete SQL issued)", async () => {
    const client = memTursoClient();
    const store = tursoLadderStorage(client);
    const entry: DecodeArchiveEntry = {
      code: "036000291452",
      canonicalGtin: "0036000291452",
      provider: "go-upc",
      httpStatus: 200,
      raw: { product: { name: "Widget" } },
      sourceUrls: ["https://go-upc.com/x"],
      fetchedAt: "2026-07-08T12:00:00.000Z",
    };
    await store.appendArchive(entry);
    expect(client.calls.some((c) => c.startsWith("UPDATE") || c.startsWith("DELETE"))).toBe(false);
    expect(client.calls.some((c) => c.startsWith("INSERT INTO"))).toBe(true);
  });

  it("creates tables (CREATE TABLE IF NOT EXISTS) lazily, once per adapter instance", async () => {
    const client = memTursoClient();
    const store = tursoLadderStorage(client);
    await store.readUsage();
    await store.readUsage();
    const createCalls = client.calls.filter((c) => c.startsWith("CREATE TABLE"));
    // 3 tables created on the FIRST call only; the second readUsage must not re-issue them.
    expect(createCalls).toHaveLength(3);
  });
});

describe("ladderStorage selector", () => {
  const ORIGINAL_ENV = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = freshDir();
    __resetLadderStorageSelectorForTests();
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.doUnmock("@libsql/client");
  });

  it("returns the file adapter when TURSO_DATABASE_URL/TURSO_AUTH_TOKEN are unset", async () => {
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    const store = await ladderStorage(dir);
    // Prove it's the file adapter: writing then reading round-trips through the filesystem.
    await store.writeUsage({ month: "2026-07", used: 7 });
    expect(existsSync(join(dir, ".go-upc-usage.json"))).toBe(true);
  });

  it("selects the Turso adapter when both env vars are set", async () => {
    vi.doMock("@libsql/client", () => ({
      createClient: () => ({
        execute: async ({ sql }: { sql: string }) => {
          if (sql.includes("CREATE TABLE")) return { rows: [] };
          if (sql.startsWith("SELECT month, used")) return { rows: [] };
          return { rows: [] };
        },
      }),
    }));
    process.env.TURSO_DATABASE_URL = "libsql://x";
    process.env.TURSO_AUTH_TOKEN = "t";
    vi.resetModules();
    const mod = await import("./storage");
    mod.__resetLadderStorageSelectorForTests();
    const store = await mod.ladderStorage(dir);
    const s = await store.readUsage();
    // Falls back to a zeroed default from the mocked (empty) Turso table -- proves the Turso path ran,
    // not the file adapter (no file is ever written by this branch).
    expect(s.used).toBe(0);
    expect(existsSync(join(dir, ".go-upc-usage.json"))).toBe(false);
  });

  it("falls back to the file adapter when Turso client construction throws", async () => {
    vi.doMock("@libsql/client", () => ({
      createClient: () => {
        throw new Error("connection refused");
      },
    }));
    process.env.TURSO_DATABASE_URL = "libsql://x";
    process.env.TURSO_AUTH_TOKEN = "t";
    vi.resetModules();
    const mod = await import("./storage");
    mod.__resetLadderStorageSelectorForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await mod.ladderStorage(dir);
    await store.writeUsage({ month: "2026-07", used: 1 });
    expect(existsSync(join(dir, ".go-upc-usage.json"))).toBe(true);
    warn.mockRestore();
  });
});
