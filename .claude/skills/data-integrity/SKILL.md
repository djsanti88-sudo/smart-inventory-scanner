---
name: data-integrity
description: Test Scanbin's sacred counting and tenant-isolation invariants from LOCKED_REQUIREMENTS.md every teach-bot run - report violations, never patch them into a test as if they were correct
---

# Data Integrity

These are the invariants the whole business depends on. They come from
`testing/app-knowledge/LOCKED_REQUIREMENTS.md`, which is SACRED and read-only to any bot or
agent - quote it, test against it, never edit it. If live behavior contradicts it, that is a
critical bug report, never a reason to change the requirement or "fix" a test to accept the
wrong behavior.

## The invariants to test EVERY run (not optional, not sampled out)

1. **Scan N = count N.** Every scanned code - known, unknown, misread, random, undecodable,
   trust-gate-rejected - must immediately appear on the scan feed AND be counted in the session
   total. Scan 10 codes, whatever their identity, and confirm the count is exactly 10.
2. **Duplicate scans increment quantity, never create duplicate rows.** Scan the same code twice
   (or more) in one session and confirm one product row with an incremented quantity, not two
   rows.
3. **Unknown scans stay counted under Needs Review.** A code that cannot be identified must still
   count and still show as a row (e.g. "Unidentified item" / Needs Review), never vanish from the
   feed or the total.
4. **A UPC and a part number for the same product resolve to ONE row.** If both identifiers exist
   for one physical product, scanning either must land on the same inventory row, not fork into
   two.
5. **Missing aliases never make a valid scan disappear.** A code with no alias/mapping yet must
   still appear and count (routes to Needs Review), never silently drop.
6. **Tenant isolation is absolute.** One business/tenant must NEVER see another tenant's data.
   Test this from every angle, not just the obvious UI:
   - Normal UI navigation as tenant A never surfaces tenant B's products/counts/history.
   - Direct URLs (guessed or copied IDs) belonging to tenant B, visited while authenticated as
     tenant A, must be rejected, not rendered.
   - Foreign object IDs substituted into an otherwise-normal request (e.g. editing a product ID
     in a form submission or API call) must be rejected server-side, not just hidden in the UI.
   - A wrong-session or stale-session API call must not leak another tenant's data.
   - Import/review endpoints specifically (CSV import, Needs Review resolution) must be checked
     for cross-tenant leakage, since these touch bulk data paths.

## How to test them

- Use two+ TEACH-BOT personas (different tenants) in the same run when testing isolation, so
  there is a real "other tenant" to try to leak into.
- Use the Playwright CLI (`goto`, `eval`, `requests`, `response-body`) to inspect actual API
  responses and network payloads, not just what renders on screen - a leak can be present in a
  response body even if the UI doesn't display it.
- Count precisely. Don't eyeball "looks about right" - read the exact number shown and compare to
  the exact number of scans performed.

## Reporting rule

**These are report-only checks.** If a violation is found, it is a confirmed/probable app bug per
`evidence-and-bug-triage` - write it up with full evidence. Never modify a test, a fixture, or
LOCKED_REQUIREMENTS.md to make a violation look expected or to make the check pass. A green test
that hides a counting or tenant-leak bug is worse than a red one.
