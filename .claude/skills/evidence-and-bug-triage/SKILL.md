---
name: evidence-and-bug-triage
description: Require reproduction and hard evidence before calling anything a confirmed bug, classify findings correctly, and log them into BUGS.md without ever recording secrets
---

# Evidence and Bug Triage

A teach-bot finding is worthless without proof, and a mislabeled finding wastes owner time. This
skill sets the evidence bar and the classification scheme for every finding produced during live
testing.

## Reproduction bar

- Reproduce the issue **2 times** before calling it `confirmed_app_bug`, unless reproducing it a
  second time is unsafe (e.g. it would delete/overwrite real data, spend more paid API calls than
  justified, or send a real message) - in that case, document why a second repro was skipped and
  classify it as `probable_app_bug` instead.
- A single occurrence with strong evidence (e.g. an unambiguous console error plus a network 500)
  can still be logged as `probable_app_bug` pending a second look, but must not be called
  `confirmed_app_bug` on one occurrence alone.

## Evidence required for every finding

Capture and attach/reference (via the Playwright CLI or MCP tools available):
- Screenshot at the moment of failure.
- Trace/video if the flow is available (Playwright trace on failure).
- Console errors/warnings around the event.
- Any failed or unexpected network requests (status code, endpoint, response body where
  relevant - sanitize any token/secret before recording).
- Exact repro steps: persona used, exact input, exact click path, viewport.
- Severity (blocks core flow / degrades a flow / cosmetic) and customer impact (who would hit
  this and how often).

## Classification

Every finding gets exactly one label:
- `confirmed_app_bug` - reproduced per the bar above, evidence attached, root cause in app code
  (not test code, not environment).
- `probable_app_bug` - strong single-occurrence evidence, or a second repro was unsafe to attempt.
- `test_bug` - the teach-bot's own test/script logic was wrong (bad selector, wrong assumption
  about a flow) - fix the test, don't file it as an app bug.
- `test_data_problem` - the synthetic data used was invalid/stale/conflicting, not an app defect.
- `environment_problem` - looks like network flake, Vercel cold start, third-party
  provider outage, or local machine issue rather than app logic.
- `flaky` - could not reliably reproduce across attempts; note the flake rate observed.

## Logging

- Append every finding to `testing/app-knowledge/BUGS.md` with: date, classification, severity,
  persona/context, repro steps, evidence references, and current status.
- Never record secrets, API keys, tokens, or real customer PII in evidence or logs - mask before
  writing, per the project's Data Privacy / Semantic Firewall rules.
- A `confirmed_app_bug` or `probable_app_bug` involving a `data-integrity` invariant is always
  high severity regardless of how "small" it looks (a 1-count discrepancy is still a broken
  invariant).
- Do not let a discovered bug get silently converted into an accepted/expected test outcome - see
  `continuous-live-testing` for why reproducible bugs must never be auto-promoted to permanent
  tests.
