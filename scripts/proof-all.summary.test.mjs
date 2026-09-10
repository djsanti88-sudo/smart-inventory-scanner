// Regression test for DEFECT (HIGH, 2026-08-16 clean-room review): VITEST_EXTRA_EXCLUDE could
// silently narrow scripts/proof-all.mjs's coverage with zero trace in the printed summary, while
// NODE_TEST_SKIP was already surfaced. A CI config change that sets VITEST_EXTRA_EXCLUDE therefore
// produced a fully green "PROOF:ALL SUMMARY" with reduced coverage and no visible sign of it -
// exactly the false-green class this gate exists to prevent.
//
// This test exercises the pure summary-building function directly (never spawns the real tsc/
// vitest/node:test legs - that would make this suite itself minutes long) and asserts:
//   1. Every VITEST_EXTRA_EXCLUDE pattern is named verbatim in the printed summary.
//   2. The RESULT line carries an explicit "narrowed" caveat whenever either opt-out knob was used,
//      so "all local legs green" can never be quoted from a narrowed run without that caveat.
//   3. A default (both knobs empty) run's RESULT line carries NO narrowed caveat and still reports
//      green plainly - this test must not force a permanent scary banner onto the common case.
//
// Two MORE defects were found in an independent clean-room review of proof-all.mjs ITSELF
// (2026-08-16), one with a live instance at the time of the review:
//
// FINDING 1 (HIGH, live instance: e2e/boss-barcode-corpus/fixtures.test.mjs and its siblings,
// plus the entire untracked e2e/boss-barcode-preview/ suite): NODE_TEST_SUITES is hand-maintained
// and the "missing" check only asks whether LISTED files still exist -- nothing discovers test
// files and reconciles them against what actually runs. A vitest-excluded suite nobody added to
// the list is invisible: it can be red forever while this gate reports green. Covered below by
// the discoverTestFiles / findOrphanTestFiles / buildSummaryReport(orphans) tests.
//
// FINDING 2 (HIGH): a narrowed run still exited 0, and the RESULT line's own wording contained
// the word "green" ("all local legs green, BUT THIS RUN WAS NARROWED"), so the exact phrase a
// reviewer would grep for to confirm full coverage could be quoted verbatim from a run that
// proved the opposite. Covered below by the computeExitCode tests and the "never says green"
// wording assertions.
import { describe, expect, it } from "vitest";
import { buildSummaryReport, computeExitCode, discoverTestFiles, findOrphanTestFiles } from "./proof-all.mjs";

function baseResults() {
  return [
    { label: "typecheck (tsc --noEmit)", ok: true, detail: "ok", skipped: 0 },
    { label: "vitest (unit + dom)", ok: true, detail: "4128 passed", skipped: 0 },
  ];
}

describe("proof-all.mjs buildSummaryReport", () => {
  it("names every VITEST_EXTRA_EXCLUDE pattern explicitly in the summary text", () => {
    const { text } = buildSummaryReport({
      results: baseResults(),
      missing: [],
      skippedByEnv: [],
      vitestExtraExclude: ["src/services/foo.test.ts", "src/server/bar.test.ts"],
      totalSkipped: 0,
    });

    expect(text).toContain("VITEST_EXTRA_EXCLUDE");
    expect(text).toContain("src/services/foo.test.ts");
    expect(text).toContain("src/server/bar.test.ts");
  });

  it("marks the RESULT line as narrowed when VITEST_EXTRA_EXCLUDE is set, even with zero failures", () => {
    const { text, failed } = buildSummaryReport({
      results: baseResults(),
      missing: [],
      skippedByEnv: [],
      vitestExtraExclude: ["src/services/foo.test.ts"],
      totalSkipped: 0,
    });

    expect(failed.length).toBe(0);
    const resultLine = text.split("\n").find((l) => l.startsWith("RESULT:"));
    expect(resultLine).toBeDefined();
    expect(resultLine.toUpperCase()).toContain("NARROWED");
  });

  it("marks the RESULT line as narrowed when NODE_TEST_SKIP is set (existing knob, same treatment)", () => {
    const { text } = buildSummaryReport({
      results: baseResults(),
      missing: [],
      skippedByEnv: ["scripts/refresh-tire-meta.test.mjs"],
      vitestExtraExclude: [],
      totalSkipped: 0,
    });

    const resultLine = text.split("\n").find((l) => l.startsWith("RESULT:"));
    expect(resultLine.toUpperCase()).toContain("NARROWED");
  });

  it("a fully default run (both knobs empty) reports plain green with NO narrowed caveat", () => {
    const { text } = buildSummaryReport({
      results: baseResults(),
      missing: [],
      skippedByEnv: [],
      vitestExtraExclude: [],
      totalSkipped: 0,
    });

    const resultLine = text.split("\n").find((l) => l.startsWith("RESULT:"));
    expect(resultLine.toUpperCase()).not.toContain("NARROWED");
    expect(resultLine).toContain("all local legs green");
  });

  it("a failed run still reports FAILED regardless of narrowing", () => {
    const results = baseResults();
    results[0] = { label: "typecheck (tsc --noEmit)", ok: false, detail: "FAILED (exit 2)", skipped: 0 };
    const { text, failed } = buildSummaryReport({
      results,
      missing: [],
      skippedByEnv: [],
      vitestExtraExclude: ["src/services/foo.test.ts"],
      totalSkipped: 0,
    });

    expect(failed.length).toBe(1);
    const resultLine = text.split("\n").find((l) => l.startsWith("RESULT:"));
    expect(resultLine).toContain("FAILED");
  });

  // FINDING 1 (HIGH) -- orphaned test files (discovered on disk, run by no runner, declared
  // nowhere) must FAIL CLOSED, not disappear into a green summary.
  it("reports discovered orphan test files as a FAIL CLOSED block and names each file", () => {
    const results = [
      ...baseResults(),
      { label: "test-file discovery (self-detection scan)", ok: false, detail: "1 orphaned file(s)", skipped: 0 },
    ];
    const { text, failed } = buildSummaryReport({
      results,
      missing: [],
      skippedByEnv: [],
      vitestExtraExclude: [],
      totalSkipped: 0,
      orphans: ["e2e/boss-barcode-corpus/fixtures.test.mjs"],
    });

    expect(text).toContain("FAIL CLOSED");
    expect(text).toContain("e2e/boss-barcode-corpus/fixtures.test.mjs");
    expect(failed.length).toBe(1);
    const resultLine = text.split("\n").find((l) => l.startsWith("RESULT:"));
    expect(resultLine).toContain("FAILED");
  });

  it("a clean discovery run (zero orphans) prints no FAIL CLOSED block", () => {
    const results = [
      ...baseResults(),
      { label: "test-file discovery (self-detection scan)", ok: true, detail: "0 orphaned files (531 discovered)", skipped: 0 },
    ];
    const { text, failed } = buildSummaryReport({
      results,
      missing: [],
      skippedByEnv: [],
      vitestExtraExclude: [],
      totalSkipped: 0,
      orphans: [],
    });

    expect(text).not.toContain("FAIL CLOSED");
    expect(failed.length).toBe(0);
  });

  it("findOrphanTestFiles flags a discovered file that is not collected by vitest, run by node:test, or declared in NOT_RUN", () => {
    const orphans = findOrphanTestFiles({
      discovered: [
        "e2e/boss-barcode-corpus/fixtures.test.mjs",
        "scripts/refresh-tire-meta.test.mjs",
        "src/inventory/ledger.test.ts",
      ],
      collectedByVitest: ["src/inventory/ledger.test.ts"],
      executedByNodeTest: ["scripts/refresh-tire-meta.test.mjs"],
      declaredNotRun: [],
    });

    expect(orphans).toEqual(["e2e/boss-barcode-corpus/fixtures.test.mjs"]);
  });

  it("findOrphanTestFiles treats a NOT_RUN-declared file as covered, not orphaned", () => {
    const orphans = findOrphanTestFiles({
      discovered: ["e2e/boss-barcode-preview/fixtures.test.mjs"],
      collectedByVitest: [],
      executedByNodeTest: [],
      declaredNotRun: ["e2e/boss-barcode-preview/fixtures.test.mjs"],
    });

    expect(orphans).toEqual([]);
  });

  it("discoverTestFiles finds *.test.mjs/*.test.ts files via injected readdir, including nested directories", () => {
    // Fake filesystem: scripts/ has one root-level suite and one nested under a subdirectory,
    // plus a non-test file that must be ignored, and a node_modules dir that must be skipped.
    const fakeFs = {
      "scripts": [
        { name: "foo.test.mjs", isDirectory: () => false },
        { name: "not-a-test.mjs", isDirectory: () => false },
        { name: "sub", isDirectory: () => true },
        { name: "node_modules", isDirectory: () => true },
      ],
      "scripts/sub": [
        { name: "bar.test.ts", isDirectory: () => false },
      ],
      "scripts/node_modules": [
        { name: "should-never-appear.test.mjs", isDirectory: () => false },
      ],
    };
    const fakeReaddir = (dir) => {
      if (!(dir in fakeFs)) throw new Error(`ENOENT: ${dir}`);
      return fakeFs[dir];
    };

    const found = discoverTestFiles(["scripts"], fakeReaddir);

    expect(found).toEqual(["scripts/foo.test.mjs", "scripts/sub/bar.test.ts"]);
  });

  // REGRESSION (2026-09-08): TEST_FILE_RE used to require a DOT before "test"
  // (/\.test\.(mjs|ts|tsx|js)$/), which made every *.node-test.mjs file invisible to this
  // scan -- the exact silent-blind-spot class this file's header warns about. Six files used
  // that hyphen convention; five had no runner at all and one had been red for months with
  // nothing reporting it. This asserts both naming conventions are discovered so the widened
  // regex cannot regress back to dot-only.
  it("discoverTestFiles also finds hyphenated *.node-test.mjs files (not just dot *.test.mjs)", () => {
    const fakeFs = {
      "scripts": [
        { name: "foo.test.mjs", isDirectory: () => false },
        { name: "build-knowledge-db.node-test.mjs", isDirectory: () => false },
        { name: "not-a-test.mjs", isDirectory: () => false },
      ],
    };
    const fakeReaddir = (dir) => {
      if (!(dir in fakeFs)) throw new Error(`ENOENT: ${dir}`);
      return fakeFs[dir];
    };

    const found = discoverTestFiles(["scripts"], fakeReaddir);

    expect(found).toEqual(["scripts/build-knowledge-db.node-test.mjs", "scripts/foo.test.mjs"]);
  });

  // FINDING 2 (HIGH) -- a narrowed run must never exit 0 (success) unless the caller explicitly
  // acknowledges the narrowing, and the exit code for an unacknowledged narrowed run must be
  // distinguishable from both "clean pass" (0) and "real failure" (1).
  describe("computeExitCode", () => {
    it("exits 0 for a clean, unnarrowed, all-legs-passed run", () => {
      expect(computeExitCode({ failed: [], narrowed: false, narrowedAccepted: false })).toBe(0);
    });

    it("exits non-zero for a narrowed run with no acknowledgment", () => {
      const code = computeExitCode({ failed: [], narrowed: true, narrowedAccepted: false });
      expect(code).not.toBe(0);
    });

    it("exits 0 for a narrowed run that IS explicitly acknowledged via PROOF_ALL_ACCEPT_NARROWED", () => {
      expect(computeExitCode({ failed: [], narrowed: true, narrowedAccepted: true })).toBe(0);
    });

    it("a real leg failure always wins: non-zero even if also narrowed and acknowledged", () => {
      const code = computeExitCode({
        failed: [{ label: "typecheck (tsc --noEmit)", ok: false }],
        narrowed: true,
        narrowedAccepted: true,
      });
      expect(code).not.toBe(0);
    });

    it("an unacknowledged-narrowed exit code is distinct from a real-failure exit code", () => {
      const narrowedCode = computeExitCode({ failed: [], narrowed: true, narrowedAccepted: false });
      const failureCode = computeExitCode({ failed: [{ label: "x", ok: false }], narrowed: false, narrowedAccepted: false });
      expect(narrowedCode).not.toBe(0);
      expect(failureCode).not.toBe(0);
      expect(narrowedCode).not.toBe(failureCode);
    });
  });

  // The word "green" must never appear anywhere in a NARROWED RESULT line -- it is the exact
  // phrase someone would quote to claim full coverage, and this run explicitly does not have it.
  it("the RESULT line never contains the word 'green' (any case) when the run is narrowed", () => {
    const { text } = buildSummaryReport({
      results: baseResults(),
      missing: [],
      skippedByEnv: ["scripts/refresh-tire-meta.test.mjs"],
      vitestExtraExclude: ["src/services/foo.test.ts"],
      totalSkipped: 0,
    });

    const resultLine = text.split("\n").find((l) => l.startsWith("RESULT:"));
    expect(resultLine.toLowerCase()).not.toContain("green");
  });
});
