# Case: hbug-02-brand-family-firewall-gap
## Task prompt (what the subject model sees)
Review the following code for real defects. This module feeds a "prefix firewall" that blocks an AI
decode result when the brand name a provider returns conflicts with the brand the corpus's GS1
company-prefix owner is known to be. `sameBrandFamily` is the escape hatch: two DIFFERENT brand
strings are treated as the SAME company (not a real conflict) only if they appear together in a
curated `FAMILIES` group with documented same-company evidence. Absence of family data must never
invent a relationship, but real corporate ownership that's missing from the table causes a live
product's identity to be wrongly blocked/demoted as a "brand conflict" purely because two sibling
brand names owned by the same company weren't in the table.
## Input code
```ts
// src/services/catalog/brandFamilies.ts

// Curated same-company brand families. Two brands in the SAME family are NOT a firewall
// conflict even when they differ, because one corporate parent owns both and legitimately
// ships product under either name across shared GS1 company prefixes.
//
// This exists to kill a specific false-positive class the prefix firewall produced on Go-UPC
// hits (see scripts/prefix-db-eval-report.md, list A): the tire corpus keys prefix 0709640 /
// 0332592 to "carlstar" (the parent), while Go-UPC returns the retail brand "Carlisle" - the
// same company, wrongly flagged as a wrong-brand conflict. A curated family table is the
// evidence-gated fix: ONLY groups we can point to concrete same-company evidence for.
//
// Pure, no imports. Each line carries the evidence for WHY those brands are one company.

/** Curated same-company groups. Only add a group with a verifiable same-company relationship. */
const FAMILIES: readonly string[][] = [
  // Bridgestone Americas owns Firestone (acquired 1988) and Dayton (Bridgestone's associate/value line).
  // Corpus prefix 0929711 carries all three (bridgestone 1684, firestone 68, dayton 53 rows).
  ["bridgestone", "firestone", "dayton"],
  // Goodyear owns Kelly (Kelly-Springfield, a Goodyear subsidiary) and Dunlop tire brand (Goodyear
  // owns the Dunlop tire trademark for North America).
  ["goodyear", "kelly", "dunlop"],
  // The Carlstar Group is the parent; Carlisle is its flagship tire/wheel retail brand. This is the
  // exact false-positive pair from the offline eval (prefixes 0709640 / 0332592).
  ["carlstar", "carlisle"],
  // Argus and Advanta are both value tire brands marketed by the same distributor (American Omni
  // Trading / same house brand family); the corpus keys them to shared prefixes.
  ["argus", "advanta"],
];

/** Same brand-normalization as the firewall so lookups line up (lowercase, strip punctuation + noise). */
function norm(b: string): string {
  return (b || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(tire|tires|tyre|tyres|inc|llc|co|company)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Precompute a normalized brand -> family-index map for O(1) lookup.
const BRAND_TO_FAMILY = new Map<string, number>();
FAMILIES.forEach((family, i) => {
  for (const brand of family) BRAND_TO_FAMILY.set(norm(brand), i);
});

/**
 * True when `a` and `b` are the SAME company per the curated family table (after normalization).
 * Identical brands trivially match. Unknown brands (not in any family) never match each other
 * unless they normalize identically - absence of family data must NOT invent a relationship.
 */
export function sameBrandFamily(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const fa = BRAND_TO_FAMILY.get(na);
  const fb = BRAND_TO_FAMILY.get(nb);
  return fa !== undefined && fa === fb;
}
```
## GROUND TRUTH (never shown to subject)
- Defect: the curated `FAMILIES` table is missing several real, well-documented corporate-sibling
  groups that the prefix firewall will hit in production - most concretely GS1 prefix `086699`, which
  the corpus keys to Michelin North America but which also legitimately carries BFGoodrich and
  Uniroyal product (Michelin owns both, via the 1990 Uniroyal Goodrich acquisition). Because
  `sameBrandFamily` only recognizes brands that are BOTH present in the same curated group, a live
  Go-UPC decode returning "Michelin" against a corpus prefix owner of "bfgoodrich" (or vice versa)
  is treated as a genuine cross-brand conflict and the correct identity gets wrongly blocked/demoted -
  the exact false-positive class this file exists to prevent, just for an un-cataloged real family.
  Other missing real families with the same failure mode: Continental/General (Continental acquired
  General Tire in 1987), Toyo/Nitto (Nitto is Toyo's subsidiary brand), and Goodyear's 2021
  acquisition of Cooper Tire (plus Cooper's house brands Mastercraft/Roadmaster/Mickey Thompson) not
  being added to the existing `["goodyear", "kelly", "dunlop"]` group.
- Fix commit: 2b64de7 fix(prefix-firewall): Michelin/BFGoodrich/Uniroyal + other evidenced corporate families end the 086699 false conflict
- Key evidence: the fix commit adds `["michelin", "bfgoodrich", "uniroyal"]`, `["continental",
  "general"]`, `["toyo", "nitto"]`, `["sumitomo", "falken", "ohtsu"]`, `["hankook", "laufenn"]` as new
  groups, and extends the existing Goodyear group to `["goodyear", "kelly", "dunlop", "cooper",
  "mastercraft", "roadmaster", "mickey thompson"]`, citing a live false-conflict reproduction: Go-UPC
  returning "Michelin" vs. prefix owner "bfgoodrich" on barcode `086699998538`.
- Scoring: HIT if the subject identifies that the curated `FAMILIES` table is incomplete for real,
  well-known corporate tire-brand ownership (naming at least one concrete missing pair such as
  Michelin/BFGoodrich, Michelin/Uniroyal, Continental/General, Toyo/Nitto, or Goodyear/Cooper) and
  explains the consequence: a genuine same-company decode gets wrongly treated as a brand conflict by
  the downstream firewall because `sameBrandFamily` returns false for any pair not jointly listed.
  PARTIAL if the subject correctly identifies "this table is necessarily incomplete / hardcoded and
  will miss real families over time" as a design risk but does not name a specific concrete missing
  pair or the resulting false-conflict consequence. Plausible-but-wrong findings: (1) claiming
  `sameBrandFamily("", "")` returning `false` is a bug (it is correct - two blank/unknown brands must
  never be treated as a match, per the doc comment); (2) flagging the `norm()` stopword regex for
  stripping "co"/"inc" as too aggressive or brand-name-mangling (not the real defect, and not shown to
  cause any incorrect grouping in this snippet); (3) suggesting `BRAND_TO_FAMILY` should be rebuilt at
  call time instead of module load (a stylistic/performance nit, unrelated to the actual false-conflict
  bug and the table's data being genuinely incomplete).
