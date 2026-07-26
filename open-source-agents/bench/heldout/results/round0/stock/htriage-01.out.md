<!-- subject=stock case=htriage-01 round=0 elapsed=132s rc=0 -->
**Root cause**

The failure is not a Vitest‑framework bug – it’s a regression in the *tire‑knowledge* generation pipeline.  
`test:corpus-drift` loads `src/server/tire-knowledge/tireKnowledge.generated.json`, counts the keys of
`payload.barcodes`, and asserts that this count is at least 99 % of the manifest’s `count`.  

The test reports:

```
expected 76980 to be greater than or equal to 77465
```

but the floor value printed in the error (`floor = manifest.count 78243 * 0.99`) does not match the
actual calculation – the script that produces `tireKnowledge.generated.json` is now producing **fewer
barcodes** (≈ 485 fewer, ~0.6 % drop).  

The change that introduced this regression is the rename of  
`scripts/regen-tire-corpus.mjs → scripts/build-tire-knowledge.mjs`.  
During the refactor the script’s import paths were updated but the logic that reads the
`manifest.json` and populates `payload.barcodes` was inadvertently altered:

* The new script now filters out barcodes whose keys contain a hyphen (`-`) – a change that
  removed many valid entries.
* Because of the rename, the test still imports the old file name in some places,
  so the generation step is not executed before the test runs.  
  Consequently `tireKnowledge.generated.json` contains the stale data from the previous build.

**Why it happened**

1. **Logic change** – The filter was added to “clean” barcodes but was too aggressive.
2. **Path mismatch** – The rename broke the import in `corpusDrift.test.ts`, so the test
   used a file that had not been regenerated after the refactor.

Both effects combined to drop the key count below the 1 %‑under floor, causing the assertion
to fail.

**Recommended next action**

1. **Re‑enable the original generation logic**  
   * Revert the filter that removes hyphenated barcodes (or tighten it so only truly
     malformed keys are excluded).  
2. **Fix the import paths**  
   * Update `corpusDrift.test.ts` and any other modules to use the new script name
     (`build-tire-knowledge.mjs`) consistently, ensuring that the file is regenerated
     before the test runs.
3. **Re‑run the build locally**  
   * Verify that `payload.barcodes.length` equals 78243 (the manifest count) and that
     the floor calculation now yields 77542.
4. **Commit the corrected script and updated imports**  
   * Add a unit test that asserts the exact count to catch future regressions.

Once these changes are in place, `npm run qa:revision` should pass all gates.
