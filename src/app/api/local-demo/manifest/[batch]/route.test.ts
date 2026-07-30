import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { createLocalDemoManifestHandler } from "./manifestHandler";
import { computeLocalDemoBatchHashes } from "@/server/localDemoArtifacts";
import { computeLocalDemoManifestHash } from "@/server/localDemoArtifacts";

const original = process.env.SCANBIN_LOCAL_DEMO;

afterEach(() => {
  if (original === undefined) delete process.env.SCANBIN_LOCAL_DEMO;
  else process.env.SCANBIN_LOCAL_DEMO = original;
});

function barcodeFor(index: number): string {
  const body = `7${String(index).padStart(10, "0")}`;
  let sum = 0;
  for (
    let position = body.length - 1, weight = 3;
    position >= 0;
    position -= 1, weight = 4 - weight
  ) {
    sum += Number(body[position]) * weight;
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

function rows(count = 100) {
  return Array.from({ length: count }, (_, index) => ({
    ordinal: index + 1,
    batch: Math.floor(index / 100) + 1,
    agent: Math.floor(index / 300) + 1,
    barcode: barcodeFor(index),
    barcodeType: "upc",
    canonicalProductUid: `uid-${index}`,
    brand: "Brand",
    model: "Model",
    size: "225/65R17",
    loadIndex: "102",
    speedRating: "H",
    manufacturerPartNumber: "",
    type: "passenger",
    season: "all season",
    sourceCount: 2,
    confidence: "verified_2src",
    currentStatus: "active_retail",
    usableFor: "auto_count_candidate",
    fieldCompletenessScore: 90,
    angle: "diversity_holdout",
    stratum: "remaining_brand_size_diversity",
  }));
}

describe("GET /api/local-demo/manifest/[batch]", () => {
  it("returns a hash-verified active batch without exposing local paths", async () => {
    process.env.SCANBIN_LOCAL_DEMO = "1";
    const reportsRoot = mkdtempSync(join(tmpdir(), "scanbin-manifest-"));
    try {
      const run = join(reportsRoot, "run-1");
      const batches = join(run, "batches");
      mkdirSync(batches, { recursive: true });
      const manifestRows = rows(3_000);
      const batchRows = manifestRows.slice(0, 100);
      const hashes = computeLocalDemoBatchHashes(batchRows);
      const manifest: Record<string, unknown> = {
        schemaVersion: 1,
        seed: "scanbin-local-tire-demo-v1",
        gitSha: "deadbeef",
        databaseSha256: "d".repeat(64),
        generatedAt: "2026-07-29T00:00:00.000Z",
        total: 3_000,
        batchSize: 100,
        batchCount: 30,
        agentCount: 10,
        manifestSha256: "",
        rows: manifestRows,
      };
      manifest.manifestSha256 = computeLocalDemoManifestHash(manifest);
      const active = {
        schemaVersion: 1,
        runDirectory: "run-1",
        gitSha: "deadbeef",
        databaseSha256: "d".repeat(64),
        manifestSha256: manifest.manifestSha256,
        generatedAt: "2026-07-29T00:00:00.000Z",
      };
      writeFileSync(join(reportsRoot, "active-run.json"), JSON.stringify(active));
      writeFileSync(join(run, "manifest.json"), JSON.stringify(manifest));
      writeFileSync(join(batches, "batch-01.json"), JSON.stringify({
        schemaVersion: 1,
        gitSha: active.gitSha,
        databaseSha256: active.databaseSha256,
        seed: "scanbin-local-tire-demo-v1",
        batch: 1,
        agent: 1,
        rowCount: 100,
        ...hashes,
        rows: batchRows,
      }));
      let currentDatabaseSha256 = active.databaseSha256 as string;
      const handler = createLocalDemoManifestHandler({
        reportsRoot,
        preflight: () => ({ databaseSha256: currentDatabaseSha256 }),
      });
      const response = await handler(
        new NextRequest("http://localhost/api/local-demo/manifest/01"),
        { params: Promise.resolve({ batch: "01" }) },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.rows).toHaveLength(100);
      expect(body).toMatchObject({ batch: 1, ...hashes });
      expect(JSON.stringify(body)).not.toContain(reportsRoot);

      currentDatabaseSha256 = "f".repeat(64);
      const staleResponse = await handler(
        new NextRequest("http://localhost/api/local-demo/manifest/01"),
        { params: Promise.resolve({ batch: "01" }) },
      );
      expect(staleResponse.status).toBe(500);
    } finally {
      rmSync(reportsRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when the active manifest content is tampered", async () => {
    process.env.SCANBIN_LOCAL_DEMO = "1";
    const reportsRoot = mkdtempSync(join(tmpdir(), "scanbin-manifest-tamper-"));
    try {
      const run = join(reportsRoot, "run-1");
      mkdirSync(join(run, "batches"), { recursive: true });
      const manifestRows = rows(3_000);
      const manifest: Record<string, unknown> = {
        schemaVersion: 1,
        seed: "scanbin-local-tire-demo-v1",
        gitSha: "deadbeef",
        databaseSha256: "9".repeat(64),
        generatedAt: "2026-07-29T00:00:00.000Z",
        total: 3_000,
        batchSize: 100,
        batchCount: 30,
        agentCount: 10,
        manifestSha256: "",
        rows: manifestRows,
      };
      manifest.manifestSha256 = computeLocalDemoManifestHash(manifest);
      writeFileSync(join(reportsRoot, "active-run.json"), JSON.stringify({
        schemaVersion: 1,
        runDirectory: "run-1",
        gitSha: manifest.gitSha,
        databaseSha256: manifest.databaseSha256,
        manifestSha256: manifest.manifestSha256,
        generatedAt: manifest.generatedAt,
      }));
      writeFileSync(
        join(run, "manifest.json"),
        JSON.stringify({ ...manifest, seed: "tampered" }),
      );
      const handler = createLocalDemoManifestHandler({
        reportsRoot,
        preflight: () => ({ databaseSha256: "9".repeat(64) }),
      });
      const response = await handler(
        new NextRequest("http://localhost/api/local-demo/manifest/01"),
        { params: Promise.resolve({ batch: "01" }) },
      );
      expect(response.status).toBe(500);
    } finally {
      rmSync(reportsRoot, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "a barcode duplicated across batches",
      mutate: (manifestRows: ReturnType<typeof rows>) => {
        manifestRows[100].barcode = manifestRows[0].barcode;
      },
    },
    {
      name: "a canonical ID duplicated across batches",
      mutate: (manifestRows: ReturnType<typeof rows>) => {
        manifestRows[100].canonicalProductUid =
          manifestRows[0].canonicalProductUid;
      },
    },
    {
      name: "a padding-equivalent barcode duplicated across batches",
      mutate: (manifestRows: ReturnType<typeof rows>) => {
        manifestRows[100].barcode = `0${manifestRows[0].barcode}`;
        manifestRows[100].barcodeType = "ean";
      },
    },
    {
      name: "an ordinal outside the exact 1..3000 sequence",
      mutate: (manifestRows: ReturnType<typeof rows>) => {
        manifestRows[100].ordinal = 999;
      },
    },
    {
      name: "an agent outside the exact 10x300 allocation",
      mutate: (manifestRows: ReturnType<typeof rows>) => {
        manifestRows[300].agent = 1;
      },
    },
  ])("rejects a rehashed manifest with $name", async ({ mutate }) => {
    process.env.SCANBIN_LOCAL_DEMO = "1";
    const reportsRoot = mkdtempSync(join(tmpdir(), "scanbin-manifest-shape-"));
    try {
      const run = join(reportsRoot, "run-1");
      mkdirSync(join(run, "batches"), { recursive: true });
      const baselineRows = rows(3_000);
      const batchRows = baselineRows.slice(0, 100);
      writeFileSync(join(run, "batches", "batch-01.json"), JSON.stringify({
        schemaVersion: 1,
        seed: "scanbin-local-tire-demo-v1",
        gitSha: "deadbeef",
        databaseSha256: "7".repeat(64),
        batch: 1,
        agent: 1,
        rowCount: 100,
        ...computeLocalDemoBatchHashes(batchRows),
        rows: batchRows,
      }));

      const manifestRows = structuredClone(baselineRows);
      mutate(manifestRows);
      const manifest: Record<string, unknown> = {
        schemaVersion: 1,
        seed: "scanbin-local-tire-demo-v1",
        gitSha: "deadbeef",
        databaseSha256: "7".repeat(64),
        generatedAt: "2026-07-29T00:00:00.000Z",
        total: 3_000,
        batchSize: 100,
        batchCount: 30,
        agentCount: 10,
        manifestSha256: "",
        rows: manifestRows,
      };
      manifest.manifestSha256 = computeLocalDemoManifestHash(manifest);
      writeFileSync(join(run, "manifest.json"), JSON.stringify(manifest));
      writeFileSync(join(reportsRoot, "active-run.json"), JSON.stringify({
        schemaVersion: 1,
        runDirectory: "run-1",
        gitSha: manifest.gitSha,
        databaseSha256: manifest.databaseSha256,
        manifestSha256: manifest.manifestSha256,
        generatedAt: manifest.generatedAt,
      }));

      const handler = createLocalDemoManifestHandler({
        reportsRoot,
        preflight: () => ({ databaseSha256: "7".repeat(64) }),
      });
      const response = await handler(
        new NextRequest("http://localhost/api/local-demo/manifest/01"),
        { params: Promise.resolve({ batch: "01" }) },
      );
      expect(response.status).toBe(500);
    } finally {
      rmSync(reportsRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for invalid batch, traversal, stale database, or hash mismatch", async () => {
    process.env.SCANBIN_LOCAL_DEMO = "1";
    const reportsRoot = mkdtempSync(join(tmpdir(), "scanbin-manifest-bad-"));
    try {
      writeFileSync(join(reportsRoot, "active-run.json"), JSON.stringify({
        schemaVersion: 1,
        runDirectory: "../escape",
        gitSha: "deadbeef",
        databaseSha256: "f".repeat(64),
        manifestSha256: "a".repeat(64),
        generatedAt: "2026-07-29T00:00:00.000Z",
      }));
      const handler = createLocalDemoManifestHandler({
        reportsRoot,
        preflight: () => ({ databaseSha256: "0".repeat(64) }),
      });
      const request = new NextRequest("http://localhost/api/local-demo/manifest/01");
      expect((await handler(request, { params: Promise.resolve({ batch: "1" }) })).status).toBe(400);
      expect((await handler(request, { params: Promise.resolve({ batch: "01" }) })).status).toBe(500);
    } finally {
      rmSync(reportsRoot, { recursive: true, force: true });
    }
  });
});
