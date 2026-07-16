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

// Dunlop is deliberately in NO family below. Goodyear held the Dunlop tire trademark for North
// America/Europe/Oceania for decades, but Sumitomo Rubber Industries REPURCHASED that trademark
// in a deal that closed May 2025 - Dunlop-branded product today is Sumitomo's, while pre-2025
// shelf stock (still legitimately in circulation) is Goodyear-era. Because ownership is
// mid-transition and a brand can only live in ONE group here, grouping "dunlop" with EITHER
// goodyear OR sumitomo risks suppressing a real conflict for the other owner's stock. Leaving it
// unfamilied routes any Dunlop-branded result on a known prefix to Needs Review instead of an
// auto-pass - "wrong product identity is FAILURE, unknown is ACCEPTABLE" (see CLAUDE.md Resolver
// Trust Rules). Revisit only with dated evidence the transition-era stock has fully cycled out.

/** Curated same-company groups. Only add a group with a verifiable same-company relationship. */
const FAMILIES: readonly string[][] = [
  // Bridgestone Americas owns Firestone (acquired 1988) and Dayton (Bridgestone's associate/value line).
  // Corpus prefix 0929711 carries all three (bridgestone 1684, firestone 68, dayton 53 rows).
  ["bridgestone", "firestone", "dayton"],
  // Goodyear owns Kelly (Kelly-Springfield subsidiary) and, since 2021, Cooper Tire & Rubber
  // including Cooper's house brands Mastercraft, Roadmaster and Mickey Thompson. Dunlop is
  // deliberately EXCLUDED here - see the standalone comment above the FAMILIES table (2025
  // Sumitomo trademark repurchase; transition-era stock spans both owners).
  ["goodyear", "kelly", "cooper", "mastercraft", "roadmaster", "mickey thompson"],
  // The Carlstar Group is the parent; Carlisle is its flagship tire/wheel retail brand. This is the
  // exact false-positive pair from the offline eval (prefixes 0709640 / 0332592).
  ["carlstar", "carlisle"],
  // Argus and Advanta are both value tire brands marketed by the same distributor (American Omni
  // Trading / same house brand family); the corpus keys them to shared prefixes.
  ["argus", "advanta"],
  // Michelin North America owns BFGoodrich (acquired via Uniroyal Goodrich, 1990) and the Uniroyal
  // tire brand in NORTH AMERICA ONLY (Continental owns the Uniroyal trademark in Europe); this
  // table serves the NA-market corpus, so NA Uniroyal GTINs legitimately share Michelin-family
  // prefixes. GS1 prefix 086699 carries Michelin, BFGoodrich and Uniroyal product (live
  // false-conflict: Go-UPC "Michelin" vs prefix owner "bfgoodrich" on 086699998538, 2026-07-10).
  ["michelin", "bfgoodrich", "uniroyal"],
  // Continental AG owns General Tire (acquired 1987, marketed as "General" in North America).
  ["continental", "general"],
  // Toyo Tire Corporation owns Nitto (Nitto Tire is Toyo's subsidiary brand).
  ["toyo", "nitto"],
  // Sumitomo Rubber Industries owns Falken and Ohtsu.
  ["sumitomo", "falken", "ohtsu"],
  // Hankook owns Laufenn (its value line).
  ["hankook", "laufenn"],
  // EVIDENCE CLASS: distributor-shared-prefix (NOT common ownership). Tireco Inc. owns Milestar
  // (its own house brand, Nankang-made) and holds the exclusive US master-distribution agreement
  // for Westlake (a Zhongce Rubber/China brand it does not manufacture). Both ship under Tireco's
  // shared distributor GTIN block (prefix 7588230); Westlake also has its own separate prefix
  // (7413170), confirming 7588230 is the shared block, not Westlake's sole identity. Recovers 65
  // false-conflict harvest rows. Sources: tireco.com/our-brands/{westlake,milestar}/, Modern Tire
  // Dealer (2012-10-17, "Tireco will sell Westlake tires in the U.S.").
  ["milestar", "westlake"],
  // EVIDENCE CLASS: common-ownership (same as Bridgestone/Firestone/Dayton). Shandong Linglong Tire
  // Co owns both Green Max (its own in-house line) and Atlas (acquired / relaunched by Linglong
  // Americas Inc. in 2009, produced by Shandong Linglong Tyre for North America). Recovers 1
  // false-conflict harvest row (prefix 6959956).
  ["green max", "atlas"],
  // EVIDENCE CLASS: distributor-shared-prefix (NOT common ownership; same class as Carlstar+Carlisle
  // above). Taskmaster Components is the US distributor: Provider (+ Provider HD) is its own house
  // brand; Diamondback is manufactured by Triangle Tire USA and exclusively distributed by Taskmaster
  // Components (confirmed independently by Modern Tire Dealer and Tire Review trade press). All three
  // legitimately share Taskmaster's distributor GTIN block (prefix 8164560); grouping them is a
  // shared-prefix statement, not a claim that Taskmaster IS a manufactured tire line. Recovers 17
  // false-conflict harvest rows (15 Taskmaster + 2 Provider).
  ["taskmaster", "provider", "diamondback"],
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

/** Title-case a normalized (lowercase) family-leader key for display, e.g. "goodyear" -> "Goodyear",
 *  "mickey thompson" -> "Mickey Thompson". Pure; used only for the family-label suffix below. */
function titleCaseLeader(leader: string): string {
  return leader.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * P5 (Task 8) - "never fully unknown" family annotation for the prefix floor. Returns the family label
 * "<Leader> family" for a NON-LEADER member of a curated group (the leader is the FIRST entry of its
 * FAMILIES group), or null for a leader, an independent brand (in no group), or empty input. Reuses
 * this module's own norm() so lookups line up with the family table. Pure, no imports.
 * Examples: "BFGoodrich" -> "Michelin family"; "Cooper" -> "Goodyear family"; "Michelin" -> null.
 */
export function familyLabelFor(brand: string): string | null {
  const b = norm(brand);
  if (!b) return null;
  for (const family of FAMILIES) {
    const leader = family[0];
    if (b !== leader && family.includes(b)) return `${titleCaseLeader(leader)} family`;
  }
  return null;
}
