# Instant Tire Scan + Fast Background Size Fill - Design

> Status: design (approved direction, pending spec review)
> Date: 2026-06-25
> Owner rule baked in: the decoder is built and validated AS IF the local 30k-tire DB does not exist.
> It uses only public GS1 company-prefix facts (the prefix table) + the Internet. Two INDEPENDENT
> Internet sources agreeing is sufficient to auto-count. The DB is never read, never a confirmer,
> never a backstop - in code or in validation.

## Goal
Make a tire scan feel instant while still landing the size and auto-counting safely, using only the free
Internet lookup path (Gemini + Google Search grounding). No synchronous AI on the scan path; the size
fills in behind the scan, fast.

## Problem (from this session's live measurements)
1. The prefix table gives the BRAND instantly and reliably (deterministic, ~0ms, $0).
2. The binding constraint is the SIZE. The fast tire hot path makes ONE synchronous grounded call capped
   at 3s (route.ts ~242). Two defects:
   - The grounded finder calls a RETIRED model (`gemini-2.0-flash-001`, groundedSpecFinder.ts:102) -> every
     grounded call errors and returns nothing. Grounding has effectively never run in production.
   - Even with a live model, a single grounded lookup returns the WRONG size on hard tires (measured 0/3
     correct): it finds the right product but guesses a common size, not the exact barcode's variant.
3. Because the grounded call is synchronous, raising its timeout would make every scan hang up to 8s.

## Architecture: two clocks
**Clock 1 - the scan (instant, ~0ms).** The prefix-anchored hot path returns immediately with the
prefix brand and NO synchronous grounded call. The row renders as a brand-known, size-pending suggestion.

**Clock 2 - background size fill (returns on first valid size; hard 8s cap).** The client fires the
existing background verify after the row is shown. It runs TWO INDEPENDENT retrievals in parallel and:
- updates the row's size for DISPLAY as soon as the first valid tire size arrives (fast, typically 3-5s);
- AUTO-COUNTS only if the two independent sources AGREE on the size (plus the existing gates: strong
  prefix-brand family, tire context, confidence threshold, public barcode).

## Components
- **route.ts (fast tire hot path, ~232-290):** remove the synchronous `await groundedSpecFind`. Return
  brand-only instantly with `decision.status = "suggested"` and a `sizePending: true` debug/flag.
- **groundedSpecFinder.ts:** (a) replace `gemini-2.0-flash-001` with the live model id (`gemini-2.5-flash`,
  via `GEMINI_MODEL`); (b) mine the size from the description/grounding text + the `model`/`productName`
  fields, not only a clean `size` field (owner insight: size often lives in the title).
- **New background size-fill path (extend `mode: "decode-deep"` in route.ts):** run two INDEPENDENT
  retrievals concurrently under one 8s budget signal:
  - Arm A: Gemini grounded Google Search (groundedSpecFinder, live model) -> size from grounding text.
  - Arm B: a direct product-page fetch (the existing enrichWithPageFetch road) -> size extracted from the
    fetched page text. This is a genuinely DIFFERENT retrieval road from Arm A (page fetch vs grounded
    search), which is what makes their agreement meaningful. Independence is required by construction;
    two calls to the same grounded road do NOT count as agreement.
  Return the first valid size for display; compute `sizeAgreement = (A.size && B.size && A.size === B.size)`.
- **decideDecode (decode.ts):** add a verify route - `internet_two_source_size`: a tire auto-counts when
  `sizeAgreement` is true AND the brand is in the STRONG prefix family AND tire context AND confidence
  >= threshold AND public barcode. This is the size analogue of the existing two-provider `canVerify`
  path; it does NOT require the exact code echoed on a page, and it NEVER consults the local DB.
- **scanStore.ts (`backgroundVerifyDeep` / `tireAutoCountOk`):** on the background result, update the row
  size; promote to counted only when decideDecode returns verified via `internet_two_source_size`.

## Data flow
scan -> prefix lookup -> brand (instant) -> row shown (suggested, size pending)
     -> client backgroundVerifyDeep -> route decode-deep -> [Arm A grounded] || [Arm B page-fetch] (<=8s)
     -> first valid size updates row -> if A.size === B.size -> decideDecode verified -> auto-count
     -> else -> row keeps the candidate size as a SUGGESTION (human review)

## Safety (false-auto-count must stay 0; Internet-only)
- Auto-count requires TWO INDEPENDENT sources to agree on the size. A lone grounded size only suggests.
- The brand still comes from the STRONG prefix family (poison/non-tire codes have no tire prefix -> never
  auto-count; the Manstel rivet-kit poison stays blocked).
- The local DB is never read in the decode/auto-count path (existing no-cheating guarantee preserved).
- Independence guard: Arm A and Arm B must use different retrieval roads; identical-source agreement is
  rejected. If only one arm returns, status stays suggested.

## Error handling / latency
- Hard 8s cap on the background race (AbortSignal). Each arm aborts at 8s; first valid size wins earlier.
- Any arm failure (timeout, HTTP, parse) degrades to the other arm; both failing -> brand-only suggestion.
- The scan path itself never blocks on the network; a grounding outage cannot slow scanning.

## Testing
- Unit (pure): size extraction from description text; `decideDecode` `internet_two_source_size` route -
  verifies on agreement, stays suggested on disagreement/single-source, blocks poison + non-tire + weak
  prefix; independence rejection (same-source agreement does not verify).
- Unit: groundedSpecFinder live-model id + description-size mining (mock fetch; no live calls).
- Integration: route fast path returns brand-only instantly (no grounded await); decode-deep runs the
  two-arm race and returns sizeAgreement (mocked arms).
- Human Bot Proof Gate (`qa:bots`): browser proof that a scan shows the brand instantly and the size
  fills in behind it, and that a two-source-agreed tire auto-counts while a single-source size stays in
  review. Required before handoff (scanner/auto-count change).

## Out of scope (future)
- The local 30k-tire DB is treated as NON-EXISTENT: not read at runtime, not a confirmer, not a
  validation answer-key. The exact-size trust comes entirely from two independent Internet lookups.
- Tuning which two retrieval roads are fastest/most independent beyond an initial pair (follow-up).
- Non-tire categories (the `internet_two_source_size` route is gated on tire context for now).

## Validation without the DB
Because the DB does not exist for this work, accuracy is NOT scored against the corpus. The trust
signal IS the production mechanism: two independent Internet sources agreeing on the size. Validation
measures the real Internet-only ceiling - on a set of scanned barcodes, what fraction reach
two-source size agreement (auto-count) vs stay suggested - plus owner spot-checks of a sample. This
is the honest ceiling: tires whose size two independent Internet sources confirm. The hard tail
(size not findable on the open Internet) stays in review by design, never an unconfirmed auto-count.

## Acceptance criteria
1. A tire scan renders the brand with NO AI wait (no synchronous grounded call on the hot path).
2. The size fills from the background within 8s, returning on the first valid size.
3. A tire auto-counts ONLY when two INDEPENDENT Internet sources agree on the size (DB never consulted).
4. The grounded finder uses a LIVE model and mines size from the description.
5. false-auto-count stays 0 (poison + single-source + non-tire + weak-prefix all blocked); all existing
   safety suites green; qa:bots browser proof passes.
