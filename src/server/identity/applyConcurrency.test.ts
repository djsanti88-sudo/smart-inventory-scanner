import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SignedPreviewChunk } from "@/services/identity/preview";
import type { ScopedIdentifier } from "@/services/identity/types";
import { createFileAtomicLocalStorage, createMemoryAtomicLocalStorage } from "./atomicLocalStorage";
import { createLocalAggregateLedger } from "./localAggregateLedger";
import { createLocalAtomicCountedApply } from "./localAtomicCountedApply";
import { createLocalRepository } from "./localRepository";
import { applyIdentityImport } from "./applyService";
import { readLocalInventoryProjection } from "./localInventoryProjection";
import { replayInventoryEvents } from "@/services/inventory.replay";

const versions = {
  engineVersion: "identity-engine-v2",
  pluginVersions: ["identity-generic-v1"],
  catalogVersion: "catalog-v1",
  catalogSnapshotHash: "snapshot-v1",
  linkVersion: "links-v1",
  linkSnapshotHash: "links-snapshot-v1",
};

function chunk(): SignedPreviewChunk {
  return {
    manifestVersion: "identity-preview-v1",
    chunkIndex: 0,
    chunkCount: 1,
    sanitizedContentRootHash: "root",
    importId: "import-1",
    previewFingerprint: "preview-1",
    scope: { businessId: "shop-a", sourceSystem: "csv", sourceSignature: "headers-v1", vendorId: "vendor-a" },
    actorId: "owner-a",
    versions,
    orderedMappings: [{ sheetName: "Stock", mapping: { quantity: "Qty" } }],
    importerVersion: "v1",
    sourceFileHashes: ["file-a"],
    issuedAt: "2026-07-31T00:00:00.000Z",
    expiresAt: "2026-07-31T00:10:00.000Z",
    rows: [{
      businessId: "shop-a",
      sourceSystem: "csv",
      sourceSignature: "headers-v1",
      vendorId: "vendor-a",
      sourceFileOrdinal: 0,
      sheetName: "Stock",
      sourceRowNumber: 2,
      quantity: 7,
      rawRecordFingerprint: "raw-1",
      identifiers: [{ type: "upc", raw: "012345678905", normalized: "012345678905", source: "csv", evidenceAuthority: "vendor_import", evidenceId: "row-1", evidenceVersion: "1" }],
    }],
    decisions: [{
      kind: "automatic",
      targetProductId: "product-1",
      candidates: [],
      decisionBasis: [],
      normalizedKeys: [],
      constraintOutcomes: [],
      candidateSnapshotHash: "snapshot-v1",
      engineVersion: "identity-engine-v2",
      pluginVersion: "identity-generic-v1",
      sourceRecordFingerprint: "raw-1",
      decisionFingerprint: "decision-1",
    }],
    rowIds: ["row-1"],
    signature: "signature",
  };
}

function dependencies(revalidateCountableTarget: () => Promise<boolean>) {
  const storage = createMemoryAtomicLocalStorage();
  const ledger = createLocalAggregateLedger(storage);
  return {
    storage,
    ledger,
    repository: createLocalRepository(storage),
    atomicCountedRow: createLocalAtomicCountedApply(storage, revalidateCountableTarget),
    verifier: async () => [chunk()],
    source: { versions, revalidateCountableTarget },
    clock: () => "2026-07-31T00:01:00.000Z",
    actor: { actorId: "owner-a", businessId: "shop-a", role: "owner" as const },
  };
}

const storageBase = path.resolve(process.cwd(), ".tmp", "identity-import");
const ownedRoots: string[] = [];
afterEach(async () => { await Promise.all(ownedRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function waitForLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => { output += chunk.toString("utf8"); if (output.includes(expected)) { child.stdout.off("data", onData); resolve(); } };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => { if (!output.includes(expected)) reject(new Error(`child exited ${code}: ${output}`)); });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let errors = ""; child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${errors}`)));
  });
}

describe("identity apply concurrency guards", () => {
  it("atomically publishes a replay-equivalent inventory projection with the counted row", async () => {
    const current = dependencies(async () => true);
    await applyIdentityImport({ signedPayloads: ["signed"], mode: "physical_count", corrections: [] }, current);
    const entries = await current.storage.read!((transaction) => transaction.get<Record<string, { event: import("@/services/identity/types").AggregateImportEvent }>>("aggregate-ledger"));
    const events = Object.values(entries ?? {}).map(({ event }) => event);

    expect(await readLocalInventoryProjection(current.storage, "shop-a", "identity-import:import-1")).toEqual(
      replayInventoryEvents(events, "identity-import:import-1"),
    );
  });

  it("revalidates a corrected reconcile target before it enters expected inventory and never counts", async () => {
    const revalidate = vi.fn(async () => false);
    const current = dependencies(revalidate);

    await expect(applyIdentityImport({
      signedPayloads: ["signed"],
      mode: "reconcile",
      corrections: [{ rowId: "row-1", targetProductId: "cross-tenant-product" }],
    }, current)).rejects.toThrow("apply_correction_target_invalid");

    expect(revalidate).toHaveBeenCalledOnce();
    await expect(current.ledger.findByIdempotencyKey({
      businessId: "shop-a",
      idempotencyKey: "identity-aggregate:import-1:row-1",
      expectedFingerprint: "not-created",
    })).resolves.toBeNull();
  });

  it("emits no ledger event when revocation wins after preflight but before the row claim", async () => {
    let releasePreflight = () => {};
    const preflightStarted = new Promise<void>((resolve) => { releasePreflight = resolve; });
    let first = true;
    const revalidate = vi.fn(async () => {
      if (first) {
        first = false;
        await preflightStarted;
        return true;
      }
      return false;
    });
    const current = dependencies(revalidate);
    const apply = applyIdentityImport({ signedPayloads: ["signed"], mode: "physical_count", corrections: [] }, current);

    releasePreflight();

    await expect(apply).rejects.toThrow("apply_target_stale");
    expect(revalidate).toHaveBeenCalledTimes(2);
    const durable = await current.storage.transaction((transaction) => transaction.get<Record<string, unknown>>("aggregate-ledger"));
    expect(durable ?? {}).toEqual({});
  });

  it("lets two independent Node processes share one atomic claim/count and returns the completed result on retry", async () => {
    const root = path.join(storageBase, `apply-process-${randomUUID()}`); ownedRoots.push(root);
    await mkdir(root, { recursive: true });
    const storage = createFileAtomicLocalStorage({ root });
    await storage.transaction((transaction) => transaction.set("identity-runs", [{ businessId: "shop-a", importId: "import-1", state: "applying" }]));
    const barrier = path.join(root, "apply.start");
    const storageModule = path.resolve(process.cwd(), "src/server/identity/atomicLocalStorage.ts");
    const applyModule = path.resolve(process.cwd(), "src/server/identity/localAtomicCountedApply.ts");
    const program = `
      import { access } from "node:fs/promises";
      import { pathToFileURL } from "node:url";
      const [storageModule, applyModule, root, barrier] = process.argv.slice(1);
      const { createFileAtomicLocalStorage } = await import(pathToFileURL(storageModule).href);
      const { createLocalAtomicCountedApply } = await import(pathToFileURL(applyModule).href);
      process.stdout.write("READY\\n");
      while (true) { try { await access(barrier); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); } }
      const apply = createLocalAtomicCountedApply(createFileAtomicLocalStorage({ root }), async () => true, { writeProjection: async () => {} });
      const result = await apply({
        validation: { businessId: "shop-a", targetProductId: "product-1" },
        operation: { businessId: "shop-a", importId: "import-1", rowId: "row-1", idempotencyKey: "identity-apply:row-1", payloadFingerprint: "payload-1" },
        event: { businessId: "shop-a", idempotencyKey: "identity-aggregate:import-1:row-1", fingerprint: "event-fingerprint", eventId: "event-1", productId: "product-1" },
        operationFingerprint: "operation-1",
        result: { row: { rowId: "row-1", status: "counted", eventId: "event-1", audit: { action: "counted" } } },
      });
      process.stdout.write(result.kind + "\\n");
    `;
    const children = [0, 1].map(() => spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", program, storageModule, applyModule, root, barrier], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }));
    const exits = children.map(waitForExit);
    await Promise.all(children.map((child) => waitForLine(child, "READY")));
    await writeFile(barrier, "start", "utf8");
    await Promise.all(exits);

    const state = await storage.read!(async (transaction) => ({ ledger: await transaction.get<Record<string, unknown>>("aggregate-ledger"), operations: await transaction.get<Record<string, unknown>>("identity-operations") }));
    expect(Object.keys(state.ledger ?? {})).toHaveLength(1);
    expect(Object.values(state.operations ?? {})).toEqual([expect.objectContaining({ state: "applied" })]);
    await expect(access(path.join(root, "identity-local-storage.lock"))).rejects.toMatchObject({ code: "ENOENT" });

    const retry = createLocalAtomicCountedApply(storage, async () => true, { writeProjection: async () => {} });
    const preview = chunk(), row = preview.rows[0]!, decision = preview.decisions[0]!;
    await expect(retry({
      validation: { businessId: "shop-a", sourceSystem: preview.scope.sourceSystem, sourceSignature: preview.scope.sourceSignature, vendorId: preview.scope.vendorId, targetProductId: "product-1", identifiers: (row.identifiers ?? []) as ScopedIdentifier[], row: row as Record<string, unknown>, decision, corrected: false },
      operation: { businessId: "shop-a", importId: "import-1", rowId: "row-1", idempotencyKey: "identity-apply:row-1", payloadFingerprint: "payload-1" },
      event: { kind: "aggregate_import", businessId: "shop-a", importId: "import-1", rowId: "row-1", idempotencyKey: "identity-aggregate:import-1:row-1", fingerprint: "event-fingerprint", eventId: "event-1", productId: "product-1", sessionId: "identity-import:import-1", quantity: 7, unitOfMeasure: "each", sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, createdAt: "2026-07-31T00:01:00.000Z" },
      operationFingerprint: "operation-1",
      result: { row: { rowId: "row-1", status: "counted", eventId: "event-1", audit: { action: "counted" } } },
    })).resolves.toMatchObject({ kind: "completed" });
  });

  it("runs localAtomicCountedApply validation exactly once for one file transaction", async () => {
    const root = path.join(storageBase, `apply-validation-${randomUUID()}`); ownedRoots.push(root);
    const storage = createFileAtomicLocalStorage({ root });
    await storage.transaction((transaction) => transaction.set("identity-runs", [{ businessId: "shop-a", importId: "import-1", state: "applying" }]));
    const revalidate = vi.fn(async () => true);
    const apply = createLocalAtomicCountedApply(storage, revalidate);
    const preview = chunk(), row = preview.rows[0]!, decision = preview.decisions[0]!;

    await expect(apply({
      validation: { businessId: "shop-a", sourceSystem: preview.scope.sourceSystem, sourceSignature: preview.scope.sourceSignature, vendorId: preview.scope.vendorId, targetProductId: "product-1", identifiers: (row.identifiers ?? []) as ScopedIdentifier[], row: row as Record<string, unknown>, decision, corrected: false },
      operation: { businessId: "shop-a", importId: "import-1", rowId: "row-1", idempotencyKey: "identity-apply:row-1", payloadFingerprint: "payload-1" },
      event: { kind: "aggregate_import", businessId: "shop-a", importId: "import-1", rowId: "row-1", idempotencyKey: "identity-aggregate:import-1:row-1", fingerprint: "event-fingerprint", eventId: "event-1", productId: "product-1", sessionId: "identity-import:import-1", quantity: 7, unitOfMeasure: "each", sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, createdAt: "2026-07-31T00:01:00.000Z" },
      operationFingerprint: "operation-1",
      result: { row: { rowId: "row-1", status: "counted", eventId: "event-1", audit: { action: "counted" } } },
    })).resolves.toMatchObject({ kind: "applied" });
    expect(revalidate).toHaveBeenCalledTimes(1);
  });
});
