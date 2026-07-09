# Prefix-DB Value Report for Go-UPC Hits (OFFLINE, no behavior change)

Generated: 2026-07-09T02:58:20.911Z by `scripts/eval-prefix-db.mjs` (offline mode).

## What this measures

The brand-prefix firewall (`src/services/catalog/brandPrefixGeneral.ts` -> `prefixBrandConflict`) routes a Go-UPC exact hit to Needs Review instead of auto-counting when the code's 7-digit GS1 company prefix is a KNOWN single-brand prefix and Go-UPC's brand clearly disagrees. Auto-count after the firewall is ALREADY owner-approved (decision 2026-07-08 evening). This report only quantifies the expected trigger rate and coverage over the 200-code Go-UPC tire run; it changes NO behavior.

- Keying scheme: `code.replace(/\D/g,'').slice(0,7)` (7-digit prefix), matching the live firewall.
- Distilled map (`brandPrefixMap.json`, the firewall's actual input): 138 single-brand prefixes.
- Raw derived map (`derivedPrefixMap.json`, source stats): 23999 prefixes.

## Counts (Go-UPC HIT rows only)

Total rows in run: 200. Go-UPC hits: 126.

| Classification | Count | Meaning |
| --- | --- | --- |
| Prefix known + brands agree | 14 | Prefix in distilled map, firewall does NOT flag -> auto-count proceeds |
| Prefix known + CONFLICT (firewall fires) | 2 | Prefix in distilled map, `prefixBrandConflict` = true -> routed to Needs Review |
| Prefix unknown | 110 | Prefix not in distilled map -> firewall is a no-op (auto-count proceeds unchecked) |

Firewall trigger rate on this set: **2 / 126 hits (1.6%)** would be diverted to Needs Review by the current distilled map.

## Conflict list (with evidence)

### A. Firewall-flagged conflicts (current distilled map, `prefixBrandConflict` = true)

| Code | Prefix | Map owner | Go-UPC brand | Corpus (truth) | Verdict |
| --- | --- | --- | --- | --- | --- |
| 070964035646 | 0709640 | carlstar | Carlisle | carlstar | FALSE POSITIVE (map owner is a same-company alias of Go-UPC's brand) |
| 033259276476 | 0332592 | carlstar | Carlisle Tire | carlstar | FALSE POSITIVE (map owner is a same-company alias of Go-UPC's brand) |

### B. Corpus-truth vs Go-UPC brand disagreements (the real error class, prefix-map-independent)

These are hits where the tire corpus ground-truth brand and Go-UPC's brand disagree. This is exactly the class the firewall exists to catch. A row here that is NOT in list A is a COVERAGE GAP: the prefix is not yet in the map, so the current firewall misses it.

| Code | Prefix | Corpus (truth) | Go-UPC brand | In distilled map? | Caught by firewall now? |
| --- | --- | --- | --- | --- | --- |
| 092971135485 | 0929711 | bridgestone | Westlake | NO | NO |
| 070964035646 | 0709640 | carlstar | Carlisle | yes | yes |
| 033259276476 | 0332592 | carlstar | Carlisle Tire | yes | yes |

Confirmed live error (Westlake vs Bridgestone) flagged: **YES**

- `092971135485`: corpus truth = **bridgestone**, Go-UPC = **Westlake**. Prefix `0929711` in distilled map: **NO**. Caught by the CURRENT firewall: **NO**.
- IMPORTANT: this true error is a COVERAGE GAP. The prefix `0929711` is absent from the distilled map, so `prefixBrandConflict` returns false and the current firewall would NOT divert it. It is only visible here because the offline corpus provides an independent ground-truth brand. The firewall's value on this error depends on adding the prefix to the map (see coverage delta + meros door below).

## Coverage delta estimate

| Prefix source | Hits with a known prefix | Coverage of hits |
| --- | --- | --- |
| Distilled map (current firewall) | 16 | 12.7% |
| + raw derived map (prefixes seen but not promoted) | 17 | 13.5% |

- 1 hit prefix(es) are present in the raw derived map but were NOT promoted to the distilled single-brand map (impure or < 3 entries). Consulting the derived map directly (with a purity gate) is a possible free coverage gain, but risks the false-positive class already seen in list A.
- 109 hit prefix(es) are absent from BOTH maps (including the Westlake prefix `0929711`). Only an external prefix source (e.g. meros.io) could add these.

### meros.io free prefix door (coverage for prefixes missing from both maps)

Not fetched (offline mode). Re-run with `--fetch-meros` to fetch up to 20 meros.io prefix pages at 1 req/s for prefixes missing from both maps and estimate the added coverage. This path is implemented but left OFF pending an owner decision — running it is a network call, not a behavior change.

## False-positive finding (load-bearing)

On this set the firewall's only two fires (list A) are BOTH false positives: prefix owner `carlstar` vs Go-UPC `Carlisle` / `Carlisle Tire`. Carlstar Wheel & Tire owns the Carlisle brand, so these are the same company; the firewall's shared-leading-token matcher does not recognize `carlstar` and `carlisle` as related and flags a conflict. Net: with the current distilled map, the firewall would send 2 correct auto-counts to Needs Review and would still MISS the one true error. This does not change the owner-approved decision (firewall on, auto-count after) but is the accuracy cost the map quality drives.

## GO / NO-GO recommendation

| Item | Recommendation | Rationale / evidence |
| --- | --- | --- |
| Prefix firewall on Go-UPC hits | GO (already owner-approved) | Owner decision 2026-07-08 evening. Expected trigger rate on this 200-code run: 2/126 hits (1.6%). Low blast radius; no behavior change from this report. |
| Improve map brand-alias handling (carlstar/carlisle) | RECOMMEND (owner-gated, separate task) | Both current fires are false positives (same-company brand aliases). Add a brand-alias table before the firewall's blast radius grows. |
| Add missing prefixes (e.g. 0929711 Bridgestone) to the map | RECOMMEND (owner-gated, separate task) | The one confirmed live error (Westlake vs Bridgestone) is a coverage gap: prefix absent from both maps, so the firewall misses it today. Adding it (via corpus regeneration or a free source like meros.io) is what makes the firewall catch this error class. |

_No behavior change without a new owner decision recorded in the spec._
