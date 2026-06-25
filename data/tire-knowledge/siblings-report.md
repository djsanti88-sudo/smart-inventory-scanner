# Sibling brands sharing FINAL prefixes

Source: data/tire-knowledge/tire_corpus_flat.csv + tire_prefixes_FINAL.csv (both read-only). Output: tire_prefixes_SIBLINGS.csv. No AI.

- new sibling rows emitted: 19 across 13 FINAL prefixes
- skipped (too-wide, > 4 new brands on one prefix): 1

## Emitted siblings

| prefix | new sibling brand | barcodes |
|---|---|---|
| 4981910 | Toyo | 2873 |
| 051342 | Continental | 1669 |
| 4981910 | Nitto | 869 |
| 051342 | General | 755 |
| 029142 | Hercules | 307 |
| 6959655 | Blackhawk | 267 |
| 0848983 | Dunlop | 250 |
| 0787025 | Mickey Thompson Tires | 241 |
| 029142 | Ironman | 72 |
| 0848983 | Ohtsu Tires | 47 |
| 0840156 | Tbb | 45 |
| 6959655 | Vogue | 30 |
| 4717784 | Presa | 21 |
| 0688028 | Tis Offroad Tires | 10 |
| 0768155 | Roadone | 10 |
| 0841623 | Kinforest | 10 |
| 029142 | Timberland | 9 |
| 0768155 | Aeolus | 5 |
| 0818749 | Giti | 5 |

## Skipped (too-wide, likely importer block)

- 0749715: Lionhart, Durun, Mazzini, Duraturn, Farroad, Roadone, Maxtrek, Groundspeed

## CONFLICTS - owner re-decision needed (corpus confirms >= 5 rows, but FINAL held it back)

| brand | prefix | FINAL tier | corpus barcodes |
|---|---|---|---|
| Goodyear | 069766 | review_before_use | 641 |
| Laufenn | 0715459 | hint_weak | 198 |
| Kelly | 069766 | hint_weak | 93 |
| Dick Cepek | 0787025 | hint_weak | 41 |
| Pantera | 0841623 | hint_weak | 31 |
| Dextero | 0818749 | hint_weak | 30 |
| Freestar | 0758823 | hint_weak | 21 |
| Landsail | 0841623 | hint_weak | 20 |
| Groundspeed | 0841623 | hint_weak | 20 |
| Nankang | 0758823 | hint_weak | 18 |
