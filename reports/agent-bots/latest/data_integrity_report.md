# DataIntegrityBot report

All pass: **true**

| check | result | detail |
|-------|--------|--------|
| two scans of one code -> qty 2 (no accidental double) | PASS | qty=2 |
| count persists after refresh | PASS | coke rows after reload=1 |
| unknown code -> Needs Review (not auto-resolved) | PASS | 12:58:25 pm	999000111222	999000111222	unknown	-	-	needs review	no approved alias |

> Idempotent sync (no double-count on network retries), exact-alias-wins, and ambiguous-normalized -> Needs Review are additionally locked by unit/store tests (multiCodeResolution, multiCodeCapture, mismatchGuard, aliasRepair). Screenshots: e2e/proof/agent-bots/data-integrity/
