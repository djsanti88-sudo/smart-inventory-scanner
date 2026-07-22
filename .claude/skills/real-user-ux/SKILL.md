---
name: real-user-ux
description: Drive Scanbin like an impatient, imperfect real customer instead of a clean scripted test - misreads, back button, refreshes, double-clicks, abandoned flows, mobile viewport
---

# Real User UX

Scripted tests click the right button in the right order. Real shop employees don't. This
skill's job is to inject realistic human sloppiness into a teach-bot run so friction and bugs
that only show up under messy real usage get found.

## Behaviors to inject during exploration

- **Misread or fat-fingered input** - type a barcode with a transposed digit, an extra space, or
  lowercase where it should be numeric; see what the scanner-buffer / resolver does with it
  (never actually break the raw-scan-preservation rule - just feed it realistic bad input).
- **Impatience** - double-click submit buttons, click a button then immediately click again
  before the UI responds, mash Enter multiple times on the scan input.
- **Navigation chaos** - use the browser back button mid-flow (e.g. mid-signup, mid-resolve),
  refresh the page unexpectedly during a scan session, open the same flow in a way that could
  race with itself.
- **Abandonment** - start a multi-step flow (signup, CSV import, resolving a Needs Review item)
  and walk away / navigate elsewhere without finishing; come back later and see what state
  survived.
- **Viewport realism** - test at a small mobile viewport (a phone in the aisle) as well as
  desktop; check tap targets, keyboard covering inputs, and whether critical actions are still
  reachable.
- **Offline/flaky network** - use `network-state-set offline` mid-scan or mid-sync, then bring
  it back online, and watch what the app tells the user versus what silently happens.
- **Real typos in text fields** - product notes, search boxes, CSV headers with extra whitespace
  or unexpected casing.

## What to capture

For every friction moment, note:
1. What a real user was trying to do.
2. What actually happened (screenshot/snapshot).
3. Whether the app gave clear feedback, silently succeeded, silently failed, or broke.
4. Whether this is a **bug** (wrong behavior) or **friction** (correct but confusing/slow) - both
   matter, but only bugs go through the `evidence-and-bug-triage` reproduction bar.

## Guardrails

- This is about realistic human sloppiness, not adversarial security probing (that is a
  different concern) and not violating the data-integrity invariants on purpose to "prove" they
  hold - those are exercised deliberately via `data-integrity`, not accidentally here.
- Never use real personal data. Stick to the synthetic TEACH-BOT persona emails and made-up
  product data.
- Log friction findings into `testing/app-knowledge/DISCOVERIES.md`, not as confirmed bugs,
  unless they meet the bug bar in `evidence-and-bug-triage`.
