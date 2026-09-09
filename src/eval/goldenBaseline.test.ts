import { describe, it, expect, beforeAll, afterAll } from "vitest";
import golden from "../../benchmarks/golden/phase1-corpus-golden.json";
import { lookupByExactBarcode } from "@/decoding/server/knowledge/tire/tireKnowledgeIndex";

// GOLDEN BASELINE GATE (B1): mechanically protects the corpus-resolvable slice of the owner-loved
// 100/100 preview baseline (commit 1782c11, preview inventory-5tk3c3vxf, 2026-07-10 - see
// scripts/dt-harvest/state/ui-100-video-results.json for the live-UI proof: 100/100 "Verified match").
//
// IMPORTANT: this gate covers 84 of those 100 codes, NOT 100. The other 16
// (scripts/build-golden-baseline.mjs run output, and task-10-report.md) are genuinely absent from
// src/decoding/server/knowledge/tire/tireKnowledge.generated.json's barcodeIndex under every zero-padding
// variant lookupByExactBarcode tries - they settled the live 100/100 run via a paid ladder rung
// (goupc/GPT), not the local corpus. That is a real corpus gap, not a test bug: see task-10-report.md
// for the full list of the 16 codes and owner follow-up (backfill those rows, or re-baseline on a
// verified 100-corpus-hit set).
//
// This test only asserts what is mechanically provable offline today: every code that DOES resolve
// from the corpus keeps resolving, with the same brand + size, and the golden set does not shrink
// below its current committed size. No live network/AI calls - lookupByExactBarcode's SQLite/Turso/JSON
// backends are all local-or-fails-closed (see tireKnowledgeIndex.ts). The suite below FORCES the
// Turso rung off (deletes TURSO_DATABASE_URL/TURSO_AUTH_TOKEN in beforeAll) so this gate is
// deterministic-offline BY DESIGN on every machine - SQLite if the knowledge DB is built, else the
// committed JSON - never a real network attempt, regardless of what happens to be exported in the
// shell running the tests.
describe("GOLDEN BASELINE GATE (owner-loved baseline, commit 1782c11)", () => {
  const goldenSet = golden as Array<{ code: string; brand: string; sizeToken: string }>;

  // OFFLINE GUARANTEE (review finding, Task 10): this gate must be deterministic-offline on every
  // machine — SQLite if the knowledge DB is built, else the committed JSON — and NEVER a real Turso
  // network call. lookupByExactBarcode only falls through to Turso when getStmtBarcode() finds no
  // local SQLite DB; on a machine without the .db file, it WOULD attempt a real Turso connection if
  // TURSO_DATABASE_URL/TURSO_AUTH_TOKEN happen to be exported in the shell. vitest does not load
  // .env.local, so today that's safe by accident, not by design. getTursoClient() (in
  // retailKnowledgeIndex.ts, reused by tire-knowledge) reads those two env vars LAZILY on first call
  // and then caches the result at module scope — it does not read them at import time — so deleting
  // them here in beforeAll (before any test calls lookupByExactBarcode) is sufficient; no
  // vi.hoisted/module-scope trick is needed. Restore in afterAll so this suite never leaks env
  // changes to other test files in the same worker.
  let savedTursoUrl: string | undefined;
  let savedTursoToken: string | undefined;
  beforeAll(() => {
    savedTursoUrl = process.env.TURSO_DATABASE_URL;
    savedTursoToken = process.env.TURSO_AUTH_TOKEN;
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
  });
  afterAll(() => {
    if (savedTursoUrl !== undefined) process.env.TURSO_DATABASE_URL = savedTursoUrl;
    if (savedTursoToken !== undefined) process.env.TURSO_AUTH_TOKEN = savedTursoToken;
  });

  it("every golden code still resolves from the corpus with the same identity", async () => {
    const failures: string[] = [];
    for (const g of goldenSet) {
      const row = await lookupByExactBarcode(g.code);
      if (!row) {
        failures.push(`${g.code}: GONE from corpus (expected brand=${g.brand})`);
        continue;
      }
      if (row.brand !== g.brand) {
        failures.push(`${g.code}: brand "${row.brand}" != golden "${g.brand}"`);
      }
      if (g.sizeToken && row.size !== g.sizeToken) {
        failures.push(`${g.code}: size "${row.size}" != golden "${g.sizeToken}"`);
      }
    }
    expect(failures, `${failures.length} golden code(s) regressed:\n${failures.join("\n")}`).toEqual([]);
  });

  it("golden set has not silently shrunk", () => {
    // NOT 100 - see the file-level comment above. 84 is the honest, corpus-provable count as of
    // scripts/build-golden-baseline.mjs's last run. If this number needs to change, regenerate the
    // script's output deliberately (never hand-edit the JSON) and update this assertion in the same
    // commit, with a note on why the count changed.
    expect(goldenSet.length, "golden baseline count changed - regenerate deliberately, don't hand-edit").toBe(84);
  });
});
