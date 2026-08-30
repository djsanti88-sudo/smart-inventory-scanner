// trustedProductHosts.ts (Task 21, owner-ratified 2026-07-15) - a small, curated allowlist of
// registrable domains the owner accepts as "a legit product page" for the trusted-source confidence
// floor and the learned-products tier: major retailers plus the manufacturer domains for the
// KNOWN_TIRE_BRANDS list (src/decoding/tireSpecs.ts). Mirrors EvidenceVerifier's existing url_only
// `trustedHosts` allowlist pattern (registrable-domain / subdomain match), but scoped to THIS module's
// own curated list rather than the caller-supplied `trustedHosts` array evidenceVerifier.ts takes.
//
// Matching is registrable-domain EXACT or a real subdomain of it (host === domain, or host ends with
// "." + domain) - NEVER substring. "evil-walmart.com.attacker.io" and "walmart.com.evil.io" must both
// fail: neither equals "walmart.com" nor ends with ".walmart.com". Pure, no imports, no network.

/** Major retailers + barcode/product databases the owner named as acceptable trusted sources. */
const RETAILERS: readonly string[] = [
  "walmart.com",
  "target.com",
  "discounttire.com",
  "tirerack.com",
  "amazon.com",
];

// Manufacturer domains for every brand in KNOWN_TIRE_BRANDS (src/decoding/tireSpecs.ts). Verified
// live 2026-07-15 - each is the brand's own retail/consumer site, not a lookalike or reseller.
// Note: not every KNOWN_TIRE_BRANDS entry has its own single canonical .com (e.g. "gt radial" ->
// gtradialtires.com, "general tire" -> generaltire.com are included below); a handful of smaller/value
// brands in that list (sailun, nokian, maxxis, kenda, hercules, ironman, mastercraft, uniroyal,
// sumitomo, atturo, milestar, lexani) are intentionally NOT added here - the task named a specific 15,
// and adding un-vetted domains would silently expand the trust surface beyond what was ratified.
const TIRE_MANUFACTURERS: readonly string[] = [
  "michelin.com",
  "goodyear.com",
  "bridgestonetire.com",
  "continentaltire.com",
  "pirelli.com",
  "yokohamatire.com",
  "falkentire.com",
  "toyotires.com",
  "coopertire.com",
  "bfgoodrichtires.com",
  "hankooktire.com",
  "nexentireusa.com",
  "kumhotire.com",
  "generaltire.com",
  "firestonetire.com",
];

/** The full curated allowlist, exported for reuse/inspection (e.g. feeding EvidenceVerifier's own
 *  `trustedHosts` option so both gates read one source of truth). */
export const TRUSTED_PRODUCT_HOSTS: readonly string[] = [...RETAILERS, ...TIRE_MANUFACTURERS];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * True when `url`'s host is exactly a trusted registrable domain, or a subdomain of one
 * (www., shop., etc). Registrable-domain comparison only - never a substring match, so a lookalike
 * host embedding a trusted domain as a prefix or suffix of a longer hostname never passes.
 */
export function isTrustedProductHost(url: string): boolean {
  const host = hostOf(url ?? "");
  if (!host) return false;
  return TRUSTED_PRODUCT_HOSTS.some((domain) => host === domain || host.endsWith("." + domain));
}
