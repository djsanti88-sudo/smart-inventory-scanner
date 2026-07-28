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

