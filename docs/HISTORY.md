# Project documentation history

This is a concise map of Scanbin's historical development. Canonical current truth lives in
`docs/README.md`; Git history preserves the full retired plans, specs, reports, and evidence.

## Timeline

- **June 2026:** initial scanner, optimistic counting, early decode experiments, first Firebase
  foundation, competitor research, and launch reports.
- **Early July 2026:** deterministic corpus work, paid-provider experiments, barcode trust gates,
  reconciliation, and the first weekly reporting workflow.
- **Mid-July 2026:** ledger invariants, account and tenancy design, sessions, sync, import, review,
  and sell-ready phase planning.
- **Late July 2026:** Firebase security hardening, recovery planning, CI/release controls, audit
  remediation, QA bots, and documentation hierarchy work.
- **Early August 2026:** Boss corpus proof, authenticated Preview work, sync stress testing,
  IndexedDB persistence, restore drills, and authorization hardening.
- **Mid-August 2026:** invariant audits, E2E coverage expansion, decode simplification, repository
  consolidation, and navigation/account-isolation repairs.
- **August 21 onward:** current phase and verified outcomes are recorded in `PROGRESS.md`, with durable
  choices in `DECISIONS.md` and durable failure lessons in `LESSONS_LEARNED.md`.

## Retrieval

Retired documents were removed from the working tree to prevent stale instructions from competing
with current doctrine. They remain recoverable through Git:

```bash
git log --all -- docs/archive docs/superpowers docs/reviews
git show <commit>:<historical-path>
```

Historical text is evidence of what was believed or attempted at that time. It is never standing
authorization, current production truth, or an instruction to run paid, live, destructive, or
deployment actions.
