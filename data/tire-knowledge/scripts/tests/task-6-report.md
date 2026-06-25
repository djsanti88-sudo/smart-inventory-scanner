# Task 6: seed_from_example.py — Gate 0 (COMPLETE)

## Summary
Implemented `scripts/seed_from_example.py` to seed the 95-row fixture through the free pipeline (URL parsing only, zero Firecrawl credits).

## Implementation
File created: `scripts/seed_from_example.py`
- Reads seed file: `seed/TIRE_C_1.csv` (100 data rows)
- Re-derives identity from each row's `source_url` via `parse_url` (URL is source of truth)
- Carries forward enrichment fields: load_index, speed_rating, tire_type, season
- Routes/writes via `write_rows` with ledger tracking
- Runs audit to verify schema, GTINs, sizes, and ledger consistency

## Execution Results

### Run 1 (Initial seed)
```
SEED COUNTS {'trusted': 100, 'backlog': 0, 'rejected': 0, 'dup_skipped': 0}
AUDIT PASS
```

### Run 2 (Idempotency test)
```
SEED COUNTS {'trusted': 0, 'backlog': 0, 'rejected': 0, 'dup_skipped': 100}
AUDIT PASS
```

### Run 3 (Idempotency confirmation)
```
SEED COUNTS {'trusted': 0, 'backlog': 0, 'rejected': 0, 'dup_skipped': 100}
AUDIT PASS
```

### Final Row Count
```
rows 100
```
(Not 300 — idempotency preserved; no duplicate insertions across all three runs.)

## Proof
- ✅ Trusted count: ~100 (exactly 100 in run 1)
- ✅ No rejected or backlog rows
- ✅ Idempotency: runs 2 and 3 both show dup_skipped: 100, trusted: 0
- ✅ Row count stable: 100 rows after all three runs
- ✅ AUDIT PASS on all runs
- ✅ Zero Firecrawl credits spent (URL parsing only)

## Gate 0 Status
**COMPLETE — ZERO CREDITS**
Pipeline proven from seed → parse → validate → route → write → ledger → audit, with idempotency guaranteed.
Ready to proceed to Milestone 2 (Firecrawl harvesting gates).
