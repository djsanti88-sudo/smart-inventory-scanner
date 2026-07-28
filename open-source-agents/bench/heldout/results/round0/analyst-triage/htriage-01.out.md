<!-- subject=analyst-triage case=htriage-01 round=0 elapsed=116s rc=0 -->
**HYPOTHESIS:**  
The failure is caused by a bug in the tire‑knowledge generation logic that, after recent changes to `brandFamilies.ts`, omitted a number of barcodes from `tireKnowledge.generated.json`. Because the test computes a 1 % floor based on `manifest.count` and then counts the keys in the generated payload, the reduced set of barcodes (actual count = 76980 vs. expected floor ≈ 77465) triggers the assertion.

**CONFIDENCE:** medium – the evidence shows a deterministic mismatch between the generated JSON size and the test’s expectation; no timing or race artifacts are apparent.

**NEXT STEP:**  
Re‑run the failing test in isolation: `vitest src/server/tire-knowledge/corpusDrift.test.ts`. If it still fails, examine the generation code (especially how `brandFamilies` is applied) to identify why barcodes were omitted.
