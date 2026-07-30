# Fetch V2 credit efficiency - design (2026-07-04, owner-approved direction)

Owner finding: ~600 of 975 Firecrawl credits went to RE-interrogating the same ~22 provably-dead
codes across sweeps (6 credits each per sweep: quoted 2 + unquoted 2 + variance-retry 2).
Owner decisions: no auto-retry of dead codes EVER (manual only - they go to the ladder);
focus = near-perfect web fetch with little/no AI; spend as close to zero as possible.

## Component 1: No-result receipts (kills ~70% of historical burn)
- `FetchV2Cache` gains `getNoResult(primary)` / `markNoResult(primary, note)` - in-memory map,
  same FIFO cap discipline. NO TTL: a receipt is permanent until explicitly cleared (owner rule).
- Engine (`index.ts`): after a full discovery pass ends with zero identity-carrying findings and
  zero page evidence, `markNoResult(primary, doorsProbed)`. On entry (after the verified-cache
  check), a receipt short-circuits to outcome `unknown` with rule
  "no-result receipt on file (owner: no auto-retry; ladder handles it)" - zero searches spent.
  Counted as always (count-first contract untouched).
- Benchmark persistence: `scripts/fetchv2-noresult-receipts.json` loaded into the cache at start,
  appended incrementally (crash-safe). New flag `--force-retry` bypasses receipts for the run
  (the owner's manual override).
- SAFETY: a receipt is only written when the code was ACTUALLY probed (discovery ran to the end,
  not budget-truncated, not rate-limit-truncated: no 429-flagged empty passes).

## Component 2: Free pattern-URL door (saves paid searches on findable codes)
- For public barcodes, BEFORE any discovery search, construct up to 2 predictable barcode-DB URLs
  from V1's curated pool (`selectBarcodeUrls`, `barcodeDbUrls` - reuse, not rebuild) and add them
  as rank-0 candidates for the free direct page fetch. Pages that carry the code produce page-level
  evidence for $0; junk/not-found pages are rejected by the existing firewall.
- Not a new trust tier: these pages go through the exact same junk gate + association proof.

## Explicitly NOT doing (YAGNI, per owner "don't overcomplicate")
- No TTL machinery, no scheduled retries, no receipt UI - a JSON file + --force-retry flag.
- No trimming of the quoted variance retry: with receipts it is a once-ever 2cr per dead code.

## Acceptance
- Unit: receipt short-circuit (0 discovery calls), receipt written only on complete empty passes,
  --force-retry override, pattern-URL candidates precede paid search, count-first invariants hold.
- Live proof: re-run the current 23-code residue twice; second pass must spend ~0 credits.
- Suite + tsc green; canaries unaffected (receipts never verify anything).
