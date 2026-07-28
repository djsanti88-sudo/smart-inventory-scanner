# Playwright Healer - gated wrapper

The official Playwright healer agent (`playwright-test-healer`) edits test files in place to
make failing tests pass. That is exactly the wrong default for teach-bot tests: a test failure
here might mean the APP is broken, not the test. If the healer runs directly against
`testing/tests/candidates/` or `testing/tests/permanent/` in this working tree, it can silently
rewrite a test to match broken app behavior, which would hide a real regression instead of
surfacing it.

**Rule: the healer must never run directly against this working tree. It always runs in a
disposable git worktree on a throwaway branch, and its output is a patch file for the owner to
review and approve - never an auto-applied change.**

## Exact procedure

1. Create a disposable worktree on a new branch, off the current branch:

   ```
   git worktree add ../wt-teach-heal -b teach/healer-scratch-<date>
   ```

2. Run the healer inside that worktree only (never in `C:\tmp\wt-teach` or the main repo):

   ```
   cd ../wt-teach-heal
   # invoke the playwright-test-healer agent / MCP tools here, scoped to this directory
   ```

3. Once the healer has made its edits, capture them as a patch instead of leaving them as live
   commits or merging them:

   ```
   git diff > ../teach-healer-<date>.patch
   ```

4. Present `../teach-healer-<date>.patch` to the owner for review. Explain in plain language what
   the healer changed and why (selector fix vs behavior-masking change - call out anything that
   looks like it's papering over an app bug rather than fixing a stale selector).

5. The owner decides whether to apply the patch to the real test tree (`git apply` or manual
   cherry-pick of the relevant hunks) - this step is never automatic.

6. Clean up the scratch worktree and branch once done:

   ```
   git worktree remove ../wt-teach-heal
   git branch -D teach/healer-scratch-<date>
   ```

## Why this matters here specifically

Teach-bot tests exist to catch real app defects (see `data-integrity` and
`evidence-and-bug-triage` skills). A healer that "fixes" a red test by changing its assertion to
match whatever the live app currently does would turn a bug-catching test into a bug-hiding test.
Routing every healer run through a disposable worktree + patch + owner-approval gate keeps that
decision in human hands every time.
