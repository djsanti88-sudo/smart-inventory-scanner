# Barcode Trust Gate + Provenance — Design Spec

**Date:** 2026-07-15
**Status:** design approved in brainstorming (owner chose Approach A); awaiting spec review before writing the implementation plan.

## Motivation

An external AI (Gemini) "decoded" 50 unmatched Point S tires and returned 16 Blackhawk barcodes it
**synthesized** from the part number: `884811` (Sailun's GS1 company prefix) + the last 6 SKU digits +
a computed Modulo-10 check digit (e.g. `BH4120176 -> 8848111201761`). Every one passes check-digit
math and is completely fabricated — Gemini itself noted "no direct barcode publication for those
specific inferred SKUs." A valid check digit proves the digits are internally consistent; it says
nothing about whether that GTIN is the number the manufacturer actually assigned. Loading such
barcodes into the corpus would cause a real scan to miss, or (worse) collide with another product and
silently count the wrong item — "wrong product identity is FAILURE."

The app already has the arithmetic (`src/services/upc/gtin.ts`: `isValidCheckDigit`, `isGtinShaped`,
`canonicalGtin`, `gtinVariants`; `src/services/upc/misread.ts`). What is missing is a **trust gate at
the points where barcodes ENTER the system**, and a **provenance record** so an AI guess is never
confused with scanned truth. This spec adds both.

## Core principle

A barcode has two independent properties that must never be conflated:
1. **Well-formed** — correct shape + valid check digit. Cheap, local, necessary, and trivially
   satisfiable by any invented number.
2. **Verified identity** — this exact code is the one the manufacturer assigned to this exact product,
   established by ground truth (a physical scan) or real external evidence, never by an AI's self-report.

The gate enforces (1) and records how far toward (2) a barcode has gotten, via provenance.

## Trust tiers (verdict)

`gradeBarcode` returns exactly one verdict:

| Verdict | Condition | Behavior |
|---|---|---|
| `rejected` | Not GTIN-shaped OR check digit invalid | A bad/misread code. Route to Needs Review as a scan misread; never stored as identity. |
| `blocked` | Check digit valid BUT synthesized (payload embeds the SKU digits — the `prefix + SKU + check` signature) | Never counts, never attaches on its own. Surfaced as "needs a physical scan to confirm." Only a physical scan can rescue it. |
| `suggested` | Check digit valid, not synthesized, provenance is a non-verified source (AI/plausible) | Counts on scan **with a visible `suggested` tag** (owner decision). Does not silently become trusted truth. Promotable. |
| `verified` | Provenance is `physical_scan`, `evidence_verified`, or `corpus_trusted` | Attach + count with confidence. |

## Provenance (new stored field)

Every stored barcode/alias carries a `provenance` label:

- `physical_scan` — captured off a real tire label. Ground truth. → verified.
- `evidence_verified` — EvidenceVerifier confirmed the exact code on a real fetched page. → verified.
- `corpus_trusted` — already in the harvested corpus at ship time (grandfathered; see below). → verified.
- `ai_suggested` — from an AI/decode suggestion, check-digit valid, not synthesized. → suggested.
- `manual_entry` — a human typed it in (no external verification yet). → suggested (until confirmed).
- `synthesized_blocked` — detected as SKU-synthesized. → blocked.

Only `physical_scan` / `evidence_verified` / `corpus_trusted` may count as verified truth. Everything
else is suggested-or-below and is visibly tagged.

## Counting behavior (owner decision: "count with a suggested tag")

- A `suggested` barcode, when its tire is scanned, **counts** — the clerk is never blocked and the item
  is reflected — but the resulting count/feed row carries the `suggested` provenance tag.
- Totals and reports MUST be able to separate **verified quantity** from **suggested quantity**, so a
  tagged-suggested count never masquerades as confirmed.
- `blocked` and `rejected` never count as identity (unchanged hard rule).

## Promotion (owner decision: "at least any other source or evidence or human")

A `suggested` barcode is promoted to `verified` when **ANY ONE** of these independent confirmations
occurs (any single one suffices):

- a **physical scan** of the real tire matches the suggested barcode,
- **EvidenceVerifier** confirms the exact code on a real fetched page,
- a **second independent source** returns the same barcode for that exact SKU, or
- a **human confirms** it in the review UI.

On promotion, provenance flips (e.g. `ai_suggested -> evidence_verified`) and its tagged counts become
verified. (Demotion — a human rejecting a suggestion — moves those counts back out of the verified
total; specified in the plan.)

## The gate (pure service)

`src/services/upc/barcodeTrust.ts` — pure, no server/react/next imports; reuses `gtin.ts`.

```
interface BarcodeGradeInput {
  barcode: string;
  partNumber?: string;        // used by the synthesized detector
  provenance: Provenance;     // where this barcode came from
  evidenceStrength?: EvidenceStrength; // from EvidenceVerifier, when present
}
interface BarcodeGrade {
  verdict: "verified" | "suggested" | "blocked" | "rejected";
  provenance: Provenance;     // may be upgraded to synthesized_blocked
  checkDigitValid: boolean;
  synthesized: boolean;
  canonicalGtin: string | null;
  reason: string;             // honest, human-readable, always set
}
function gradeBarcode(input: BarcodeGradeInput): BarcodeGrade;
```

## Synthesized-barcode detector

`isSynthesizedFromPartNumber(barcode, partNumber): boolean` — flags a barcode whose payload embeds the
part number's digit run (the tell in every `8848…` fake: the GTIN's item-reference is a contiguous
copy of the SKU digits). Heuristic and deliberately conservative: a hit routes to `blocked`
(physical-verify), never a silent accept. False positives cost only an extra physical scan; false
negatives would poison the corpus, so the detector errs toward blocking.

## Existing corpus (owner decision: grandfather)

The 78,202 existing corpus barcodes are the already-harvested/verified baseline and are grandfathered
as `provenance = corpus_trusted` — NOT re-validated through the gate. The gate applies only to NEW
inputs from here forward. (A one-time report-only audit of the existing corpus for pre-existing
synthesized entries is noted as a possible follow-up, out of scope for this spec.)

## Wiring points (scope: every entry point)

Every place a barcode enters the system calls `gradeBarcode` before the barcode is stored or trusted:

1. **CSV / API import** — `shopwareCsvAdapter` / the reconcile ingest path.
2. **Alias approval** — when a human (or a promotion) approves a barcode↔part-number link.
3. **Backfill worklist** — the pilot backfill and any bulk barcode add.
4. **Decode / AI-suggestion path** — the decode ladder's output and any AI-provided barcode.

No entry point stores a barcode as trusted without a gate verdict; there is no back door.

## Components (isolation)

- `barcodeTrust.ts` — the gate + synthesized detector (pure, unit-tested).
- `Provenance` / `EvidenceStrength` types — in the types module.
- A `provenance` field added to the barcode/alias data model + store, with verified-vs-suggested count
  separation in the report layer.
- Thin call-site adapters at each of the four entry points.

## Testing

- Unit: `gradeBarcode` across all four verdicts; `isSynthesizedFromPartNumber` positive/negative.
- **Fixture (must-block):** the 16 Gemini `8848…` Blackhawk barcodes — every one must return `blocked`.
- **Fixture (suggested):** the real-source ones (Fortune `840139…`, Nexen `191563…`, etc.) return
  `suggested` when provenance is `ai_suggested`.
- **Fixture (verified):** a physically-scanned real GTIN returns `verified`.
- Promotion: a `suggested` barcode flips to `verified` on each of the four independent confirmations.
- Wiring: each entry point rejects a bad-check-digit code and blocks a synthesized one.

## Out of scope (this spec)

- One-time audit / re-validation of the existing 78k corpus (grandfathered; possible follow-up).
- Building new external verification providers (uses the existing EvidenceVerifier / decode ladder).
- The Brave/Firecrawl efficiency test on the unmatched tires (separate, owner-gated task).

## Open items

None — the three design decisions (counting-with-tag, grandfather, any-one-promotion) are resolved.
