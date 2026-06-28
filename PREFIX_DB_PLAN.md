# Comprehensive GS1 Prefix Database - Plan (all-products, derived from the 4M+ cloud catalog)

> Goal: generalize the tire-only prefix lookup to EVERY product category, so a scan that misses the
> catalog can instantly know "what company / brand owns this barcode" (and its country) with NO AI call.
> Status: PLAN ONLY. Nothing built. Author: Claude Code, 2026-06-28.

## 1. What it is
A **GS1 company-prefix -> brand/company index**, derived from the 4M+ rows we already hold (Open Food
Facts retail + the 76k tire corpus). For a barcode, the GS1 *company prefix* identifies the **brand
owner**; the leading digits identify the **country** of the numbering authority.

```
barcode 051596320812
   │
   ├─ leading digits ─► COUNTRY (GS1 numbering authority)   [we already derive this: gs1Prefixes.ts]
   └─ company prefix  ─► BRAND / COMPANY owner               [NEW: this index]
```

It is **grounding/recall + a sanity check**, never identity truth:
- feeds the AI prompt as a non-authoritative brand hint (like tire `anchorBrand`),
- powers a category-agnostic brand-prefix CONFLICT check (generalize `brandPrefixGeneral.ts`),
- **never auto-counts on the prefix alone** (a prefix is the brand owner, not the exact product).

## 2. Where it is stored
Two-tier (mirrors how `tirePrefixLookup` already works - an in-memory table):

| Tier | What | Where | Why |
|---|---|---|---|
| A (hot) | Compact derived index: strong single-brand prefixes only | `data/prefix-knowledge/gs1_prefix_index.json` (a few MB), loaded into memory server-side at cold start | Instant, free, no per-scan DB read. The 4M ROWS collapse to ~tens of thousands of distinct prefixes, so the index is small. |
| B (optional) | Full / long-tail + ambiguous prefixes, updatable | Firestore `gs1PrefixIndex` collection (public-read, server-write, same model as `catalogEntries`) | Lets us grow/refresh without a redeploy. |

Note: `.vercelignore` excludes the 3.4GB raw `data/` harvest, but the **derived index is small** - the
one small `gs1_prefix_index.json` is un-ignored and bundled (or read once from Firestore at cold start).

## 3. How it gets built (offline, never on Vercel)
A streaming derivation script (same pattern as `import-retail-to-catalog.ts` / `process_off.py`):

```
4M+ jsonl/Firestore rows ─► [stream] ─► for each row: extract company prefix + brand + category
   ─► aggregate: prefix -> { topBrand, brandCounts, categoryDist, rowCount }
   ─► score: confidence = dominance of the top brand (single-brand vs shared/ambiguous)
   ─► emit: gs1_prefix_index.json  (strong prefixes)  + optional Firestore upload (full)
```
- **Streaming aggregation** (incremental Map), never loads 4M into memory.
- **Confidence/ambiguity scoring**: only "strong single-brand" prefixes become trusted anchors;
  shared prefixes (retailers, private label, long-tail) are kept low-confidence -> no anchor, fall to AI.
- Regenerate when the catalog grows (a documented `npm run build:prefix-index`).

## 4. How the program uses it (runtime, category-agnostic)
Slots into the decode "LOCAL FIRST" step (the architecture box "GS1 PREFIX IDENTITY"):
```
lookupGs1Prefix(code) -> { brand, category, confidence, country } | null
  • strong single-brand  -> anchorBrand (instant) + prompt hint + brand-conflict sanity (ALL categories)
  • ambiguous/none       -> country only; no anchor; normal AI path
```
Trust model identical to tires: prefix is a HINT + a CONFLICT gate, never an auto-count.

## 5. Phases
| # | Phase | Output |
|---|---|---|
| P1 | GS1 company-prefix extraction (variable length) + tests | `gs1CompanyPrefix.ts` |
| P2 | Offline streaming derivation + confidence scoring | `scripts/build-prefix-index.ts`, `gs1_prefix_index.json` |
| P3 | Runtime loader (in-memory, server-only) + `lookupGs1Prefix` + generalize `brandPrefixGeneral` | service + tests |
| P4 | Wire into decode local-first (anchor + hint + conflict), all categories | route + tests |
| P5 | Storage finalize (bundled file vs Firestore `gs1PrefixIndex`) + refresh runbook | docs |

## 6. Risks
- **Variable GS1 prefix length** (6-10+ digits): naive fixed-length grouping is approximate. Mitigation:
  confidence scoring; trust only strong single-brand prefixes.
- **Prefix = brand owner, not seller**: private-label / retailer prefixes are noisy -> low confidence.
- **Trust**: never auto-count on a prefix; hint + conflict gate only (same as tires).
- **Build cost**: derivation is offline/local ($0 of AI); only reads our own data.

## 7. Anti-hallucination firewall (NEW - evidence-weighted, NOT absolute)
The prefix DB is also a **hallucination guard**, not just recall. Origin: Gemini decoded `051596320812`
as a Hampton Bay AL383LED-BN ceiling fan; its real UPC is `792145369783` (prefix `792145` = King of
Fans). The scanned prefix `051596` = United Solutions (buckets) - a deterministic tell the AI was wrong.

**CRITICAL WORDING (corrected):** a prefix-owner mismatch is a **STRONG CONFLICT SIGNAL, not final
proof.** Never "a product can NEVER have this prefix." Rule: a mismatch **lowers confidence, blocks
auto-verify, and forces Needs Review UNLESS official exact-code evidence (Level 1/2) overrides it.**

Why not absolute (the firewall must not create NEW false rejects):
- **GS1 company prefix = brand OWNER / GS1 member, not the factory.** Compare prefix -> *manufacturer*.
- **Private label is legitimate and expected:** this very bucket is retail-brand "The Home Depot" on a
  United Solutions prefix. A brand-name difference ALONE (Home Depot != United Solutions) is NOT a
  conflict. Conflict requires manufacturer + category + known-UPC mismatch (like the fan).
- **Reused/leased/reassigned prefixes, conglomerates, stale 3rd-party data** all break "NEVER".
- **Our prefix map is catalog-DERIVED (product-level), not an official GS1 record** - so weight the veto
  by the prefix's own confidence (single-owner dominance = strong veto; shared/ambiguous = weak veto).

### Guard A - prefix-to-candidate conflict
Inputs: scanned code, prefix-owner candidate (from prefix DB + its confidence), AI product +
brand/manufacturer/OEM/category, evidence.
Behavior: if the prefix owner conflicts with the candidate's **manufacturer/category** (not merely the
retail brand) -> set `prefixBrandConflict` -> NOT auto-count, NOT verified, force Needs Review unless
exact-code Level 1/2 evidence shows the scanned code AND the exact product together. Log reason
platformOwner-only; customers see safe product-facing status.

### Guard B - reverse known-UPC
Inputs: scanned code, AI proposed product/model, evidence.
Behavior: determine the candidate's known UPC **set** (products have many legit UPCs - pack/region/OEM
variants). If that set is well-established and **excludes** the scanned code -> set
`reverseKnownUpcConflict` -> NOT auto-count, NOT verified, Needs Review unless exact-code Level 1/2
overrides. Note: discovering the candidate's UPC set costs an extra lookup - gate it (strong candidate
only) and respect the 8s / cost budget.

### Evidence levels (override hierarchy; maps to our `evidenceStrength` + `decideDecode`)
1. official exact-code source  2. strong 3rd-party exact-code  3. weak exact-code snippet/OCR/social
4. official product-family corroboration WITHOUT the exact UPC  5. prefix-only / check-digit-only.
Auto-verify needs Level 1 (or strong Level 2). A prefix hint may ENRICH an Unknown but must NEVER, by
itself, create a verified identity.

### Worked target behavior for `051596320812`
valid UPC-A; NOT the fan (blocked: known UPC 792145369783 + prefix mismatch); likely candidate "The
Home Depot 5 Gal Orange Homer Bucket / 05GLHD2"; grade = weak-exact + official family; status = Needs
Review / reviewable suggestion; confidence ~0.75; never verified, never auto-count; platformOwner sees
raw code + prefix hint + evidence + conflict logs; customers cannot export raw code/alias/evidence.

**Strongest version = prefix DB + exact-code evidence + reverse-UPC + confidence gate** (catches
Gemini-style hallucinations without new false rejections).
