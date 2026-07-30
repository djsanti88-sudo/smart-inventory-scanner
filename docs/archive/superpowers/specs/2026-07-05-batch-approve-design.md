# Batch-Approve for the Suggested Pile - Design

Owner-approved 2026-07-05. Build 3 of 3 (small; may jump the queue if the owner wants the
labor relief first).

## Goal

~44% of decoded codes land as Suggested (right ~98% of the time in campaigns) and each costs a
human tap. A batch-approve screen turns ~90 taps into ~3 while keeping a human in the loop.
Trust rules do NOT change: nothing auto-promotes; a human still approves every suggestion.

## Design

- Review screen gains a "Suggested" tab listing all suggested rows: checkbox per row,
  select-all, and one **Approve selected** button (plus per-row Reject).
- Each row shows the structured identity (Build 2 columns when available), source count,
  confidence, and the winning source link for spot-checking.
- Approve = the exact same path as today's single approval (`resolveUnknown`): creates/links
  the product, writes the permanent approved alias, counts once (idempotency keys per row,
  reused on retry - a double-click or retry can never double-count).
- Reject routes to Needs Review with the suggestion kept as background info.
- Batch operations are chunked (25 per commit) so one bad row cannot fail the whole batch;
  failures are listed by code with reasons.

## Testing / proof

- Unit: batch approve is idempotent per row; partial-failure chunking; reject path.
- Playwright: seed 30 suggested rows -> select all -> approve -> counts table shows all 30,
  re-clicking approves nothing twice; screenshot proof. Scanner-focus rules untouched
  (dangerous actions stay off the scan flow; this screen is /review only).
