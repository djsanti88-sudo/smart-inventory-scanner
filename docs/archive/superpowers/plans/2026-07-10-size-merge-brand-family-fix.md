# Size-Aware Identity Merge + Michelin Brand Family Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop database/ladder-verified scans from landing in Needs Review: (1) same-model-DIFFERENT-SIZE tires must mint distinct products instead of collapsing into a fuzzy "link to existing product?" suggestion; (2) Michelin-family brands (BFGoodrich/Uniroyal) on a shared GS1 prefix must not fire the prefix firewall.

**Proven defect (2026-07-10 Playwright run, 100 owner codes on preview `inventory-8lnprljm7`):** server verified 99/100 (84 corpus + 15 ladder), yet the UI produced only 40 "Verified match"; 59 corpus-verified scans showed "Unidentified item"/Suggested and went to Review (each model verified once, every additional size collapsed), plus 1 false `goupc_prefix_conflict`: Go-UPC said "Michelin" for `086699998538`, prefix owner is "bfgoodrich" — same company (Michelin North America owns BFGoodrich).

**Architecture:** Two isolated, pure-service fixes + one store call-site change. `findIdentityMerge` (src/services/catalog/identityMerge.ts) gains size awareness through the existing `specsShort`/`specsFull` product fields (sizes are NOT in product names — corpus names are slugs like `wrangler_steadfast_ht`, which is why the existing name-parse tire rule never fires). `brandFamilies.ts` gains the Michelin group (+ other evidence-backed corporate families). scanStore passes the decoded product's specs into the merge.

**Tech Stack:** TypeScript, Vitest (node project for services, jsdom for stores), Playwright proof, Vercel preview deploy.

## Global Constraints

- No React/next imports in src/services (services stay pure).
- Wrong product identity is FAILURE; Unknown is ACCEPTABLE — never weaken a real-conflict path.
- Automated tests NEVER call live providers.
- No em/en dashes in user-facing copy.
- Do not commit secrets. Do not push or deploy to PRODUCTION (preview deploy IS authorized by owner for this task).
- Follow existing test patterns in the file being extended.
- Branch: `feat/decode-ladder-goupc` (work directly on it).

---

### Task 1: Michelin (and other evidenced) brand families

**Files:**
- Modify: `src/services/catalog/brandFamilies.ts:14-27` (the `FAMILIES` table only)
- Test: `src/services/catalog/brandFamilies.test.ts` (extend existing)
- Test: `src/server/upc/GoUpcProvider.test.ts` (extend existing — integration through `evaluatePrefix`)

**Interfaces:**
- Consumes: existing `sameBrandFamily(a: string, b: string): boolean` — unchanged signature.
- Produces: `sameBrandFamily("Michelin", "bfgoodrich") === true` (and the other new pairs). Task 4's UI proof relies on `evaluatePrefix("086699998538", "Michelin", ...)` returning `{ conflict: false }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/services/catalog/brandFamilies.test.ts` (match the file's existing describe/it style):

```typescript
describe("michelin family (086699998538 false-conflict class)", () => {
  it("treats Michelin and BFGoodrich as the same company", () => {
    expect(sameBrandFamily("Michelin", "bfgoodrich")).toBe(true);
    expect(sameBrandFamily("BFGoodrich Tires", "michelin")).toBe(true);
  });
  it("treats Michelin and Uniroyal as the same company", () => {
    expect(sameBrandFamily("Uniroyal", "Michelin")).toBe(true);
  });
  it("does NOT relate Michelin to Goodyear or Bridgestone", () => {
    expect(sameBrandFamily("Michelin", "Goodyear")).toBe(false);
    expect(sameBrandFamily("bfgoodrich", "Bridgestone")).toBe(false);
  });
});

describe("other evidenced corporate families", () => {
  it("Continental owns General Tire", () => {
    expect(sameBrandFamily("General", "Continental")).toBe(true);
  });
  it("Goodyear owns Cooper (2021) and Cooper's house brands", () => {
    expect(sameBrandFamily("Cooper", "Goodyear")).toBe(true);
    expect(sameBrandFamily("Mastercraft", "goodyear")).toBe(true);
  });
  it("Toyo owns Nitto", () => {
    expect(sameBrandFamily("Nitto", "Toyo")).toBe(true);
  });
  it("unrelated pairs still never match", () => {
    expect(sameBrandFamily("Cooper", "Michelin")).toBe(false);
    expect(sameBrandFamily("Nitto", "Hankook")).toBe(false);
  });
});
```

Append to `src/server/upc/GoUpcProvider.test.ts` (find the existing `evaluatePrefix` describe block and add):

```typescript
it("does not conflict when Go-UPC brand is a corporate sibling of the prefix owner (Michelin on bfgoodrich prefix)", () => {
  const v = evaluatePrefix("086699998538", "Michelin", { prefixLookup: () => "bfgoodrich" });
  expect(v.owner).toBe("bfgoodrich");
  expect(v.conflict).toBe(false);
});

it("still conflicts when the brand is NOT in the owner's family", () => {
  const v = evaluatePrefix("086699998538", "Goodyear", { prefixLookup: () => "bfgoodrich" });
  expect(v.conflict).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/services/catalog/brandFamilies.test.ts src/server/upc/GoUpcProvider.test.ts`
Expected: the new michelin/continental/cooper/nitto assertions FAIL (`sameBrandFamily` returns false); all pre-existing tests still pass.

- [ ] **Step 3: Add the families**

In `src/services/catalog/brandFamilies.ts`, extend the `FAMILIES` array (keep the existing four groups untouched, append after `["argus", "advanta"]`):

```typescript
  // Michelin North America owns BFGoodrich (acquired via Uniroyal Goodrich, 1990) and the Uniroyal
  // tire brand in North America. GS1 prefix 086699 carries Michelin, BFGoodrich and Uniroyal product
  // (live false-conflict: Go-UPC "Michelin" vs prefix owner "bfgoodrich" on 086699998538, 2026-07-10).
  ["michelin", "bfgoodrich", "uniroyal"],
  // Continental AG owns General Tire (acquired 1987, marketed as "General" in North America).
  ["continental", "general"],
  // Goodyear acquired Cooper Tire & Rubber in 2021, which brings Cooper's house brands
  // Mastercraft, Roadmaster and Mickey Thompson under the same parent. NOTE: kept as a SEPARATE
  // group from the existing ["goodyear", "kelly", "dunlop"] line would split the family, so instead
  // Cooper's brands are MERGED into that existing group (see below).
  // Toyo Tire Corporation owns Nitto (Nitto Tire is Toyo's subsidiary brand).
  ["toyo", "nitto"],
  // Sumitomo Rubber Industries owns Falken and Ohtsu.
  ["sumitomo", "falken", "ohtsu"],
  // Hankook owns Laufenn (its value line).
  ["hankook", "laufenn"],
```

AND replace the existing goodyear line so Cooper's brands share one family (a brand may appear in only ONE group — the `BRAND_TO_FAMILY` map keeps the last write, so a split family would silently break):

```typescript
  // Goodyear owns Kelly (Kelly-Springfield subsidiary), the Dunlop tire trademark for North America,
  // and since 2021 Cooper Tire & Rubber including Cooper's house brands Mastercraft, Roadmaster and
  // Mickey Thompson.
  ["goodyear", "kelly", "dunlop", "cooper", "mastercraft", "roadmaster", "mickey thompson"],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/catalog/brandFamilies.test.ts src/server/upc/GoUpcProvider.test.ts`
Expected: ALL PASS.

CAUTION check while here: `029142` prefixes are Cooper-owned (the 12 test codes `029142*` are Cooper models like trendsetter_se). Merging cooper into the goodyear family must not create a new false NEGATIVE for real conflicts — verify the two "still conflicts" style tests in both files pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/services/catalog/brandFamilies.ts src/services/catalog/brandFamilies.test.ts src/server/upc/GoUpcProvider.test.ts
git commit -m "fix(prefix-firewall): Michelin/BFGoodrich/Uniroyal + other evidenced corporate families end the 086699 false conflict"
```

---

### Task 2: Size-aware identity merge (service)

**Files:**
- Modify: `src/services/catalog/identityMerge.ts`
- Test: `src/services/catalog/identityMerge.test.ts` (extend existing)

**Interfaces:**
- Consumes: `tireSizeToken(r: { productName?: string; brand?: string } | null | undefined): string` from `@/services/ai/tireSpecs` (already imported; returns canonical size like "245/70R16" or "").
- Produces (Task 3 relies on these exact shapes): `IdentityCandidate` and `DecodedIdentity` both gain optional `specsShort?: string | null; specsFull?: string | null`. `findIdentityMerge` behavior change: in the FUZZY branch only, when BOTH sides have a derivable tire size and the sizes DIFFER, that candidate is skipped (different size = different product, no suggestion). GTIN-equality behavior is unchanged (size disagreement there still downgrades to suggest_link — a GTIN anomaly is genuinely reviewable).

- [ ] **Step 1: Write the failing tests**

Append to `src/services/catalog/identityMerge.test.ts`:

```typescript
describe("size-aware fuzzy merge (2026-07-10 same-model-different-size collapse)", () => {
  // Corpus products have SLUG names with no size; the size lives in specsShort ("245/70R16 107T").
  const existingSteadfast = {
    id: "p1",
    brand: "goodyear",
    name: "wrangler_steadfast_ht",
    specsShort: "265/45R20 105V",
    specsFull: "265/45R20 105V SL BSW",
  };

  it("same brand + identical slug name but DIFFERENT size -> none (mint a new product, no suggestion)", () => {
    const r = findIdentityMerge([existingSteadfast], {
      brand: "goodyear",
      name: "wrangler_steadfast_ht",
      specsShort: "255/55R20 110V",
    });
    expect(r.kind).toBe("none");
  });

  it("same brand + identical slug name and SAME size -> still suggest_link (possible real duplicate)", () => {
    const r = findIdentityMerge([existingSteadfast], {
      brand: "goodyear",
      name: "wrangler_steadfast_ht",
      specsShort: "265/45R20 105V",
    });
    expect(r).toEqual({ kind: "suggest_link", productId: "p1" });
  });

  it("size known on only ONE side -> unchanged: suggest_link (cannot prove distinct)", () => {
    const r = findIdentityMerge([existingSteadfast], {
      brand: "goodyear",
      name: "wrangler_steadfast_ht",
    });
    expect(r).toEqual({ kind: "suggest_link", productId: "p1" });
  });

  it("GTIN equality with size disagreement is unchanged: suggest_link, never auto", () => {
    const r = findIdentityMerge(
      [{ ...existingSteadfast, gtin: "0697662155102" }],
      { gtin: "697662155102", brand: "goodyear", name: "wrangler_steadfast_ht", specsShort: "255/55R20 110V" },
    );
    expect(r).toEqual({ kind: "suggest_link", productId: "p1" });
  });

  it("size in specsFull (not specsShort) also counts", () => {
    const r = findIdentityMerge(
      [{ id: "p2", brand: "michelin", name: "pilot_mxm4", specsFull: "P245/45R19 98V" }],
      { brand: "michelin", name: "pilot_mxm4", specsFull: "P235/45R18 94V" },
    );
    expect(r.kind).toBe("none");
  });

  it("size embedded in the NAME still works (pre-existing behavior preserved)", () => {
    const r = findIdentityMerge(
      [{ id: "p3", brand: "goodyear", name: "Eagle Touring 225/55R19 99V" }],
      { brand: "goodyear", name: "Eagle Touring 245/45R20 103V" },
    );
    expect(r.kind).toBe("none");
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/services/catalog/identityMerge.test.ts`
Expected: the "-> none" cases FAIL (they currently return suggest_link); the two "unchanged" cases PASS.

- [ ] **Step 3: Implement**

In `src/services/catalog/identityMerge.ts`:

(a) Extend both interfaces (after the existing fields):

```typescript
export interface IdentityCandidate {
  id: string;
  gtin?: string | null;
  upc?: string | null;
  ean?: string | null;
  primaryBarcode?: string | null;
  brand?: string | null;
  name?: string | null;
  productName?: string | null;
  /** Size usually lives here, NOT in the name (corpus names are slugs like "wrangler_steadfast_ht"). */
  specsShort?: string | null;
  specsFull?: string | null;
}

export interface DecodedIdentity {
  gtin?: string | null;
  upc?: string | null;
  ean?: string | null;
  brand?: string | null;
  name?: string | null;
  productName?: string | null;
  specsShort?: string | null;
  specsFull?: string | null;
}
```

(b) Add a size helper next to `nameOf` that searches name AND specs:

```typescript
/** Canonical tire size for a candidate, parsed from its name AND its specs fields (corpus product
 *  names are slugs with no size - the size lives in specsShort/specsFull). "" when none found. */
function sizeOf(c: (IdentityCandidate | DecodedIdentity) & { specsShort?: string | null; specsFull?: string | null }): string {
  const text = [nameOf(c), c.specsShort ?? "", c.specsFull ?? ""].join(" ");
  return tireSizeToken({ productName: text, brand: c.brand ?? undefined });
}
```

(c) In `findIdentityMerge`, replace the two `tireSizeToken(...)` call sites with `sizeOf(...)`:

```typescript
  const decodedTireSize = sizeOf(decoded);
```
and inside the loop:
```typescript
    const existingTireSize = sizeOf(p);
```

(d) In the FUZZY branch (currently `if (sim >= 0.75 || plusDiff)`), skip candidates whose size provably differs:

```typescript
    // 2) Fuzzy: same normalized brand + name Jaccard >= 0.75 -> suggest_link (never auto).
    if (decodedBrand && normBrand(p.brand) === decodedBrand) {
      // SIZE-DISTINCT rule (2026-07-10): when BOTH sides carry a derivable tire size and the sizes
      // DIFFER, they are DIFFERENT countable products (same model, another size) - do not suggest a
      // link at all. Without this, a same-brand burst collapses every additional size of a model into
      // Needs Review ("Unidentified item"), which is exactly the 59/100 defect proven on the preview.
      if (bothHaveTireSize && !tireSizeAgrees) continue;
      const existingTokens = nameTokens(nameOf(p));
      const sim = jaccard(decodedTokens, existingTokens);
      const plusDiff = plusGenerationDiff(decodedTokens, existingTokens);
      if (sim >= 0.75 || plusDiff) {
        suggestion ??= { kind: "suggest_link", productId: p.id };
      }
    }
```

(e) Update the file-top doc comment's TIRE rule line to state the new fuzzy behavior:

```
//   TIRE rule  when BOTH sides carry a parseable tire size (from name OR specsShort/specsFull),
//              auto_link ADDITIONALLY requires size equality; on the GTIN path a size disagreement
//              downgrades to suggest_link (GTIN anomaly), and on the FUZZY path a size disagreement
//              means DIFFERENT products: no suggestion at all (same model, another size).
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/catalog/identityMerge.test.ts`
Expected: ALL PASS (new + all pre-existing cases in the file).

- [ ] **Step 5: Commit**

```bash
git add src/services/catalog/identityMerge.ts src/services/catalog/identityMerge.test.ts
git commit -m "fix(identity-merge): derive tire size from specs fields; size-distinct fuzzy matches mint new products instead of Needs Review suggestions"
```

---

### Task 3: scanStore passes specs into the merge + burst regression test

**Files:**
- Modify: `src/stores/scanStore.ts:2938-2944` (the `findIdentityMerge` call inside `resolveUnknown`)
- Test: `src/stores/identityMerge.store.test.ts` (extend existing)

**Interfaces:**
- Consumes: Task 2's extended `DecodedIdentity` (accepts `specsShort`/`specsFull`). The merge-candidate side needs NO change: `state.products` items already carry `specsShort`/`specsFull` (src/types.ts:90-91) and satisfy `IdentityCandidate` structurally.
- Produces: resolveUnknown with a same-model-different-size decoded product creates a NEW product and resolves the review (no `suggestedLinkProductId`, no open review).

- [ ] **Step 1: Write the failing store test**

Append to `src/stores/identityMerge.store.test.ts`, following that file's existing setup helpers (store reset, how it seeds products, and how it invokes `resolveUnknown` with a `newProduct` payload — reuse the file's own patterns; the assertion content below is what matters):

```typescript
it("same-model-different-size verified decode mints a NEW product instead of a suggest_link review (2026-07-10 burst defect)", () => {
  // Seed an existing counted product: slug name, size only in specsShort (the corpus shape).
  // ...use this file's existing helper to add a product + count with:
  //   name: "wrangler_steadfast_ht", brand: "goodyear", specsShort: "265/45R20 105V"
  // Then resolve an unknown for a DIFFERENT size of the same model:
  //   newProduct: { name: "wrangler_steadfast_ht", brand: "goodyear", specsShort: "255/55R20 110V", ... }
  // Assertions:
  const st = useScanStore.getState();
  const steadfasts = st.products.filter((p) => p.name === "wrangler_steadfast_ht");
  expect(steadfasts.length).toBe(2); // two sizes = two products
  const review = st.needsReviewQueue.find((r) => r.cleanCode === SCANNED_CODE);
  expect(review?.status).toBe("resolved"); // not left open with a link suggestion
  expect(review?.suggestedLinkProductId).toBeUndefined();
});

it("same-model SAME-size still becomes a suggest_link review (dedup protection intact)", () => {
  // Same seed, but resolve with specsShort: "265/45R20 105V" (identical size).
  // Assert: review stays open with suggestedLinkProductId set to the seeded product id,
  // and NO second product named "wrangler_steadfast_ht" exists.
});
```

- [ ] **Step 2: Run to verify the first test fails**

Run: `npx vitest run src/stores/identityMerge.store.test.ts`
Expected: FAIL — currently 1 product + an open review with `suggestedLinkProductId` (the suggest_link no-op path). The SAME-size test should already pass.

- [ ] **Step 3: Pass specs at the call site**

In `src/stores/scanStore.ts` (~line 2938), extend the decoded-identity argument:

```typescript
            const merge = findIdentityMerge(mergeCandidates, {
              gtin: np.gtin ?? null,
              upc: np.upc ?? null,
              ean: np.ean ?? null,
              brand: np.brand ?? null,
              name: np.name ?? null,
              specsShort: np.specsShort ?? null,
              specsFull: np.specsFull ?? null,
            });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/stores/identityMerge.store.test.ts src/stores/verifiedNameBurst.store.test.ts`
Expected: ALL PASS (verifiedNameBurst is the f40ff8e regression suite — it must stay green; its scans have no distinct specs so its suggest_link expectations are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/stores/scanStore.ts src/stores/identityMerge.store.test.ts
git commit -m "fix(scan-store): pass decoded specs into identity merge so distinct tire sizes count instead of queueing for review"
```

---

### Task 4: Full gates

**Files:** none new (verification only).

- [ ] **Step 1: Full unit suite** — Run: `npm run test` — Expected: 0 failures (baseline was 1690 pass; `cloudDrainRace.store.test.ts` is known timing-flaky under full parallel load — if it is the ONLY failure, rerun it isolated and accept green).
- [ ] **Step 2: Types** — Run: `npx tsc --noEmit` — Expected: clean.
- [ ] **Step 3: Lint changed files** — Run: `npx eslint src/services/catalog/brandFamilies.ts src/services/catalog/identityMerge.ts src/stores/scanStore.ts src/services/catalog/identityMerge.test.ts src/services/catalog/brandFamilies.test.ts src/server/upc/GoUpcProvider.test.ts src/stores/identityMerge.store.test.ts` — Expected: 0 errors.
- [ ] **Step 4: Build** — Run: `npm run build` — Expected: success.
- [ ] **Step 5: E2E** — Run: `npm run test:e2e` — Expected: 31/31 (or baseline count) pass.
- [ ] **Step 6: Commit anything the gates required** (only if fixes were needed).

---

### Task 5: Preview deploy (owner-authorized) + 100-code Playwright proof

**Files:**
- Reuse: `scripts/dt-harvest/state/ui-100-video.mjs` (already exists; takes the preview URL via env/arg inside the script — update its BASE constant or parameterize via `process.argv[2]` if it is hard-coded)

- [ ] **Step 1: Deploy a NEW preview** — Run: `npx vercel deploy` (NOT `--prod`) from the repo root; capture the printed preview URL. Expected: build succeeds on Vercel; URL like `https://inventory-<hash>-sharpenly.vercel.app`. Write it to `scripts/dt-harvest/state/preview-url.txt`.
- [ ] **Step 2: API smoke** — POST `{"rawCode":"697662155102","cleanCode":"697662155102","mode":"decode","scanContext":"tire"}` to `<preview>/api/ai-lookup`; expect HTTP 200, corpus path, verified. Then the false-conflict code: POST `086699998538`; expect decision status "verified" and path `goupc_exact` (served from decode cache, aiCalled may be true; NO fresh spend expected — if the response indicates a live paid call was about to happen repeatedly, stop and report instead of hammering).
- [ ] **Step 3: Full UI re-run with video** — Run `ui-100-video.mjs` against the NEW preview URL (fresh context, localStorage+sessionStorage cleared, 650ms pacing, video on).
- [ ] **Step 4: Acceptance** — From the results JSON: 100 feed rows; "Verified match" >= 99; ZERO rows whose product starts "Unidentified item" while the reason says "trusted tire knowledge base"; Review badge <= 1 (expect 0: `086699998538` should now verify); zero 429s; zero console errors. Save video + results JSON paths.
- [ ] **Step 5: Report** — Owner report: new preview URL, before/after table (40->N verified, 60->M review), video, spend note (expect $0 fresh: corpus + decode cache), git status (commits on `feat/decode-ladder-goupc`, NOT pushed).

---

## Self-Review Notes

- Spec coverage: defect 1 (size collapse) = Tasks 2+3; defect 2 (Michelin family) = Task 1; Playwright re-test + new preview = Task 5. Owner rule "if in database it must not go to needs review" is satisfied for the proven class (distinct sizes); a same-size same-model DIFFERENT barcode still suggests a link, which is genuine dedup protection and NOT part of the proven defect.
- Type consistency: `specsShort`/`specsFull` optional on both merge interfaces; Product (src/types.ts:90-91) already has them as required strings — structurally compatible.
- The `bothHaveTireSize && !tireSizeAgrees` continue happens BEFORE Jaccard so a size-distinct candidate can never become the `suggestion` fallback, but AFTER the GTIN branch so GTIN anomalies keep their existing suggest_link semantics.
- brandFamilies merge caution: a brand must appear in exactly ONE family group (BRAND_TO_FAMILY last-write-wins) — that is why cooper joins the existing goodyear group instead of a second group.
