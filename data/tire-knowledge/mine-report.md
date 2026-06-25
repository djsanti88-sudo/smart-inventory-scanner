# Mined prefix report

Source: data/tire-knowledge/tire_corpus_flat.csv (read-only). Output: tire_prefixes_ADDITIONS.csv. No AI used.

- brands processed: 205
- distinct prefixes emitted: 169
- (prefix,brand) rows emitted: 206
- skipped (too-wide, > 6 brands on one prefix): 2

## Top 20 emitted prefixes (by confirming barcodes)

| prefix | brand | brands | barcodes |
|---|---|---|---|
| 6419440 | Nokian | 1 | 1852 |
| 0887613 | Nexen | 2 | 805 |
| 89947310 | Achilles | 1 | 437 |
| 88481160 | Blackhawk | 1 | 415 |
| 087718400 | Falken | 2 | 334 |
| 899702061 | Accelera | 1 | 312 |
| 88593055 | Trazano | 2 | 309 |
| 07413179 | Kelly | 1 | 190 |
| 88864595 | Radar | 2 | 159 |
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

- 0636313: 17 brands (Primewell, Chaoyang, Cordovan, Dean, Mazzini, Rapid, Vitour, Blacklion, ...)
- 0655360: 7 brands (Prinx, Roadx, Atlander, Dcenti, Trazano, Giti, Sigma)

## Dropped (minor share < 10% of the brand's barcodes - likely contamination)

- Toyo on 0092971: 42 of 2941 (1.4%)
- Blackhawk on 045043434: 31 of 819 (3.8%)
- Toyo on 064773201: 12 of 2941 (0.4%)
- Firestone on 092971: 11 of 611 (1.8%)
- Radar on 07147706: 11 of 152 (7.2%)
- Fortune on 084006360: 10 of 389 (2.6%)
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
- Falken on 0724515: 4 of 1832 (0.2%)
- Nexen on 8807622: 4 of 1256 (0.3%)
- Toyo on 0648620344: 4 of 2941 (0.1%)
- Vogue on 0733569: 4 of 82 (4.9%)
- Versatyre on 6921000003: 4 of 117 (3.4%)
- Fortune on 0450602: 4 of 389 (1.0%)
- Blackhawk on 0450000: 4 of 819 (0.5%)
- Doublestar on 045011351: 4 of 45 (8.9%)
- Doublestar on 045076: 4 of 45 (8.9%)
- Doublestar on 04508819: 4 of 45 (8.9%)
- Evergreen on 04601353: 4 of 44 (9.1%)
- Evergreen on 046096584: 4 of 44 (9.1%)
- Fullway on 6910070820: 4 of 45 (8.9%)
- Rydanz on 0636313: 4 of 42 (9.5%)
- Windforce on 0733569: 4 of 43 (9.3%)
- Aplus on 04503624: 4 of 45 (8.9%)
- Dextero on 89908761210: 4 of 44 (9.1%)
- Duraturn on 084335300: 4 of 41 (9.8%)
- Sunny on 0768155413: 4 of 43 (9.3%)
- Cosmo on 0850014951: 4 of 45 (8.9%)
- Kanati on 0721749: 4 of 44 (9.1%)
- Solar on 08401127538: 4 of 45 (8.9%)
- Lanvigator on 04631461: 4 of 41 (9.8%)
- Lanvigator on 0636313: 4 of 41 (9.8%)
- ... and 174 more
