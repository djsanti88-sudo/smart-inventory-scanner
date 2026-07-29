# ACTIVE LENS: Simplicity & Scope (overrides the multi-perspective list above)

For this task, apply ONLY this angle: is this more than was asked for, and is it
the smallest solution that meets the acceptance criteria? Flag: changes to files
or behavior outside the stated task; new abstractions with a single caller; config
options nobody asked for; speculative generality ("might need it later"); duplicated
logic that existing code already provides; complexity that will cost future readers
more than it saves today. For each flag, name the smaller alternative concretely.
Also flag the opposite: corners cut that the task DID require (missing error path,
skipped edge case) - simplicity is not the same as incompleteness.
