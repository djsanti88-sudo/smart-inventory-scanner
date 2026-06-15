# Resolver Audit - Product Identity Accuracy Hotfix

## Symptom
Scanned codes were mapped to WRONG products and saved as trusted aliases:
- `855724007602` -> "Laird Superfood Creamer"
- `078742051451` -> "Leviton 5145-W receptacle"
- `X004DY7YUT` (Amazon FNSKU) -> generic "Amazon FBA Label" product

## Root cause
An **AI auto-accept** feature (added after V1) trusted AI guesses as verified identity.

Flow that caused it:
1. `processScan` auto-fired `lookupUnknown` for every unknown code when AI was enabled.
2. The real Gemini provider returns a *plausible guess* for an arbitrary code with HIGH confidence
   (0.95-0.98) and `needsHumanReview: false`. For an unseen UPC it hallucinates a product name.
3. `lookupUnknown` had an **auto-accept** branch: when `confidence >= 0.85 && !needsHumanReview`,
   it called `resolveUnknown(..., "create_new", { applyToCount: true })`, which:
   - created a NEW product from the AI guess,
   - saved a **deterministic alias** for the scanned code,
   - counted it as Known.
4. That poisoned product + alias was persisted to `localStorage` (`sis-scan-v1`) and the mock DB
   (`sis-mockdb-v1`), so every later scan of that code kept resolving to the wrong product.

The core trust-boundary violation: **AI suggestions were promoted to verified/Known identity and
persisted as deterministic aliases with no human approval.** There was no `verified`/`approved`
flag distinguishing trusted local data (seed, human-approved) from AI guesses.

Note: the bad product names were NEVER in source code or seed data. They were generated at runtime
by the AI and written into the user's browser storage. So the fix is (a) remove the auto-save path,
(b) add an explicit trust gate, and (c) purge/migrate the poisoned persisted data.

## Fix summary
1. **Removed AI auto-accept and the auto-fire of AI on scan.** AI now only ever produces a
   *Suggested* result attached to a Needs Review item. It never creates products, aliases, or counts.
2. **Added an explicit trust gate.** `Product.verified` and `Alias.approved` flags. The deterministic
   resolver returns `known` ONLY when matching an `approved` alias or a `verified` product identifier.
   Seed data is verified/approved; human resolutions set these true. AI-written data does not exist.
3. **Strict resolver statuses** with a human-readable `reason`: `known | needs_review | conflict`
   (deterministic), plus `suggested` (AI, review-only) and `resolved` (human-approved).
4. **Vendor/Amazon label detection** (`X00...`, `B0...` 10-char codes). These are never treated as
   UPC/EAN/GTIN and route to Needs Review unless a human-approved alias already exists.
5. **Cache purge:** persist bumped to version 3 with a migrate that drops all non-seed (learned)
   products/aliases and clears session data, plus a "Clear local cache" UI action with confirmation.

## Non-negotiables enforced (with tests)
- AI suggestion never becomes Known/alias automatically.
- Mock/AI result never marks a real unknown scan as Known.
- Unknown + vendor labels go to Needs Review.
- Human approval required before an alias is saved; approved aliases then count deterministically.
- Verified manual/seed data can count immediately.
- Poisoned localStorage is clearable/migratable.
- No paid APIs, no deploy, no real business systems, no keys in client code.
