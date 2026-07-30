# Task 2 report - trusted UPC/EAN twin selection

## Scope

Owned resolver and local-demo trust files only. No generated artifact, database, E2E, paid, or live operation was run.

## RED

Added all eight real Boss UPC-to-EAN cases with their actual stable UIDs, MPN affix forms, and companion source-count shapes (0 or 1). Before implementation:

`npx.cmd vitest run src/server/tire-knowledge/tireKnowledgeIndex.localDemo.test.ts`

failed 8/10 assertions because `lookupByExactBarcodeLocal` returned the weak raw UPC row instead of its trusted EAN companion. A later raw-absent fallback regression test also failed as expected (`expected trusted padded row, received null`).

## GREEN

The local-only lookup now:

- preserves raw-first behavior for ordinary independently trusted rows;
- uses a companion only after valid 12/13-digit UPC/EAN leading-zero equivalence, non-empty identical UID, and intersecting part-number variants when both MPNs exist;
- requires companion `process_verified_green`, active retail, auto-count candidate, brand, model/display, and size;
- marks only this already-validated in-memory companion for the local trust bridge, leaving the normal `source_count >= 2` rule unchanged for all other rows;
- retains trusted padded-candidate fallback when no raw row exists, while refusing a weak fallback.

Focused verification:

`npx.cmd vitest run src/server/tire-knowledge/tireKnowledgeIndex.localDemo.test.ts src/server/tire-knowledge/localDemoTrust.test.ts src/server/tire-knowledge/TireKnowledgeProvider.test.ts`

Result: 3 files, 61 tests passed.

`npx.cmd eslint src/server/tire-knowledge/tireKnowledgeIndex.ts src/server/tire-knowledge/tireKnowledgeIndex.localDemo.test.ts src/server/tire-knowledge/localDemoTrust.mjs src/server/tire-knowledge/TireKnowledgeProvider.ts src/server/tire-knowledge/TireKnowledgeProvider.test.ts`

Result: passed. `git diff --check` passed.

## Self-review

Fail-closed coverage includes different/empty UID, incompatible MPN, review/non-green/inactive/missing-model/missing-size companions, GTIN-14, raw trusted precedence, and raw-absent trusted/weak candidate behavior. The `tirePartNumberVariants` intersection occurs only after same-UID equality; numeric core never crosses a UID boundary.

Concern: the companion source counts in the real corpus are 0/1, so this intentionally narrow, in-memory selected-twin marker is necessary. It must not be reused outside the verified local exact-twin path.
