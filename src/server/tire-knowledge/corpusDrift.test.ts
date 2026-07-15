import { describe, it, expect } from "vitest";
import { lookupByExactBarcode, getTireKnowledgeMeta, __resetTireKnowledgeCacheForTests } from "@/server/tire-knowledge/tireKnowledgeIndex";
import golden from "../../../benchmarks/golden/phase1-corpus-golden.json";

// B2 (2026-07-15): the golden gate (B1, goldenBaseline.test.ts) deliberately FORCES Turso offline so it
// can never see a live corpus regression - it only proves the committed SQLite/JSON snapshot is stable.
// A Turso row-count shrink or corruption (bad migration, accidental DELETE, partial restore) would be
// invisible to B1 forever. This suite is the live counterpart: it only runs when real Turso credentials
// are present in the environment (describe.skipIf), so a normal `npm run test`/`vitest run` never
// attempts network I/O and never flakes CI. Run it deliberately via `npm run test:corpus-drift` with
// Turso env loaded (e.g. from .env.local) to prove the LIVE database has not drifted.
//
// FLOOR derivation (owner-ratified 2026-07-15): src/server/tire-knowledge/tireKnowledge.generated.meta.json
// records barcode_index_count = 76173 as of the last generation (2026-06-30, commit 7a1c805). The floor is
// that count rounded DOWN by 1% (76173 * 0.99 = 75411.27 -> floor 75411) so ordinary harvester growth never
// trips the gate, but a real shrink (a botched migration, a truncated restore, a bad DELETE) does. Growth
// is fine and expected (the DT-harvest weekly job adds rows); only shrinkage below the floor is drift.
const COMMITTED_META_BARCODE_INDEX_COUNT = 76173;
const DRIFT_FLOOR = Math.floor(COMMITTED_META_BARCODE_INDEX_COUNT * 0.99); // 75411

const hasTurso = !!process.env.TURSO_DATABASE_URL && !!process.env.TURSO_AUTH_TOKEN;

describe.skipIf(!hasTurso)("B2 corpus drift gate (LIVE Turso - run via npm run test:corpus-drift)", () => {
  it("meta row counts have not shrunk below the committed floor", async () => {
    const meta = await getTireKnowledgeMeta();
    expect(meta).not.toBeNull();
    // FLOOR = the generated meta's counts at plan time (75411 = 76173 rounded down 1%). Growth is fine.
    expect(meta!.barcode_index_count ?? 0).toBeGreaterThanOrEqual(DRIFT_FLOOR);
  });

  it("10 spot-check golden barcodes still resolve live with the golden identity", async () => {
    __resetTireKnowledgeCacheForTests();
    const spots = (golden as Array<{ code: string; brand: string }>).slice(0, 10);
    for (const g of spots) {
      const row = await lookupByExactBarcode(g.code);
      expect(row, `${g.code} vanished from live corpus`).not.toBeNull();
      expect(row!.brand).toBe(g.brand);
    }
  });
});

// NOTE for future maintainers: this file intentionally has NO fallback "always runs" describe block.
// The env-gate itself (B3, src/eval/envGate.test.ts) separately asserts unit runs are NOT accidentally
// exporting Turso creds, so this file staying skipped in a normal run is expected, proven, and safe.
