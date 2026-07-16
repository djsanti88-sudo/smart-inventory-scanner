# Barcode Trust Gate + Provenance — Design Spec

**Date:** 2026-07-15
**Status:** REVISED v3 - spec review complete (3-angle review: code-grounding, adversarial, counting-model)
PLUS live-web ground truth (2026-07-15): Sailun/Blackhawk's REAL published UPCs embed the part number
(6959655468007 = 695965 + last-6-of-PN 546800 + check 7, verbatim on tires.auto structured data).
Amendments AM-1..AM-12 below SUPERSEDE any conflicting text above them; AM-11 supersedes the
synthesized-detector-as-block wherever earlier text (including AM-6..AM-8) says otherwise. Owner
decisions ratified 2026-07-15: next-physical-scan counting (AM-2), grandfather-with-later-audit (AM-5),
two-phase build (AM-6). PHASE 1 SHIPPED 2026-07-15 on feat/barcode-trust-gate (51462ca..90f2ce1+,
plan docs/superpowers/plans/2026-07-15-barcode-trust-gate-phase1.md): gate + 4 wiring points +
AM-2 pins + multi-angle verification (adversarial fuzz, browser law proof, test audit, qa bots).

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

## Amendments (v2, 2026-07-15) — SUPERSEDE conflicting text above

Findings from the spec review (code-grounded verification + adversarial detector attack + counting-model
trace). Each amendment is binding on the implementation plan.

### AM-1 — The detector is defense-in-depth, never the permit (fixes review C1/I2/I3)

The synthesized detector only ever ADDS blocks; it is never the reason an AI-origin barcode gets to
count. A pure hallucination (valid check digit, real-looking prefix, NO part-number relationship, e.g.
`8848119900017`) is invisible to the detector by construction, as is any fake for a letters-only part
number (`BLACKHAWK-HT` has no digit run to embed). Therefore: "the detector did not fire" NEVER means
"safe" — it means "no additional evidence of fabrication." Trust for AI-origin barcodes comes only from
the confirmations in the promotion list, per AM-2.

### AM-2 — Counting trigger is the NEXT PHYSICAL SCAN (owner decision; supersedes "counts on scan" §Counting)

The traced reality of the pre-amendment wording: the decode ladder's own output called
`resolveUnknown(..., applyToCount: true)`, which replays the SAME code it just decoded — the system
re-scanning its own guess, with no independent confirming event. That self-replay is abolished for the
suggested tier:

- A decode/AI result alone only MINTS the `suggested`-provenance alias/product. It never counts itself.
- The count is created by the NEXT physical scan event that matches the suggested alias — a real,
  independent barcode read under the existing scanner-buffer model. That count carries the visible
  `suggested` tag until promotion.
- Note the same physical scan that first counts a suggested barcode is also the promotion trigger
  ("physical scan matches the suggested barcode"): in the common case the first counted unit promotes
  the identity to `verified` at the same moment. The suggested-tagged-count state is therefore
  short-lived by design.
- The Phase-7 verified auto-count path (status `verified`, app-verified exact-code evidence,
  confidence >= 0.8, full specs, no firewall conflict) is UNCHANGED — that path's trust comes from
  app-run evidence verification, not from the suggestion itself.

### AM-3 — Provenance is re-derived inside the gate, never trusted from the caller (fixes review C2)

`gradeBarcode` ALWAYS runs shape + check-digit + synthesized detection regardless of the claimed
provenance. A synthesized-positive verdict blocks EVEN IF the caller claims `evidence_verified`
(exception: AM-7 ground-truth carve-out). Unforgeability rules:

- `evidence_verified` is only accepted when the gate is handed the actual `EvidenceVerifier` result
  (the `EvidenceStrength` value from the app's own verification run) — never a bare string, and never
  mapped from a provider's self-reported `exactCodeEvidence` (which the app already forbids trusting).
- `physical_scan` is settable ONLY by the scanner input path (`processScan` capture). No code reachable
  from the decode ladder or any import path may mint it.
- `corpus_trusted` is settable ONLY by the grandfathering migration (AM-5), never at runtime.

### AM-4 — Corrected wiring map (fixes the missed back door; supersedes §Wiring points)

The four entry points, corrected against the real code:

1. **CSV import — the REAL path is `src/services/csvImport.ts` (`buildProductImport`, ~:154-200)**, which
   today mints `approved: true` aliases and `verified: true` products from any CSV cell with zero
   validation. This is the live back door and MUST be gated (both the ExportMenu path and the
   CsvImportPanel path — this repo's known two-pipelines trap). `shopwareCsvAdapter` parses no barcodes
   and needs no gate itself; the reconcile flow is gated where its output mints an alias (which is
   wiring point 2).
2. **Alias approval — `resolveUnknown` in `src/stores/scanStore.ts`** (single convergent path,
   including the batch-approve flips). One gate call here also covers the decode path's human approvals.
3. **Corpus/backfill — `scripts/dt-harvest/apply.mjs` (`mergeIntoBarcodeIndex`, ~:170-211)** is the real
   ungated corpus write (gate alongside the existing `guardRow` call). `backfill.mjs` only fills part
   numbers onto existing barcodes and `scripts/pilot-backfill-worklist.mjs` is already review-gated with
   no store write — neither is an entry point on its own; their outputs re-funnel through 1 or 2.
4. **Decode / AI-suggestion — where `UnknownCodeReview` is constructed with `suggested*` code fields**
   (pipeline), stamping the gate verdict next to the existing `evidenceStrength` stamp; plus AM-2's
   removal of suggested-tier self-count.

Every entry point stores a gate verdict before a barcode is stored or trusted; there is no back door.

### AM-5 — Grandfather now, audit later (owner decision, ratified with the risk stated)

The 78,202 corpus barcodes are grandfathered as `corpus_trusted` without re-validation, as originally
specified. The review flagged this as the largest untested surface (the harvest history includes a known
poisoning incident); the owner accepts that risk for now. The one-time report-only detector audit of the
corpus is a NAMED follow-up backlog item (not "possible"), to be run before any future corpus-derived
trust expansion (e.g. Turso sync to production).

### AM-6 — Two-phase build (owner decision)

- **Phase 1 (this plan):** `barcodeTrust.ts` (pure gate + synthesized detector, AM-8 params) + the
  16-fake must-block fixture + gate wiring at ALL entry points in AM-4 + the AM-2 removal of
  suggested-tier self-count. No data-model change beyond stamping verdicts on review items. This alone
  kills the Gemini-Blackhawk class.
- **Phase 2 (separate spec-reviewed plan):** the stored `provenance` field + persist migration
  (AM-10), verified-vs-suggested count separation in the report layer (touches the count core and 40+
  `.quantity` consumers — the heaviest piece), and the full promotion/demotion machinery (AM-9).

### AM-7 — Ground truth is never blocked by the heuristic (fixes review I5 false positives)

Real manufacturers legitimately encode catalog SKUs into GTIN item references. Therefore the
synthesized flag blocks only NON-ground-truth provenances (`ai_suggested`, `manual_entry`, import
paths). A barcode established by an actual physical scan, or app-verified by `EvidenceVerifier` at
`fetched_source`/`grounding_chunk` strength, is NOT blocked by the embed heuristic — real evidence is
exactly what distinguishes a legitimately SKU-encoding brand from a fabrication. Rescue rules for
`blocked`: a physical scan OR an app-run EvidenceVerifier confirmation (strong strength) un-blocks. A
"second independent source" can NEVER rescue a `blocked` code (two hallucinations can agree).

### AM-8 — Detector parameters (fixes review I4/M1 ambiguity)

- Normalization: compare digits-only (strip spaces/hyphens/letters from the PN; barcode is digits by
  shape). Compare against BOTH the raw and the `canonicalGtin` (zero-stripped) forms of the barcode.
- Match rule: a contiguous PN digit run of length >= 5 appearing inside the GTIN's payload
  (prefix+item-reference, excluding the check digit). Runs shorter than 5 are statistically
  meaningless (coincidental hits) and MUST NOT fire.
- PN with fewer than 5 digits: the detector returns "cannot assess" (not synthesized, not clean) —
  harmless under AM-1/AM-2 because detector silence never grants trust.
- The detector result is a labeled enum (`synthesized | clean | cannot_assess`), not a bare boolean, so
  call sites cannot conflate "didn't fire" with "safe."

### AM-9 — Promotion/demotion state machine, explicit (fixes the coherence gaps; Phase 2)

- `suggested -> verified`: any ONE of the four confirmations (unchanged).
- `blocked -> verified`: ONLY physical scan or app-run EvidenceVerifier strong confirmation (AM-7).
  Never a second source, never a human click alone (a human can send it to physical-verify, not verify it).
- `rejected`: terminal (misread; re-scan produces a new event).
- Demotion is its own transition, `verified -> suggested` (relabel, counts move from verified-qty to
  suggested-qty) — distinct from rejecting a never-promoted suggestion, which removes/corrects its
  suggested-tagged counts via the existing `markProductWrong`/`removeFromCount` semantics (reuse, do
  not re-invent). Counts are never silently deleted; every transition emits the existing audit events.

### AM-10 — Persist migration defaults (Phase 2, decided in writing before build)

Additive migration only (version bump + migrate fn), NEVER a reset of learned data. Defaults for
pre-existing rows: existing counts -> `physical_scan`-equivalent (they met the approved-alias/verified-
product bar when scanned); existing `approved: true` aliases and `verified: true` products ->
`corpus_trusted`-style grandfathering (the old data model cannot retroactively distinguish human
approvals from AI auto-approvals; this is a stated best-effort decision, mirroring AM-5). The Phase 2
plan restates these defaults for owner sign-off.

### AM-11 — Synthesized detector DEMOTED to advisory signal; `blocked` is not a structural verdict
### (live-web ground truth 2026-07-15; supersedes the detector-as-block everywhere, incl. AM-6..AM-8)

**The fact:** Sailun/Blackhawk's real, published UPC scheme is corporate-prefix + last-6-of-part-number
+ check digit: `6959655468007` = `695965` + `546800` (from SKU 5546800V) + `7`, confirmed verbatim in
tires.auto retailer structured data. "Payload embeds the PN" is a legitimate industry numbering
practice, not a fabrication tell. The detector therefore cannot reliably DENY trust (this finding), just
as it could never GRANT it (AM-1). Structure distinguishes nothing; evidence does. The thing that
separates Gemini's phantom `8848111201761` from the real `6959655468007` is that one appears on a real
fetched page and the other appears nowhere.

**Design consequences:**

1. The gate's verdicts collapse to three: `rejected` (not GTIN-shaped / bad check digit — unchanged,
   absolute) | `suggested` (well-formed, non-ground-truth provenance) | `verified` (ground-truth
   provenance per AM-3). The `blocked` verdict for PN-embedding is REMOVED.
2. `isSynthesizedFromPartNumber` becomes an advisory annotation only (`pnDerived: true/false/
   cannot_assess`, AM-8 normalization/threshold params kept for it): recorded on the grade and shown in
   the review UI as context ("this code is PN-derived - a common legitimate scheme AND the common
   fabrication pattern"). It never changes a verdict, never blocks, never counts, in either direction.
3. Safety is carried entirely by AM-2 + AM-3 (this was already their job): a phantom barcode minted as
   a `suggested` alias can never reach a count, because no physical tire will ever scan as that code and
   no real page will ever evidence-verify it. It decays honestly in review as "no evidence found."
   Batch-2-style real codes promote normally via physical scan or EvidenceVerifier.
4. One structural hard-block DOES remain, because it has no legitimate counterexample: the
   placeholder/dummy blocklist (the `123456789012` family, `0000000000000`, `9999999999999`) already
   established in the QA round's corpus-sanitize work. That list is enumerated junk, not a heuristic.
5. `synthesized_blocked` is removed from the Provenance enum. The provenance labels are:
   `physical_scan` | `evidence_verified` | `corpus_trusted` | `ai_suggested` | `manual_entry`.
6. Fixtures redefined:
   - The 16 Gemini `8848…` barcodes: grade `suggested` with `pnDerived: true`; MUST never reach a
     count or a verified promotion in the test flow (no evidence, no physical scan) — the safety
     assertion moves from "blocked at the door" to "inert without evidence."
   - The REAL `6959655468007` (Blackhawk BH5546800): grades `suggested` with `pnDerived: true`, and
     MUST promote to `verified` on an app-run EvidenceVerifier confirmation — the false-positive
     regression test this finding demands.
   - Placeholder junk (`0000000000000` etc.): `rejected`/hard-blocked via the blocklist.
7. The AM-5 corpus-audit backlog item is now EVIDENCE-based, not structural: a PN-embed scan of the
   corpus would flag Sailun's entire legitimate catalog. The audit tool is "does this barcode appear in
   real retailer evidence," with the free retailer structured-data path (tires.auto-class pages) as the
   first rung.

### AM-12 — TOP-LEVEL LAW: every scan appears and counts (owner order, 2026-07-15)

EVERY scanned code - known, unknown, misread, random, undecodable, gate-rejected - MUST immediately
appear on the scan feed AND be counted in session totals (scan 10 = count 10, no exceptions). The
gate's verdicts (including `rejected`) decide only the IDENTITY attached to the row and what may be
STORED as identity; they never decide whether a scanned row appears or counts. An unidentifiable code
counts as an "Unidentified item" row. This law is also recorded at top level in the project CLAUDE.md
and binds Phase 2's count-separation work equally.

## Open items

- Phase 2 spec review (provenance field, count separation, promotion machinery) after Phase 1 ships.
- Backlog (AM-5 + AM-11.7): one-time report-only EVIDENCE audit of the 78k corpus before any
  corpus-derived trust expansion.
- Separate task (other session, owner-gated): free retailer structured-data evidence pass over the
  batch-2 Blackhawks and the ~57 sourced candidates.
