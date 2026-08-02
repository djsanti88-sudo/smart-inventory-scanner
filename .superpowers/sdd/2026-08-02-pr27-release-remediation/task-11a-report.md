# Task 11A atomic review phase

## RED/GREEN evidence

- `localAtomicReviewCountedApply.test.ts` first failed at module resolution because the coordinator did not exist.
- The coordinator now makes stored review-action replay authoritative before the optional tx-aware freshness callback. A new action stages tenant product/link, immutable action, review resolution, operation journal, aggregate ledger, and projection in one `AtomicLocalStorage.transaction`.
- The focused coordinator test proves the same action key returns its original action/count event without revalidation, and a projection failure rolls all staged state back.
- `npx.cmd vitest run src/server/identity/localAtomicReviewCountedApply.test.ts` passed (2/2).
- `npx.cmd tsc --noEmit --incremental false`, focused ESLint, and `git diff --check` passed.

## Boundaries and remaining integration

- The existing route still invokes its legacy split action/count path; it must be routed through this coordinator with a tx-aware configured-model validator before Task 11A is considered complete. No nested repository/model read is permitted from that callback.
- The existing generic file-storage test already proves post-manifest-swap sync is indeterminate and durable. A coordinator fresh-process integration proof could not be added in this worktree because its `.tmp/identity-import` child-root ACL rejects directory creation with `EPERM`; do not treat that as a behavioral proof.
- No cursor or UI work was performed.
