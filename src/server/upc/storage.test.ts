import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileLadderStorage,
  type UsageState,
  type MissEntry,
  type DecodeArchiveEntry,
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
    it("returns a zeroed default when no file exists yet", () => {
      const store = fileLadderStorage(dir);
      const s = store.readUsage();
      expect(s.used).toBe(0);
      expect(typeof s.month).toBe("string");
    });

    it("round-trips a written usage state", () => {
      const store = fileLadderStorage(dir);
      const written: UsageState = { month: "2026-07", used: 42 };
      store.writeUsage(written);
      // fresh adapter reading the same dir sees the persisted value
      const reread = fileLadderStorage(dir).readUsage();
      expect(reread).toEqual(written);
    });
  });

  describe("miss cache", () => {
    it("returns null for an unknown key", () => {
      const store = fileLadderStorage(dir);
      expect(store.readMissCache("0036000291452")).toBeNull();
    });

    it("round-trips a miss entry with its TTL fields", () => {
      const store = fileLadderStorage(dir);
      const entry: MissEntry = {
        canonical: "0036000291452",
        missedAt: "2026-07-08T00:00:00.000Z",
        ttlDays: 30,
      };
      store.writeMissCache(entry.canonical, entry);
      const reread = fileLadderStorage(dir).readMissCache(entry.canonical);
      expect(reread).toEqual(entry);
    });

    it("keeps multiple keys independent", () => {
      const store = fileLadderStorage(dir);
      const a: MissEntry = { canonical: "111", missedAt: "2026-07-08T00:00:00.000Z", ttlDays: 30 };
      const b: MissEntry = { canonical: "222", missedAt: "2026-07-08T01:00:00.000Z", ttlDays: 30 };
      store.writeMissCache(a.canonical, a);
      store.writeMissCache(b.canonical, b);
      const s2 = fileLadderStorage(dir);
      expect(s2.readMissCache("111")).toEqual(a);
      expect(s2.readMissCache("222")).toEqual(b);
      expect(s2.readMissCache("333")).toBeNull();
    });
  });

  describe("archive", () => {
    it("appends entries and buckets them by fetchedAt month (append-only JSONL)", () => {
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
      store.appendArchive(e1);
      store.appendArchive(e2);

      // Both land in the same YYYY-MM bucket file (2026-07), append-only, order preserved.
      const monthFile = join(dir, "decode-archive", "2026-07.jsonl");
      expect(existsSync(monthFile)).toBe(true);
      const lines = readFileSync(monthFile, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual(e1);
      expect(JSON.parse(lines[1])).toEqual(e2);
    });

    it("buckets a different month into its own file", () => {
      const store = fileLadderStorage(dir);
      const aug: DecodeArchiveEntry = {
        code: "888",
        canonicalGtin: "0000000000888",
        provider: "fetchv2",
        raw: {},
        fetchedAt: "2026-08-01T00:00:00.000Z",
      };
      store.appendArchive(aug);
      expect(existsSync(join(dir, "decode-archive", "2026-08.jsonl"))).toBe(true);
    });

    it("appending never rewrites existing lines", () => {
      const store = fileLadderStorage(dir);
      const first: DecodeArchiveEntry = {
        code: "1",
        canonicalGtin: "0000000000001",
        provider: "go-upc",
        raw: { a: 1 },
        fetchedAt: "2026-07-08T00:00:00.000Z",
      };
      store.appendArchive(first);
      const monthFile = join(dir, "decode-archive", "2026-07.jsonl");
      const afterFirst = readFileSync(monthFile, "utf8");

      const second: DecodeArchiveEntry = {
        code: "2",
        canonicalGtin: "0000000000002",
        provider: "go-upc",
        raw: { a: 2 },
        fetchedAt: "2026-07-20T00:00:00.000Z",
      };
      store.appendArchive(second);
      const afterSecond = readFileSync(monthFile, "utf8");
      // The original bytes are still a prefix of the file (nothing rewritten).
      expect(afterSecond.startsWith(afterFirst)).toBe(true);
    });
  });

  describe("resilience", () => {
    it("skips corrupt lines on read of usage/miss without throwing (returns default)", () => {
      // Corrupt the usage file directly, then confirm read degrades gracefully.
      const store = fileLadderStorage(dir);
      store.writeUsage({ month: "2026-07", used: 5 });
      const usageFile = join(dir, ".go-upc-usage.json");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      require("node:fs").writeFileSync(usageFile, "{ not json", "utf8");
      const s = fileLadderStorage(dir).readUsage();
      expect(s.used).toBe(0);
      warn.mockRestore();
    });
  });
});
