---
name: app-expert
description: Load and maintain Scanbin's living knowledge base (routes, roles, terminology, workflows, testids) before and during any teach-bot run against the live app
---

# App Expert

You are building and using a persistent mental model of the Scanbin barcode inventory app so
every teach-bot run gets smarter than the last one, instead of rediscovering the app from
scratch each time.

## Read first, every run

1. `testing/app-knowledge/APP_EXPERT.md` - the auto-learned map: routes, roles, terminology,
   known workflows, stable testids, decode-ladder read-only fields the UI surfaces (verified /
   suggested / needs-review reasons). Treat it as your starting mental model.
2. `testing/app-knowledge/LOCKED_REQUIREMENTS.md` - the SACRED, owner-authored source of truth
   for what the app must always do (see `data-integrity` skill). This file is READ-ONLY to you.
   **Never edit, append to, or "correct" LOCKED_REQUIREMENTS.md under any circumstance.** If a
   locked requirement looks wrong or stale, write the concern into `DISCOVERIES.md` instead and
   let the owner decide.
3. `testing/app-knowledge/COVERAGE_MATRIX.json` and `RUN_HISTORY.jsonl` - what has already been
   exercised, so you don't waste a live run re-treading the same path (see `risk-based-exploration`).

## What to capture in APP_EXPERT.md

Keep entries short, factual, and dated. Organize under headings:

- **Routes** - real paths you navigated (e.g. `/scan`, `/needs-review`, `/settings`,
  `/sign-in`), what each renders, and which require auth.
- **Roles** - what each persona (tire shop, convenience store, supplier - see the 3 TEACH-BOT
  personas) can and cannot see or do.
- **Terminology** - the app's own words for things (e.g. "Needs Review", "Verified AI Decode",
  "(suggested)", "Saved locally, not synced yet") so future runs recognize UI text instead of
  guessing.
- **Workflows** - the real click-path for common tasks: sign up, scan a known code, scan an
  unknown code, resolve a Needs Review item, export CSV, view session history.
- **Stable testids/selectors** - anything with a `data-testid` or stable role/label you found
  useful for Playwright, so later runs don't re-derive locators.
- **Decode ladder surface** - what the UI actually shows for decode results: verified vs
  suggested badges, honest-reason text for misses, confidence hints. Read-only observations only
  - never assert how the ladder SHOULD behave here, only what it DOES show.

## Update discipline

- Update `APP_EXPERT.md` freely and often. It is disposable, auto-learned memory - if it goes
  stale or wrong, the next run corrects it.
- Prefer small targeted edits over rewrites; keep the file scannable (headings, short bullets).
- When something you observe contradicts a locked requirement, do NOT resolve the conflict
  yourself: log it plainly in `DISCOVERIES.md` (see `evidence-and-bug-triage`) and continue.
- Never store secrets, real customer data, or synthetic-account passwords in this file - route
  through the sanitizer rules in the project's `CLAUDE.md` (Data Privacy / Semantic Firewall).
