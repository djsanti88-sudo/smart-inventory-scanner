# Controlled Automated Pilot — Summary

**This is a CONTROLLED AUTOMATED PILOT against the Firebase emulator. It is NOT a physical shop pilot
(no physical scanning occurred).** It drives the real app (real Auth-emulator sign-in, real business
context, real Firestore persistence) through a tire-shop count session and asserts the result both in
the browser and directly against the emulator via the Admin SDK.

- Proof: `e2e/firebase-phase2/controlled-pilot.spec.ts` (runs under `npm run test:e2e:firebase`)
- Metrics: `reports/benchmark/controlled_pilot_metrics.json`
- Screenshots + CSV sample: `e2e/proof/controlled-pilot/`
- Business: `biz-pilot` ("Pilot Tire Shop"), isolated from the other Firebase E2E business.

## What the pilot proved (all PASS)
| step | result |
|------|--------|
| Real sign-in + select business + scanner focus | PASS |
| Known tire barcode resolves (qty 1) | PASS |
| Alias SKU resolves to the same tire (qty 2) | PASS |
| Legit repeat scan increments (qty 3), no duplicate product row | PASS |
| Unknown tire code -> Needs Review | PASS |
| Approve unknown as new tire (+ approved alias) | PASS |
| Rescan learned code resolves Known, appears in counts | PASS |
| **Refresh: counts/products/session reload; known tire stays 3 (no double count)** | PASS |
| Finish session + CSV export | PASS |
| Business-scoped audit trail (started/completed/review/product/alias/export) | PASS |
| No live AI called | PASS (0 calls) |

## Roles
Owner / counter / viewer memberships were seeded for `biz-pilot` and asserted present with the correct
roles. **Role ENFORCEMENT** (counter can scan/count but not manage/delete products; viewer is read-only;
non-members denied) is proven at the security-rules layer in
`src/services/db/firebase/tenantIsolation.rules.test.ts` and on real cloud in `scripts/cloud-smoke.mjs`.

## Direct emulator assertions
- `inventoryCounts`: Michelin tire `countedQuantity == 3` (idempotent across reload — no double count).
- `products`: learned "Pilot Mystery Tire" persisted.
- `aliases`: the approved alias for the unknown code persisted (`approved == true`).
- `countSessions`: a session reached `status == completed`.
- `auditLog`: business-scoped, includes session_started, session_completed, unknown_review_created,
  product_created, alias_approved, csv_export.

## Exported CSV sample (`e2e/proof/controlled-pilot/final-counts.csv`)
- Michelin Pilot Sport 4 — qty 3 (barcode 4019238847352, SKU MICH-PS4-2454018)
- Pilot Mystery Tire — qty 2 (learned code 8888888888)

## Proof type
Automated (Playwright + Admin SDK against the Firebase emulator). No live cloud, no paid APIs, no
physical scanning. $0 spend.
