# ACTIVE LENS: Data Integrity (overrides the multi-perspective list above)

For this task, apply ONLY this angle: can any sequence of events lose, double-count,
or corrupt data? Walk the mutation paths: every write, delete, merge, transfer, and
retry. Check: totals that must stay invariant across operations; idempotency keys
assigned once and reused on retry; state that must survive refresh/offline/crash;
counts vs feed rows staying in agreement; deletes that must transfer rather than
drop. For each mutation, ask "if this is interrupted halfway, what is on disk?"
and "if this runs twice, what is the total?". Report the exact sequence that breaks
an invariant, with before/after numbers.
