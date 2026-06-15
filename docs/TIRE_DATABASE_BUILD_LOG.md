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
| discovery | _pending_ | — | — | — | — | — | — | — |
| 100 | _pending_ | — | — | — | — | — | — | — |
| 500 | _pending_ | — | — | — | — | — | — | — |
| 5000 | _pending_ | — | — | — | — | — | — | — |
