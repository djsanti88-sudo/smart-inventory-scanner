import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileDecodeStorage, tursoDecodeStorage, type DecodeOutcomeEntry, type TursoClientLike } from "./storage";

const outcome: DecodeOutcomeEntry = {
  code: "049000006346",
  canonicalGtin: "49000006346",
  settledBy: "gpt-5.4-mini",
  status: "suggested",
  reasons: [],
  durationMs: 25,
  sourceTier: "gpt_5_4_mini",
  createdAt: "2026-08-21T00:00:00.000Z",
};

describe("fileDecodeStorage", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("stores counters and enforces a conditional limit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scanbin-decode-storage-"));
    directories.push(directory);
    const storage = fileDecodeStorage(directory);

    expect(await storage.get("calls")).toBeNull();
    await storage.set("calls", "2");
    expect(await storage.increment("calls")).toBe(3);
    expect(await storage.incrementBy("calls", -1)).toBe(2);
    expect(await storage.incrementIfBelow("calls", 3)).toEqual({ value: 3, granted: true });
    expect(await storage.incrementIfBelow("calls", 3)).toEqual({ value: 3, granted: false });
    expect(readFileSync(join(directory, ".decode-kv.json"), "utf8")).toContain('"calls":"3"');
  });

  it("appends outcome JSONL by month", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scanbin-decode-storage-"));
    directories.push(directory);
    await fileDecodeStorage(directory).appendOutcome(outcome);

    const file = join(directory, "decode-outcomes", "2026-08.jsonl");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8").trim())).toEqual(outcome);
  });
});

function fakeTurso() {
  const values = new Map<string, number>();
  const outcomes: unknown[][] = [];
  const execute = vi.fn(async ({ sql, args }: { sql: string; args: unknown[] }) => {
    if (/^CREATE TABLE/i.test(sql.trim())) return { rows: [] };
    if (/INSERT INTO decode_outcomes/i.test(sql)) {
      outcomes.push(args);
      return { rows: [] };
    }
    if (/SELECT value FROM decode_kv/i.test(sql)) {
      const value = values.get(String(args[0]));
      return { rows: value === undefined ? [] : [{ value }] };
    }
    if (/SELECT \?, '1' WHERE/i.test(sql)) {
      const key = String(args[0]);
      const limit = Number(args[1]);
      const current = values.get(key) ?? 0;
      if (!(current < limit)) return { rows: [] };
      values.set(key, current + 1);
      return { rows: [{ value: current + 1 }] };
    }
    if (/RETURNING CAST\(value AS INTEGER\)/i.test(sql)) {
      const key = String(args[0]);
      const delta = args.length === 1 ? 1 : Number(args[2]);
      const next = (values.get(key) ?? 0) + delta;
      values.set(key, next);
      return { rows: [{ value: next }] };
    }
    if (/INSERT INTO decode_kv/i.test(sql)) {
      values.set(String(args[0]), Number(args[1]));
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { client: { execute } as unknown as TursoClientLike, execute, values, outcomes };
}

describe("tursoDecodeStorage", () => {
  it("uses database-side counter arithmetic and conditional grants", async () => {
    const fake = fakeTurso();
    const storage = tursoDecodeStorage(fake.client);

    await storage.set("calls", "2");
    expect(await storage.increment("calls")).toBe(3);
    expect(await storage.incrementBy("calls", -1)).toBe(2);
    expect(await storage.incrementIfBelow("calls", 3)).toEqual({ value: 3, granted: true });
    expect(await storage.incrementIfBelow("calls", 3)).toEqual({ value: 3, granted: false });
    expect(await storage.get("calls")).toBe("3");
    expect(fake.execute.mock.calls.filter(([query]) => /CREATE TABLE/i.test(query.sql))).toHaveLength(2);
  });

  it("appends decode outcomes", async () => {
    const fake = fakeTurso();
    await tursoDecodeStorage(fake.client).appendOutcome(outcome);
    expect(fake.outcomes).toHaveLength(1);
    expect(fake.outcomes[0]).toContain("gpt-5.4-mini");
  });
});
