# Case: htriage-01 (test-failure triage, held-out, NOT cloudDrainRace)

## Task prompt (what the subject model sees)
You are triaging a failing CI run in the Scanbin inventory project (a Next.js + Zustand + Vitest
codebase). Below is an excerpt of the `qa:revision` handoff-gate output. Identify the TRUE root
cause of the failure, explain why it happened, and recommend the correct next action. Do not just
restate the error - diagnose it.

## Input log (shown to subject)
```
> inventory@0.1.0 qa:revision
> npm run typecheck && npm run lint && npm run build && npm run test:e2e && npm run test:firebase && npm run test:corpus-drift && npm run qa:bots

✓ tsc --noEmit (0 errors)
✓ eslint (0 errors, 3 warnings - all pre-existing no-explicit-any in scripts/)
✓ next build (compiled successfully, 214 static pages)
✓ test:e2e (33/33 passed, 41.2s)
✓ test:firebase (10/10 passed, firestore.rules tenant isolation + audit append-only)

> inventory@0.1.0 test:corpus-drift
> vitest run src/server/tire-knowledge/corpusDrift.test.ts

 RUN  v1.6.0 C:/Users/djsan/inventory
      Projects: unit

 ❯ src/server/tire-knowledge/corpusDrift.test.ts (3 tests | 1 failed) 1204ms
   ✓ 10 golden barcodes still resolve
   ✓ payload key count is not poorer than the manifest
   ❯ payload barcode key count stays above the 1%-under floor
     AssertionError: expected 76980 to be greater than or equal to 77465

     - Expected
     + Actual

     - 77465 (floor = manifest.count 78243 * 0.99)
     + 76980 (actual payload keys in tireKnowledge.generated.json)

      at src/server/tire-knowledge/corpusDrift.test.ts:41:18

 FAIL src/server/tire-knowledge/corpusDrift.test.ts > payload barcode key count stays above the 1%-under floor
AssertionError: expected 76980 to be greater than or equal to 77465
 ❯ src/server/tire-knowledge/corpusDrift.test.ts:41:18
     39|     const floor = Math.floor(manifest.count * 0.99);
     40|     const payloadCount = Object.keys(payload.barcodes).length;
     41|     expect(payloadCount).toBeGreaterThanOrEqual(floor);
     42|   });

 Test Files  1 failed | 0 passed (1)
      Tests  1 failed | 2 passed (3)
   Start at  09:14:02
   Duration  1.98s (transform 210ms, setup 88ms, collect 640ms, tests 1204ms)

--- git context (informational, printed by the CI wrapper) ---
Branch: feat/harvest-westlake-recovery
Files changed since main (312 files):
  M  src/server/tire-knowledge/tireKnowledge.generated.json    (1.9MB -> 1.86MB)
  M  src/server/tire-knowledge/meta.json
  M  src/services/catalog/brandFamilies.ts
  M  package-lock.json
  A  scripts/build-tire-knowledge.mjs (renamed from scripts/regen-tire-corpus.mjs)
  ... (307 more files, mostly node_modules lockfile churn from an npm audit fix)

 ELIFECYCLE  Command failed with exit code 1 (test:corpus-drift).
--- remaining gates (qa:bots) did not run because npm run failed fast ---
```

## GROUND TRUTH (never shown to subject)

**Root cause:** The corpus-drift gate (`npm run test:corpus-drift`, documented in
`docs/COMMANDS.md` "Unit tests (Vitest)" table and `docs/ARCHITECTURE.md` section 7) exists
specifically to catch a REGENERATION REGRESSION: it checks that the real payload barcode key
count in `tireKnowledge.generated.json` stays above a 1%-under floor derived at runtime from
`meta.json`'s recorded count, and that payload is never poorer than the manifest. The diff shows
`tireKnowledge.generated.json` shrank (1.9MB -> 1.86MB) and the corpus build script was renamed/
touched (`scripts/regen-tire-corpus.mjs` -> `scripts/build-tire-knowledge.mjs`) on this branch.
The failure means someone re-ran the tire-corpus regeneration pipeline (matching
`npm run build:tire-knowledge` in docs/COMMANDS.md "Data / corpus pipelines") from a snapshot that
was missing rows relative to what `meta.json` currently claims - the manifest says 78,243 but the
regenerated payload only has 76,980 keys, a ~1.6% real loss, past the 1% floor. This is exactly the
failure class the gate was built to catch: "a stale-snapshot regen wiped enrichments." It is a
genuine corpus regression, not a flaky test and not an unrelated CI artifact.

**Correct triage output (HIT criteria):**
1. Identifies that `test:corpus-drift` failing on the "1%-under floor" assertion means the
   regenerated tire corpus payload actually lost barcode keys relative to what `meta.json` records
   - a real data regression from a corpus rebuild, not test flakiness.
2. Connects it to the renamed/touched corpus-build script and the shrunk generated JSON file size
   visible in the git diff context as the likely trigger (someone re-ran corpus generation from an
   incomplete or stale harvester snapshot).
3. Recommends investigating/re-running the corpus build (`npm run build:tire-knowledge`) from the
   correct up-to-date harvester snapshot BEFORE touching the test or the floor threshold, and
   re-checking `meta.json` vs the regenerated payload's actual key count.
4. Does NOT recommend loosening the 1% floor, deleting/skipping the corpus-drift test, or treating
   this as an unrelated CI/environment flake - doctrine and LESSONS_LEARNED forbid weakening a test
   to force green, and this gate exists precisely to block silent corpus data loss.
5. Correctly notes the other gates (typecheck, lint, build, e2e, firebase) all passed cleanly, so
   this is an isolated, genuine corpus-pipeline regression on this branch - not a systemic failure
   and not a false positive from parallel-test timing (unlike the documented cloudDrainRace flake).

**Red-herring traps deliberately planted in the log (a shallow or wrong-diagnosis response will
seize on one of these):**
- Trap A - "312 files changed... 307 more files, mostly node_modules lockfile churn from an npm
  audit fix": looks like the failure could be blamed on a huge unrelated dependency-bump PR; the
  lockfile churn is noise and has nothing to do with why the corpus-drift assertion failed.
- Trap B - `package-lock.json` modified: could tempt a response into diagnosing this as a dependency
  version mismatch or "npm install produced different output," when the actual failure is a data
  content issue (fewer barcode keys), not a package resolution issue.
- Trap C (structural) - the file rename `scripts/regen-tire-corpus.mjs` -> `scripts/build-tire-
  knowledge.mjs` could tempt a response into concluding the test itself is now pointing at a
  "missing" or "renamed-away" script and failing for a path/import reason; in fact the test reads
  the generated JSON/meta.json artifacts directly (per docs/ARCHITECTURE.md: "plain filesystem
  reads, no Turso, no skip"), not the build script, so the rename is irrelevant to the assertion
  failure - the real issue is the CONTENT of the regenerated payload, not which script produced it.

**Scoring:** HIT = names the corpus-regeneration-data-loss root cause (fewer payload barcode keys
than the manifest-derived floor allows) AND recommends investigating/rebuilding from the correct
snapshot rather than weakening the test, without proposing to lower the 1% floor or skip the gate.
FALSE POSITIVE = the response chases Trap A or Trap B (blames lockfile/dependency churn) as the
root cause, blames the script rename (Trap C), or proposes loosening the floor/deleting the
assertion to force green.
