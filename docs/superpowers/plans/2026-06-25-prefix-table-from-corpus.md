# Massive Prefix Table from the Corpus - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mine the local 33,878-row tire corpus into a large cross-confirmed GS1 prefix table (a separate additions file), so the decoder - using only the prefix table + AI, never the corpus - decodes unknown tires fast and confidently.

**Architecture:** A standalone offline Node script derives each brand's GS1 prefix(es) deterministically from its real barcodes (longest-common-prefix within a leading-digit block, >=2 distinct barcodes to confirm), writes them to `tire_prefixes_ADDITIONS.csv`, and the existing generator is taught to merge FINAL + ADDITIONS. A live harness then validates decode quality on held-out tires using Gemini Flash only. The big corpus is never imported by the decoder.

**Tech Stack:** Node ESM (`.mjs`), Vitest, the existing `tirePrefixLookup`/`genTirePrefixHints` modules, the live `/api/ai-lookup` route.

## Global Constraints

- The big corpus (`data/tire-knowledge/tire_corpus_flat.csv`) is read ONLY by the offline miner. It is NEVER imported or queried by the decode pipeline (no cheating). Acceptance: confirm no runtime code path reads it.
- The miner writes ONLY `tire_prefixes_ADDITIONS.csv` (new) and its report. It NEVER modifies `tire_prefixes_FINAL.csv` (owner-owned) or the corpus.
- "strong" = cross-confirmed by >=2 distinct real barcodes. false-auto-count must stay 0.
- Mini models only (Gemini Flash) and only in the validation harness; the miner uses no AI ($0).
- Services/scripts pure where practical; no em dash or en dash in code/comments/strings.
- Do not commit unless the owner asks.

---

## File map
- Create: `scripts/lib/prefix-miner.mjs` - pure derivation (normalizeToGtin13 + deriveBrandPrefixes + LCP).
- Test: `scripts/__tests__/prefix-miner.test.mjs`.
- Create: `scripts/mine-tire-prefixes.mjs` - CLI: read corpus -> derive per brand -> conflict guard -> write `tire_prefixes_ADDITIONS.csv` + `data/tire-knowledge/mine-report.md`.
- Modify: `scripts/genTirePrefixHints.mjs` - merge FINAL + ADDITIONS.
- Create: `scripts/validate-prefix-decode.mjs` - live validation harness (Gemini Flash).
- Output (generated, reviewable): `tire_prefixes_ADDITIONS.csv`, `data/tire-knowledge/mine-report.md`, `reports/product-intel/<date>/prefix-decode-validation.json`.

---

### Task 1: Pure prefix derivation

**Files:**
- Create: `scripts/lib/prefix-miner.mjs`
- Test: `scripts/__tests__/prefix-miner.test.mjs`

**Interfaces:**
- Produces:
  - `normalizeToGtin13(code) => string | null` (12->zero-pad 13, 13->as is, 14->slice(1), else null; identical to `src/services/tire/tirePrefixLookup.ts`).
  - `longestCommonPrefix(strings: string[]) => string`.
  - `deriveBrandPrefixes(barcodes: string[], opts?: { minConfirm?: number; blockLen?: number }) => Array<{ prefix: string; count: number; examples: string[] }>` - groups the brand's GTIN-13 barcodes by their leading `blockLen` (default 6), and for each block with `>=minConfirm` (default 2) DISTINCT barcodes emits `{ prefix: LCP-of-the-block, count, examples: first 2 }`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/__tests__/prefix-miner.test.mjs
import { describe, it, expect } from "vitest";
import { normalizeToGtin13, longestCommonPrefix, deriveBrandPrefixes } from "../lib/prefix-miner.mjs";

describe("prefix-miner", () => {
  it("normalizes UPC-A to GTIN-13 by zero-padding", () => {
    expect(normalizeToGtin13("848983006257")).toBe("0848983006257");
    expect(normalizeToGtin13("4019238334760")).toBe("4019238334760");
    expect(normalizeToGtin13("abc")).toBe(null);
  });
  it("longestCommonPrefix", () => {
    expect(longestCommonPrefix(["0848983006257", "0848983007933", "0848983025555"])).toBe("0848983");
  });
  it("derives a cross-confirmed prefix from >=2 barcodes (Falken-like)", () => {
    const out = deriveBrandPrefixes(["848983006257", "848983007933", "848983025555"]);
    expect(out).toHaveLength(1);
    expect(out[0].prefix).toBe("0848983");
    expect(out[0].count).toBe(3);
  });
  it("does NOT emit a prefix when only one barcode confirms it", () => {
    expect(deriveBrandPrefixes(["848983006257"])).toHaveLength(0);
  });
  it("emits multiple prefixes for a brand using two GS1 blocks", () => {
    const out = deriveBrandPrefixes(["086699220585", "086699091000", "352870111111", "352870222222"]);
    expect(out.map((o) => o.prefix).sort()).toEqual(["0086699", "0352870"]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** Run: `npx vitest run scripts/__tests__/prefix-miner.test.mjs` -> FAIL (module missing).

- [ ] **Step 3: Implement `scripts/lib/prefix-miner.mjs`**

```js
// scripts/lib/prefix-miner.mjs - pure, deterministic, no AI. Derives GS1 company prefixes from a
// brand's real barcodes (LCP within a leading-digit block; >=N distinct barcodes confirm).
export function normalizeToGtin13(code) {
  const d = String(code ?? "").replace(/\D/g, "");
  if (d.length === 12) return "0" + d;
  if (d.length === 13) return d;
  if (d.length === 14) return d.slice(1);
  return null;
}

export function longestCommonPrefix(strings) {
  if (!strings.length) return "";
  let p = strings[0];
  for (const s of strings.slice(1)) {
    let i = 0;
    while (i < p.length && i < s.length && p[i] === s[i]) i++;
    p = p.slice(0, i);
    if (!p) break;
  }
  return p;
}

export function deriveBrandPrefixes(barcodes, opts = {}) {
  const minConfirm = opts.minConfirm ?? 2;
  const blockLen = opts.blockLen ?? 6;
  const blocks = new Map(); // leading-blockLen -> Set of GTIN-13
  for (const raw of barcodes) {
    const g = normalizeToGtin13(raw);
    if (!g || g.length !== 13) continue;
    const b = g.slice(0, blockLen);
    if (!blocks.has(b)) blocks.set(b, new Set());
    blocks.get(b).add(g);
  }
  const out = [];
  for (const [, set] of blocks) {
    const distinct = [...set];
    if (distinct.length < minConfirm) continue;
    out.push({ prefix: longestCommonPrefix(distinct), count: distinct.length, examples: distinct.slice(0, 2) });
  }
  return out.sort((a, b) => a.prefix.localeCompare(b.prefix));
}
```

- [ ] **Step 4: Run the test, verify it passes.** Run: `npx vitest run scripts/__tests__/prefix-miner.test.mjs` -> PASS.

- [ ] **Step 5: Commit (ask owner).** `git add scripts/lib/prefix-miner.mjs scripts/__tests__/prefix-miner.test.mjs && git commit -m "feat(prefix): pure GS1 prefix derivation from barcodes"`

### Task 2: The miner CLI

**Files:**
- Create: `scripts/mine-tire-prefixes.mjs`

**Interfaces:**
- Consumes: `deriveBrandPrefixes`, `normalizeToGtin13` (Task 1).
- Produces: `tire_prefixes_ADDITIONS.csv` (columns identical to `tire_prefixes_FINAL.csv`) and `data/tire-knowledge/mine-report.md`. Run: `node scripts/mine-tire-prefixes.mjs`.

- [ ] **Step 1: Implement the CLI**

Read `data/tire-knowledge/tire_corpus_flat.csv` (use a small CSV line parser; the file is comma-delimited with quoted fields). Build `brand -> [barcodes]` from the `brand` + `barcode` columns (skip empty). For each brand, call `deriveBrandPrefixes(barcodes)`. Build `prefix -> { brands: Map<brand, {count, examples}> }`.

CONFLICT GUARD: if a single derived prefix maps to MORE THAN 6 distinct brands, treat it as a likely country/regional block (not a company prefix): write those rows to the report's "skipped (too-wide)" section and do NOT emit them as strong. (Real corporate families are small; 6 is generous.)

Write `tire_prefixes_ADDITIONS.csv` with header `brand,prefix,prefix_length,region,verification_status,ingest_tier,example_barcode,source_url,mapping_flag,notes` and one row per surviving (prefix, brand): `verification_status=barcode_checked_crossconfirmed`, `ingest_tier=hint_strong`, `example_barcode`=one real code, `region=mined`, `mapping_flag=OK`, `notes="mined from corpus: <count> barcodes"`. Write `mine-report.md`: counts (brands processed, prefixes emitted, skipped-too-wide), the top 20 emitted prefixes with brand+count, and the skipped list.

- [ ] **Step 2: Run it.** Run: `node scripts/mine-tire-prefixes.mjs`. Expected: prints counts; `tire_prefixes_ADDITIONS.csv` and `data/tire-knowledge/mine-report.md` exist; ~150-188 brands emitted; `tire_prefixes_FINAL.csv` byte-unchanged (verify with `git status` - FINAL not modified).

- [ ] **Step 3: Commit (ask owner).** `git add scripts/mine-tire-prefixes.mjs tire_prefixes_ADDITIONS.csv data/tire-knowledge/mine-report.md && git commit -m "feat(prefix): mine cross-confirmed prefixes from the tire corpus"`

### Task 3: Generator merges FINAL + ADDITIONS

**Files:**
- Modify: `scripts/genTirePrefixHints.mjs`

**Interfaces:**
- Produces: `src/services/tire/tirePrefixHints.ts` built from BOTH CSVs (strong beats weak on duplicate brand+prefix; additive).

- [ ] **Step 1:** In `genTirePrefixHints.mjs`, after parsing `tire_prefixes_FINAL.csv` into rows, ALSO read `tire_prefixes_ADDITIONS.csv` if it exists and concatenate its data rows into the same `data` array before the map-building loop (the existing strong-beats-weak merge in the loop then handles dedupe). Update the header comment to note additions are merged.
- [ ] **Step 2: Run + verify.** Run: `node scripts/genTirePrefixHints.mjs`. Expected: prints a higher `hint_strong` count and `distinct prefixes`; `tirePrefixHints.ts` now contains the mined strong prefixes (spot-check a few, e.g. Toyo, Pirelli).
- [ ] **Step 3: Commit (ask owner).** `git add scripts/genTirePrefixHints.mjs src/services/tire/tirePrefixHints.ts && git commit -m "feat(prefix): generator merges FINAL + ADDITIONS prefix tables"`

### Task 4: Sanity + safety gate

**Files:** Test: `scripts/__tests__/mined-prefix-sanity.test.mjs`

**Interfaces:**
- Consumes: the regenerated `TIRE_PREFIX_HINTS` + `isBrandInPrefixFamily` from `src/services/tire/tirePrefixLookup`.

- [ ] **Step 1: Write the functional sanity test** (mined prefixes must corroborate known brands' REAL barcodes; convention-agnostic via the lookup's dual-alignment):

```js
// scripts/__tests__/mined-prefix-sanity.test.mjs
import { describe, it, expect } from "vitest";
import { isBrandInPrefixFamily } from "../../src/services/tire/tirePrefixLookup.ts";

const KNOWN = [
  ["086699220585", "Michelin"], ["029142753568", "Cooper"], ["0848983018830", "Falken"],
  ["092971263164", "Bridgestone"], ["0715459431564", "Hankook"], ["4981910527329", "Toyo"],
];

describe("mined prefix table corroborates known brands' real barcodes", () => {
  for (const [code, brand] of KNOWN) {
    it(`${brand} ${code} is in its strong prefix family`, () => {
      expect(isBrandInPrefixFamily(code, brand, { strongOnly: true })).toBe(true);
    });
  }
});
```

- [ ] **Step 2: Run it.** Run: `npx vitest run scripts/__tests__/mined-prefix-sanity.test.mjs` -> PASS. If a known brand FAILS, the derivation/merge is wrong - fix Task 1/2 before continuing.
- [ ] **Step 3: Run the safety suites.** Run: `npx vitest run src/services/ai/decode src/services/ai/decodeCorroboration src/eval src/services/tire`. Expected: PASS, false-auto-count invariant green. If a weak-tier example test now fails because its prefix became strong, repoint it to a still-weak prefix (precedent in `decodeCorroboration.test.ts`: Nexen -> Nokian).
- [ ] **Step 4: Confirm no-cheating.** Run: `npx grep -r "tire_corpus_flat\|tire-knowledge/" src/` (or Grep tool). Expected: NO match under `src/app`, `src/services`, `src/stores` (the decoder). The corpus is referenced only by `scripts/`. Record the result.
- [ ] **Step 5: Commit (ask owner).** `git add scripts/__tests__/mined-prefix-sanity.test.mjs src/services/ai/decodeCorroboration.test.ts && git commit -m "test(prefix): functional sanity for mined prefixes + safety green"`

### Task 5: Live validation on unknown tires (Gemini Flash)

**Files:** Create: `scripts/validate-prefix-decode.mjs`

**Interfaces:**
- Produces: `reports/product-intel/<date>/prefix-decode-validation.json` + a short console summary. Run with the dev server up (`npm run dev -- -p 3200`).

- [ ] **Step 1: Implement the harness.** Pick a sample (default 50) of barcodes that are NOT used as table examples (read distinct barcodes from `tire_corpus_flat.csv`, take a deterministic slice, e.g. every Nth row). For each: POST `/api/ai-lookup` `{ mode:"decode-deep", scanContext:"tire", rawCode, cleanCode, codeType, confidenceThreshold:0.85, allowImageSuggestions:true }` (the decoder uses only the prefix table + Gemini Flash; the corpus is never consulted). Tally: verified / suggested / needs_review, brand-correct rate, latency p50/p95, est cost. Write the JSON + print the summary.
- [ ] **Step 2: Run it (live, mini models).** Start `npm run dev -- -p 3200`; then `node scripts/validate-prefix-decode.mjs --count=50`. Expected: verify rate MATERIALLY above the 30% baseline (the table is now ~4x larger), p50 latency low seconds, false-auto-count 0, est cost within ~$0.50.
- [ ] **Step 3: Commit (ask owner).** `git add scripts/validate-prefix-decode.mjs && git commit -m "feat(prefix): live validation harness for prefix+AI decode"`

---

## Self-Review (done at write time)

**Spec coverage:** Mine offline ($0) -> Tasks 1-2. Separate ADDITIONS file, FINAL untouched -> Task 2 (+ verify in Step 2). Generator merge -> Task 3. Cross-confirmed >=2 -> Task 1 (`minConfirm`). Conflict guard -> Task 2. Sanity (mined matches known) -> Task 4 (functional, via the lookup - handles the leading-zero convention). Safety/false-count 0 -> Task 4. No-cheating (decoder never reads corpus) -> Global Constraints + Task 4 Step 4. Validation on unknowns with Gemini Flash -> Task 5. Budget -> $0 miner + Task 5 cost tally. All spec sections map to a task.

**Placeholder scan:** Task 1 has complete code; Tasks 2/5 specify exact CSV columns, the conflict-guard threshold (6 brands), the request body, and the metrics. No "TBD"/"handle edge cases". The CSV line parser in Task 2 is "the same comma+quote parser as genTirePrefixHints.mjs" - reuse it.

**Type consistency:** `deriveBrandPrefixes(barcodes, opts) -> [{prefix,count,examples}]` used identically in Tasks 1 and 2. `normalizeToGtin13` reused in Tasks 1, 2, 5. The sanity test uses `isBrandInPrefixFamily(code, brand, {strongOnly}) -> boolean` exactly as `tirePrefixLookup.ts` exports it.

## Open risks
1. Leading-zero prefix convention (UPC-form vs GTIN-13-form): handled by validating FUNCTIONALLY through the lookup's dual-alignment (Task 4), not by exact-string match.
2. A real corporate family larger than the 6-brand conflict-guard threshold would be skipped: acceptable (safety over coverage); the report lists skipped entries for manual add.
3. The validation sample uses corpus barcodes (the decoder still can't see the corpus, so they are "unknown" to it): for a stricter test, swap in barcodes not present in the corpus.
