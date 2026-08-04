import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));

vi.mock("node:fs/promises", () => ({ readFile: readFileMock }));

import {
  __resetTireExactIndexCacheForTests,
  lookupTrustedExactBarcode,
} from "@/server/tire-knowledge/tireExactIndex";

beforeEach(() => {
  readFileMock.mockReset();
  readFileMock.mockImplementation((path: string, encoding?: string) => Promise.resolve(readFileSync(path, encoding === "utf8" ? "utf8" : undefined)));
  __resetTireExactIndexCacheForTests();
});

describe("trusted tire exact index", () => {
  it("resolves an exact global-corpus GTIN without derived boss access", async () => {
    const result = await lookupTrustedExactBarcode("029142337393", { authenticatedBossCorpus: false });

    expect(result).toMatchObject({
      kind: "hit",
      sourceScope: "global_corpus",
      row: { barcode: "029142337393" },
    });
  });

  it("elevates a global/Boss overlap only for an authenticated Boss capability", async () => {
    const manifest = JSON.parse(readFileSync("src/server/tire-knowledge/exact-index/manifest.json", "utf8"));
    let overlapCode = "";
    for (const shard of Object.keys(manifest.shardCounts)) {
      const rows = JSON.parse(readFileSync(`src/server/tire-knowledge/exact-index/${shard}.json`, "utf8"));
      overlapCode = Object.keys(rows).find((code) => rows[code].sourceScope === "global_corpus" && rows[code].bossTrusted === true) ?? "";
      if (overlapCode) break;
    }
    expect(overlapCode).not.toBe("");
    await expect(lookupTrustedExactBarcode(overlapCode, { authenticatedBossCorpus: false })).resolves.toMatchObject({ kind: "hit", sourceScope: "global_corpus" });
    await expect(lookupTrustedExactBarcode(overlapCode, { authenticatedBossCorpus: true })).resolves.toMatchObject({ kind: "hit", sourceScope: "authenticated_boss_corpus" });
  });

  it("does not disclose an authenticated-boss row without the internal capability", async () => {
    await expect(lookupTrustedExactBarcode("191563001655", { authenticatedBossCorpus: false })).resolves.toBeNull();
  });

  it("resolves an approved non-GTIN Boss identifier only with the internal capability", async () => {
    await expect(lookupTrustedExactBarcode("3220017438", { authenticatedBossCorpus: false })).resolves.toBeNull();
    await expect(lookupTrustedExactBarcode("3220017438", { authenticatedBossCorpus: true })).resolves.toMatchObject({
      kind: "hit", sourceScope: "authenticated_boss_corpus", row: { barcode: "3220017438" },
    });
  });

  it("blocks every leading-zero spelling of the excluded case pack before legacy lookup", async () => {
    await expect(lookupTrustedExactBarcode("30029885620210", { authenticatedBossCorpus: true })).resolves.toEqual({
      kind: "blocked_package",
      canonicalKey: "30029885620210",
    });
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
    const manifest = JSON.parse(readFileSync("src/server/tire-knowledge/exact-index/manifest.json", "utf8"));
    const shards = Object.keys(manifest.shardCounts).sort();
    const codes = shards.map((shard) =>
      Object.keys(JSON.parse(readFileSync(`src/server/tire-knowledge/exact-index/${shard}.json`, "utf8")))[0],
    );
    const access = { authenticatedBossCorpus: true };
    const shardReadsFor = (shard: string) => readFileMock.mock.calls.filter(([path]) => String(path).endsWith(`${shard}.json`)).length;

    for (const code of codes) await lookupTrustedExactBarcode(code, access);
    await lookupTrustedExactBarcode(codes[0], access);
    expect(shardReadsFor(shards[0])).toBe(1);
  });

  it("uses a bounded 16-shard LRU only for the explicit local corpus certification", async () => {
    const manifest = JSON.parse(readFileSync("src/server/tire-knowledge/exact-index/manifest.json", "utf8"));
    const shards = Object.keys(manifest.shardCounts).sort();
    const codes = shards.slice(0, 17).map((shard) => Object.keys(JSON.parse(readFileSync(`src/server/tire-knowledge/exact-index/${shard}.json`, "utf8")))[0]);
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
    const manifest = JSON.parse(readFileSync("src/server/tire-knowledge/exact-index/manifest.json", "utf8"));
    const shards = Object.keys(manifest.shardCounts).sort();
    const codes = shards.map((shard) => Object.keys(JSON.parse(readFileSync(`src/server/tire-knowledge/exact-index/${shard}.json`, "utf8")))[0]);
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
      manifest.blockedPackageCanonicalKeys = ["30029885620210", "00000000000000"];
      return Promise.resolve(JSON.stringify(manifest));
    });

    await expect(lookupTrustedExactBarcode("029142337393", { authenticatedBossCorpus: false })).resolves.toEqual({
      kind: "unavailable",
    });
  });
});
