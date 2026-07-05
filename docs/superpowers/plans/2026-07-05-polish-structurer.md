# Polish Structurer Implementation Plan (Build 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every product identity, from every source, splits into brand / model / description plus a glued-digits size tag (all tire notations) or weight/count tag, powering organized columns and a numbers-only tire filter.

**Architecture:** A pure deterministic service (`src/services/polish/structurer.ts`) does the parsing at $0; a mock-first LLM fallback polishes only low-confidence rows; Product gains structured fields with an idempotent backfill; the products table gains columns + a digits filter. Proven against the owner's own data (76,173-row tire knowledge index + the 210-code fixture truths) in fix-and-rerun loops BEFORE any UI wiring.

**Tech Stack:** TypeScript pure services (no React/next imports), Vitest node project, existing ai-lookup mock-provider pattern for the LLM fallback, Playwright for the filter proof.

## Global Constraints

- Deterministic first: the LLM fallback runs ONLY when `structureProduct` returns `confidence < 0.6`, is mocked in ALL automated tests, and caches so a name is polished at most once.
- Tire tag = GLUED DIGITS, one canonical form per size regardless of notation:
  `LT265/70R17`->`2657017`; `265 /70 R17`->`2657017`; `265x70R17`->`2657017`; `245/35ZR19XL`->`2453519`; `295/75R22.5`->`29575225`; `37x12.50R20`->`37125020`; `33x12.50-15LT`->`33125015`; `25x8-12`->`25812`; `100/80-17`->`1008017`; `120/70ZR17`->`1207017`.
- Non-tire tag = size/weight/count when present: `9.25 oz`->`9.25oz`; `30 ct`->`30ct`; `1.5L`->`1.5l`; `500 ml`->`500ml`; `2 pack`->`2pk`. Lowercase, no spaces.
- Human edits win permanently: `structuredBy: "deterministic" | "llm" | "human"`; backfill and re-polish NEVER overwrite `structuredBy === "human"` rows.
- Junk stays junk: names failing the fetchV2 identity firewall shapes (shop-speak, breadcrumb arrows, code echoes) must return `confidence 0` and empty fields, never a fake brand.
- Eval gates before UI wiring (owner order "tested multiple times... until it does it completely right"): tire sizeTag accuracy >= 99% and brand accuracy >= 97% on a 2,000-row sample of the tire knowledge index; zero WRONG brand on the 210-fixture retail truths (unknown brand is acceptable, wrong is not).
- No em/en dashes in any user-facing copy. Count-first untouched. Keys server-side only.

---

### Task 1: `structureProduct` core (tires, weights, brand lexicon)

**Files:**
- Create: `src/services/polish/structurer.ts`
- Test: `src/services/polish/structurer.test.ts`

**Interfaces (later tasks + the eval harness rely on these exact names):**
```ts
export interface StructuredProduct {
  brand: string;            // "" when unknown - NEVER guessed from noise
  model: string;            // name minus brand minus size/weight/noise tokens
  descriptionText: string;  // cleaned display string (full name, tidied)
  sizeTag: string;          // glued digits ("2657017") or weight tag ("9.25oz") or ""
  sizeTagKind: "tire" | "weight" | "count" | "volume" | "none";
  confidence: number;       // 0..1; < 0.6 marks the row for LLM fallback
}
export interface StructurerContext {
  knownBrands?: string[];   // lexicon injected by the caller (catalog + prefix map); pure DI
  category?: string;        // "tires" biases tire parsing
}
export function structureProduct(name: string, brand?: string, ctx?: StructurerContext): StructuredProduct;
export function tireSizeTag(text: string): string; // "" when no tire size found - exported for the eval harness and the UI filter
```

Requirements:
- `tireSizeTag` handles EVERY notation in Global Constraints (passenger incl. spaced/x/dash/ZR/XL glue and service prefixes LT/ST/P, decimal truck rims 22.5, flotation NNxNN.NN, ATV NNxNN-NN, motorcycle NNN/NN-NN). Steal test fixtures from real data: the notations that appeared in the fetchV2 campaigns (siblingGuard has the battle-tested TIRE_SIZE_RE as a starting reference - this parser is richer and lives independently; do not import from siblingGuard, but DO read it first).
- Brand detection order: explicit `brand` arg (if non-junk) > longest knownBrands match at any word boundary (case-insensitive) > leading-token heuristic ONLY when the first 1-2 tokens are capitalized-word-shaped and not generic (tire/the/new/premium...). Unknown -> "".
- `model` = name minus brand tokens minus the size/weight match minus marketplace noise (trailing "| eBay"-style tails, "(2 Pack)" quantity prefixes like "2 X", "4 New").
- Confidence: 0.9+ when brand AND sizeTag found; 0.7 brand-or-size; 0.4 name-only passthrough; 0 junk.
- Junk gate: reuse shapes (not imports) from the fetchV2 firewall: breadcrumb arrows, "buy cheap/online store", price-comparison words, host-echo single tokens, pure code echoes -> confidence 0.

- [ ] **Step 1: failing tests** - a notation TABLE test (every Global Constraints example verbatim), brand lexicon cases (Falken/Michelin found mid-name; "BurstBrand Tire" leading-token; junk names -> confidence 0; generic first words never become brands), weight/count/volume cases, model extraction cases ("2 X TOYO Extensa HP II 275/35r20 102w Tires" -> brand Toyo, model "Extensa HP II", sizeTag "2753520").
- [ ] **Step 2: RED.** `npx vitest run src/services/polish/structurer.test.ts`
- [ ] **Step 3: implement.**
- [ ] **Step 4: GREEN + `npx tsc --noEmit`.**
- [ ] **Step 5: commit** `feat(polish): deterministic product structurer - all tire notations, weight tags, brand lexicon, junk gate`

### Task 2: offline eval harness against the owner's own data

**Files:**
- Create: `scripts/polish-eval.mts`
- Consumes: `structureProduct`/`tireSizeTag` (Task 1), `src/server/tire-knowledge/tireKnowledge.generated.json` (barcodeIndex: 76,173 rows with brand/model_normalized/size/raw_size_text ground truth), `scripts/fetchv2-db-sample-200.json` (210 truth strings).

Requirements:
- Tire eval: deterministic sample (every Nth row for a 2,000-row spread) of barcodeIndex. For each row, build REALISTIC listing names via templates (`"${BRAND} ${MODEL} ${raw_size_text} ${load_index}${speed_rating}"`, eBay-style `"4 New ${size} ${BRAND} ${MODEL} Tires"`, spaced-size variant, plus the raw fields as-is), run structureProduct with the tire-knowledge brand list as lexicon, score: sizeTag === glued(row.size), brand match (normalized), model token overlap.
- Retail eval: the 210 fixture truths -> structureProduct; score brand: WRONG only when a non-empty brand contradicts the truth's leading brand token(s); unknown "" is acceptable.
- Output: `scripts/polish-eval-results.json` with per-field accuracy + EVERY failing row (name, expected, got) so the controller can fix classes and rerun.
- No network. Run: `npx tsx scripts/polish-eval.mts`.
- [ ] Steps: build -> run -> commit harness `feat(polish): offline eval harness (76K tire rows + 210 retail truths)`.
  (The controller then LOOPS: read failures -> class-fix structurer with TDD -> rerun until Global Constraints gates pass.)

### Task 3: LLM fallback (mock-first) + polish cache

**Files:**
- Create: `src/services/polish/llmPolish.ts`, test `src/services/polish/llmPolish.test.ts`

Requirements: `polishWithLlm(name, deps: { provider: (prompt: string) => Promise<string>; cache: Map<string, StructuredProduct> })` -> parses a strict-JSON reply into StructuredProduct (structuredBy "llm"), contained failures (bad JSON -> null), sanitizer BEFORE the prompt (mask prices/emails/phones - reuse `src/services/ai/sanitizer` if present, else the decode path's sanitizer - grep first), cache hit skips the provider. The DEFAULT provider export is the mock (deterministic canned splits); a Gemini Flash-Lite live provider is wired but only constructed when GEMINI_API_KEY exists AND the caller passes live: true (never in tests). TDD.
- [ ] commit `feat(polish): mock-first LLM polish fallback with sanitizer + cache`

### Task 4: Product fields, backfill, UI columns + digits filter

**Files:**
- Modify: `src/types.ts` (Product: `structuredBrand?`, `structuredModel?`, `structuredDescription?`, `sizeTag?`, `structuredBy?`), the products/final-count table component (find via `grep -rn "final-count-table" src/`), `src/stores/scanStore.ts` (structure on product create/update paths - one call site helper).
- Create: `scripts/polish-backfill.mts` (idempotent: skips `structuredBy === "human"`, re-runnable, mock-DB aware), `e2e/polish-filter.spec.ts`.

Requirements:
- Structure runs at product creation/update (deterministic only in the hot path; LLM fallback is a background/backfill concern, never blocks a scan).
- Table: Brand / Model / Size columns + a filter input; typing digits filters by sizeTag prefix ("265" matches 2657017); typing text filters brand/model/description. data-testids for E2E.
- Playwright: seed products via scans (mocked decode payloads with tire names), filter "2055516" -> only the matching row; filter "205" -> prefix matches; screenshot to `e2e/proof/polish/`.
- Backfill: dry-run flag prints changes without writing; real run structures existing rows.
- [ ] commit `feat(polish): structured product fields, backfill, table columns + digits filter with Playwright proof`
