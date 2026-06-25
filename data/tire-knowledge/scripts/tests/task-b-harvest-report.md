# Task B — upcitemdb_harvest Report

**run_id**: upcitemdb_001  
**date**: 2026-06-23

## Summary

| metric | value |
|---|---|
| brands_hit | 46 |
| brands_missed | 2 (gt_radial: 404, venom_power: 404) |
| products_parsed | 1,202 |
| trusted_added | 910 |
| dup_skipped | 265 |
| backlog | 27 |
| rejected | 0 |
| audit_ok | **True** (AUDIT PASS) |
| corpus before | 21,978 |
| corpus after | **22,888** |

## Per-brand breakdown (parsed / trusted)

| brand | parsed | trusted |
|---|---|---|
| goodyear | 31 | 30 |
| michelin | 0 | 0 |
| bridgestone | 0 | 0 |
| firestone | 11 | 11 |
| continental | 0 | 0 |
| pirelli | 0 | 0 |
| cooper | 0 | 0 |
| falken | 43 | 16 |
| hankook | 45 | 8 |
| kumho | 40 | 29 |
| nexen | 45 | 41 |
| nitto | 42 | 21 |
| toyo | 32 | 6 |
| yokohama | 45 | 23 |
| dunlop | 36 | 16 |
| general | 0 | 0 |
| bfgoodrich | 0 | 0 |
| nokian | 37 | 35 |
| fortune | 45 | 45 |
| blackhawk | 45 | 45 |
| ironman | 18 | 3 |
| hercules | 0 | 0 |
| mastercraft | 4 | 4 |
| sumitomo | 28 | 27 |
| laufenn | 44 | 7 |
| kenda | 0 | 0 |
| maxxis | 1 | 1 |
| sailun | 32 | 32 |
| milestar | 45 | 45 |
| westlake | 41 | 41 |
| gt_radial | MISS | — |
| linglong | 18 | 18 |
| prinx | 19 | 19 |
| delinte | 45 | 45 |
| sentury | 1 | 1 |
| radar | 43 | 36 |
| atturo | 38 | 14 |
| federal | 44 | 43 |
| lexani | 43 | 40 |
| lionhart | 38 | 37 |
| nankang | 41 | 40 |
| gladiator | 41 | 40 |
| venom_power | MISS | — |
| vredestein | 1 | 1 |
| uniroyal | 0 | 0 |
| kelly | 45 | 44 |
| goodride | 30 | 30 |
| ohtsu | 45 | 16 |

## Test results

143/143 passed. New tests: `test_upcitemdb_harvest.py` (5 tests, all offline).

## Concerns

- **Zero-parsed brands** (michelin, bridgestone, continental, pirelli, cooper, general, bfgoodrich, hercules, kenda, uniroyal): pages returned 200 but contained no `<div class="rImage">` blocks matching the parser regex. These brands likely use a different page layout or pagination on upcitemdb. Content is there but not in the expected format. Backlog slugs that are 0-parsed are candidates for a follow-up scraper pass.
- **Backlog (27 rows)**: rows where the parser could not extract a GTIN-valid barcode or size. All routed to `tire_enrichment_backlog.csv`.
- **UID uniqueness fix**: upcitemdb legitimately lists multiple distinct UPCs for the same model+size combination (different distribution channels). The harvester appends the barcode to the `manufacturer_part_number` field (`{mpn}_{barcode}`) to guarantee a unique `canonical_product_uid` per barcode. This keeps the audit clean without changing shared validate.py.
- **gt_radial / venom_power**: both return HTTP 404. Likely need alternate slug forms (e.g. `gt-radial`, `venom-power`).
