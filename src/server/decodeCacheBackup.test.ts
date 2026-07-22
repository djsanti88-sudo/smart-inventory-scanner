// Task 20 (owner-ratified 2026-07-15, pay-once durability): a Turso decode_cache wipe would force
// re-paying un-approved paid decodes. exportDecodeCache/parseBackup give a faithful JSONL dump/restore
// of the cache itself - no corpus write-back, no archive replay (see the plan's out-of-scope note).
import { describe, it, expect } from "vitest";
import { exportDecodeCache, parseBackup } from "./decodeCacheBackup";
import type { PersistedDecode } from "./decodeCacheStore";

describe("exportDecodeCache / parseBackup (Task 20)", () => {
  it("round-trips rows through JSONL export and parse (deep-equal)", () => {
    const rows: PersistedDecode[] = [
      {
        code: "049000006346",
        kind: "result",
        payload: JSON.stringify({ status: "verified", brand: "Coca-Cola" }),
        tier: "verified",
        createdAt: 1700000000000,
      },
      {
        code: "096385074",
        kind: "no_result_receipt",
        payload: "",
        tier: "gpt_none",
        createdAt: 1700000001111,
      },
    ];

    const jsonl = exportDecodeCache(rows);
    const parsed = parseBackup(jsonl);

    expect(parsed).toEqual(rows);
  });

  it("writes one JSON object per line", () => {
    const rows: PersistedDecode[] = [
      { code: "a", kind: "result", payload: "{}", tier: "verified", createdAt: 1 },
      { code: "b", kind: "result", payload: "{}", tier: "verified", createdAt: 2 },
    ];
    const jsonl = exportDecodeCache(rows);
    const lines = jsonl.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(() => JSON.parse(lines[0])).not.toThrow();
    expect(() => JSON.parse(lines[1])).not.toThrow();
  });

  it("empty input produces empty output and parses back to an empty array", () => {
    expect(exportDecodeCache([])).toBe("");
    expect(parseBackup("")).toEqual([]);
    expect(parseBackup("\n\n")).toEqual([]);
  });

  it("skips a corrupt (unparseable) JSON line but keeps valid neighbors - never throws", () => {
    const good1 = JSON.stringify({ code: "x1", kind: "result", payload: "{}", tier: "verified", createdAt: 1 });
    const bad = "{not valid json,,,";
    const good2 = JSON.stringify({ code: "x2", kind: "result", payload: "{}", tier: "verified", createdAt: 2 });
    const jsonl = [good1, bad, good2].join("\n");

    expect(() => parseBackup(jsonl)).not.toThrow();
    const parsed = parseBackup(jsonl);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].code).toBe("x1");
    expect(parsed[1].code).toBe("x2");
  });

  it("skips a line that parses as JSON but has the wrong shape - never throws", () => {
    const good = JSON.stringify({ code: "x1", kind: "result", payload: "{}", tier: "verified", createdAt: 1 });
    const wrongShape1 = JSON.stringify({ code: "", kind: "result", payload: "{}", tier: "verified", createdAt: 1 }); // empty code
    const wrongShape2 = JSON.stringify({ code: "x2", kind: "bogus", payload: "{}", tier: "verified", createdAt: 1 }); // bad kind
    const wrongShape3 = JSON.stringify({ code: "x3", kind: "result", payload: 123, tier: "verified", createdAt: 1 }); // payload not string
    const wrongShape4 = JSON.stringify({ code: "x4", kind: "result", payload: "{}", tier: 5, createdAt: 1 }); // tier not string
    const wrongShape5 = JSON.stringify({ code: "x5", kind: "result", payload: "{}", tier: "verified", createdAt: "later" }); // createdAt not number
    const wrongShape6 = JSON.stringify({ kind: "result", payload: "{}", tier: "verified", createdAt: 1 }); // missing code
    const wrongShape7 = "42"; // valid JSON, not an object
    const wrongShape8 = "null"; // valid JSON, null

    const jsonl = [
      good,
      wrongShape1,
      wrongShape2,
      wrongShape3,
      wrongShape4,
      wrongShape5,
      wrongShape6,
      wrongShape7,
      wrongShape8,
    ].join("\n");

    const parsed = parseBackup(jsonl);
    expect(parsed).toEqual([{ code: "x1", kind: "result", payload: "{}", tier: "verified", createdAt: 1 }]);
  });

  it("a payload containing embedded newlines still round-trips (JSON string escaping, not literal newlines in the JSONL)", () => {
    const rows: PersistedDecode[] = [
      {
        code: "with-newline",
        kind: "result",
        payload: JSON.stringify({ note: "line one\nline two\nline three" }),
        tier: "verified",
        createdAt: 42,
      },
    ];
    const jsonl = exportDecodeCache(rows);
    // The JSONL itself must be exactly one physical line for this row - the newline lives only
    // inside the escaped JSON string, never as a literal line break.
    const lines = jsonl.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);

    const parsed = parseBackup(jsonl);
    expect(parsed).toEqual(rows);
    expect(JSON.parse(parsed[0].payload).note).toBe("line one\nline two\nline three");
  });

  it("tolerates trailing blank lines / trailing newline at end of file", () => {
    const rows: PersistedDecode[] = [
      { code: "a", kind: "result", payload: "{}", tier: "verified", createdAt: 1 },
    ];
    const jsonl = exportDecodeCache(rows);
    expect(parseBackup(jsonl + "\n\n\n")).toEqual(rows);
  });
});
