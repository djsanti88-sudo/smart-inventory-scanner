// Canonical tire part-number keys. Pure, no imports. Distributors bolt their own letters onto the
// SAME manufacturer number: 762590, BH762590, 762590BH, GY706069165, F-28034300, KH2289933,
// MICH-97614 are one core number wearing different distributor affixes. This module reduces them to
// a shared key so the same tire in two label formats is treated as one product.
//
// SAFETY: the numeric CORE is a LOOKUP FAN-OUT key, never a truth key. Two unrelated tires can share
// a core once letters are stripped (ATX750130 vs a hypothetical XY750130). The core here is produced
// whenever the shape matches - it is NOT clever enough to tell a distributor affix from model-identity
// letters. Every consumer MUST corroborate a core hit with brand and/or size (identityMatcher.ts's
// AM-R4 gate) before acting on it. Never auto-count on a core match alone.

/** Base normalization - mirrors normPartKey (tireKnowledgeIndex.ts:40-42): strip spaces/hyphens,
 *  uppercase, drop remaining whitespace. This is the exact key the tire corpus is indexed under. */
export function basePartNumberKey(pn: string): string {
  return (pn ?? "").toString().replace(/[ -]/g, "").trim().toUpperCase().replace(/\s/g, "");
}

/** The manufacturer numeric core when the base key is `<=5 affix letters><>=5 digits><=3 affix
 *  letters>`. Returns null when the shape does not apply, OR when the core equals the base (a
 *  pure-digit code gains nothing). Leading cap 5 covers MICH/NEXN/PIRE/COOP; trailing cap 3 covers NXK. */
export function tirePartNumberCore(pn: string): string | null {
  const base = basePartNumberKey(pn);
  const m = base.match(/^[A-Z]{0,5}(\d{5,})[A-Z]{0,3}$/);
  if (!m) return null;
  const core = m[1];
  return core === base ? null : core;
}

/** Ordered, de-duplicated lookup keys: exact base first, then the numeric core when it differs.
 *  Callers query every variant and UNION the hits, then corroborate (never trust a core hit alone). */
export function tirePartNumberVariants(pn: string): string[] {
  const base = basePartNumberKey(pn);
  if (!base) return [];
  const core = tirePartNumberCore(pn);
  return core ? [base, core] : [base];
}
