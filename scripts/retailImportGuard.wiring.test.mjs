// Regression guard for historical finding DT2-4 (2026-08-13; see docs/HISTORY.md):
// retailImportGuard.mjs's evaluateShrinkGuard() was unit-tested in isolation, but nothing proved
// scripts/import-retail-turso.mjs actually CALLS it, or that the guard's decision runs BEFORE
// `DROP TABLE retail` against the live ~4.13M-row production table. import-retail-turso.mjs opens a
// real Turso connection unconditionally at module load, so it cannot simply be imported in a test.
//
// Fix (chosen: restructure into a real, Turso-free seam over a source-parsing-only test): the
// drop-or-skip decision that used to be inlined in import-retail-turso.mjs is now a single pure
// function, decideRetailImportAction(), in scripts/retailImportGuard.mjs. import-retail-turso.mjs's
// only DROP TABLE call site is now reachable exclusively through `decision.action === "drop"`, where
// `decision` is this function's return value -- so a test that fully exercises
// decideRetailImportAction() (below) proves, without touching Turso, that every path into a
// production-data-destroying DROP is gated by the guard, including the "nothing to protect" (small
// existing table) and "explicit --force-shrink" paths. A second, lightweight source-read test
// additionally proves the two are actually WIRED together in import-retail-turso.mjs itself (that the
// script calls decideRetailImportAction and gates its one DROP TABLE on the result) -- belt-and-
// suspenders coverage for the wiring itself, since a correct decision function alone doesn't
// guarantee the script obeys its return value.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideRetailImportAction } from "./retailImportGuard.mjs";

describe("decideRetailImportAction (DT2-4 real seam, no Turso connection required)", () => {
  it("proceeds without dropping when the existing table is small (nothing to protect)", () => {
    const decision = decideRetailImportAction({ existingCount: 100, localEntryCount: 50, force: false, forceShrink: false });
    expect(decision.action).toBe("proceed");
  });

  it("skips entirely (exit 0) when the table already looks imported and --force was not passed", () => {
    const decision = decideRetailImportAction({ existingCount: 4_130_000, localEntryCount: 4_000_000, force: false, forceShrink: false });
    expect(decision.action).toBe("skip");
  });

  it("REFUSES to drop when --force is passed but the local source would shrink the live corpus", () => {
    const decision = decideRetailImportAction({ existingCount: 4_130_000, localEntryCount: 1_000_000, force: true, forceShrink: false });
    expect(decision.action).toBe("refuse");
    expect(decision.reason).toMatch(/1000000/);
    expect(decision.reason).toMatch(/4130000/);
  });

  it("drops only when --force is passed AND the guard allows it (local source is not a material shrink)", () => {
    const decision = decideRetailImportAction({ existingCount: 4_130_000, localEntryCount: 4_130_000, force: true, forceShrink: false });
    expect(decision.action).toBe("drop");
  });

  it("drops a deliberate shrink only when BOTH --force and --force-shrink are passed", () => {
    const refusedWithoutForceShrink = decideRetailImportAction({ existingCount: 4_130_000, localEntryCount: 10, force: true, forceShrink: false });
    expect(refusedWithoutForceShrink.action).toBe("refuse");

    const allowedWithForceShrink = decideRetailImportAction({ existingCount: 4_130_000, localEntryCount: 10, force: true, forceShrink: true });
    expect(allowedWithForceShrink.action).toBe("drop");
  });
});

describe("import-retail-turso.mjs wiring proof (source-read, no Turso connection)", () => {
  const source = readFileSync(join(process.cwd(), "scripts", "import-retail-turso.mjs"), "utf8");

  it("imports decideRetailImportAction from the guard module", () => {
    expect(source).toMatch(/import\s*\{[^}]*decideRetailImportAction[^}]*\}\s*from\s*["']\.\/retailImportGuard\.mjs["']/);
  });

  it("has exactly one DROP TABLE call site, and it is reachable only when decision.action === \"drop\"", () => {
    const dropMatches = [...source.matchAll(/DROP TABLE retail/g)];
    expect(dropMatches.length).toBe(1);

    const dropIndex = source.indexOf("DROP TABLE retail");
    const before = source.slice(0, dropIndex);
    // The nearest preceding `if` guarding the drop must test decision.action === "drop".
    const lastIfIndex = before.lastIndexOf("if (decision.action");
    expect(lastIfIndex).toBeGreaterThan(-1);
    const guardClause = before.slice(lastIfIndex, before.length);
    expect(guardClause).toMatch(/decision\.action\s*===\s*["']drop["']/);
    // Nothing between that guard's `if (` and the DROP TABLE call closes the block early with
    // another top-level statement that could let a different branch reach it (best-effort proof:
    // no `else` and no second unguarded `client.execute` mentioning DROP anywhere in the file).
    expect(source.match(/DROP TABLE/gi)?.length).toBe(1);
  });

  it("the decision is computed before the DROP TABLE call site appears in the source", () => {
    const decisionCallIndex = source.indexOf("decideRetailImportAction(");
    const dropIndex = source.indexOf("DROP TABLE retail");
    expect(decisionCallIndex).toBeGreaterThan(-1);
    expect(decisionCallIndex).toBeLessThan(dropIndex);
  });
});
