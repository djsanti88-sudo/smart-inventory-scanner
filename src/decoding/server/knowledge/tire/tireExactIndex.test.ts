import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalGtin } from "@/products/barcodes/gtin";

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));

vi.mock("node:fs/promises", () => ({ readFile: readFileMock }));

import {
  __resetTireExactIndexCacheForTests,
  hasBossHmacKeyConfigured,
  lookupTrustedExactBarcode,
} from "@/decoding/server/knowledge/tire/tireExactIndex";

const hasConfiguredBossKey = Buffer.byteLength(process.env.BOSS_EXACT_INDEX_HMAC_KEY ?? "", "utf8") >= 32;
function publicCodeForShard(shard: string): string {
  const rows = JSON.parse(readFileSync(`src/decoding/server/knowledge/tire/exact-index/${shard}.json`, "utf8"));
  const row = Object.values(rows).find((candidate) => (candidate as { sourceScope?: string }).sourceScope === "global_corpus") as { barcode?: string } | undefined;
  if (!row?.barcode) throw new Error("expected every shard to contain a public corpus row");
  return row.barcode;
}

beforeEach(() => {
  readFileMock.mockReset();
  readFileMock.mockImplementation((path: string, encoding?: string) => Promise.resolve(readFileSync(path, encoding === "utf8" ? "utf8" : undefined)));
  __resetTireExactIndexCacheForTests();
});

describe.skipIf(!hasConfiguredBossKey)("trusted tire exact index", () => {
  it("resolves an exact global-corpus GTIN without derived boss access", async () => {
    const result = await lookupTrustedExactBarcode("029142337393", { authenticatedBossCorpus: false });

    expect(result).toMatchObject({
      kind: "hit",
      sourceScope: "global_corpus",
      row: { barcode: "029142337393" },
    });
  });

  it("elevates a global/Boss overlap only for an authenticated Boss capability", async () => {
    const manifest = JSON.parse(readFileSync("src/decoding/server/knowledge/tire/exact-index/manifest.json", "utf8"));
    let overlapCode = "";
    for (const shard of Object.keys(manifest.shardCounts)) {
      const rows = JSON.parse(readFileSync(`src/decoding/server/knowledge/tire/exact-index/${shard}.json`, "utf8"));
      for (const row of Object.values(rows) as Array<{ sourceScope: string; barcode: string }>) {
        if (row.sourceScope !== "global_corpus") continue;
        const candidate = await lookupTrustedExactBarcode(row.barcode, { authenticatedBossCorpus: true });
        if (candidate?.kind === "hit" && candidate.sourceScope === "authenticated_boss_corpus") { overlapCode = row.barcode; break; }
      }
      if (overlapCode) break;
    }
    expect(overlapCode).not.toBe("");
    const publicResult = await lookupTrustedExactBarcode(overlapCode, { authenticatedBossCorpus: false });
    const bossResult = await lookupTrustedExactBarcode(overlapCode, { authenticatedBossCorpus: true });
    expect(publicResult).toMatchObject({ kind: "hit", sourceScope: "global_corpus" });
    expect(bossResult).toMatchObject({ kind: "hit", sourceScope: "authenticated_boss_corpus" });
    if (!publicResult || publicResult.kind !== "hit" || !bossResult || bossResult.kind !== "hit") throw new Error("expected dual-scope overlap hits");
    expect(publicResult.row.canonical_product_uid).not.toBe(bossResult.row.canonical_product_uid);
  });

  it("does not trust an arbitrary valid GTIN when neither its canonical nor exact non-GTIN key is admitted", async () => {
    const unindexedValidGtin = "4006381333931";
    expect(canonicalGtin(unindexedValidGtin)).not.toBeNull();

    await expect(lookupTrustedExactBarcode(unindexedValidGtin, { authenticatedBossCorpus: true })).resolves.toBeNull();
  });

  it("reports a corrupt manifest as internal unavailability, never an ordinary miss", async () => {
    readFileMock.mockImplementation((path: string) =>
      path.endsWith("manifest.json") ? Promise.resolve("{not json") : Promise.resolve(readFileSync(path)),
    );

    await expect(lookupTrustedExactBarcode("029142337393", { authenticatedBossCorpus: false })).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("reports a missing or corrupt required shard as internal unavailability", async () => {
    readFileMock.mockImplementation((path: string) =>
      path.endsWith(".json") && !path.endsWith("manifest.json")
        ? Promise.reject(new Error("simulated missing shard"))
        : Promise.resolve(readFileSync(path)),
    );

    await expect(lookupTrustedExactBarcode("029142337393", { authenticatedBossCorpus: false })).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("coalesces concurrent cold reads of the same shard", async () => {
    let shardReads = 0;
    let markFirstShardRead!: () => void;
    const firstShardRead = new Promise<void>((resolve) => { markFirstShardRead = resolve; });
    const releaseReads: Array<() => void> = [];
    readFileMock.mockImplementation((path: string, encoding?: string) => {
      if (path.endsWith("manifest.json")) {
        return Promise.resolve(readFileSync(path, encoding === "utf8" ? "utf8" : undefined));
      }
      shardReads += 1;
      if (shardReads === 1) markFirstShardRead();
      return new Promise((resolve) => {
        releaseReads.push(() => resolve(readFileSync(path)));
      });
    });

    const concurrent = Promise.all(Array.from({ length: 3 }, () =>
      lookupTrustedExactBarcode("029142337393", { authenticatedBossCorpus: false }),
    ));
    try {
      await firstShardRead;
      await vi.waitFor(() => expect(shardReads).toBe(1));
    } finally {
      releaseReads.splice(0).forEach((release) => release());
    }

    await expect(concurrent).resolves.toEqual([
      expect.objectContaining({ kind: "hit" }),
      expect.objectContaining({ kind: "hit" }),
      expect.objectContaining({ kind: "hit" }),
    ]);
  });

  it("retains every verified shard after a full exact-index warmup", async () => {
    const manifest = JSON.parse(readFileSync("src/decoding/server/knowledge/tire/exact-index/manifest.json", "utf8"));
    const shards = Object.keys(manifest.shardCounts).sort();
    const codes = shards.map(publicCodeForShard);
    const access = { authenticatedBossCorpus: true };
    const shardReadsFor = (shard: string) => readFileMock.mock.calls.filter(([path]) => String(path).endsWith(`${shard}.json`)).length;

    for (const code of codes) await lookupTrustedExactBarcode(code, access);
    await lookupTrustedExactBarcode(codes[0], access);
    expect(shardReadsFor(shards[0])).toBe(1);
  });

  it("uses a bounded 16-shard LRU only for the explicit local corpus certification", async () => {
    const manifest = JSON.parse(readFileSync("src/decoding/server/knowledge/tire/exact-index/manifest.json", "utf8"));
    const shards = Object.keys(manifest.shardCounts).sort();
    const codes = shards.slice(0, 17).map(publicCodeForShard);
    const firstShardReads = () => readFileMock.mock.calls.filter(([path]) => String(path).endsWith(`${shards[0]}.json`)).length;
    const previousCertification = process.env.BOSS_CORPUS_CERTIFICATION;
    const previousCap = process.env.BOSS_CORPUS_EXACT_INDEX_CACHE_CAP;
    process.env.BOSS_CORPUS_CERTIFICATION = "1";
    process.env.BOSS_CORPUS_EXACT_INDEX_CACHE_CAP = "16";
    try {
      for (const code of codes) await lookupTrustedExactBarcode(code, { authenticatedBossCorpus: true });
      await lookupTrustedExactBarcode(codes[0], { authenticatedBossCorpus: true });
      expect(firstShardReads()).toBe(2);
    } finally {
      if (previousCertification === undefined) delete process.env.BOSS_CORPUS_CERTIFICATION; else process.env.BOSS_CORPUS_CERTIFICATION = previousCertification;
      if (previousCap === undefined) delete process.env.BOSS_CORPUS_EXACT_INDEX_CACHE_CAP; else process.env.BOSS_CORPUS_EXACT_INDEX_CACHE_CAP = previousCap;
    }
  });

  it("ignores the certification cap outside certification so Preview and production retain all shards", async () => {
    const manifest = JSON.parse(readFileSync("src/decoding/server/knowledge/tire/exact-index/manifest.json", "utf8"));
    const shards = Object.keys(manifest.shardCounts).sort();
    const codes = shards.map(publicCodeForShard);
    const firstShardReads = () => readFileMock.mock.calls.filter(([path]) => String(path).endsWith(`${shards[0]}.json`)).length;
    process.env.BOSS_CORPUS_EXACT_INDEX_CACHE_CAP = "16";
    try {
      for (const code of codes) await lookupTrustedExactBarcode(code, { authenticatedBossCorpus: true });
      await lookupTrustedExactBarcode(codes[0], { authenticatedBossCorpus: true });
      expect(firstShardReads()).toBe(1);
    } finally {
      delete process.env.BOSS_CORPUS_EXACT_INDEX_CACHE_CAP;
    }
  });

  it("rejects a manifest whose digest-covered block list is unsorted", async () => {
    readFileMock.mockImplementation((path: string) => {
      if (!path.endsWith("manifest.json")) return Promise.resolve(readFileSync(path));
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.blockedBossPackageKeys = [`boss:v1:${"F".repeat(64)}`, `boss:v1:${"0".repeat(64)}`];
      return Promise.resolve(JSON.stringify(manifest));
    });

    await expect(lookupTrustedExactBarcode("029142337393", { authenticatedBossCorpus: false })).resolves.toEqual({
      kind: "unavailable",
    });
  });
});

describe("trusted tire exact index key binding", () => {
  it("fails closed after HMAC key rotation even when the manifest is already cached", async () => {
    const previous = process.env.BOSS_EXACT_INDEX_HMAC_KEY;
    if (!hasConfiguredBossKey) return;
    try {
      await expect(lookupTrustedExactBarcode("029142337393", { authenticatedBossCorpus: false }))
        .resolves.toMatchObject({ kind: "hit", sourceScope: "global_corpus" });

      process.env.BOSS_EXACT_INDEX_HMAC_KEY = "synthetic-rotated-key-with-at-least-thirty-two-bytes";

      await expect(lookupTrustedExactBarcode("029142337393", { authenticatedBossCorpus: false }))
        .resolves.toEqual({ kind: "unavailable" });
    } finally {
      if (previous === undefined) delete process.env.BOSS_EXACT_INDEX_HMAC_KEY;
      else process.env.BOSS_EXACT_INDEX_HMAC_KEY = previous;
      __resetTireExactIndexCacheForTests();
    }
  });

  it("fails closed when the server-only HMAC key is absent or does not match the manifest", async () => {
    const previous = process.env.BOSS_EXACT_INDEX_HMAC_KEY;
    try {
      delete process.env.BOSS_EXACT_INDEX_HMAC_KEY;
      __resetTireExactIndexCacheForTests();
      await expect(lookupTrustedExactBarcode("029142337393", { authenticatedBossCorpus: false }))
        .resolves.toEqual({ kind: "unavailable" });
      process.env.BOSS_EXACT_INDEX_HMAC_KEY = "synthetic-wrong-key-with-at-least-thirty-two-bytes";
      __resetTireExactIndexCacheForTests();
      await expect(lookupTrustedExactBarcode("029142337393", { authenticatedBossCorpus: false }))
        .resolves.toEqual({ kind: "unavailable" });
    } finally {
      if (previous === undefined) delete process.env.BOSS_EXACT_INDEX_HMAC_KEY;
      else process.env.BOSS_EXACT_INDEX_HMAC_KEY = previous;
      __resetTireExactIndexCacheForTests();
    }
  });

  // Regression for defect #42 (2026-08-06): the live prod deploy hit "unavailable" for every
  // allowlisted business's scan because BOSS_EXACT_INDEX_HMAC_KEY was never configured in Vercel -
  // a class of failure indistinguishable from a corrupt shard/manifest until this diagnostic existed.
  it("hasBossHmacKeyConfigured reports the missing-key class distinctly from other unavailability", () => {
    const previous = process.env.BOSS_EXACT_INDEX_HMAC_KEY;
    try {
      delete process.env.BOSS_EXACT_INDEX_HMAC_KEY;
      expect(hasBossHmacKeyConfigured()).toBe(false);
      process.env.BOSS_EXACT_INDEX_HMAC_KEY = "synthetic-key-with-at-least-thirty-two-bytes-long";
      expect(hasBossHmacKeyConfigured()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.BOSS_EXACT_INDEX_HMAC_KEY;
      else process.env.BOSS_EXACT_INDEX_HMAC_KEY = previous;
    }
  });
});
