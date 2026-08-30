// extractTireFields.ts (Phase 10) - pure, deterministic. Turn a messy decode/identity into the
// structured columns the inventory table shows: Size, Brand, Part number, Description. NEVER fabricates:
// a field that cannot be confidently found stays null/blank, and the raw text is kept in the description
// (project resolver principle: prefer blank over wrong).

import { matchTireSize } from "@/products/tires/tireSizeNormalizer";
import { KNOWN_TIRE_BRANDS } from "@/services/ai/tireSpecs";

export type TireIdentityInput = {
  productName?: string;
  name?: string; // a stored Product uses `name`; AiLookupResult uses `productName`
  brand?: string;
  specsShort?: string;
  specsFull?: string;
  primarySku?: string;
  mpn?: string;
};

export type ExtractedTireFields = {
  size: string | null;
  brand: string | null;
  partNumber: string | null;
  description: string;
};

function cleanup(s: string): string {
  return s.replace(/\s+/g, " ").replace(/^[\s\-|,/]+|[\s\-|,/]+$/g, "").trim();
}

export function extractTireFields(identity: TireIdentityInput | null | undefined): ExtractedTireFields {
  if (!identity) return { size: null, brand: null, partNumber: null, description: "" };
  const name = (identity.productName ?? identity.name ?? "").trim();

  // size: prefer the name, then the structured spec fields. null when none is confidently found.
  const sizeM = matchTireSize(name) ?? matchTireSize(identity.specsShort) ?? matchTireSize(identity.specsFull);
  const size = sizeM?.canonical ?? null;

  // brand: only a hand-verified known tire brand (reuse tireSpecs). Prefer the casing from the name; fall
  // back to a declared brand that matches the known list. Otherwise blank - never fabricated.
  const lowerName = name.toLowerCase();
  const declared = (identity.brand ?? "").trim();
  const inNameKey = KNOWN_TIRE_BRANDS.find((b) => lowerName.includes(b));
  let brandRaw = "";
  if (inNameKey) {
    const idx = lowerName.indexOf(inNameKey);
    brandRaw = name.slice(idx, idx + inNameKey.length); // token as it appears in the name (for stripping)
  }
  // Prefer a declared known brand's clean casing (e.g. "Michelin") over a SCREAMING-CAPS name token.
  const declaredKnown = !!declared && KNOWN_TIRE_BRANDS.some((b) => declared.toLowerCase().includes(b));
  const brand: string | null = declaredKnown ? declared : brandRaw || null;

  // part number / SKU: take what's there; never invent one.
  const partNumber = (identity.primarySku ?? identity.mpn ?? "").trim() || null;

  // description: clean model/line = name minus brand + size + load/speed noise. If stripping empties it
  // (or nothing was extractable), keep the raw text instead of guessing.
  let description = name;
  for (const token of [brandRaw, sizeM?.raw, sizeM?.rawLoadSpeed]) {
    if (token) description = description.split(token).join(" ");
  }
  description = cleanup(description);
  if (!description) description = cleanup(name) || (identity.specsShort ?? "").trim();

  return { size, brand, partNumber, description };
}
