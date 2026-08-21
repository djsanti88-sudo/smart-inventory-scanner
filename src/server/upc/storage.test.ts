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
  type DecodeArchiveEntry,
  type DecodeOutcomeEntry,
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

    it("incrementUsage returns 1 then 2 for a fresh month (atomic counter, not read-modify-write)", async () => {
      const store = fileLadderStorage(dir);
      expect(await store.incrementUsage("2026-07")).toBe(1);
      expect(await store.incrementUsage("2026-07")).toBe(2);
      // persisted state matches the returned counter
      const persisted = await fileLadderStorage(dir).readUsage();
      expect(persisted).toEqual({ month: "2026-07", used: 2 });
    });

    it("incrementUsage rolls over cleanly when the month key changes", async () => {
      const store = fileLadderStorage(dir);
      expect(await store.incrementUsage("2026-06")).toBe(1);
      expect(await store.incrementUsage("2026-06")).toBe(2);
      // a new month key starts its own counter at 1
      expect(await store.incrementUsage("2026-07")).toBe(1);
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

  describe("outcomes (A4 decode outcome ledger)", () => {
    it("appends entries and buckets them by createdAt month (append-only JSONL)", async () => {
      const store = fileLadderStorage(dir);
      const e1: DecodeOutcomeEntry = {
        code: "036000291452",
        canonicalGtin: "0036000291452",
        settledBy: "go-upc",
        status: "verified",
        reasons: [{ rung: "go-upc", reason: "Go-UPC exact barcode match" }],
        durationMs: 120,
        sourceTier: "paid_rung",
        createdAt: "2026-07-08T12:00:00.000Z",
      };
      const e2: DecodeOutcomeEntry = {
        code: "999",
        canonicalGtin: "0000000000999",
        settledBy: null,
        status: "needs_review",
        reasons: [],
        durationMs: 40,
        sourceTier: null,
        createdAt: "2026-07-09T00:00:00.000Z",
      };
      await store.appendOutcome(e1);
      await store.appendOutcome(e2);

      // Both land in the same YYYY-MM bucket file (2026-07), append-only, order preserved.
      const monthFile = join(dir, "decode-outcomes", "2026-07.jsonl");
      expect(existsSync(monthFile)).toBe(true);
      const lines = readFileSync(monthFile, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual(e1);
      expect(JSON.parse(lines[1])).toEqual(e2);
    });

    it("buckets a different month into its own file", async () => {
      const store = fileLadderStorage(dir);
      const aug: DecodeOutcomeEntry = {
        code: "888",
        canonicalGtin: "0000000000888",
        settledBy: "fetchv2",
        status: "suggested",
        reasons: [],
        durationMs: 500,
        sourceTier: "paid_rung",
        createdAt: "2026-08-01T00:00:00.000Z",
      };
      await store.appendOutcome(aug);
      expect(existsSync(join(dir, "decode-outcomes", "2026-08.jsonl"))).toBe(true);
    });

    it("appending never rewrites existing lines", async () => {
      const store = fileLadderStorage(dir);
      const first: DecodeOutcomeEntry = {
        code: "1",
        canonicalGtin: "0000000000001",
        settledBy: "go-upc",
        status: "verified",
        reasons: [],
        durationMs: 100,
        sourceTier: "paid_rung",
        createdAt: "2026-07-08T00:00:00.000Z",
      };
      await store.appendOutcome(first);
      const monthFile = join(dir, "decode-outcomes", "2026-07.jsonl");
      const afterFirst = readFileSync(monthFile, "utf8");

      const second: DecodeOutcomeEntry = {
        code: "2",
        canonicalGtin: "0000000000002",
        settledBy: null,
        status: "needs_review",
        reasons: [],
        durationMs: 200,
        sourceTier: null,
        createdAt: "2026-07-20T00:00:00.000Z",
      };
      await store.appendOutcome(second);
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

  // Generic get/set/increment: backs the daily AI-lookup spend cap (aiSpendGuard's
  // chargeDailySlot/readDailyUsed) over an arbitrary string key, independent of the Go-UPC
  // usage/miss/archive stores above.
  describe("generic kv (get/set/increment)", () => {
    it("get returns null for an unknown key", async () => {
      const store = fileLadderStorage(dir);
      expect(await store.get("ai_daily_cap:2026-07-09")).toBeNull();
    });

    it("set then get round-trips", async () => {
      const store = fileLadderStorage(dir);
      await store.set("ai_daily_cap:2026-07-09", "5");
      expect(await fileLadderStorage(dir).get("ai_daily_cap:2026-07-09")).toBe("5");
    });

    it("increment returns 1 then 2 for a fresh key (atomic counter, not read-modify-write)", async () => {
      const store = fileLadderStorage(dir);
      expect(await store.increment("ai_daily_cap:2026-07-09")).toBe(1);
      expect(await store.increment("ai_daily_cap:2026-07-09")).toBe(2);
      expect(await fileLadderStorage(dir).get("ai_daily_cap:2026-07-09")).toBe("2");
    });

    it("keeps keys independent (a Go-UPC usage write does not leak into the kv store or vice versa)", async () => {
      const store = fileLadderStorage(dir);
      await store.writeUsage({ month: "2026-07", used: 99 });
      await store.increment("ai_daily_cap:2026-07-09");
      expect(await store.readUsage()).toEqual({ month: "2026-07", used: 99 });
      expect(await store.get("ai_daily_cap:2026-07-09")).toBe("1");
    });

    it("50 parallel increments land on exactly 50 (atomicity contract, real fs adapter)", async () => {
      const store = fileLadderStorage(dir);
      await Promise.all(Array.from({ length: 50 }, () => store.increment("concurrent-key")));
      expect(await store.get("concurrent-key")).toBe("50");
    });

    it("keeps the KV JSON valid across 601 concurrent writes from independent adapters in one process", async () => {
      const first = fileLadderStorage(dir);
      const second = fileLadderStorage(dir);
      const key = "ratelimit:local:0";

      await Promise.all(Array.from({ length: 601 }, (_, index) =>
        (index % 2 === 0 ? first : second).increment(key),
      ));

      expect(await first.get(key)).toBe("601");
      expect(JSON.parse(readFileSync(join(dir, ".ladder-kv.json"), "utf8"))).toMatchObject({ [key]: "601" });
    });
  });

  // incrementIfBelow: the atomic conditional charge that backs the daily-cap grant/deny decision
  // (aiSpendGuard's chargeDailySlotConditional). Unlike increment(), it MUST NOT advance the counter
  // once the counter has reached `limit` - that is exactly the check-then-act race the daily cap had.
  describe("incrementIfBelow (conditional atomic charge)", () => {
    it("grants and increments while under the limit, returning the new value", async () => {
      const store = fileLadderStorage(dir);
      expect(await store.incrementIfBelow("cap-key", 3)).toEqual({ value: 1, granted: true });
      expect(await store.incrementIfBelow("cap-key", 3)).toEqual({ value: 2, granted: true });
      expect(await store.incrementIfBelow("cap-key", 3)).toEqual({ value: 3, granted: true });
      expect(await store.get("cap-key")).toBe("3");
    });

    it("denies at the limit WITHOUT advancing the counter (returns the unchanged current value)", async () => {
      const store = fileLadderStorage(dir);
      await store.incrementIfBelow("cap-key", 1); // value now 1, at limit
      const denied = await store.incrementIfBelow("cap-key", 1);
      expect(denied).toEqual({ value: 1, granted: false });
      // The denied call must not have written anything past the limit.
      expect(await store.get("cap-key")).toBe("1");
    });

    it("denies a fresh key when the limit is 0 and writes nothing", async () => {
      const store = fileLadderStorage(dir);
      expect(await store.incrementIfBelow("cap-key", 0)).toEqual({ value: 0, granted: false });
      expect(await store.get("cap-key")).toBeNull();
    });

    it("under 100 parallel conditional charges against a limit of 40, grants EXACTLY 40 (no overshoot)", async () => {
      const store = fileLadderStorage(dir);
      const results = await Promise.all(
        Array.from({ length: 100 }, () => store.incrementIfBelow("race-key", 40)),
      );
      const granted = results.filter((r) => r.granted).length;
      expect(granted).toBe(40);
      expect(await store.get("race-key")).toBe("40");
    });
  });
});

describe("tursoLadderStorage", () => {
  // In-memory mocked Turso client: NEVER a live connection. Tracks executed SQL for assertions.
  function memTursoClient(): TursoClientLike & { calls: string[] } {
    const usage = new Map<string, number>();
    const miss = new Map<string, { canonical: string; missed_at: string; ttl_days: number }>();
    const archive: Record<string, unknown>[] = [];
    const outcomes: Record<string, unknown>[] = [];
    const kv = new Map<string, number>();
    const calls: string[] = [];
    return {
      calls,
      async execute({ sql, args }) {
        calls.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
        if (sql.includes("CREATE TABLE")) return { rows: [] };
        if (sql.startsWith("INSERT INTO ladder_kv") && sql.includes("WHERE CAST(ladder_kv.value AS INTEGER) <")) {
          // Conditional atomic charge: grant + increment only while current < limit, else a no-op that
          // returns zero rows (the daily-cap grant/deny primitive). args = [key, limit, limit].
          const [key, , limit] = args as [string, number, number];
          const current = kv.get(key) ?? 0;
          if (current < Number(limit)) {
            const next = current + 1;
            kv.set(key, next);
            return { rows: [{ value: next }] };
          }
          return { rows: [] }; // denied: no mutation, no returned row
        }
        if (sql.startsWith("INSERT INTO ladder_kv") && sql.includes("CAST(value AS INTEGER) + 1")) {
          // Atomic increment: the SQL itself computes the new value, never a JS-precomputed total.
          const [key] = args as [string];
          expect(args).toHaveLength(1); // no precomputed "new value" arg is passed
          const next = (kv.get(key) ?? 0) + 1;
          kv.set(key, next);
          return { rows: [{ value: next }] };
        }
        if (sql.startsWith("INSERT INTO ladder_kv")) {
          const [key, value] = args as [string, string];
          kv.set(key, Number(value));
          return { rows: [] };
        }
        if (sql.startsWith("SELECT value FROM ladder_kv")) {
          const [key] = args as [string];
          return kv.has(key) ? { rows: [{ value: String(kv.get(key)) }] } : { rows: [] };
        }
        if (sql.startsWith("INSERT INTO goupc_usage") && sql.includes("used = used + 1")) {
          // Atomic increment: the SQL itself computes the new value, never a JS-precomputed total.
          const [month] = args as [string];
          expect(args).toHaveLength(1); // no precomputed "new used" arg is passed
          const next = (usage.get(month) ?? 0) + 1;
          usage.set(month, next);
          return { rows: [{ used: next }] };
        }
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
        if (sql.startsWith("INSERT INTO decode_outcomes")) {
          const [code, canonicalGtin, settledBy, status, reasons, durationMs, sourceTier, createdAt] = args as [
            string,
            string,
            string | null,
            string,
            string,
            number,
            string | null,
            string,
          ];
          outcomes.push({ code, canonicalGtin, settledBy, status, reasons, durationMs, sourceTier, createdAt });
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

  it("appendOutcome (A4) inserts append-only (no update/delete SQL issued)", async () => {
    const client = memTursoClient();
    const store = tursoLadderStorage(client);
    const entry: DecodeOutcomeEntry = {
      code: "036000291452",
      canonicalGtin: "0036000291452",
      settledBy: "go-upc",
      status: "verified",
      reasons: [{ rung: "go-upc", reason: "Go-UPC exact barcode match" }],
      durationMs: 120,
      sourceTier: "paid_rung",
      createdAt: "2026-07-08T12:00:00.000Z",
    };
    await store.appendOutcome(entry);
    expect(client.calls.some((c) => c.startsWith("UPDATE") || c.startsWith("DELETE"))).toBe(false);
    expect(client.calls.some((c) => c.startsWith("INSERT INTO"))).toBe(true);
  });

  it("incrementUsage issues an atomic in-SQL increment (used = used + 1), not a JS-computed value", async () => {
    const client = memTursoClient();
    const store = tursoLadderStorage(client);
    const n1 = await store.incrementUsage("2026-07");
    const n2 = await store.incrementUsage("2026-07");
    expect(n1).toBe(1);
    expect(n2).toBe(2);
    const incrementCalls = client.calls.filter((c) => c.startsWith("INSERT INTO"));
    expect(incrementCalls.length).toBeGreaterThan(0);
  });

  it("incrementUsage keeps separate months independent", async () => {
    const store = tursoLadderStorage(memTursoClient());
    expect(await store.incrementUsage("2026-06")).toBe(1);
    expect(await store.incrementUsage("2026-06")).toBe(2);
    expect(await store.incrementUsage("2026-07")).toBe(1);
  });

  it("creates tables (CREATE TABLE IF NOT EXISTS) lazily, once per adapter instance", async () => {
    const client = memTursoClient();
    const store = tursoLadderStorage(client);
    await store.readUsage();
    await store.readUsage();
    const createCalls = client.calls.filter((c) => c.startsWith("CREATE TABLE"));
    // 4 tables (usage, archive, generic kv, decode outcomes) created on the FIRST call only; the
    // second readUsage must not re-issue them. (goupc_miss_cache is gone - owner 2026-08-20.)
    expect(createCalls).toHaveLength(4);
  });

  describe("generic kv (get/set/increment)", () => {
    it("get returns null for an unknown key", async () => {
      const store = tursoLadderStorage(memTursoClient());
      expect(await store.get("ai_daily_cap:2026-07-09")).toBeNull();
    });

    it("set then get round-trips via upsert", async () => {
      const store = tursoLadderStorage(memTursoClient());
      await store.set("ai_daily_cap:2026-07-09", "5");
      expect(await store.get("ai_daily_cap:2026-07-09")).toBe("5");
      // upsert: writing the same key again updates in place, not a duplicate row
      await store.set("ai_daily_cap:2026-07-09", "6");
      expect(await store.get("ai_daily_cap:2026-07-09")).toBe("6");
    });

    it("increment issues an atomic in-SQL increment (CAST(value AS INTEGER) + 1), not a JS-computed value", async () => {
      const client = memTursoClient();
      const store = tursoLadderStorage(client);
      const n1 = await store.increment("ai_daily_cap:2026-07-09");
      const n2 = await store.increment("ai_daily_cap:2026-07-09");
      expect(n1).toBe(1);
      expect(n2).toBe(2);
      const incrementCalls = client.calls.filter((c) => c.startsWith("INSERT INTO"));
      expect(incrementCalls.length).toBeGreaterThan(0);
    });

    it("keeps separate keys independent", async () => {
      const store = tursoLadderStorage(memTursoClient());
      expect(await store.increment("ai_daily_cap:2026-07-08")).toBe(1);
      expect(await store.increment("ai_daily_cap:2026-07-08")).toBe(2);
      expect(await store.increment("ai_daily_cap:2026-07-09")).toBe(1);
    });

    it("incrementIfBelow grants while under the limit and denies at it, using a single conditional statement", async () => {
      const client = memTursoClient();
      const store = tursoLadderStorage(client);
      expect(await store.incrementIfBelow("cap-key", 2)).toEqual({ value: 1, granted: true });
      expect(await store.incrementIfBelow("cap-key", 2)).toEqual({ value: 2, granted: true });
      // At the limit: denied, counter unchanged, reported value is the true current (not the limit guess).
      expect(await store.incrementIfBelow("cap-key", 2)).toEqual({ value: 2, granted: false });
      expect(await store.get("cap-key")).toBe("2");
      // The grant path must be a single in-SQL conditional upsert (never a JS read-then-write): the
      // conditional statement carries the limit as an arg, it is not precomputed client-side.
      expect(client.calls.some((c) => c.startsWith("INSERT INTO"))).toBe(true);
    });

    it("incrementIfBelow denies a fresh key when the limit is 0 and writes nothing", async () => {
      const store = tursoLadderStorage(memTursoClient());
      expect(await store.incrementIfBelow("cap-key", 0)).toEqual({ value: 0, granted: false });
      expect(await store.get("cap-key")).toBeNull();
    });

    it("preserves an authoritative denial ({granted:false}) even when the diagnostic value read throws", async () => {
      // Deep-review Finding 3 (2026-08-10): the conditional statement authoritatively DENIED (zero rows).
      // The follow-up SELECT exists ONLY to fetch a display value - if IT throws, the helper must still
      // return granted:false, never reject (a rejection is misread upstream as an S4 storage error and
      // fail-opens the account cap). Client: conditional -> zero rows (deny); the diagnostic SELECT throws.
      const denyThenReadFails: TursoClientLike = {
        async execute({ sql }) {
          if (sql.includes("CREATE TABLE")) return { rows: [] };
          if (sql.includes("WHERE CAST(ladder_kv.value AS INTEGER) <")) return { rows: [] }; // authoritative deny
          if (sql.startsWith("SELECT value FROM ladder_kv")) throw new Error("turso read timeout");
          return { rows: [] };
        },
      };
      const store = tursoLadderStorage(denyThenReadFails);
      const res = await store.incrementIfBelow("cap-key", 5);
      expect(res.granted).toBe(false); // the denial is authoritative regardless of the diagnostic read
      expect(res.value).toBe(5); // safe fallback (the cap limit) when the true value can't be read
    });
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

  it("uses the Boss certification-owned file directory instead of the caller fallback", async () => {
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    const certificationDir = freshDir();
    process.env.BOSS_CORPUS_LADDER_STORAGE_DIR = certificationDir;

    const store = await ladderStorage(dir);
    await store.writeUsage({ month: "2026-07", used: 7 });

    expect(existsSync(join(certificationDir, ".go-upc-usage.json"))).toBe(true);
    expect(existsSync(join(dir, ".go-upc-usage.json"))).toBe(false);
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
