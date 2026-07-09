import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { purgeBySource, type MockDbLike } from "@/server/corpusPurge";

// Build a fresh in-memory store of MIXED provenance for each test.
// Shape mirrors the persisted MockDb store (src/services/mockDb.ts): products keyed by id,
// aliases keyed by a composite string, each carrying a `source` provenance token.
function seedStore(): MockDbLike {
  return {
    products: {
      // paid-decode rows (quarantine targets)
      p_goupc_1: { id: "p_goupc_1", source: "go-upc" },
      p_goupc_2: { id: "p_goupc_2", source: "go-upc" },
      p_gpt_1: { id: "p_gpt_1", source: "gpt" },
      p_fetchv2_1: { id: "p_fetchv2_1", source: "fetchv2" },
      // human / trusted rows (must NEVER be touched)
      p_human_1: { id: "p_human_1", source: "human_review" },
      p_seed_1: { id: "p_seed_1", source: "seed" },
      p_manual_1: { id: "p_manual_1", source: "manual" },
    },
    aliases: {
      // aliases learned FROM a decode source point at that source's product
      "b|c1|p_goupc_1": { productId: "p_goupc_1", source: "go-upc" },
      "b|c2|p_goupc_2": { productId: "p_goupc_2", source: "go-upc" },
      "b|c3|p_gpt_1": { productId: "p_gpt_1", source: "gpt" },
      "b|c4|p_fetchv2_1": { productId: "p_fetchv2_1", source: "fetchv2" },
      // human-approved alias on a human product
      "b|c5|p_human_1": { productId: "p_human_1", source: "human_review" },
      // a human-approved alias that happens to point AT a go-upc product (human override):
      // its own origin is human, so a purge must keep it.
      "b|c6|p_goupc_1": { productId: "p_goupc_1", source: "human_review" },
    },
  };
}

describe("purgeBySource", () => {
  it("dry-run counts matches but deletes nothing", () => {
    const store = seedStore();
    const before = JSON.stringify(store);

    const res = purgeBySource({ source: "go-upc", mode: "dry-run", store });

    // 2 go-upc products + 2 go-upc aliases matched (the human_review alias on a go-upc product is NOT a match)
    expect(res.matched).toBe(4);
    expect(res.removed).toBe(0);
    expect(res.requeued).toBe(0);
    // store is byte-identical: nothing mutated
    expect(JSON.stringify(store)).toBe(before);
  });

  it("purge removes only rows of the target source (products + their aliases); human rows untouched", () => {
    const store = seedStore();

    const res = purgeBySource({ source: "go-upc", mode: "purge", store });

    // matched = 2 products + 2 aliases; removed = same 4
    expect(res.matched).toBe(4);
    expect(res.removed).toBe(4);
    expect(res.requeued).toBe(0);

    // go-upc products gone
    expect(store.products.p_goupc_1).toBeUndefined();
    expect(store.products.p_goupc_2).toBeUndefined();
    // go-upc aliases gone
    expect(store.aliases["b|c1|p_goupc_1"]).toBeUndefined();
    expect(store.aliases["b|c2|p_goupc_2"]).toBeUndefined();

    // other-source decode rows untouched
    expect(store.products.p_gpt_1).toBeDefined();
    expect(store.products.p_fetchv2_1).toBeDefined();

    // HUMAN rows untouched -- both the human product AND the human-origin alias that
    // pointed at a purged go-upc product survive (origin, not target, decides).
    expect(store.products.p_human_1).toBeDefined();
    expect(store.products.p_seed_1).toBeDefined();
    expect(store.products.p_manual_1).toBeDefined();
    expect(store.aliases["b|c5|p_human_1"]).toBeDefined();
    expect(store.aliases["b|c6|p_goupc_1"]).toBeDefined();
  });

  it("purge of gpt leaves go-upc and fetchv2 intact", () => {
    const store = seedStore();
    const res = purgeBySource({ source: "gpt", mode: "purge", store });
    expect(res.matched).toBe(2); // 1 product + 1 alias
    expect(res.removed).toBe(2);
    expect(store.products.p_gpt_1).toBeUndefined();
    expect(store.aliases["b|c3|p_gpt_1"]).toBeUndefined();
    expect(store.products.p_goupc_1).toBeDefined();
    expect(store.products.p_fetchv2_1).toBeDefined();
  });

  it("revalidate flags rows for re-decode and deletes NOTHING", () => {
    const store = seedStore();

    const res = purgeBySource({ source: "go-upc", mode: "revalidate", store });

    expect(res.matched).toBe(4);
    expect(res.removed).toBe(0);
    expect(res.requeued).toBe(4);

    // nothing deleted
    expect(store.products.p_goupc_1).toBeDefined();
    expect(store.products.p_goupc_2).toBeDefined();
    expect(store.aliases["b|c1|p_goupc_1"]).toBeDefined();

    // target rows flagged
    expect(store.products.p_goupc_1.needsRevalidation).toBe(true);
    expect(store.products.p_goupc_2.needsRevalidation).toBe(true);
    expect(store.aliases["b|c1|p_goupc_1"].needsRevalidation).toBe(true);
    expect(store.aliases["b|c2|p_goupc_2"].needsRevalidation).toBe(true);

    // non-target rows NOT flagged
    expect(store.products.p_gpt_1.needsRevalidation).toBeUndefined();
    expect(store.products.p_human_1.needsRevalidation).toBeUndefined();
    expect(store.aliases["b|c6|p_goupc_1"].needsRevalidation).toBeUndefined();
  });

  it("never touches the raw archive: the module has NO fs import and NO archive-module import", () => {
    // The raw paid-response archive (data/decode-archive/*.jsonl) is purge-proof evidence. This module
    // must operate ONLY on the passed-in store and can therefore reach neither the filesystem nor any
    // archive module. Assert statically over ONLY the import/require STATEMENTS (not prose) that no
    // such dependency is pulled in -- if it is not imported, it cannot be called.
    const src = readFileSync(join(__dirname, "corpusPurge.ts"), "utf8");
    const importLines = src
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l) || /\brequire\s*\(/.test(l));
    const joined = importLines.join("\n");
    // no filesystem access of any kind
    expect(joined).not.toMatch(/["'](?:node:)?fs(?:\/promises)?["']/);
    // no archive / ladder-storage module (which owns appendArchive)
    expect(joined).not.toMatch(/decodeArchive/i);
    expect(joined).not.toMatch(/upc\/storage/i);
    // sanity: the only imports allowed are pure (server-only guard); assert fs truly absent
    expect(importLines.some((l) => /fs/.test(l))).toBe(false);
  });

  it("returns zeros when nothing matches the source", () => {
    const store = seedStore();
    const res = purgeBySource({ source: "fetchv2", mode: "purge", store });
    expect(res.matched).toBe(2);
    // and a source with no rows at all
    const empty = { products: {}, aliases: {} } satisfies MockDbLike;
    const res2 = purgeBySource({ source: "go-upc", mode: "purge", store: empty });
    expect(res2).toEqual({ matched: 0, removed: 0, requeued: 0 });
  });
});
