# Billing Truth: Argus / Fable 5 expert calls

Date: 2026-07-19

## Root cause

On 2026-07-19 a stray User-level `ANTHROPIC_API_KEY` environment variable was found on this
machine. It silently overrode the owner's Claude Max subscription auth for any tool that shells
out to the `claude` CLI, including `tools/fable5/experts.py`. Any such call was billed as metered
API usage instead of running under the subscription, with no visible warning at call time.

## Fix

The stray `ANTHROPIC_API_KEY` was removed from the User environment on 2026-07-19. Its value was
backed up first, not discarded, at:

`%USERPROFILE%\.claude\anthropic-api-key.backup.txt`

`tools/fable5/experts.py` already scrubs `ANTHROPIC_API_KEY` (and related cloud credential env
vars) from the subprocess environment before every `claude` CLI call, via `_environment()`. That
scrub protects the child process; it does not, by itself, prove the parent machine's auth state is
correct or catch a future regression before it spends money.

## Guards added (Argus Task 0.5)

1. **Subscription preflight.** `subscription_preflight()` in `tools/fable5/experts.py` runs
   `claude auth status` before any expert is dispatched. `run_experts(...)` calls it first: if the
   payload is not exactly `authMethod == "claude.ai"` with no truthy `apiKeySource` field (any
   other shape, nonzero exit, timeout, or missing CLI), every requested expert returns a
   `CheckResult` with status `skipped` and the preflight reason. No expert is launched.
2. **Budget cap on every call.** `build_claude_command(...)` now always appends
   `--max-budget-usd 0.50` to the `claude --print ...` invocation, so even a single call cannot run
   away past that ceiling.
3. **Fail-closed cost check.** `_run_one` parses the CLI's `--output-format json` result envelope
   via `parse_envelope(...)`. If `cost_usd` is present and greater than zero, the `CheckResult`
   status becomes `failed` with reason `metered API cost detected: $<amount>; subscription-only
   policy`, unless the caller explicitly opts out with `--allow-paid-fallback`
   (`run_experts(..., allow_paid=True)`). With the opt-out active, nonzero cost is still reported
   in the reason text; status follows the CLI exit code instead. Zero or missing cost keeps prior
   behavior. Every successful call's reason line reports the token counts and, when a cost is
   present, includes the exact phrase `true spend = provider console` per the project's paid-API
   cost truth rule: response metadata is a computed floor, never the final word on spend.

## What this does not cover

These guards catch a metered key on THIS execution path (`tools/fable5/experts.py`). They do not
retroactively audit charges already incurred before the fix, and they do not cover other tools or
scripts in this repository that may independently shell out to `claude` or another Anthropic
credential path.

## Owner checklist

- [ ] Glance at the Anthropic console billing/usage page once for historical charges from the
      period the stray key was active, to confirm there is no unresolved balance.
