// Sibling-product guard: same brand, different variant (flavor/size/pack/tire-size) must never
// verify - count the scan, send identity to Needs Review. Pairwise comparison over candidate
// identities; ANY ambiguous pair poisons the set.

export interface IdentityCandidate {
  name: string;
  brand: string;
}

export interface SiblingVerdict {
  ambiguous: boolean;
  reason: string;
}

// Tire sizes accept "/", "X", or "x" as the width/aspect separator (live row: "215X65R16"), a
// GLUED service prefix (ST225/75R15 trailer, LT285/70R17) whose letters defeat \b (forensic bug),
// and DECIMAL commercial rims (275/80R22.5).
const TIRE_SIZE_RE = /(?:\b(?:ST|LT|P)?|(?<=[A-Za-z])(?:ST|LT|P))?(?<![0-9])\d{3}[/xX]\d{2}\s?Z?R\d{2}(?:\.\d)?\b/gi;
const PACK_SIZE_RE = /\b\d+(?:\.\d+)?\s?(?:oz|fl ?oz|g|kg|ml|l|lb|lbs|ct|count|pk|pack)\b/gi;
const NOISE_WORDS = new Set(["flavored", "flavor", "bag", "box", "the", "a", "of", "with", "and"]);

/** Lowercase, drop trailing "| site" / "– site" segments, glue letter-slash variants (A/T3W ->
 * at3w), split size glue ("9.25oz" -> "9.25 oz"), strip punctuation. */
function canon(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/([a-z])['’]([a-z])/g, "$1$2") // N'Fera == NFera (apostrophes glue, never split)
    .replace(/\s*\|\s*[^|]{2,30}$/g, " ") // trailing "| site" suffix segment
    .replace(/\s*[–—-]\s+[^\d|–—-]{2,30}$/g, " ") // trailing "- site" ONLY when digit-free (never eat sizes)
    .replace(/([a-z])\/([a-z0-9])/g, "$1$2") // A/T3W == AT3W, M/C == MC
    .replace(/(\d)(oz|g|kg|ml|l|lb|lbs|ct|pk)\b/g, "$1 $2")
    .replace(/[^\w./ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sizesOf(name: string): string[] {
  const c = canon(name);
  // Normalize: separator to "/", strip glued ST/LT/P service prefixes, so ST225/75R15 ===
  // St225/75r15 === 225/75R15 for agreement purposes.
  // Strip Z speed prefix too: 255/45ZR18 === 255/45R18 (the Z is a speed rating, not a size).
  const tire = (c.toUpperCase().match(TIRE_SIZE_RE) ?? []).map((t) =>
    t.replace(/^(?:ST|LT|P)/, "").replace(/[xX]/, "/").replace(/ZR/, "R"),
  );
  const pack = c.match(PACK_SIZE_RE) ?? [];
  return [...tire.map((t) => t.replace(/\s/g, "").toUpperCase()), ...pack.map((p) => p.replace(/\s/g, ""))];
}

/** Unit of a pack-size token ("9.25oz" -> "oz"); tire sizes get their own bucket. */
function unitOf(size: string): string {
  if (/^\d{3}\//.test(size)) return "tire";
  return size.replace(/^[\d.]+/, "").replace(/\s/g, "");
}

/**
 * Sizes conflict ONLY when both sides carry a size in the SAME unit and the values differ.
 * "12 oz" vs "28 g" is serving-size noise across unit systems, not a variant conflict (live row).
 */
function sizesConflict(sa: string[], sb: string[]): boolean {
  for (const a of sa) {
    for (const b of sb) {
      if (unitOf(a) === unitOf(b) && a !== b) return true;
    }
  }
  return false;
}

function tokensOf(name: string): Set<string> {
  return new Set(canon(name).replace(TIRE_SIZE_RE, " ").replace(PACK_SIZE_RE, " ").split(" ").filter((t) => t.length > 1 && !NOISE_WORDS.has(t)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export type IdentityRelation = "agree" | "sibling" | "unrelated";

/**
 * Classify a pair of identities:
 *   agree     same product (high token overlap, no size clash)
 *   sibling   same FAMILY but a different variant (flavor/size/pack/tire-size) - never verify
 *   unrelated different products entirely - if both claim the same code, that is a recycled-code
 *             conflict, not a sibling. Missing brands do NOT imply the same family (live bug
 *             2026-07-04: a water and a video game were called "siblings").
 */
/** Share of the SHORTER name's tokens contained in the longer name. */
function containment(a: Set<string>, b: Set<string>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let inTokens = 0;
  for (const t of small) if (big.has(t)) inTokens++;
  return inTokens / small.size;
}

export function identityRelation(a: IdentityCandidate, b: IdentityCandidate): IdentityRelation {
  const brandA = (a.brand ?? "").trim().toLowerCase();
  const brandB = (b.brand ?? "").trim().toLowerCase();
  if (brandA && brandB && brandA !== brandB) return "unrelated";
  const ta = tokensOf(a.name);
  const tb = tokensOf(b.name);
  const sa = sizesOf(a.name);
  const sb = sizesOf(b.name);
  const sizeClash = sizesConflict(sa, sb);
  // Tire rule: the SAME exact tire size plus any shared distinctive token = the same tire. Sizes
  // are near-unique identifiers; noise tokens (load index, SKU, "4 New", marketplace names) were
  // producing false conflicts between agreeing listings (200-run live bug).
  const tiresA = sa.filter((s) => unitOf(s) === "tire");
  const tiresB = sb.filter((s) => unitOf(s) === "tire");
  if (tiresA.length && tiresB.length && tiresA.some((s) => tiresB.includes(s))) {
    let shared = 0;
    for (const t of ta) if (tb.has(t) && !/^\d+$/.test(t)) shared++;
    if (shared >= 1 && !sizesConflict(tiresA, tiresB)) return "agree";
  }
  // Containment = the same product named short vs long ("Beef Chunks" vs "Grabill Country Meats
  // Beef Chunks, 27 oz") - AGREEMENT, unless a same-unit size clash proves a variant.
  if (containment(ta, tb) >= 0.8) return sizeClash ? "sibling" : "agree";
  // Leading-prefix containment: the shorter name's ONLY uncontained tokens are its leading
  // store/brand prefix ("Harris Teeter Triple berry blend" vs "Triple berry blend ...").
  // True siblings differ AFTER the brand (Doritos COOL RANCH vs Doritos NACHO CHEESE), so
  // requiring the uncontained run to start at token 0 keeps them apart.
  {
    const [shortName, longTokens] = ta.size <= tb.size ? [a.name, tb] : [b.name, ta];
    const shortSeq = [...canon(shortName).replace(TIRE_SIZE_RE, " ").replace(PACK_SIZE_RE, " ").split(" ").filter((t) => t.length > 1 && !NOISE_WORDS.has(t))];
    const uncontained = shortSeq.map((t, i) => (longTokens.has(t) ? -1 : i)).filter((i) => i >= 0);
    const leadingRun = uncontained.length > 0 && uncontained.length <= 2 && uncontained.every((idx, j) => idx === j);
    const containRatio = shortSeq.length ? (shortSeq.length - uncontained.length) / shortSeq.length : 0;
    if (leadingRun && containRatio >= 0.6) return sizeClash ? "sibling" : "agree";
  }
  const sim = jaccard(ta, tb);
  const sameFamily = (brandA && brandA === brandB) || sim >= 0.25;
  if (!sameFamily) return "unrelated";
  if (sizeClash) return "sibling";
  return sim < 0.6 ? "sibling" : "agree";
}

/** Sibling check only: same-family variant ambiguity. Unrelated pairs are NOT siblings. */
export function detectSiblingAmbiguity(candidates: IdentityCandidate[]): SiblingVerdict {
  const named = candidates.filter((c) => (c.name ?? "").trim().length > 0);
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      if (identityRelation(named[i], named[j]) === "sibling") {
        return { ambiguous: true, reason: `same-family sibling variant: "${named[i].name}" vs "${named[j].name}"` };
      }
    }
  }
  return { ambiguous: false, reason: "" };
}
