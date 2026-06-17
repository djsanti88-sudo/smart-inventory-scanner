// Architecture Version: v1.0.0
//
// gs1Prefixes.ts - VERIFIED GS1 prefix -> numbering-authority region table + a NON-authoritative
// region-hint deriver used to enrich the AI decode prompt.
//
// SOURCE: GS1 General Specifications, GS1 Prefix allocation (the standardized leading-digit ranges
// published by GS1 and administered by GS1 Member Organisations). Reference:
// https://www.gs1.org/standards/id-keys/company-prefix and the GS1 prefix allocation table.
//
// IMPORTANT (mandated labeling): a GS1 prefix identifies the GS1 Member Organisation that ALLOCATED
// the company prefix. It is NOT the country of manufacture, NOT the brand, and NOT product identity.
// This is a hint only and must never override real evidence. Uncertain/unallocated prefixes are
// intentionally omitted so an unmapped code returns null instead of a guessed region.

import type { CodeType } from "@/types";

export const ARCHITECTURE_VERSION = "1.0.0";

/**
 * Mandated, non-authoritative disclaimer. Single source of truth for both the AI prompt and the UI.
 * Rendered with a normal hyphen (no em/en dash) per the project's user-facing copy convention.
 */
export const GS1_HINT_DISCLAIMER =
  "GS1 numbering authority region only - not country of manufacture, not brand, and not product identity.";

/** Only real public barcodes carry a GS1 prefix; SKUs, vendor labels, messy/empty codes do not. */
const PUBLIC_BARCODE_TYPES: ReadonlyArray<CodeType> = ["upc_a", "ean_13", "gtin_14"];

interface Gs1Range {
  start: number; // inclusive 3-digit prefix (0..999)
  end: number; // inclusive
  region: string;
}

// 3-digit GS1 prefix ranges. Verified against GS1's published prefix allocation. Gaps are deliberate
// (unallocated or uncertain) and resolve to null.
const GS1_RANGES: ReadonlyArray<Gs1Range> = [
  { start: 0, end: 19, region: "United States and Canada (GS1 US)" },
  { start: 20, end: 29, region: "Restricted distribution (internal/store use)" },
  { start: 30, end: 39, region: "United States (GS1 US)" },
  { start: 40, end: 49, region: "Restricted distribution (internal/company use)" },
  { start: 50, end: 59, region: "GS1 US (reserved, e.g. coupons)" },
  { start: 60, end: 139, region: "United States and Canada (GS1 US)" },
  { start: 200, end: 299, region: "Restricted distribution (internal/store use)" },
  { start: 300, end: 379, region: "France and Monaco" },
  { start: 380, end: 380, region: "Bulgaria" },
  { start: 383, end: 383, region: "Slovenia" },
  { start: 385, end: 385, region: "Croatia" },
  { start: 387, end: 387, region: "Bosnia and Herzegovina" },
  { start: 389, end: 389, region: "Montenegro" },
  { start: 400, end: 440, region: "Germany" },
  { start: 450, end: 459, region: "Japan" },
  { start: 460, end: 469, region: "Russia" },
  { start: 470, end: 470, region: "Kyrgyzstan" },
  { start: 471, end: 471, region: "Taiwan" },
  { start: 474, end: 474, region: "Estonia" },
  { start: 475, end: 475, region: "Latvia" },
  { start: 476, end: 476, region: "Azerbaijan" },
  { start: 477, end: 477, region: "Lithuania" },
  { start: 478, end: 478, region: "Uzbekistan" },
  { start: 479, end: 479, region: "Sri Lanka" },
  { start: 480, end: 480, region: "Philippines" },
  { start: 481, end: 481, region: "Belarus" },
  { start: 482, end: 482, region: "Ukraine" },
  { start: 483, end: 483, region: "Turkmenistan" },
  { start: 484, end: 484, region: "Moldova" },
  { start: 485, end: 485, region: "Armenia" },
  { start: 486, end: 486, region: "Georgia" },
  { start: 487, end: 487, region: "Kazakhstan" },
  { start: 488, end: 488, region: "Tajikistan" },
  { start: 489, end: 489, region: "Hong Kong" },
  { start: 490, end: 499, region: "Japan" },
  { start: 500, end: 509, region: "United Kingdom" },
  { start: 520, end: 521, region: "Greece" },
  { start: 528, end: 528, region: "Lebanon" },
  { start: 529, end: 529, region: "Cyprus" },
  { start: 530, end: 530, region: "Albania" },
  { start: 531, end: 531, region: "North Macedonia" },
  { start: 535, end: 535, region: "Malta" },
  { start: 539, end: 539, region: "Ireland" },
  { start: 540, end: 549, region: "Belgium and Luxembourg" },
  { start: 560, end: 560, region: "Portugal" },
  { start: 569, end: 569, region: "Iceland" },
  { start: 570, end: 579, region: "Denmark, Faroe Islands and Greenland" },
  { start: 590, end: 590, region: "Poland" },
  { start: 594, end: 594, region: "Romania" },
  { start: 599, end: 599, region: "Hungary" },
  { start: 600, end: 601, region: "South Africa" },
  { start: 603, end: 603, region: "Ghana" },
  { start: 604, end: 604, region: "Senegal" },
  { start: 608, end: 608, region: "Bahrain" },
  { start: 609, end: 609, region: "Mauritius" },
  { start: 611, end: 611, region: "Morocco" },
  { start: 613, end: 613, region: "Algeria" },
  { start: 615, end: 615, region: "Nigeria" },
  { start: 616, end: 616, region: "Kenya" },
  { start: 617, end: 617, region: "Cameroon" },
  { start: 618, end: 618, region: "Ivory Coast" },
  { start: 619, end: 619, region: "Tunisia" },
  { start: 620, end: 620, region: "Tanzania" },
  { start: 621, end: 621, region: "Syria" },
  { start: 622, end: 622, region: "Egypt" },
  { start: 623, end: 623, region: "Brunei" },
  { start: 624, end: 624, region: "Libya" },
  { start: 625, end: 625, region: "Jordan" },
  { start: 626, end: 626, region: "Iran" },
  { start: 627, end: 627, region: "Kuwait" },
  { start: 628, end: 628, region: "Saudi Arabia" },
  { start: 629, end: 629, region: "United Arab Emirates" },
  { start: 640, end: 649, region: "Finland" },
  { start: 690, end: 699, region: "China" },
  { start: 700, end: 709, region: "Norway" },
  { start: 729, end: 729, region: "Israel" },
  { start: 730, end: 739, region: "Sweden" },
  { start: 740, end: 740, region: "Guatemala" },
  { start: 741, end: 741, region: "El Salvador" },
  { start: 742, end: 742, region: "Honduras" },
  { start: 743, end: 743, region: "Nicaragua" },
  { start: 744, end: 744, region: "Costa Rica" },
  { start: 745, end: 745, region: "Panama" },
  { start: 746, end: 746, region: "Dominican Republic" },
  { start: 750, end: 750, region: "Mexico" },
  { start: 754, end: 755, region: "Canada" },
  { start: 759, end: 759, region: "Venezuela" },
  { start: 760, end: 769, region: "Switzerland and Liechtenstein" },
  { start: 770, end: 771, region: "Colombia" },
  { start: 773, end: 773, region: "Uruguay" },
  { start: 775, end: 775, region: "Peru" },
  { start: 777, end: 777, region: "Bolivia" },
  { start: 778, end: 779, region: "Argentina" },
  { start: 780, end: 780, region: "Chile" },
  { start: 784, end: 784, region: "Paraguay" },
  { start: 786, end: 786, region: "Ecuador" },
  { start: 789, end: 790, region: "Brazil" },
  { start: 800, end: 839, region: "Italy, San Marino and Vatican City" },
  { start: 840, end: 849, region: "Spain and Andorra" },
  { start: 850, end: 850, region: "Cuba" },
  { start: 858, end: 858, region: "Slovakia" },
  { start: 859, end: 859, region: "Czech Republic" },
  { start: 860, end: 860, region: "Serbia" },
  { start: 865, end: 865, region: "Mongolia" },
  { start: 867, end: 867, region: "North Korea" },
  { start: 868, end: 869, region: "Turkey" },
  { start: 870, end: 879, region: "Netherlands" },
  { start: 880, end: 880, region: "South Korea" },
  { start: 883, end: 883, region: "Myanmar" },
  { start: 884, end: 884, region: "Cambodia" },
  { start: 885, end: 885, region: "Thailand" },
  { start: 888, end: 888, region: "Singapore" },
  { start: 890, end: 890, region: "India" },
  { start: 893, end: 893, region: "Vietnam" },
  { start: 896, end: 896, region: "Pakistan" },
  { start: 899, end: 899, region: "Indonesia" },
  { start: 900, end: 919, region: "Austria" },
  { start: 930, end: 939, region: "Australia" },
  { start: 940, end: 949, region: "New Zealand" },
  { start: 950, end: 950, region: "GS1 Global Office" },
  { start: 951, end: 951, region: "GS1 Global Office (EPC general identifier)" },
  { start: 955, end: 955, region: "Malaysia" },
  { start: 958, end: 958, region: "Macau" },
  { start: 977, end: 977, region: "Serial publications (ISSN)" },
  { start: 978, end: 979, region: "Books and notated music (ISBN/ISMN)" },
  { start: 980, end: 980, region: "Refund receipts" },
  { start: 981, end: 984, region: "Coupons (GS1 common currency)" },
  { start: 990, end: 999, region: "Coupons" },
];

/**
 * Derive the GS1 numbering-authority region for a PUBLIC barcode (UPC-A / EAN-13 / GTIN-14) only.
 * Returns null for any non-public code type, malformed length, or unmapped prefix.
 * NON-AUTHORITATIVE - see GS1_HINT_DISCLAIMER. Never treat the result as country of origin or identity.
 */
export function deriveGs1RegionHint(code: string, codeType: CodeType): string | null {
  if (!PUBLIC_BARCODE_TYPES.includes(codeType)) return null;
  const digits = (code ?? "").replace(/\D/g, "");

  // Normalize to a 13-digit GTIN-13 base so the leading 3 digits are the GS1 prefix.
  let base: string;
  if (codeType === "upc_a") {
    if (digits.length !== 12) return null;
    base = "0" + digits; // UPC-A -> GTIN-13 (leading zero)
  } else if (codeType === "ean_13") {
    if (digits.length !== 13) return null;
    base = digits;
  } else {
    // gtin_14: drop the leading packaging-indicator digit to expose the embedded GTIN-13.
    if (digits.length !== 14) return null;
    base = digits.slice(1);
  }

  const prefix = Number(base.slice(0, 3));
  if (!Number.isFinite(prefix)) return null;
  const match = GS1_RANGES.find((r) => prefix >= r.start && prefix <= r.end);
  return match ? match.region : null;
}

/**
 * Convenience: the full hint line (region + mandated disclaimer) for injection into the AI prompt
 * and display in the UI. Returns null when no region hint applies (so callers emit nothing).
 */
export function formatGs1Hint(code: string, codeType: CodeType): string | null {
  const region = deriveGs1RegionHint(code, codeType);
  if (!region) return null;
  return `GS1 prefix region: ${region}. ${GS1_HINT_DISCLAIMER}`;
}
