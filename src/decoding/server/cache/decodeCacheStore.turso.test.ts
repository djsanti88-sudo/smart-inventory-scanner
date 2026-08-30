// Persistent decode cache (L2) - TURSO backend, driven through a fake libsql client. Proves the one
// thing the file-backend suite cannot: the Turso schema carries `source_tier`, so pipeline.ts's
// "a bare free title must not overwrite an identity the app already bought" rule reads the same
// truth in production as it does locally. Before 2026-08-19 the Turso DDL/INSERT/SELECT dropped the
// field and the rule was silently inverted in production (audit finding A2).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type Row = Record<string, unknown>;

// Minimal in-memory libsql stand-in: understands exactly the statements decodeCacheStore issues.
function makeFakeTurso(opts: { legacySchema?: boolean } = {}) {
  const rows = new Map<string, Row>();
  const columns = new Set(["code", "kind", "payload", "tier", "created_at"]);
  if (!opts.legacySchema) columns.add("source_tier");
  const executed: string[] = [];
  const client = {
    async execute({ sql, args }: { sql: string; args: unknown[] }) {
      executed.push(sql);
      if (sql.startsWith("CREATE TABLE")) return { rows: [] };
      if (sql.startsWith("PRAGMA table_info")) return { rows: [...columns].map((name) => ({ name })) };
      if (sql.startsWith("ALTER TABLE")) { columns.add("source_tier"); return { rows: [] }; }
      if (sql.startsWith("INSERT INTO decode_cache")) {
        const names = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((s) => s.trim());
        for (const n of names) if (!columns.has(n)) throw new Error(`no such column: ${n}`);
        const row: Row = {};
        names.forEach((n, i) => { row[n] = args[i]; });
        rows.set(String(row.code), row);
        return { rows: [] };
      }
      if (sql.startsWith("SELECT")) {
        const selected = sql.slice("SELECT ".length, sql.indexOf(" FROM")).split(",").map((s) => s.trim());
        for (const n of selected) if (!columns.has(n)) throw new Error(`no such column: ${n}`);
        const row = rows.get(String(args[0]));
        return { rows: row ? [row] : [] };
      }
      if (sql.startsWith("DELETE")) { rows.delete(String(args[0])); return { rows: [] }; }
      throw new Error(`fake turso: unsupported sql ${sql}`);
    },
  };
  return { client, rows, executed, columns };
}

let fake = makeFakeTurso();
vi.mock("@/decoding/server/tursoClient", () => ({
  tursoCredentialsFromEnv: () => ({ url: "libsql://fake", authToken: "fake" }),
  createTursoClient: async () => fake.client,
}));

import { getPersistedDecode, persistDecode, __resetForTest, type PersistedDecode } from "@/decoding/server/cache/decodeCacheStore";

describe("decodeCacheStore (Turso backend via fake libsql client)", () => {
  beforeEach(() => { fake = makeFakeTurso(); __resetForTest(); });
  afterEach(() => { __resetForTest(); });

  const paidRow: PersistedDecode = {
    code: "00900000000003",
    kind: "result",
    payload: JSON.stringify({ decision: { status: "suggested" } }),
    tier: "suggested",
    sourceTier: "gpt_5_4_mini",
    createdAt: 1_700_000_000_000,
  };

  it("persists sourceTier in the source_tier column and reads it back (paid identity stays paid)", async () => {
    await persistDecode(paidRow);
    expect(fake.rows.get(paidRow.code)?.source_tier).toBe("gpt_5_4_mini");
    const back = await getPersistedDecode(paidRow.code);
    expect(back).toEqual(paidRow);
  });

  it("a free suggestion persists with NO sourceTier (null column) and reads back without the field", async () => {
    const free: PersistedDecode = { ...paidRow, code: "00900000000010", sourceTier: undefined };
    delete (free as Partial<PersistedDecode>).sourceTier;
    await persistDecode(free);
    expect(fake.rows.get(free.code)?.source_tier).toBeNull();
    const back = await getPersistedDecode(free.code);
    expect(back).toEqual(free);
    expect(back && "sourceTier" in back).toBe(false);
  });

  it("upgrades a legacy table (no source_tier column) with one idempotent ALTER and keeps working", async () => {
    fake = makeFakeTurso({ legacySchema: true });
    __resetForTest();
    await persistDecode(paidRow);
    expect(fake.executed.filter((s) => s.startsWith("ALTER TABLE")).length).toBe(1);
    expect(fake.columns.has("source_tier")).toBe(true);
    // A second write in the same process does not re-run the ALTER (table readiness is latched).
    await persistDecode({ ...paidRow, code: "00900000000027" });
    expect(fake.executed.filter((s) => s.startsWith("ALTER TABLE")).length).toBe(1);
    expect((await getPersistedDecode(paidRow.code))?.sourceTier).toBe("gpt_5_4_mini");
  });

  it("a lost ALTER race (duplicate column) is treated as migrated, not as a storage failure", async () => {
    fake = makeFakeTurso({ legacySchema: true });
    __resetForTest();
    // Simulate the race loser: the PRAGMA said "no column", but another instance ALTERed first.
    const original = fake.client.execute.bind(fake.client);
    fake.client.execute = async (stmt: { sql: string; args: unknown[] }) => {
      if (stmt.sql.startsWith("ALTER TABLE")) {
        fake.columns.add("source_tier"); // the winner already migrated
        throw new Error("SQLITE_ERROR: duplicate column name: source_tier");
      }
      return original(stmt);
    };
    await persistDecode(paidRow);
    expect(fake.rows.get(paidRow.code)?.source_tier).toBe("gpt_5_4_mini");
    expect((await getPersistedDecode(paidRow.code))?.sourceTier).toBe("gpt_5_4_mini");
  });

  it("does not ALTER when the column already exists", async () => {
    await persistDecode(paidRow);
    expect(fake.executed.some((s) => s.startsWith("ALTER TABLE"))).toBe(false);
  });

  it("an unknown/garbage source_tier value in the column reads back as absent, never as a fake tier", async () => {
    await persistDecode(paidRow);
    fake.rows.get(paidRow.code)!.source_tier = "bogus";
    const back = await getPersistedDecode(paidRow.code);
    expect(back?.sourceTier).toBeUndefined();
  });
});
