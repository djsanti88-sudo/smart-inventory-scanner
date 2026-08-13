# Simplification Campaign — Executor Brief (2026-08-12)

Status: DRAFT, awaiting owner decisions. No code touched.

This is the brief handed verbatim to every chunk lead and executor. It **replaces**
the `code-simplifier` plugin agent's built-in instructions, which encode a different
project's conventions (`function` over arrow, no try/catch, mandatory return type
annotations). Those do not apply here and must not be acted on.

Baseline proven green 2026-08-12: `npm run proof:local` -> 4124 passed / 105 skipped,
exit 0, 57.39s.

---

## 1. Mission

Reduce accidental complexity in an assigned chunk **without changing one bit of
observable behavior**. The goal is less code, fewer layers, fewer places to look —
not different code.

## 2. The one rule that makes this safe

**You may not create, modify, delete, skip, or weaken a single test file.**

The repo's 464 test files are the specification. They are the only thing standing
between a simplification and a silent regression. If a change you want to make
requires a test to change, that is proof the change alters behavior: **abandon it and
report it as escalated-out-of-scope.** Do not accommodate it. Do not "fix" the test.

Violating this rule invalidates the entire chunk's work, which will be discarded.

## 3. Hunt list, in priority order

1. **Proven dead code** — no references anywhere in `src/`, `scripts/`, or tests.
   Must cite the search that proved it. Distinguish sharply from *suspected* dead.
2. **Duplicated logic** — the same decision implemented in two or more places.
3. **Single-caller abstractions** — a wrapper, helper, or interface with exactly one
   consumer that adds no decision of its own.
4. **Over-layering** — a call chain where a hop only forwards arguments.
5. **Inconsistent patterns** — the same job done three ways across sibling files.
6. **Files that should be split** — cite the seam, do not perform the split unless
   the task explicitly authorizes it.
7. **Names that lie** — a function whose name contradicts what it does.

## 4. Anti-goals (immediate rejection)

- Renaming sprees, reformatting, import reordering.
- "Modernizing" syntax; converting arrow functions to `function` or vice versa.
- Adding type annotations that the compiler already infers.
- Extracting new abstractions. This campaign removes layers, it does not add them.
- Any diff whose justification is taste rather than "there is now less to read."
- Touching generated artifacts: `*.generated.json`, `knowledge.generated.db*`,
  anything under `src/server/tire-knowledge/` or `src/server/retail-knowledge/`
  that is produced by a build script. Change the generator, never the output.

## 5. Invariants you may never propose violating

Sourced from `CLAUDE.md` and `GUARDRAILS.md`. A simplification that touches any of
these must be escalated, not attempted.

- **TOP-LEVEL LAW**: every scanned code appears in the feed and counts in the totals.
  Scan 10 = count 10. No gate, verdict, cap, breaker, or error may suppress a row.
- **`ensureProvisionalCount` ordering**: it runs synchronously before any decode or
  network await. That call ordering *is* the enforcement of the law. Do not reorder,
  do not make it async, do not hoist anything above it.
- **`markWrong` is a transfer**, never a delete. Counted physical quantity is
  repointed onto a fresh provisional, never zeroed.
- **Idempotency keys** are assigned once at scan time and reused on every retry.
  Never regenerate one inside a retry path.
- **Barcodes and part numbers are text**, always. No numeric coercion at any layer.
- **Server-only key boundary**: client code never reads `process.env.*_API_KEY`.
  `src/server/*` stays out of client bundles.
- **Resolver trust**: `known` comes only from an approved alias or a verified product
  identifier. AI output is a suggestion.
- **Decode ladder is pay-once and cost-ordered**; a rung that answered is never
  re-paid. Gemini stays out of decode.
- **`src/services` stays pure** — no React, no `next/*` imports.

## 6. Required output per finding

One row, no prose padding:

| field | content |
|---|---|
| id | `<chunk>-<n>` |
| category | one of the seven hunt-list items |
| evidence | `file:line`, plus the search that proves it for dead code |
| claim | what is redundant, in one sentence |
| change | the exact edit, or `ESCALATE` |
| confidence | proven / probable / speculative |
| blast radius | which gate command proves it safe |
| LOC delta | expected net line change (negative is the point) |

Speculative findings are reported, never executed.

## 7. Verification

Executors run the focused tests for the files they touched. That is a self-check, not
the gate. The real gate is run by the orchestrator on the merged chunk:

| chunk | gate battery |
|---|---|
| A — scan core & ledger | `proof:local` + `test:ledger` |
| B — decode & AI | `proof:local` + ladder continuation tests |
| C — UI & app shell | `proof:local` + `test:e2e` + `qa:bots` |
| D — data, catalog, sync | `proof:local` + `test:firebase` + corpus drift/golden |
| E — repo hygiene | `proof:local` |

No chunk merges on a red gate. No test is weakened to make a gate green — the change
is reverted instead.

## 8. Fleet shape

Orchestration lives in the main thread; chunk leads do judgment only and return task
lists, because subagents cannot reliably spawn subagents.

- **Chunk lead (Opus for A and B, Sonnet for C/D/E)** — analyze, produce the ranked
  atomic task list per section 6. Read-only. No edits.
- **Executors (Sonnet)** — one per disjoint file set, each applying pre-judged atomic
  tasks. Edits only inside its assigned files.
- **Isolation** — one git worktree per chunk, so parallel waves cannot collide.
- **Merge** — sequential, orchestrator-only, gate-gated, after diff review.

## 9. Wave order

1. **Pilot: E + D** — lowest risk; calibrates the brief before it is trusted.
2. **B + C** — after the pilot's findings prove the brief produces substance, not churn.
3. **A alone, last** — `scanStore.ts` is 8,789 lines and owns the counting law.
   Sub-chunked by section (intake / ledger / review queue / sync-drain / persistence),
   never reviewed as one blob.
