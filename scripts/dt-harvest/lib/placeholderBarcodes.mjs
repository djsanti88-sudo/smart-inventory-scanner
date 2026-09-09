// scripts/dt-harvest/lib/placeholderBarcodes.mjs
// Node-runnable mirror of the barcode trust gate's placeholder blocklist + placeholder check
// (src/products/barcodes/barcodeTrust.ts), so the .mjs harvest pipeline (which plain `node` cannot
// import TS into) can reject the same enumerated placeholder/dummy barcodes the runtime rejects.
// Reimplemented rather than imported for the same reason lib/brandFamilies.mjs reimplements
// sameBrandFamily - this .mjs cannot import the app's TS module.
//
// HARDENED (2026-07-15, adversarial finding): a zero-padded all-same-digit code (e.g.
// "000055555555", the canonical form of a blocked "55555555") defeats the raw all-same-digit regex.
// The zero-STRIPPED significant core is also checked: an all-digit string whose stripped core is
// empty (all-zeros) or all-same-digit is a placeholder. No real GS1 allocation has an all-same-digit
// significant core, so this is a safe structural block, not a false-positive risk.
//
// CRITICAL: the exported list below MUST stay byte-for-byte identical to the TS source's blocklist.
// A drift-guard vitest test (src/products/barcodes/barcodeTrust.test.ts) reads this file and asserts the
// two lists match - do not edit this list without editing the .ts in lockstep and re-running that
// test.
//
// Pure, no imports.

// The ONLY structural hard block: enumerated junk with no legitimate counterexample.
/** @type {ReadonlyArray<string>} */
export const PLACEHOLDER_BARCODES = [
  "123456789012",
  "0123456789012",
  "1234567890128",
  "01234567890128",
];

/**
 * True when `code` is an enumerated placeholder/dummy barcode, an all-same-digit code, or a
 * zero-padded code whose zero-stripped significant core is empty or all-same-digit. Logic mirrors
 * src/products/barcodes/barcodeTrust.ts's isPlaceholderBarcode (enforced by the drift test).
 * @param {string} code
 * @returns {boolean}
 */
export function isPlaceholderBarcode(code) {
  const t = (code ?? "").toString().trim();
  if (!t) return false;
  if (/^(\d)\1+$/.test(t)) return true; // all-same-digit (0000000000000, 9999999999999, ...)
  // Zero-stripped significant core: catches a zero-padded all-same-digit code that dodges the
  // raw regex above (e.g. "000055555555" strips to "55555555").
  if (/^\d+$/.test(t)) {
    const stripped = t.replace(/^0+/, "");
    if (stripped === "" || /^(\d)\1*$/.test(stripped)) return true;
  }
  if (PLACEHOLDER_BARCODES.includes(t)) return true;
  const stripped = t.replace(/^0+/, "");
  return PLACEHOLDER_BARCODES.some((p) => p.replace(/^0+/, "") === stripped);
}
