---
name: warn-deploy-lock-wrapper-required
enabled: true
event: bash
conditions:
  - field: command
    operator: regex_match
    pattern: \bvercel\s+deploy\b(?!.*--prod)
  - field: command
    operator: not_contains
    pattern: deploy-preview.mjs
---

**Use the deploy wrapper, not raw `vercel deploy`.**

This command looks like a raw `vercel deploy` (preview) invocation that did NOT go through
`node scripts/deploy-preview.mjs` -- the ONLY sanctioned deploy path in this repo.

**Why this matters (owner order, 2026-07-22 "never again" package, item 5):** many parallel Claude
sessions can touch this repo's deploy surface at once with no shared awareness of what any other
session already did. That is exactly how a preview-only branch reached production and how four
already-shipped fixes went missing from the lineage that actually got deployed. The wrapper exists
to close that gap: it takes an exclusive deploy lock (`.deploy-lock`, stale after 30 min), runs the
fix-lineage guard and env-parity gate if they exist, runs `vercel deploy` itself, then runs the
post-deploy smoke fingerprint if present, and always releases the lock afterward.

**Do this instead:**
```
node scripts/deploy-preview.mjs            # real preview deploy
node scripts/deploy-preview.mjs --dry-run   # exercise lock + preflight logic only, no network call
```

**Honest limitation of this rule:** hookify matches on the literal Bash `command` string only -- it
has no visibility into child-process environment variables, so it cannot mechanically verify the
wrapper's internal `DEPLOY_WRAPPER=1` marker at all. This rule instead exempts any Bash command
whose text contains the substring `deploy-preview.mjs` (the `not_contains` condition above), on the
theory that the wrapper is invoked as `node scripts/deploy-preview.mjs [--dry-run]` -- a command
string that always contains that substring -- while the wrapper's own internal `vercel deploy` call
happens inside a **separate spawned child process** the Bash tool never sees as a command string at
all, so this rule never has a chance to fire on the wrapper's own internal invocation in the first
place (there is nothing for it to match against).

This exemption is NOT airtight: a command string that happens to mention `deploy-preview.mjs`
anywhere (e.g. `echo see scripts/deploy-preview.mjs && vercel deploy`) is exempted even though it
contains a real bypass. A regex/substring check over a command string can never perfectly
distinguish "this vercel deploy came from inside the wrapper" from "this vercel deploy was typed
directly but happens to mention the wrapper's filename" -- that distinction requires actual process
lineage, which this hook event does not expose. This is a WARN, not a BLOCK, precisely because of
that gap: a false positive here should not be able to halt a legitimate wrapper-adjacent command,
and a determined bypass can still slip past the exemption by naming the wrapper in an unrelated
comment. Treat this rule as a reminder, not a guarantee -- the wrapper itself (with its lock file)
is the real enforcement mechanism; this rule only nudges a session back toward using it.

This rule does NOT duplicate `hookify.vercel-prod-gate.local.md` (which BLOCKS `--prod`/`promote`/
`rollback`/`alias set` outright) or `hookify.push-deploy-gate.local.md` (a general push/deploy
owner-gate reminder) -- it is scoped specifically to plain preview `vercel deploy` bypassing the
lock-and-preflight wrapper.
