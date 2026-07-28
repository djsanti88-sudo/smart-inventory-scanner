# LOCKED REQUIREMENTS — sacred, owner-owned

> Teach Bot may READ this file to judge findings. Teach Bot MUST NEVER auto-edit it.
> Only the owner changes this file. A discovery that contradicts a locked rule is a
> **defect to report**, never a behavior to accept, and never grounds to promote a test.
> When a script recommends changing one of these, report it as:
> *"the script recommended X, but you said this is sacred."*

## L1 — Scan N = count N (TOP-LEVEL LAW)
Every scanned code — known, unknown, misread, random, vendor, undecodable, gate-rejected —
MUST immediately appear on the scan feed AND be counted in the session totals. Scan 10 = count 10,
no exceptions. Gates/decodes decide the IDENTITY of a row, never whether it appears or counts.
An unidentifiable code still counts as an "Unidentified item" row.

## L2 — Wrong identity is failure; Unknown is acceptable
Prefer Needs Review over a wrong guess. A wrong product identity is a failure; leaving a code
Unknown / in Needs Review is acceptable and correct.

## L3 — Vendor / Amazon codes never auto-verify
X00 / FNSKU / ASIN (B0...) and vendor-style labels are never treated as UPC/EAN/GTIN and never
auto-counted as a verified product. They route to Needs Review unless a human-approved alias exists.

## L4 — Decode ladder: diagnose + propose only, never modify without owner approval
Teach Bot may observe the ladder read-only, diagnose it, and PROPOSE fixes with options. It may
NEVER modify ladder logic (order, rungs, gating, charging) without the owner's explicit approval.
The pay-once rule (first settled rung stops the ladder) is owner-owned; the goal is the FULL
product, so a rung settling on partial identity (brand only) is a finding to report, not to accept.

## L5 — Idempotency: retries never double-count
Every ScanEvent keeps one stable id + idempotencyKey reused across retries. Any number of retries,
refreshes, or reconnects must never double-count or duplicate a product row.

## L6 — Tenant isolation
One tenant must never access another tenant's data — not via UI, direct URLs, foreign object IDs,
a wrong-session API request, or import/review endpoints carrying another tenant's IDs.

## L7 — Secrets never leave
No passwords, tokens, cookies, or Firebase credentials are ever written to reports, knowledge
files, manifests, artifacts, or logs.
