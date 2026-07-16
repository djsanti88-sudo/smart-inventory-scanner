# Barcode Trust Gate - Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure barcode trust gate (spec v3, AM-1..AM-11) and wire it at every real barcode entry point so no fabricated, misread, or placeholder barcode is ever stored as product identity - while pinning the already-scan-driven counting invariants with regression tests.

**Architecture:** One new pure service (`src/services/upc/barcodeTrust.ts`) built on the existing `gtin.ts` arithmetic. Verdicts are `rejected | suggested | verified` only; the PN-embed detector is an ADVISORY annotation (`pn_derived | clean | cannot_assess`) that never changes a verdict in either direction (AM-11: Sailun's real published UPCs embed the PN - proven live). Thin call-site gates at the entry points: `csvImport.ts buildProductImport` (the ungated back door), `resolveUnknown`'s product-field minting (the single choke point all approvals converge on), and the dt-harvest `apply.mjs` corpus merge (placeholder blocklist added to `guardRow`, which already validates check digits).

**Tech Stack:** TypeScript, Vitest (node project for pure services, jsdom for store tests), plain node `.mjs` for dt-harvest scripts (with the established `.mjs`-mirror + drift-guard-test pattern from `brandFamilies.mjs`).

## Code reality this plan is grounded on (verified 2026-07-15)

- Counting is ALREADY scan-driven ("decode-everything": scan 10 = count 10; `scanStore.ts:2360+` provisional count). The AI never adds counts beyond physical scan events; it attaches IDENTITY.
- The suggested tier (`shouldAutoApplySuggestion`, `src/stores/scanGates.ts:134`) applies a name onto the already-counted provisional row - NO alias, NO extra count, review parked "suggested" with approve/decline. AM-2's "no suggested self-count" is thus ALREADY the code's behavior; this plan PINS it with regression tests rather than rewiring it.
- The verified auto-count tier (`canAutoCount`, `scanGates.ts:83`) is the Phase-7 gate and is UNCHANGED by this plan (AM-2).
- The real holes this plan closes: (a) `csvImport.ts:154-200` mints `approved:true` aliases + `verified:true` products from any CSV cell with zero validation; (b) `resolveUnknown`'s two minting sites (`scanStore.ts:3392-3394` and `:3437-3439`) copy `np.gtin/upc/ean` verbatim from AI/import payloads into stored product identity; (c) dt-harvest `apply.mjs mergeIntoBarcodeIndex` has check-digit + prefix guards but no placeholder blocklist.

## Global Constraints

- TOP-LEVEL LAW (owner order, 2026-07-15): EVERY scanned code - known, unknown, misread, random,
  trust-gate-rejected - MUST appear on the scan feed AND count in session totals (scan 10 = count 10).
  The gate decides IDENTITY only; it must NEVER suppress a scanned row from the feed or the count.
  Any task change that makes a scanned code vanish from feed/totals is a defect.
- Verdicts are exactly `rejected | suggested | verified`. There is NO `blocked` verdict (AM-11 supersedes it).
- `pnDerived` is advisory ONLY: it never changes a verdict, never blocks, never counts, in either direction (AM-1 + AM-11). The enum is `"pn_derived" | "clean" | "cannot_assess"` - call sites must not conflate `cannot_assess` with `clean`.
- The placeholder blocklist is the ONLY structural hard block: the `123456789012` family, all-same-digit codes (`0000000000000`, `9999999999999`, etc.) (AM-11.4).
- `verified` requires a re-checkable ground-truth artifact handed to the gate (AM-3): `physical_scan` (scanner path only), `evidence_verified` (the actual app-run `EvidenceStrength`, accepted only at `grounding_chunk` or `fetched_source`), or `corpus_trusted` (grandfathering only). Never a bare caller string.
- The Phase-7 auto-count conjunction in `src/stores/scanGates.ts` (`canAutoCount`, `shouldAutoApplySuggestion`) is UNCHANGED - do not edit that file except to add nothing; regression tests pin it.
- `src/services/**` stays pure: no React, no `next/*`, no server imports (project convention, enforced by review).
- No em dash or en dash in user-facing copy (project convention).
- Automated tests NEVER call live providers (mock everything; this plan touches no live paths).
- Commits are pathspec-only (`git commit -m "..." -- <files>`), conventional-commit style.
- Phase 2 (stored provenance field, verified/suggested count split, promotion state machine) is OUT OF SCOPE - do not add a `provenance` field to any persisted type.

---

### Task 1: `barcodeTrust.ts` - the pure gate

**Files:**
- Create: `src/services/upc/barcodeTrust.ts`
- Test: `src/services/upc/barcodeTrust.test.ts`

**Interfaces:**
- Consumes: `isGtinShaped`, `isValidCheckDigit`, `canonicalGtin` from `src/services/upc/gtin.ts`; `EvidenceStrength` from `src/types.ts` (type-only import).
- Produces (later tasks rely on these exact names):
  - `type BarcodeVerdict = "rejected" | "suggested" | "verified"`
  - `type PnDerived = "pn_derived" | "clean" | "cannot_assess"`
  - `type GroundTruth = { kind: "physical_scan" } | { kind: "evidence_verified"; strength: EvidenceStrength } | { kind: "corpus_trusted" }`
  - `interface BarcodeGrade { verdict: BarcodeVerdict; checkDigitValid: boolean; gtinShaped: boolean; placeholder: boolean; pnDerived: PnDerived; canonicalGtin: string | null; reason: string }`
  - `function gradeBarcode(input: { barcode: string; partNumber?: string; groundTruth?: GroundTruth }): BarcodeGrade`
  - `function isPlaceholderBarcode(code: string): boolean`
  - `function pnDerivedAnnotation(barcode: string, partNumber?: string): PnDerived`
  - `const PLACEHOLDER_BARCODES: readonly string[]` (exported so Task 5's `.mjs` drift test can compare)

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/upc/barcodeTrust.test.ts
import { describe, it, expect } from "vitest";
import {
  gradeBarcode,
  isPlaceholderBarcode,
  pnDerivedAnnotation,
  PLACEHOLDER_BARCODES,
} from "./barcodeTrust";

/** GS1 mod-10 check digit for a payload (all digits EXCEPT the check). */
function checkDigitFor(payload: string): string {
  const digits = payload.split("").map(Number);
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += digits[i] * w;
  return String((10 - (sum % 10)) % 10);
}
function makeGtin(payload: string): string {
  return payload + checkDigitFor(payload);
}

// The documented Gemini phantom (batch 1): Sailun prefix 884811 + last-6 of SKU BH4120176 + check.
const PHANTOM_8848 = "8848111201761";
// The documented REAL Sailun/Blackhawk UPC (tires.auto structured data, AM-11):
// 695965 + last-6 of SKU 5546800V + check 7.
const REAL_BLACKHAWK = "6959655468007";

// Representative phantom fixture: same construction as the 16 Gemini fakes
// (prefix 884811 + last-6 SKU digits + computed check). The exact 16 from the Gemini
// output can be swapped in verbatim when the owner supplies them; the CONSTRUCTION is identical.
const PHANTOM_SKU_TAILS = [
  "120176", "120177", "120183", "120190", "120204", "120211", "120228", "120235",
  "120242", "120259", "120266", "120273", "120280", "120297", "120303", "120310",
];
const PHANTOM_FIXTURE = PHANTOM_SKU_TAILS.map((tail) => makeGtin("884811" + tail));

describe("check-digit + shape (rejected verdict)", () => {
  it("rejects a GTIN-shaped code with a bad check digit", () => {
    const g = gradeBarcode({ barcode: "8848111201762" }); // last digit off by one
    expect(g.verdict).toBe("rejected");
    expect(g.checkDigitValid).toBe(false);
    expect(g.reason).toMatch(/check digit/i);
  });
  it("rejects a non-GTIN-shaped value", () => {
    const g = gradeBarcode({ barcode: "BH4120176" });
    expect(g.verdict).toBe("rejected");
    expect(g.gtinShaped).toBe(false);
  });
  it("sanity: the fixture check-digit helper matches gtin.ts arithmetic", () => {
    expect(makeGtin("884811120176")).toBe(PHANTOM_8848);
    expect(makeGtin("695965546800")).toBe(REAL_BLACKHAWK);
  });
});

describe("placeholder blocklist (the only structural hard block, AM-11.4)", () => {
  it.each(["123456789012", "0123456789012", "0000000000000", "9999999999999", "00000000"]) (
    "rejects placeholder %s",
    (code) => {
      expect(isPlaceholderBarcode(code)).toBe(true);
      const g = gradeBarcode({ barcode: code });
      expect(g.verdict).toBe("rejected");
      expect(g.placeholder).toBe(true);
    },
  );
  it("does not flag a real barcode as placeholder", () => {
    expect(isPlaceholderBarcode(REAL_BLACKHAWK)).toBe(false);
  });
  it("exports the blocklist for the .mjs drift test", () => {
    expect(PLACEHOLDER_BARCODES.length).toBeGreaterThan(0);
  });
});

describe("pnDerived annotation is ADVISORY and never changes the verdict (AM-11)", () => {
  it("flags the phantom 8848 pattern as pn_derived - and still grades it suggested, not rejected", () => {
    const g = gradeBarcode({ barcode: PHANTOM_8848, partNumber: "BH4120176" });
    expect(g.pnDerived).toBe("pn_derived");
    expect(g.verdict).toBe("suggested"); // NOT rejected: structure never denies trust
  });
  it("flags the REAL Blackhawk UPC as pn_derived too (Sailun's real scheme) - the false-positive regression", () => {
    const g = gradeBarcode({ barcode: REAL_BLACKHAWK, partNumber: "5546800V" });
    expect(g.pnDerived).toBe("pn_derived");
    expect(g.verdict).toBe("suggested"); // same annotation, same verdict: evidence decides, not structure
  });
  it("returns cannot_assess for a PN with fewer than 5 digits", () => {
    expect(pnDerivedAnnotation(REAL_BLACKHAWK, "HT4")).toBe("cannot_assess");
    expect(pnDerivedAnnotation(REAL_BLACKHAWK, "BLACKHAWK-HT")).toBe("cannot_assess");
  });
  it("returns clean when no 5+ digit PN run appears in the payload", () => {
    expect(pnDerivedAnnotation(makeGtin("003653112905"), "9876543")).toBe("clean");
  });
  it("matches the PN run against the canonical (zero-stripped) form too", () => {
    // 0-padded EAN-13 of a UPC whose payload embeds the PN run
    const upcPayload = "69596554680"; // 11-digit payload -> UPC-A
    const upc = makeGtin(upcPayload);
    const ean13 = "0" + upc;
    expect(pnDerivedAnnotation(ean13, "5546800V")).toBe("pn_derived");
  });
});

describe("verdicts with ground truth (AM-3: re-checkable artifacts only)", () => {
  it("valid + no ground truth -> suggested", () => {
    expect(gradeBarcode({ barcode: REAL_BLACKHAWK }).verdict).toBe("suggested");
  });
  it("physical_scan -> verified", () => {
    expect(
      gradeBarcode({ barcode: REAL_BLACKHAWK, groundTruth: { kind: "physical_scan" } }).verdict,
    ).toBe("verified");
  });
  it("evidence_verified at fetched_source strength -> verified", () => {
    expect(
      gradeBarcode({
        barcode: REAL_BLACKHAWK,
        groundTruth: { kind: "evidence_verified", strength: "fetched_source" },
      }).verdict,
    ).toBe("verified");
  });
  it("evidence_verified at WEAK strength (url_only / snippet / none) stays suggested", () => {
    for (const strength of ["none", "url_only", "snippet"] as const) {
      expect(
        gradeBarcode({ barcode: REAL_BLACKHAWK, groundTruth: { kind: "evidence_verified", strength } })
          .verdict,
      ).toBe("suggested");
    }
  });
  it("corpus_trusted -> verified (grandfathering, AM-5)", () => {
    expect(
      gradeBarcode({ barcode: REAL_BLACKHAWK, groundTruth: { kind: "corpus_trusted" } }).verdict,
    ).toBe("verified");
  });
  it("ground truth NEVER rescues a bad check digit or a placeholder", () => {
    expect(
      gradeBarcode({ barcode: "8848111201762", groundTruth: { kind: "physical_scan" } }).verdict,
    ).toBe("rejected");
    expect(
      gradeBarcode({ barcode: "0000000000000", groundTruth: { kind: "physical_scan" } }).verdict,
    ).toBe("rejected");
  });
});

describe("the 16-phantom fixture: inert without evidence (AM-11.6)", () => {
  it("every phantom grades suggested + pn_derived - never verified, never rejected-for-structure", () => {
    for (const [i, code] of PHANTOM_FIXTURE.entries()) {
      const g = gradeBarcode({ barcode: code, partNumber: "BH4" + PHANTOM_SKU_TAILS[i] });
      expect(g.verdict).toBe("suggested");
      expect(g.pnDerived).toBe("pn_derived");
      expect(g.checkDigitValid).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/upc/barcodeTrust.test.ts`
Expected: FAIL - `Cannot find module './barcodeTrust'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

```typescript
// src/services/upc/barcodeTrust.ts
// Barcode trust gate (spec v3, AM-1..AM-11). Pure: no React, no next/*, no server imports.
//
// Two independent properties, never conflated:
//   1. Well-formed (shape + GS1 check digit) - cheap, local, trivially satisfiable by any invented number.
//   2. Verified identity - established ONLY by a re-checkable ground-truth artifact (AM-3):
//      a physical scan, the app's own EvidenceVerifier result, or the grandfathered corpus.
//
// AM-11 (live ground truth 2026-07-15): Sailun/Blackhawk's REAL published UPCs embed the part number
// (6959655468007 = 695965 + last-6-of-PN + check). "Payload embeds the PN" is a legitimate industry
// scheme AND the common fabrication pattern - so pnDerived is an ADVISORY annotation that never
// changes a verdict in either direction. Evidence distinguishes real from phantom; structure cannot.
import { isGtinShaped, isValidCheckDigit, canonicalGtin } from "./gtin";
import type { EvidenceStrength } from "../../types";

export type BarcodeVerdict = "rejected" | "suggested" | "verified";
export type PnDerived = "pn_derived" | "clean" | "cannot_assess";

export type GroundTruth =
  | { kind: "physical_scan" }
  | { kind: "evidence_verified"; strength: EvidenceStrength }
  | { kind: "corpus_trusted" };

export interface BarcodeGradeInput {
  barcode: string;
  partNumber?: string;
  /** Only re-checkable artifacts (AM-3). Callers must NEVER map a provider's self-report here. */
  groundTruth?: GroundTruth;
}

export interface BarcodeGrade {
  verdict: BarcodeVerdict;
  checkDigitValid: boolean;
  gtinShaped: boolean;
  placeholder: boolean;
  pnDerived: PnDerived;
  canonicalGtin: string | null;
  reason: string; // honest, human-readable, always set
}

/** The ONLY structural hard block (AM-11.4): enumerated junk with no legitimate counterexample. */
export const PLACEHOLDER_BARCODES: readonly string[] = [
  "123456789012",
  "0123456789012",
  "1234567890128",
  "01234567890128",
];

const PLACEHOLDER_CANONICALS = new Set(
  PLACEHOLDER_BARCODES.map((c) => canonicalGtin(c)).filter(Boolean) as string[],
);

export function isPlaceholderBarcode(code: string): boolean {
  const t = (code ?? "").trim();
  if (!t) return false;
  if (/^(\d)\1+$/.test(t)) return true; // all-same-digit (0000000000000, 9999999999999, 00000000, ...)
  if (PLACEHOLDER_BARCODES.includes(t)) return true;
  const canon = canonicalGtin(t);
  return canon !== null && PLACEHOLDER_CANONICALS.has(canon);
}

/**
 * ADVISORY annotation (AM-8 params, AM-11 demotion): does a contiguous run of >= 5 part-number
 * digits appear in the barcode payload (check digit excluded)? Compared against both the raw and
 * the canonical (zero-stripped) form. NEVER changes a verdict - shown as context in review UI only.
 */
export function pnDerivedAnnotation(barcode: string, partNumber?: string): PnDerived {
  const pnDigits = (partNumber ?? "").replace(/\D/g, "");
  if (pnDigits.length < 5) return "cannot_assess";
  const raw = (barcode ?? "").trim();
  const forms = new Set<string>();
  if (raw.length >= 2) forms.add(raw.slice(0, -1)); // payload without the check digit
  const canon = canonicalGtin(raw);
  if (canon) forms.add(canon.slice(0, -1));
  for (const body of forms) {
    for (let len = pnDigits.length; len >= 5; len--) {
      for (let i = 0; i + len <= pnDigits.length; i++) {
        if (body.includes(pnDigits.slice(i, i + len))) return "pn_derived";
      }
    }
  }
  return "clean";
}

const STRONG_EVIDENCE: readonly EvidenceStrength[] = ["grounding_chunk", "fetched_source"];

export function gradeBarcode(input: BarcodeGradeInput): BarcodeGrade {
  const raw = (input.barcode ?? "").trim();
  const gtinShaped = isGtinShaped(raw);
  const checkDigitValid = isValidCheckDigit(raw);
  const placeholder = isPlaceholderBarcode(raw);
  const canon = canonicalGtin(raw);
  const pnDerived = pnDerivedAnnotation(raw, input.partNumber);

  const base = { checkDigitValid, gtinShaped, placeholder, pnDerived, canonicalGtin: canon };

  // Structural rejection: misreads and enumerated junk. Ground truth never rescues these -
  // a "physical scan" of a bad-check-digit code IS the misread case.
  if (placeholder) {
    return { ...base, verdict: "rejected", reason: "Placeholder/dummy barcode (blocklist)" };
  }
  if (!gtinShaped) {
    return { ...base, verdict: "rejected", reason: "Not a GTIN-shaped barcode" };
  }
  if (!checkDigitValid) {
    return { ...base, verdict: "rejected", reason: "Invalid GS1 check digit (likely misread)" };
  }

  const gt = input.groundTruth;
  if (gt?.kind === "physical_scan") {
    return { ...base, verdict: "verified", reason: "Captured by a physical scan" };
  }
  if (gt?.kind === "corpus_trusted") {
    return { ...base, verdict: "verified", reason: "Grandfathered corpus barcode" };
  }
  if (gt?.kind === "evidence_verified" && STRONG_EVIDENCE.includes(gt.strength)) {
    return { ...base, verdict: "verified", reason: `App-verified in real evidence (${gt.strength})` };
  }
  if (gt?.kind === "evidence_verified") {
    return {
      ...base,
      verdict: "suggested",
      reason: `Evidence too weak to verify (${gt.strength}); needs a physical scan or stronger evidence`,
    };
  }
  return {
    ...base,
    verdict: "suggested",
    reason: "Well-formed but unverified; counts only after a physical scan or app-verified evidence",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/upc/barcodeTrust.test.ts`
Expected: PASS, all tests green, no console noise.

- [ ] **Step 5: Also run the neighboring suites to prove no regression**

Run: `npx vitest run src/services/upc/`
Expected: PASS (gtin/misread suites untouched and green).

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(trust-gate): pure barcode trust gate - rejected/suggested/verified + advisory pnDerived (spec v3 AM-1..AM-11)" -- src/services/upc/barcodeTrust.ts src/services/upc/barcodeTrust.test.ts
```

---

### Task 2: Gate the CSV import back door (`buildProductImport`)

**Files:**
- Modify: `src/services/csvImport.ts` (the `buildProductImport` loop, ~:112-207)
- Test: `src/services/csvImport.trustGate.test.ts` (new file; do NOT touch existing `csvImport.test.ts` assertions)

**Interfaces:**
- Consumes: `gradeBarcode` from Task 1 (exact signature above).
- Produces: no new exports; `ImportConflict` entries with reason prefix `"barcode rejected: "` that the panel already renders.

**Gating rules (from the spec, be precise):**
- Values from the `gtin` / `upc` / `ean` columns MUST be valid GTINs: `gradeBarcode` verdict `rejected` means the value is dropped from BOTH the alias candidates and the product field, with a conflict entry `{ code, reason: "barcode rejected: <grade.reason>" }`.
- `barcode`/`primary_barcode` column: a physical label can legitimately be a non-GTIN code (vendor label), so ONLY reject it when it is GTIN-shaped with a bad check digit, or a placeholder. Non-GTIN-shaped primary barcodes keep today's behavior (vendor-typed alias).
- `sku` and `vendor_codes` columns are NOT barcodes and are NEVER graded.
- A row whose every code was rejected creates no product (existing `rowAliases.length === 0` rule already handles this).

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/csvImport.trustGate.test.ts
import { describe, it, expect } from "vitest";
import { buildProductImport } from "./csvImport";

const base = {
  existingProducts: [],
  existingAliases: [],
  businessId: "biz-1",
  now: () => "2026-07-15T00:00:00.000Z",
};
function idFactoryFrom(seed = 0) {
  let n = seed;
  return () => String(++n);
}

describe("CSV import trust gate (the csvImport back door, AM-4.1)", () => {
  it("drops a bad-check-digit gtin: no alias, field blanked, honest conflict", () => {
    const out = buildProductImport({
      ...base,
      idFactory: idFactoryFrom(),
      rows: [{ name: "Fake Tire", gtin: "8848111201762" }], // valid shape, WRONG check digit
    });
    expect(out.products).toHaveLength(0); // only code was rejected -> no product
    expect(out.aliases).toHaveLength(0);
    expect(out.conflicts.some((c) => c.reason.startsWith("barcode rejected:"))).toBe(true);
  });

  it("drops a placeholder barcode (0000000000000) the same way", () => {
    const out = buildProductImport({
      ...base,
      idFactory: idFactoryFrom(),
      rows: [{ name: "Junk", barcode: "0000000000000" }],
    });
    expect(out.aliases).toHaveLength(0);
    expect(out.conflicts.some((c) => c.reason.startsWith("barcode rejected:"))).toBe(true);
  });

  it("keeps a VALID barcode exactly as before (regression: 6959655468007 imports cleanly)", () => {
    const out = buildProductImport({
      ...base,
      idFactory: idFactoryFrom(),
      rows: [{ name: "Blackhawk Street-H HH11", sku: "5546800V", upc: "6959655468007" }],
    });
    expect(out.products).toHaveLength(1);
    expect(out.products[0].upc).toBe("6959655468007");
    // sku + upc both become aliases, as today
    expect(out.aliases.map((a) => a.cleanCode).sort()).toEqual(["5546800V", "6959655468007"].sort());
    expect(out.conflicts).toHaveLength(0);
  });

  it("does NOT grade sku/vendor codes (non-barcode columns are out of the gate's jurisdiction)", () => {
    const out = buildProductImport({
      ...base,
      idFactory: idFactoryFrom(),
      rows: [{ name: "Vendor thing", sku: "X0012ABCDE", vendor_codes: "V-99|K-77" }],
    });
    expect(out.products).toHaveLength(1);
    expect(out.aliases).toHaveLength(3);
    expect(out.conflicts).toHaveLength(0);
  });

  it("keeps a non-GTIN primary_barcode as a vendor-typed alias (physical labels may be code128)", () => {
    const out = buildProductImport({
      ...base,
      idFactory: idFactoryFrom(),
      rows: [{ name: "Shop-labeled", barcode: "SHOP-TAG-0042" }],
    });
    expect(out.products).toHaveLength(1);
    expect(out.aliases).toHaveLength(1);
  });

  it("a bad gtin does not kill the row when another code is valid - field blanked, rest imports", () => {
    const out = buildProductImport({
      ...base,
      idFactory: idFactoryFrom(),
      rows: [{ name: "Half-good", gtin: "8848111201762", upc: "6959655468007" }],
    });
    expect(out.products).toHaveLength(1);
    expect(out.products[0].gtin).toBe(""); // rejected field blanked, never stored as identity
    expect(out.products[0].upc).toBe("6959655468007");
    expect(out.conflicts.some((c) => c.reason.startsWith("barcode rejected:"))).toBe(true);
  });
});
```

Note: the exact `rows` key names must match `pick(row, [...])` in `buildProductImport` (`name`, `gtin`, `upc`, `ean`, `barcode`, `sku`, `vendor_codes`). Check `parseCsv`'s row shape - if `buildProductImport` takes parsed row objects keyed by header, pass plain objects as above (see existing tests in `csvImport.test.ts` for the established fixture shape and mirror it).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/csvImport.trustGate.test.ts`
Expected: FAIL - bad-check-digit gtin currently imports as an approved alias (first test's `toHaveLength(0)` assertions fail).

- [ ] **Step 3: Implement the gate in `buildProductImport`**

In `src/services/csvImport.ts`, import the gate at the top:

```typescript
import { gradeBarcode } from "./upc/barcodeTrust";
import { isGtinShaped } from "./upc/gtin";
```

Inside the row loop, after the `pick(...)` calls and BEFORE `rawCodes` is built (~:118-127), grade the barcode-typed fields:

```typescript
    // TRUST GATE (spec v3 AM-4.1): gtin/upc/ean columns must be valid GTINs; primary_barcode is
    // rejected only when GTIN-shaped-with-bad-check-digit or a placeholder (a physical label may
    // legitimately be a non-GTIN vendor code). Rejected values never become aliases OR product
    // identity fields. sku/vendor codes are not barcodes and are never graded.
    const rejectedCodes = new Set<string>();
    const gateStrict = (value: string, field: string): string => {
      if (!value) return value;
      const grade = gradeBarcode({ barcode: value, partNumber: primarySku });
      if (grade.verdict === "rejected") {
        conflicts.push({ code: value, reason: `barcode rejected: ${grade.reason} (${field})` });
        rejectedCodes.add(value);
        return "";
      }
      return value;
    };
    const gatePhysicalLabel = (value: string): string => {
      if (!value || !isGtinShaped(value)) {
        // non-GTIN label: only the placeholder blocklist applies
        const grade = value ? gradeBarcode({ barcode: value }) : null;
        if (grade?.placeholder) {
          conflicts.push({ code: value, reason: `barcode rejected: ${grade.reason} (barcode)` });
          rejectedCodes.add(value);
          return "";
        }
        return value;
      }
      return gateStrict(value, "barcode");
    };
    const gatedGtin = gateStrict(gtin, "gtin");
    const gatedUpc = gateStrict(upc, "upc");
    const gatedEan = gateStrict(ean, "ean");
    const gatedPrimaryBarcode = gatePhysicalLabel(primaryBarcode);
```

Then change the `rawCodes` construction (~:127) to use the gated values and skip rejected ones:

```typescript
    const rawCodes = [primarySku, gatedPrimaryBarcode, gatedGtin, gatedUpc, gatedEan, ...vendorCodes]
      .filter(Boolean)
      .filter((c) => !rejectedCodes.has(c));
```

And in the `Product` literal (~:186-190), store the gated values:

```typescript
      primaryBarcode: gatedPrimaryBarcode,
      gtin: gatedGtin,
      upc: gatedUpc,
      ean: gatedEan,
```

Wait for `gatePhysicalLabel`'s non-GTIN branch: `gradeBarcode` on a non-GTIN value returns verdict `rejected` (not shaped) - that is why the non-GTIN branch ONLY checks `grade.placeholder`, never the verdict. Keep that distinction or the vendor-label test fails.

- [ ] **Step 4: Run tests to verify they pass, plus the existing suite**

Run: `npx vitest run src/services/csvImport.trustGate.test.ts src/services/csvImport.test.ts`
Expected: PASS both files (the existing suite proves no behavior change for valid imports).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(trust-gate): gate CSV import barcode fields - the ungated approved:true back door (AM-4.1)" -- src/services/csvImport.ts src/services/csvImport.trustGate.test.ts
```

---

### Task 3: Gate `resolveUnknown`'s product identity minting (the single choke point)

**Files:**
- Modify: `src/stores/scanStore.ts` (the two minting sites: provisional upgrade ~:3383-3409 and fresh mint ~:3425-3456)
- Test: `src/stores/scanStore.trustGate.store.test.ts` (new)

**Interfaces:**
- Consumes: `gradeBarcode` from Task 1.
- Produces: a module-scope helper in scanStore.ts (not exported): `gateIdentityBarcodeFields(np, partNumber)` returning `{ gtin, upc, ean }` with rejected values blanked.

**What this closes:** both minting sites copy `np.gtin/upc/ean` verbatim from the caller's payload (AI decode `newProduct`, batchApprove's `suggested*` copy, human review payloads) into stored product identity. A phantom or misread barcode in those fields becomes searchable/trusted identity today. After this task a rejected barcode field is silently blanked (the product still mints; its identity fields just never carry junk). The scanned `cleanCode` alias is NOT gated here: the code was physically scanned, its existence is ground truth, and vendor labels must keep aliasing (Resolver Trust Rules unchanged).

- [ ] **Step 1: Write the failing test**

```typescript
// src/stores/scanStore.trustGate.store.test.ts
// jsdom project (store test). Follow the createTestScanStore/mock pattern of the neighboring
// scanStore.*.store.test.ts files (see scanStore.batchApprove.test.ts for the review fixture shape).
import { describe, it, expect, beforeEach } from "vitest";
import { useScanStore } from "./scanStore";

function seedOpenReview(cleanCode: string) {
  useScanStore.setState((s) => ({
    needsReviewQueue: [
      ...s.needsReviewQueue,
      {
        id: `rev-${cleanCode}`,
        businessId: s.businessId,
        rawCode: cleanCode,
        cleanCode,
        normalizedCode: cleanCode,
        codeType: "numeric_sku",
        status: "open",
        reason: "unknown code",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        suggestedProductName: "",
        suggestedBrand: "",
        suggestedCategory: "",
        suggestedAliases: [],
        suggestedGtin: "",
        suggestedUpc: "",
        suggestedEan: "",
        suggestedPrimaryBarcode: "",
        suggestedPrimarySku: "",
        suggestedProductUrl: "",
        suggestedImageUrl: "",
        sourceUrls: [],
        confidence: 0,
        idempotencyKey: `idem-${cleanCode}`,
      } as never,
    ],
  }));
}

describe("resolveUnknown gates identity barcode fields (AM-4.2)", () => {
  beforeEach(() => {
    useScanStore.getState().clearLocalCache?.();
  });

  it("blanks a bad-check-digit gtin/upc from the minted product; keeps valid ones", () => {
    seedOpenReview("PN-TG-1");
    useScanStore.getState().resolveUnknown("rev-PN-TG-1", "create_new", {
      origin: "human",
      newProduct: {
        name: "Trust Gate Tire",
        brand: "Blackhawk",
        gtin: "8848111201762", // WRONG check digit - must be blanked
        upc: "6959655468007", // real - must be kept
        ean: "0000000000000", // placeholder - must be blanked
      },
    } as never);
    const p = useScanStore.getState().products.find((x) => x.name === "Trust Gate Tire");
    expect(p).toBeTruthy();
    expect(p!.gtin).toBe("");
    expect(p!.ean).toBe("");
    expect(p!.upc).toBe("6959655468007");
    // the scanned code itself still aliases (physically scanned = its existence is ground truth)
    expect(p!.aliases).toContain("PN-TG-1");
  });

  it("regression: a fully valid newProduct mints exactly as before", () => {
    seedOpenReview("PN-TG-2");
    useScanStore.getState().resolveUnknown("rev-PN-TG-2", "create_new", {
      origin: "human",
      newProduct: { name: "Clean Tire", brand: "Nexen", upc: "6959655468007" },
    } as never);
    const p = useScanStore.getState().products.find((x) => x.name === "Clean Tire");
    expect(p?.upc).toBe("6959655468007");
    expect(p?.verified).toBe(true);
  });
});
```

Adapt the fixture to the real `UnknownCodeReview` shape (`src/types.ts:233+`) and the store-test setup helpers the neighboring `*.store.test.ts` files use - copy their beforeEach/reset pattern exactly rather than inventing one. If `clearLocalCache` is not the reset used by sibling tests, use whatever they use.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stores/scanStore.trustGate.store.test.ts`
Expected: FAIL - `p.gtin` is `"8848111201762"` (stored verbatim today).

- [ ] **Step 3: Implement the helper + wire both minting sites**

In `scanStore.ts`, near the other module-scope helpers (imports at top: `import { gradeBarcode } from "../services/upc/barcodeTrust";`):

```typescript
/** TRUST GATE (spec v3 AM-4.2): rejected barcode identity fields are blanked, never stored.
 *  The scanned cleanCode alias is NOT gated (physically scanned; vendor labels must keep aliasing). */
function gateIdentityBarcodeFields(
  np: { gtin?: string; upc?: string; ean?: string; primarySku?: string },
): { gtin: string; upc: string; ean: string } {
  const gate = (v?: string): string => {
    const value = (v ?? "").trim();
    if (!value) return "";
    return gradeBarcode({ barcode: value, partNumber: np.primarySku }).verdict === "rejected" ? "" : value;
  };
  return { gtin: gate(np.gtin), upc: gate(np.upc), ean: gate(np.ean) };
}
```

At the provisional-upgrade site (~:3392-3394), replace:

```typescript
              gtin: np.gtin ?? orphan.gtin,
              upc: np.upc ?? orphan.upc,
              ean: np.ean ?? orphan.ean,
```

with:

```typescript
              ...(function () {
                const gated = gateIdentityBarcodeFields(np);
                return {
                  gtin: np.gtin !== undefined ? gated.gtin : orphan.gtin,
                  upc: np.upc !== undefined ? gated.upc : orphan.upc,
                  ean: np.ean !== undefined ? gated.ean : orphan.ean,
                };
              })(),
```

At the fresh-mint site (~:3437-3439), replace:

```typescript
              gtin: np.gtin ?? "",
              upc: np.upc ?? "",
              ean: np.ean ?? "",
```

with:

```typescript
              ...gateIdentityBarcodeFields(np),
```

- [ ] **Step 4: Run the new test + the resolveUnknown-adjacent suites**

Run: `npx vitest run src/stores/scanStore.trustGate.store.test.ts src/stores/scanStore.batchApprove.test.ts src/stores/poisonGuard.store.test.ts src/stores/identityMerge.store.test.ts`
Expected: ALL PASS (batchApprove + poisonGuard use valid fixture barcodes and must not regress; if a fixture uses an invalid check digit as a stand-in barcode, fix the FIXTURE to a valid one via the check-digit helper, never weaken the gate).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(trust-gate): gate identity barcode fields at resolveUnknown minting - single choke point (AM-4.2)" -- src/stores/scanStore.ts src/stores/scanStore.trustGate.store.test.ts
```

---

### Task 4: AM-2 regression pins + scrub AI-suggested barcode fields on review rows

**Files:**
- Modify: `src/stores/scanStore.ts` (ONLY the decode-result sites that write `suggestedGtin/suggestedUpc/suggestedEan/suggestedPrimaryBarcode` from a DECODE `best` result - find them with `grep -n "suggestedGtin:" src/stores/scanStore.ts` and gate only those sourced from decode payloads, NOT the ones copying from an already-trusted matched product like :1377-1379)
- Test: `src/stores/scanStore.am2Invariants.store.test.ts` (new)

**Interfaces:**
- Consumes: `gradeBarcode` (Task 1), existing `shouldAutoApplySuggestion`/`canAutoCount` (read-only - DO NOT EDIT `scanGates.ts`).

**Why:** AM-2's "suggested tier never self-counts" is already the code's behavior (see Code Reality above) - these tests PIN it so no future change silently reintroduces the self-count. The scrub keeps phantom/misread AI barcodes out of the review row's `suggested*` fields so the approve path (and batchApprove's verbatim copy of those fields) can never launder them (defense in depth on top of Task 3).

- [ ] **Step 1: Write the failing-or-pinning tests**

```typescript
// src/stores/scanStore.am2Invariants.store.test.ts
import { describe, it, expect } from "vitest";
import { shouldAutoApplySuggestion, canAutoCount } from "./scanGates";

describe("AM-2 invariant pins (suggested tier never self-counts; Phase-7 gate unchanged)", () => {
  it("a confidence-0.9 SUGGESTED decode does NOT clear the auto-count gate", () => {
    expect(
      canAutoCount({
        codeType: "upc_a",
        decision: { status: "suggested", confidence: 0.9 },
        productName: "Some Tire",
        productNameUsable: true,
        tireOk: true,
        contextConflict: null,
      }).allowed,
    ).toBe(false);
  });

  it("a provider-claimed 'verified' with NO app corroboration does NOT auto-count (non-self-report path)", () => {
    expect(
      canAutoCount({
        codeType: "upc_a",
        decision: { status: "verified", confidence: 0.95, corroborationPath: "none" },
        productName: "Some Tire",
        productNameUsable: true,
        tireOk: true,
        contextConflict: null,
      }).allowed,
    ).toBe(false);
  });

  it("suggestion auto-apply never fires on a 'verified' decode without app verification (T20/1225 firewall)", () => {
    expect(
      shouldAutoApplySuggestion({
        autoAddOn: true,
        contextConflict: null,
        productNameUsable: true,
        confidence: 0.95,
        status: "verified",
        exactCodeEvidenceVerifiedByApp: false,
      }),
    ).toBe(false);
  });

  it("suggestion auto-apply is an IDENTITY DISPLAY only - documented invariant", () => {
    // shouldAutoApplySuggestion returning true leads to a name applied on the counted provisional
    // row + a PARKED "suggested" review. It must never mint an alias or add a count. This is pinned
    // structurally: the function returns a boolean consumed by the display path, and the alias-minting
    // path (resolveUnknown) is only reachable via canAutoCount (pinned above) or a human action.
    expect(
      shouldAutoApplySuggestion({
        autoAddOn: true,
        contextConflict: null,
        productNameUsable: true,
        confidence: 0.85,
        status: "suggested",
        exactCodeEvidenceVerifiedByApp: false,
      }),
    ).toBe(true);
  });
});
```

Additionally (same file or a sibling `describe`): a store-level test that runs a scan through the mocked decode path with a SUGGESTED result carrying a phantom barcode and asserts, after decode settles: `aliases` contains NO approved alias for the code, `finalCounts` total equals exactly the number of physical `processScan` calls, and the parked review's `suggestedGtin` is `""` (scrubbed). Follow the existing mocked-decode store-test pattern (grep for `page.route`-less unit decode mocks in `scanStore.*.store.test.ts` siblings - e.g. the tests around the auto-apply path; mock `fetch` the way they do).

- [ ] **Step 2: Run to verify the pins hold and the scrub test fails**

Run: `npx vitest run src/stores/scanStore.am2Invariants.store.test.ts`
Expected: the 4 pure pins PASS immediately (they pin existing behavior - that is their job); the store-level scrub assertion FAILS (`suggestedGtin` currently carries the phantom verbatim).

- [ ] **Step 3: Implement the scrub at the decode-result review-write sites**

Module-scope helper in scanStore.ts:

```typescript
/** Defense in depth (AM-4.4): a decode-provided barcode field that fails the trust gate is scrubbed
 *  from the review's suggested* fields so no approve path can launder it into identity. */
function scrubSuggestedBarcode(value: string | undefined, partNumber?: string): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  return gradeBarcode({ barcode: v, partNumber }).verdict === "rejected" ? "" : v;
}
```

At each decode-result site that writes `suggestedGtin: best?.gtin ?? ""` (and upc/ean/primaryBarcode), wrap with `scrubSuggestedBarcode(best?.gtin, best?.primarySku ?? tireFields?.partNumber)`. Leave :1377-1379 (copies from an already-stored matched product) untouched.

- [ ] **Step 4: Run the new suite + the decode-path suites**

Run: `npx vitest run src/stores/scanStore.am2Invariants.store.test.ts src/stores/scanGates.test.ts src/stores/poisonGuard.store.test.ts`
Expected: PASS. (If `scanGates.test.ts` does not exist, skip it - do not create one; the pins live in the new file.)

- [ ] **Step 5: Commit**

```bash
git commit -m "test(trust-gate): pin AM-2 invariants (suggested never self-counts) + scrub rejected AI barcodes from review suggestions" -- src/stores/scanStore.ts src/stores/scanStore.am2Invariants.store.test.ts
```

---

### Task 5: Placeholder blocklist in the dt-harvest corpus guard

**Files:**
- Create: `scripts/dt-harvest/lib/placeholderBarcodes.mjs` (mirror of Task 1's list - plain node cannot import TS; same pattern as `brandFamilies.mjs`)
- Modify: `scripts/dt-harvest/lib/merge.mjs` (`guardRow` - add the placeholder check next to the existing check-digit check)
- Test: `scripts/dt-harvest/lib/placeholderBarcodes.test.mjs` + extend the existing guardRow test file (find it: `ls scripts/dt-harvest/lib/*.test.mjs`) + a DRIFT test in `src/services/upc/barcodeTrust.test.ts` comparing the two lists

**Interfaces:**
- Produces: `isPlaceholderBarcode(code)` and `PLACEHOLDER_BARCODES` from `placeholderBarcodes.mjs`, logic-identical to Task 1's TS exports.

- [ ] **Step 1: Write the failing tests**

`scripts/dt-harvest/lib/placeholderBarcodes.test.mjs` (node test runner style used by the existing `.test.mjs` files in that dir - mirror their import/assert style exactly):

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPlaceholderBarcode, PLACEHOLDER_BARCODES } from "./placeholderBarcodes.mjs";

test("placeholder blocklist mirrors the TS gate", () => {
  assert.equal(isPlaceholderBarcode("0000000000000"), true);
  assert.equal(isPlaceholderBarcode("123456789012"), true);
  assert.equal(isPlaceholderBarcode("9999999999999"), true);
  assert.equal(isPlaceholderBarcode("6959655468007"), false);
  assert.ok(PLACEHOLDER_BARCODES.length > 0);
});
```

Extend the guardRow test file: a harvest row whose `gtin` is `0000000000000` (which passes... actually an all-zero code FAILS the check digit? No: 0000000000000 has check digit 0 and sum 0 -> valid!) must be rejected with reason `placeholder_barcode`.

DRIFT test appended to `src/services/upc/barcodeTrust.test.ts` (mutation-proven pattern from `brandFamilies` drift guard):

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("placeholder blocklist drift guard (.mjs mirror)", () => {
  it("the .mjs mirror contains exactly the same list", () => {
    const mjs = readFileSync(
      join(__dirname, "../../../scripts/dt-harvest/lib/placeholderBarcodes.mjs"),
      "utf8",
    );
    for (const code of PLACEHOLDER_BARCODES) {
      expect(mjs).toContain(`"${code}"`);
    }
    // and no extras: count the quoted 8-14 digit literals in the mirror's list block
    const listBlock = mjs.slice(mjs.indexOf("PLACEHOLDER_BARCODES"), mjs.indexOf("]"));
    const literals = listBlock.match(/"\d{8,14}"/g) ?? [];
    expect(literals.length).toBe(PLACEHOLDER_BARCODES.length);
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `node --test scripts/dt-harvest/lib/placeholderBarcodes.test.mjs` -> FAIL (module missing).
Run: `npx vitest run src/services/upc/barcodeTrust.test.ts` -> drift test FAILS (file missing).

- [ ] **Step 3: Implement**

`scripts/dt-harvest/lib/placeholderBarcodes.mjs`:

```javascript
// Mirror of src/services/upc/barcodeTrust.ts's placeholder blocklist (plain node cannot import TS).
// A drift-guard test in barcodeTrust.test.ts keeps the two lists identical - edit BOTH or it fails.
export const PLACEHOLDER_BARCODES = [
  "123456789012",
  "0123456789012",
  "1234567890128",
  "01234567890128",
];

export function isPlaceholderBarcode(code) {
  const t = (code ?? "").toString().trim();
  if (!t) return false;
  if (/^(\d)\1+$/.test(t)) return true;
  if (PLACEHOLDER_BARCODES.includes(t)) return true;
  const stripped = t.replace(/^0+/, "");
  return PLACEHOLDER_BARCODES.some((p) => p.replace(/^0+/, "") === stripped);
}
```

In `merge.mjs`'s `guardRow`, next to the existing check-digit rejection, add:

```javascript
  if (isPlaceholderBarcode(row.gtin ?? row.barcode)) {
    return { ok: false, reason: "placeholder_barcode" };
  }
```

(with the import at top: `import { isPlaceholderBarcode } from "./placeholderBarcodes.mjs";` - match the existing import style of merge.mjs, which may use relative `./`).

- [ ] **Step 4: Run all three test surfaces**

Run: `node --test scripts/dt-harvest/lib/` and `npx vitest run src/services/upc/barcodeTrust.test.ts`
Expected: PASS. Also run the existing dt-harvest suite in full (same command the Westlake round used): all existing guardRow/backfill tests stay green.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(trust-gate): placeholder-barcode blocklist in dt-harvest guardRow + .mjs mirror with drift test (AM-4.3, AM-11.4)" -- scripts/dt-harvest/lib/placeholderBarcodes.mjs scripts/dt-harvest/lib/placeholderBarcodes.test.mjs scripts/dt-harvest/lib/merge.mjs src/services/upc/barcodeTrust.test.ts
```

(plus the guardRow test file you extended)

---

### Task 6: Full gates + docs

**Files:**
- Modify: `docs/superpowers/specs/2026-07-15-barcode-trust-gate-design.md` (mark Phase 1 shipped in Status), `PROGRESS.md`, `TESTING.md`

- [ ] **Step 1: Full unit suite**

Run: `npx vitest run`
Expected: 0 failures (note: `cloudDrainRace.store.test.ts` is timing-flaky under full parallel load ONLY - rerun it isolated before calling it a failure).

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit` -> 0 errors. `npm run lint` -> exit 0 (40 pre-existing errors in untouched `scripts/` are known debt; no NEW errors in touched files).

- [ ] **Step 3: Targeted Playwright**

Run: `npx playwright test e2e/csv-import* e2e/review*` (match actual spec filenames with `ls e2e/`; run the CSV-import and review-flow specs - the two UI surfaces whose services changed).
Expected: PASS.

- [ ] **Step 4: Docs + ledger**

Update PROGRESS.md (phase entry), TESTING.md (the new test files + the drift-guard convention), spec Status line ("Phase 1 shipped <commit range>"). Append task completions to `.superpowers/sdd/progress.md`.

- [ ] **Step 5: Commit**

```bash
git commit -m "docs(trust-gate): phase 1 shipped - progress + testing notes" -- PROGRESS.md TESTING.md docs/superpowers/specs/2026-07-15-barcode-trust-gate-design.md
```

---

## Self-review notes (done at write time)

- Spec coverage: AM-1/AM-11 (Task 1 verdict design + advisory annotation), AM-2 (Task 4 pins; code reality documented - no rewire needed), AM-3 (Task 1 groundTruth artifacts), AM-4.1 (Task 2), AM-4.2 (Task 3), AM-4.3 (Task 5), AM-4.4 decode-path (Task 4 scrub), AM-11.4 (Tasks 1+5), AM-11.6 fixtures (Task 1). AM-5/AM-9/AM-10 are Phase 2 / backlog by the spec's own text - no task, correctly.
- The 16-phantom fixture uses the documented construction with representative SKU tails; the exact Gemini output lives in another session's data and can be swapped in verbatim without changing any assertion.
- Type consistency: `gradeBarcode` signature identical in Tasks 1-4; `PLACEHOLDER_BARCODES` name identical in Tasks 1+5.
