# Loop 2 Defect Hunt — scan-core section (2026-08-13)

Scope per `npm run check:section scan-core`. Read-only pass: adversarial verification of the
uncommitted persist-corruption fix (JOB 1), then a hostile/malicious-input lens (JOB 2).
`.next/` excluded from all searches. `scanStore.ts` (~8,900 lines) navigated by symbol, not
top-to-bottom.

## JOB 1 — verification verdict

| Claim | Verdict | Evidence |
|---|---|---|
| LAYER A (`sanitizePersistedScanShape` in the persist `merge`) coerces any non-array top-level persisted field to `[]`, closing the "`products: "not-an-array"` at current version" defect | **CONFIRMED** | `scanStore.ts:8649-8666`, wired at `merge:` (`:8862-8868`). `scanStore.persistShapeGuard.test.ts` ran green (`npx vitest run` → 4/4 passed). Reused, not duplicated, by LAYER B. |
| LAYER B (`sanitizeLiveScanStateShape` + try/catch around `resolveScan`) stops the SAME top-level shape defect from throwing inside `processScan` if it ever reaches live state by any other path | **CONFIRMED for the exact defect it targets** | `scanStore.ts:3204-3246`. Test `LAYER B: processScan survives a wrong-shape 'products' state...` (`persistShapeGuard.test.ts:69-101`) sets `products: "not-an-array"` directly on live state and proves the row still appears + counts. |
| The two-layer fix is a complete close of "any wrong-shape state can silently drop a scan" | **WEAKENED — see SC2-1** | The fix only guards the top-level `Array.isArray` check. A well-formed array containing a malformed *member* (e.g. `products: [validProduct, null]`) reproduces the identical failure class through an unguarded second touch-point a few lines later in the same function. |
| Sanitizer can destroy valid data | **REFUTED (no defect)** | `sanitizeLiveScanStateShape` only calls `set()` for fields where `current[field] !== sanitized[field]`; `sanitizePersistedScanShape` leaves any field that already passes `Array.isArray` byte-for-byte (same reference), so a genuinely valid array is never touched or emptied. |
| Errors are logged, never silently swallowed | **CONFIRMED** | Both layers `console.warn`/`console.error` before recovering; the LAYER B test asserts `console.error` was called. |
| Would the regression test fail if the fix were reverted | **CONFIRMED it would** (by code inspection — reverting either layer removes the exact code path the test exercises: `sanitizePersistedScanShape` export or the try/catch around `resolveScan`) |
| Invariants preserved (idempotency-once, `markWrong` transfer, text codes, `ensureProvisionalCount` ordering) | **CONFIRMED, unaffected** | Diff touches only shape sanitation + a display-only `quantityAfterScan` backfill in the alias-merge feed-relabel path (`:6739-6767`, cosmetic — does not change `finalCounts`/ledger math). |

### SC2-1 — malformed array *member* still throws uncaught out of `processScan` (new finding, JOB 1 refutation angle)

Both fix layers gate only `Array.isArray(value)`. A persisted/live `products` array that is a real
array but contains a non-object member (`null`, a string, `5`) — plausible from partial IndexedDB
writes or a bad merge — is **not** normalized by either layer.

Trace:
1. `resolveScan` → `resolveScanToProductTiered` → `collectAllIdentifierHits`
   (`src/services/aliasMatcher.ts:160`): `products.filter((p) => p.businessId === businessId && ...)`.
   `.filter` visits every element unconditionally, so `p.businessId` on a `null` member throws
   `TypeError: Cannot read properties of null`. This throw **is** caught by `processScan`'s new
   `try { resolution = resolveScan(...) } catch` (`scanStore.ts:3227-3246`), which correctly degrades
   `resolution` to a safe `needs_review`/`productId: null` fallback — LAYER B working as designed.
2. But immediately after the catch, `processScan` re-touches the **same unsanitized `products`
   array** at `scanStore.ts:3272-3283`:
   ```
   if (!countable && !knownConflict) {           // true in the degraded/catch path
     ...
     provMatchId = products.find((p) => countedIds.has(p.id) && p.status !== "archived" && ...)
   ```
   `isKnown` is `false` and `knownConflict` is `null` in the catch-degraded path, so this block
   always executes. `.find` again visits the malformed member and throws `TypeError: Cannot read
   properties of null (reading 'status')` — this time **outside any try/catch**. The exception
   propagates out of `processScan` uncaught.
3. The only call site (`src/app/(app)/scan/page.tsx:56-64`, `handleScan`) has no try/catch around
   `processScan`. An uncaught throw here means the row is never appended to `scanFeed` and nothing is
   counted — the exact TOP-LEVEL LAW violation this whole fix exists to close, reproduced through a
   sibling shape (member-level, not array-level).

Neither `scanStore.persistShapeGuard.test.ts` nor `e2e/persist-corruption-recovery.spec.ts` covers
this: both fixtures use `products: "not-an-array"` (non-array) or omit `products` entirely, never a
same-shaped array with a bad element. Same unguarded pattern recurs at `scanStore.ts:3474-3484`
(`repeatPlaceholderId`), `:3546-3548`, `:3620-3622`, `:3653` — every subsequent `products.find(...)`
in `processScan` after the try/catch reads the same unsanitized array.

Severity: Medium-High (reproduces the exact class the fix targets; requires a specific but plausible
corruption shape — a partially-written array element rather than a fully wrong-typed field).
Confidence: High (traced by direct code reading of `.filter`/`.find` predicates that dereference
`p.field` with no null guard; not executed live because doing so would require adding a test file,
which this read-only loop cannot do).

## JOB 2 — hostile/pathological input, new lens

- **Prototype-pollution keys**: no plain-object used as a map keyed by scanned code was found in
  `scanStore.ts` (`trustedExactProbeIdsByCode`, `trustedExactProbes` are real `Map`s, immune to
  `__proto__`/`constructor` key collision). `finalCounts`/`scanFeed`/`needsReviewQueue` are arrays,
  looked up via `.find`, not object-keyed — no reachable prototype-pollution sink in this section.
- **Unicode/RTL/zero-width/long codes**: `scanCleaner.ts`'s `INVISIBLE` class strips C0 controls,
  DEL, zero-width space/joiner/non-joiner, BOM (confirmed by loop 1, re-spot-checked, unchanged in
  this diff). `resolver.ts` has an explicit `SCAN_LENGTH_CAP = 500` used only for an additive honest
  reason string — the raw code is still stored and still counted, matching the "still counts even if
  a scanner glitch" comment. No truncation of `rawCode`, no crash path found for oversized input.
- **Volume/quadratic risk**: not newly probed deeply this loop beyond loop 1's scope; no new evidence
  found of a quadratic blowup introduced by this diff (the diff's new `mergeBaselineQty` lookup at
  `scanStore.ts:6739` is a single `.find` over `finalCounts`, not nested).
- **Instruction-injection text reaching AI prompts**: out of this diff's surface — the diff does not
  touch decode/AI code paths, only persist shape and a cosmetic feed relabel.

No new SC2 finding from JOB 2 beyond SC2-1 (which was surfaced via the "array containing malformed
members" angle JOB 2 also asks for — it sits at the intersection of both jobs).

## Bottom line

The shipped fix is real and closes the specific defect it documents (top-level non-array persisted
field). It does not fully close the broader defect class ("any wrong-shape state must never throw
uncaught out of `processScan`") — SC2-1 shows a concrete, one-line-different corruption shape that
still drops a scan silently. Recommend hardening `sanitizeLiveScanStateShape`/`sanitizePersistedScanShape`
to also strip non-object members from these array fields (or wrapping the remainder of `processScan`
after the `resolveScan` try/catch, not just the resolver call itself) before treating this defect
class as closed.
