# Mined prefix report

Source: data/tire-knowledge/tire_corpus_flat.csv (read-only). Output: tire_prefixes_ADDITIONS.csv. No AI used.

- brands processed: 209
- distinct prefixes emitted: 124
- (prefix,brand) rows emitted: 159
- skipped (too-wide, > 6 brands on one prefix): 1

## Top 20 emitted prefixes (by confirming barcodes)

| prefix | brand | brands | barcodes |
|---|---|---|---|
| 6419440 | Nokian | 1 | 1852 |
| 0887613 | Nexen | 2 | 805 |
| 88481160 | Blackhawk | 1 | 415 |
| 88864595 | Radar | 3 | 375 |
| 087718400 | Falken | 2 | 334 |
| 899702061 | Accelera | 1 | 312 |
| 88593055 | Arisun | 1 | 305 |
| 07413179 | Kelly | 1 | 190 |
| 0040232 | Americus | 1 | 180 |
| 899423402 | Accelera | 1 | 147 |
| 47110415 | Kenda | 1 | 121 |
| 07465732 | Advanta | 2 | 114 |
| 955000000 | Versatyre | 2 | 113 |
| 47133091 | Kenda | 1 | 104 |
| 08444020 | Gladiator | 2 | 91 |
| 89353412 | Blackhawk | 1 | 86 |
| 09904986 | Rotalla | 4 | 86 |
| 0661537 | Nankang | 5 | 82 |
| 868111066 | Arroyo | 2 | 76 |
| 0729419 | Amp | 1 | 66 |

## Skipped (too-wide, flagged for manual review)

- 0636313: 12 brands (Primewell, Cordovan, Mazzini, Rapid, Blacklion, Constancy, Kinforest, Minerva, ...)

## Dropped (minor share < 10% of the brand's barcodes - likely contamination)

- Toyo on 0092971: 42 of 2941 (1.4%)
- Blackhawk on 045043434: 31 of 819 (3.8%)
- Americus on 0094922: 20 of 249 (8.0%)
- Toyo on 064773201: 12 of 2941 (0.4%)
- Firestone on 092971: 11 of 611 (1.8%)
- Radar on 07147706: 11 of 152 (7.2%)
- Fortune on 084006360: 10 of 389 (2.6%)
- Americus on 0051497394: 10 of 249 (4.0%)
- Fortune on 693783350: 9 of 389 (2.3%)
- Radar on 04504465: 8 of 152 (5.3%)
- Vogue on 031381: 8 of 82 (9.8%)
- Mickey Thompson Tires on 0029142674: 7 of 248 (2.8%)
- Vogue on 893534120: 7 of 82 (8.5%)
- Fortune on 074512549: 7 of 389 (1.8%)
- Continental on 4019238: 6 of 1675 (0.4%)
- Vogue on 0655360: 6 of 82 (7.3%)
- Blackhawk on 893609630: 6 of 819 (0.7%)
- Versatyre on 0770887435: 5 of 117 (4.3%)
