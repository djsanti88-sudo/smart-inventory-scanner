# Task 3 report: local-demo batch-01 status regression

## Scope and base

- Worktree: `C:\tmp\inventory-local-tire-demo`
- Starting SHA: `4082b314d8fc30f674fc4eb616bf63bf76e6664f`
- Inherited fixture work: the five local-demo test files plus the new
  `src/test/createTireKnowledgeDbFixture.ts` helper were already uncommitted.
- Production files changed: none. `src/stores/scanStore.ts` was inspected but
  deliberately left unchanged.

## RED observed before correction

`npx.cmd vitest run src/stores/localDemoBatch01Suggested.repro.test.ts`
failed at the unchanged all-nine `decodeStatus === "verified"` assertion. The
final mismatch was `0758823162664: suggested`, with its review still `open`.
Both reported Fortune rows were already correct and resolved:

- `840139633249`: `verified`, `225/50R18 95Y`
- `840139633485`: `verified`, `275/40R19 105Y`

The failure was not a later store downgrade. The fixture incorrectly made
`758823159756` a `255/65R16` SU318 H/T and paired the EAN-shaped input with an
invented raw EAN record, creating a legitimate size/identity merge hold.

## Correction and root cause

The test fixture now mirrors the committed generated corpus. In particular:

- `758823159756` is `255/70R16 111T`.
- EAN input `0758823162664` resolves through the UPC fixture row
  `758823162664` (`255/65R16 109T`).
- EAN input `0758823173844` resolves through UPC `758823173844`
  (`215/65R16 98H`).
- All formerly invented `TIRE_*` canonical IDs and incompatible fields were
  replaced with their committed corpus values. Test metadata intentionally
  keeps `source_count: 3` to exercise the multi-source path.

There is no production `scanStore` root cause in this case. The relevant
post-resolution suggested writes already preserve an app-verified badge:
the auto-merge repoint at `scanStore.ts:4957-4960` and own-provisional refresh
at `scanStore.ts:5008-5010` guard `decodeStatus !== "verified"`; the primary
decode settle path only acts on decoding/needs-review/suggested rows.

## GREEN and verification

- `npx.cmd vitest run src/stores/localDemoBatch01Suggested.repro.test.ts`
  — 1 file, 1 test passed.
- `npx.cmd vitest run src/app/api/ai-lookup/route.localDemo.test.ts src/server/decode/pipeline.localDemo.test.ts src/server/tire-knowledge/tireKnowledge.test.ts src/services/tire/sameUidBlankPropagation.parity.test.ts src/stores/localDemoBatch01Suggested.repro.test.ts src/stores/identityMerge.store.test.ts src/services/catalog/identityMerge.test.ts src/stores/scanStore.autocount.test.ts`
  — 8 files, 60 tests passed.
- Focused ESLint on all six staged test/helper paths — passed.
- `git diff --check` — passed.

## Self-review and concerns

- Diagnostics were removed; the all-nine final assertion and its timing are
  unchanged.
- The EAN inputs intentionally remain EAN-shaped while their backing fixture
  records are the committed UPCs, proving zero-padded candidate fallback.
- No E2E, deployment, push, live/paid decode, or production mutation ran.
- Concern: the fixture's `source_count: 3` is deliberate test metadata and
  differs from the generated records' current source count; all identity and
  resolver-relevant fields match the committed corpus.
