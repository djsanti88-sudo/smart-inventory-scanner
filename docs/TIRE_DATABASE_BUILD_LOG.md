# Tire Database Build Log

Staged build of a tire barcode/spec catalog: 100 → 500 → 5000. Each stage advances ONLY if the
source-discovery go/no-go and quality gates pass and spend stays within caps.

## Hard gate
**No tire record generation begins** until both `reports/tire-db/source_inventory.md` and
`reports/tire-db/source_inventory.json` exist (source discovery complete).

## Caps & legality
- Cash cap $30 governs Gemini/OpenAI/UPCitemdb/Go-UPC/Barcode Lookup/any paid API (`reports/spend-ledger.json`).
- Firecrawl prepaid: cap 500 credits, 50 pages/domain (`reports/firecrawl-ledger.json`); reported every stage.
- No bypass of logins/paywalls/robots/ToS. Facts only, no copied marketing copy. Keep source URL/note.
- No one-by-one paid barcode lookup to reach 500/5000 — needs a safe bulk/free source or it stops.

## Record count categories (reported per stage — no padding)
1. verified scannable (verified + has UPC/GTIN/barcode)
2. candidate scannable
3. spec-only candidate (no verified barcode)
4. conflicted
5. rejected / held

## Stages

| stage | status | verified-scannable | candidate-scannable | spec-only | conflicted | rejected | metered $ | firecrawl credits |
|-------|--------|--------------------|--------------------|-----------|------------|----------|-----------|-------------------|
| discovery | DONE | — | — | — | — | — | $0 | 0 |
| 100 | DONE (candidate-grade) | 0 | 0 | 10 | 0 | 10 | $0 | ~80 (94 cumulative w/ benchmark) |
| 500 | NO-GO | — | — | — | — | — | — | — |
| 5000 | NO-GO | — | — | — | — | — | — | — |

## 100-stage result
20 real, source-backed records via `scripts/tire-discovery.ts` (Firecrawl, robots-checked, facts-only).
**0 verified-scannable, 0 active candidate-scannable, 10 spec-only candidates (manufacturer sources),
10 held (retailer), 0 conflicts.** Confirms the discovery finding: no free/legal source publishes
scannable tire UPC/GTIN. See `reports/tire-db/stage_100_summary.md`. STOP before 500/5000.

## Source-discovery result (gate)
See `reports/tire-db/source_inventory.md` + `.json`. **Binding finding: no safe, free, bulk source of
scannable tire barcodes exists** without an owner/vendor file, a paid license (Tireweb ~240k / TiresAddict),
or a per-code paid API over the $30 cap (Go-UPC $74.95/mo, Barcode Lookup). Decision: build + test the
pipeline, run a bounded honest 100-stage candidate sample (mostly spec/SKU, low verified-scannable), then
**STOP before 500/5000** per the owner's `bulk_source_rule`.
