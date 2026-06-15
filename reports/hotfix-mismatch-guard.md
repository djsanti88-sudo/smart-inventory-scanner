# Hotfix — Human-mistake warning guard

## Problem
A Falken tire part number was accidentally linked to "Camel Crush Menthol Silver Cigarettes." The system
must not silently allow a code that looks like one product to be linked to a clearly different one; it must
warn, let the owner override explicitly (audited), and block non-owners from overriding.

## What was built
- **`src/services/productMismatchGuard.ts`** (pure): infers a coarse product domain (tire / tobacco /
  beverage / food / supplement / battery / auto_part / tool) from the code's suggested identity and the
  target product, and returns `safe | warn | high_risk` with a human message. Cross-domain links
  (tire → tobacco) are `high_risk`; clearly different brand → `warn`; shared brand/category/domain → `safe`.
- **Store enforcement** (`scanStore.resolveUnknown`): a `link_existing` flagged `high_risk` is **BLOCKED**
  (no alias created) and raises `lastMismatchWarning`; it proceeds only when called again with
  `confirmedMismatch: true`. Audited: `alias_link_warning_shown`, `alias_link_override`.
  Also `evaluateLinkMismatch()` (preview) and `clearMismatchWarning()`.
- **UI** (`NeedsReviewTable`): a red "Possible wrong product" banner with **Link anyway** (override) / **Cancel**.

## Proof (automated)
- `src/services/productMismatchGuard.test.ts` (6) — tire→Camel = high_risk; same tire = safe; brand
  mismatch = warn; no suggestion = safe.
- `src/stores/mismatchGuard.store.test.ts` (3) — the tire→cigarette link is blocked (no alias created);
  `evaluateLinkMismatch` reports high_risk; override links + clears the warning.

## How to verify in the app
On the Needs Review page, try to **Link** a code whose suggested identity is a tire to a cigarette product
→ a red warning appears and the link does not happen until you press **Link anyway**.

## Notes / limitations
- The guard is strongest when a lookup suggestion exists for the code (AI/web identity). With AI off and no
  suggestion, a cross-domain link can't be inferred — the deferred server-side resolution + global catalog
  will strengthen this. Role nuances (non-owner cannot override) are part of the DEFERRED foundation
  (docs/HOTFIX_FOLLOWUPS.md); today's block applies to all roles and is overridable with explicit confirm.
