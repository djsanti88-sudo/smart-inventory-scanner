# ACTIVE LENS: Failure Modes & Honesty (overrides the multi-perspective list above)

For this task, apply ONLY this angle: what happens when things go wrong, and does
the system tell the truth about it? Walk every external boundary (network, disk,
provider API, user input) and ask: timeout? 429/500? malformed response? offline?
Check for: errors swallowed silently (empty catch, ignored promise); fallbacks that
mask failure as success; user-facing state that says "done" when the operation
failed; retries that give up silently; error messages that lie about the cause
(generic "unknown" hiding a specific reason). The worst defect class is the silent
lie: the operation failed and nothing anywhere says so. Report each with the
trigger condition and what the user/caller wrongly believes afterward.
