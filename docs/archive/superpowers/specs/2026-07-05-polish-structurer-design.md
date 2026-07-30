# Polish Structurer (free organizing intelligence) - Design

Owner-approved decisions, 2026-07-05. Build 2 of 3.

## Goal

Every product identity, from every source (fetchV2, GPT ladder, human approvals, existing
catalog rows), is split into **brand / model / description** plus a **glued-digits size tag**
so users can filter tires by typing only numbers, and see organized columns instead of one
long name. Fast, accurate, and free-first.

## Owner decisions (locked)

1. **Engine:** deterministic parsing FIRST ($0, instant, testable). A free-tier LLM
   (Gemini Flash-Lite, mocked in all tests) polishes ONLY rows the deterministic pass cannot
   split confidently.
2. **Tire tag = glued digits, all tire universes** (owner: "it has to be pretty smart when it
   comes to tires"):
   - Passenger/metric: `LT265/70R17` / `265 /70 R17` / `265x70R17` / `ZR`, `XL` -> `2657017`
   - Truck/18-wheeler decimals: `295/75R22.5` -> `29575225`
   - Flotation: `37x12.50R20` -> `37125020`
   - ATV/UTV: `25x8-12` -> `25812`
   - Motorcycle dash: `100/80-17` -> `1008017`
   The existing `TIRE_SIZE_RE` machinery (siblingGuard) is the starting point but the
   structurer gets its own richer parser; sharing happens by extraction, not duplication.
3. **Non-tire products:** the tag is the size/weight when present (`9.25 oz` -> `9.25oz`,
   `30 ct`, `1.5L`); brand and description split the same way.
4. **Scope: everywhere products live.** New structured fields on Product
   (`brand`, `model`, `descriptionText`, `sizeTag`, `structuredBy: "deterministic" | "llm" | "human"`),
   a one-time backfill pass over the existing DB, columns in the products/final-count table,
   and a numbers-only filter box (prefix match: typing `265` finds `2657017`).
5. **Test-until-right BEFORE merge (owner's explicit demand):** the structurer is scored in
   offline loops against the owner's own database (free, no network): per-field accuracy
   (brand right? size tag right? nothing lost?), fix-and-rerun in batches until it is right
   across many different barcode/product types. Same campaign discipline as v2.3. Only then
   does it wire into the UI.

## Architecture

- `src/services/polish/structurer.ts` - pure function
  `structureProduct(name, brand?, context?) -> { brand, model, descriptionText, sizeTag, confidence }`.
  No React/next imports. Brand detection: catalog + prefix-DB lexicon, then leading-token
  heuristics. Model = what remains after brand and size/weight extraction; description = the
  cleaned display string.
- `src/services/polish/llmPolish.ts` - fallback for `confidence < threshold`; provider behind
  the existing ai-lookup mock-first pattern; sanitizer runs before any external call; results
  cached so a name is polished at most once.
- Backfill script (`scripts/polish-backfill.mts`) - idempotent, re-runnable, writes
  `structuredBy` so human edits are never overwritten.
- UI: products/final-count table gains Brand / Model / Description / Size columns + filter box;
  scan feed rows show the structured name. Human edits to structured fields win permanently.

## Testing / proof gates

- Unit: notation table for every tire universe above + weights/counts + junk names (firewall
  outputs stay junk, never structured into fake brands).
- Offline DB campaign: batches over the full own-DB catalog, per-field scoring, loops until the
  owner-visible error rate is effectively zero; report with per-field accuracy tables.
- Playwright: filter by `2657017` and by `265` prefix shows the right rows; screenshot proof.
- LLM fallback tests fully mocked; live free-tier smoke only with explicit owner OK.

## Out of scope

Re-decoding anything (input is the already-decoded name); changing decode outcomes; paid LLM use.
