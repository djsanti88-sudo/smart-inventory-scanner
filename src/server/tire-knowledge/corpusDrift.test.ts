import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { lookupByExactBarcode, getTireKnowledgeMeta, __resetTireKnowledgeCacheForTests } from "@/server/tire-knowledge/tireKnowledgeIndex";
import golden from "../../../benchmarks/golden/phase1-corpus-golden.json";

// B2 (2026-07-15, reframed 2026-07-20 per P6 D10): the golden gate (B1, goldenBaseline.test.ts)
// deliberately FORCES Turso offline, so it can never see a corpus regression in the shipped payload.
// This suite is the LOCAL generated-manifest floor + payload-integrity check. It reads the committed
// tireKnowledge.generated.meta.json (via getTireKnowledgeMeta - a plain local-file read with no
// Turso/SQLite fallback chain, see tireKnowledgeIndex.ts:383-386) and the committed
// tireKnowledge.generated.json payload itself. It does NOT open a live Turso connection and never did;
// the prior "LIVE Turso" doc-comment was false and the pointless describe.skipIf(hasTurso) gate has
// been removed. Pure local-file check, zero network I/O: it runs unconditionally in every
// `npm run test` / `vitest run` / `qa:revision` pass.
//
// INVARIANT DIRECTION (encodes the regression the orchestrator caught 2026-07-20): enrichment
// pipelines (DT harvest +2,029 GTINs, Shop-Ware/Westlake PN backfills) legitimately write the PAYLOAD
// ahead of the manifest, so payload RICHER than manifest (actualKeys >= meta.barcode_index_count) is
// healthy and expected. Payload POORER than manifest means someone regenerated from a stale
// data/tire-knowledge snapshot and silently threw away enrichment data - exactly the shrink class this
// gate must FAIL on. Do NOT tighten this to strict equality, and NEVER hand-type a count literal here;
// the floor is always derived at runtime from the committed meta.json.
const GENERATED_JSON_PATH = join(process.cwd(), "src", "server", "tire-knowledge", "tireKnowledge.generated.json");

async function loadActualBarcodeKeyCount(): Promise<number> {
  const raw = await readFile(GENERATED_JSON_PATH, "utf8");
  const parsed = JSON.parse(raw) as { barcodeIndex: Record<string, unknown> };
  return Object.keys(parsed.barcodeIndex).length;
}

describe("B2 corpus drift gate (local manifest floor + payload-not-poorer-than-manifest)", () => {
  it("actual payload barcode count has not shrunk below the manifest-derived floor", async () => {
    const meta = await getTireKnowledgeMeta();
    expect(meta).not.toBeNull();
    const manifestCount = meta!.barcode_index_count ?? 0;
    expect(manifestCount).toBeGreaterThan(0);
    // Floor = 1% under the committed manifest count, asserted against the REAL runtime payload
    // (Object.keys of the generated.json barcodeIndex) - never meta-vs-meta (tautology).
    const driftFloor = Math.floor(manifestCount * 0.99);
    const actualKeys = await loadActualBarcodeKeyCount();
    expect(actualKeys).toBeGreaterThanOrEqual(driftFloor);
  });

  it("payload is never poorer than the manifest (catches stale-snapshot regen wiping enrichments)", async () => {
    const meta = await getTireKnowledgeMeta();
    expect(meta).not.toBeNull();
    const actualKeys = await loadActualBarcodeKeyCount();
    // Payload >= manifest: enrichment pipelines write the payload ahead of the manifest (healthy).
    // Payload < manifest = a regen from a stale snapshot destroyed enrichment data - FAIL.
    expect(actualKeys).toBeGreaterThanOrEqual(meta!.barcode_index_count ?? 0);
  });

  it("10 spot-check golden barcodes still resolve with the golden identity", async () => {
    __resetTireKnowledgeCacheForTests();
    const spots = (golden as Array<{ code: string; brand: string }>).slice(0, 10);
    for (const g of spots) {
      const row = await lookupByExactBarcode(g.code);
      expect(row, `${g.code} vanished from local corpus`).not.toBeNull();
      expect(row!.brand).toBe(g.brand);
    }
  });
});
