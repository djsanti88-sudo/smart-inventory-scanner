# Retail Corpus Sanitize - Before/After Diff (QA Task 5)

GATE: Turso NOT synced. This diff describes what the sanitize would remove/change. The LOCAL
knowledge.generated.db was rebuilt clean; the production Turso mirror is UNCHANGED and awaits
owner approval before any re-sync.

Source JSON generated_at: 2026-06-30T00:36:06.527Z

## Row counts
| metric | value |
|---|---|
| total rows (before) | 4,047,273 |
| rows kept (after) | 4,033,662 |
| rows DROPPED | 13,611 (0.3363%) |
|  - dropped: dummy/placeholder barcode | 2 |
|  - dropped: garbled text (run-on / blob) | 13,609 |
| brands truncated to first tag | 213,499 (5.2784% incl. cleared) |
| brands cleared (first tag still garbled) | 134 |

## Verified in the REBUILT LOCAL DB
- Poisoned row 0123456789012 ("Peanut Butter Crunch" / "Fleischer, Selbst gemacht, The Wholesome Bar, Uberti"): ABSENT (dropped).
- Run-on multi-brand rows (>=3 commas in brand): 0 (was the poisoning vector).
- brand length > 60: 68 (was 1908) - residual are benign single verbose names, no comma tag-lists.
- Total retail rows in rebuilt DB: 4,033,662.

## Sample dropped rows (garbage)
- 10827987: ["Kale & chicken chopped kale blend, white meat chicken, feta cheese, dried cranberries with a raspberry vinaigrette salad","SIGNATURE CAFE","Salted-s
- 10846384: ["00020126920014br.gov.bcb.pix2570qrcodes.sulcredi.coop.br/v2/v3/at/6a858260-1e93-4df2-9c35-0f952de314cf5204000053039865802BR5911BYTECH LTDA6009SAO PA
- 11145066: ["Trail Mix Crackers with mung beans, seeds, cashews, raisins & cheese","Trader Joe's",null]
- 12118878: ["Rosemary, mint, sage, green tea clear mind kombucha","BREW DR. KOMBUCHA","Beverages"]
- 14321184: ["Reviews Clean Nutraceuticals Primary Supplement TypeL-Theanine, Magnesium Glycinate, Magnesium, Magnesium Citrate, Magnesium Taurate",null,null]
- 14745393: ["Grape, lemon, strawberry, green apple, orange original bite size candies","SKITTLES","Confectioneries"]
- 14926280: ["Vanilla and chocolate with heath toffee pieces and fudge covered waffle cone pieces frozen dairy dessert, vanilla and chocolate","UNILEVER","Frozen 
- 14983108: ["Protein Meal Bar, Chocolate Peanut Butter - Elevation by Millville - Elevation by Millville - Elevation by Millville",null,null]
- 15983220: ["TURKEY SAUSAGE Bites with Sharp Cheddar Cheese & Sea Salted Almonds & Peanut Butter Filled Pretzels","H-E-B",null]
- 16465565: ["16 mini nems - poulet, menthe, légumes, coriandre","Cuisine Evasion","Chicken nems"]
- 17853699: ["Katsu Curry Noodles, Chicken Breast Noodles, Kale, Edamame & Katsu Sauce","Fuelhub",null]
- 18115628: ["Pâte à tartiner, chocolat, noir, noisettes, orange",null,null]

## Sample brand truncations (first OFF tag kept)
- 10000052: "E.Leclerc, Leclerc" => "E.Leclerc"
- 10004265: "Nestlé, Quality Street" => "Nestlé"
- 10007822: "Tesco, Yew tree dairy" => "Tesco"
- 10012567: "Tesco, Garden" => "Tesco"
- 10023280: "Lidl, Solevita" => "Lidl"
- 10024041: "Splenda, SMUCKERS" => "Splenda"
- 10035399: "Tesco, method" => "Tesco"
- 10048597: "Mars, Snickers" => "Mars"
- 10055144: "Allos, Tartex" => "Allos"
- 10055564: "Iberia, NOEL" => "Iberia"
- 10066157: "Tesco, Woodcote" => "Tesco"
- 10070390: "Evian, Kusmi Tea" => "Evian"
