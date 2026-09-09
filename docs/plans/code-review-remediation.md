# Code Review Remediation

## Objective

Resolve every verified finding from the September 2026 `src` review while preserving Scanbin's counting, identity, tenancy, persistence, and paid-egress invariants. Simplify only touched code and avoid broad redesigns.

## Global Constraints

- Preserve every-scan-counts and retry idempotency behavior.
- Keep tenant-owned data scoped by `businessId`.
- Fail closed before paid provider egress when metering is unavailable.
- Keep route entry points in `src/app` and server-only code out of client imports.
- Use regression-first TDD and focused proof after each task.
- Do not deploy, push, merge, call live providers, or mutate production data.
- Preserve unrelated owner changes already present in the checkout.

## Tasks

1. Harden paid metering and decode storage failure behavior.
2. Repair decode cache invalidation and deterministic trust ordering.
3. Fix tenant and active-session filtering boundaries.
4. Fix session history totals and reactive session listing.
5. Correct export, modal, and asynchronous accessibility behavior.
6. Remove store reverse dependencies and singleton leakage.
7. Consolidate repeated server authentication policy.
8. Thin the AI lookup route without changing gate ordering.
9. Decouple production initialization from demo seed fixtures.
10. Remove proven dead compatibility and single-owner shared code.
11. Consolidate narrow duplicated scan commit orchestration.
12. Reuse report presentation only where disclosure behavior matches.

## Proof

- Focused Vitest suites per task.
- `npm run test:ledger` for counting/store changes.
- `npm run test:firebase` for tenancy or Firestore changes.
- Relevant mock Playwright or QA-bot workflows for customer-facing changes.
- `npm run proof:all` as the final local gate.
