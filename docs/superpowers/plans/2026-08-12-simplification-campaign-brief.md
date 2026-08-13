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

   **SELF-SKIPPING TEST TRAP (added 2026-08-12 after the pilot produced a false
   positive on exactly this).** 11 `*.rules.test.ts` files use
   `describe.skipIf(!ready)` gated on `FIRESTORE_EMULATOR_HOST`. Under
   `npm run test` / `proof:local` there is no emulator, so they SKIP — they are
   most of the "105 skipped" in a green baseline. A symbol used only by those
   files looks dead to a naive search AND deleting it leaves the default suite
   green while breaking `npm run test:firebase`.

   Therefore: a dead-code claim is INVALID unless its cited search explicitly
   covers `*.rules.test.ts` and every other conditionally-skipped suite, and the
   finding states which suites actually executed. "The tests passed" is not
   evidence when the relevant tests never ran.
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

**Owner ruling 2026-08-12: certainty over speed.** Every executor runs the FULL
`npm run proof:local` (typecheck + 4124 tests, ~60s) before reporting done, not just
the focused tests for files it touched. A red result is fixed or reverted by that
executor; it never reports done on red. This catches a break at the agent that caused
it instead of at merge time, when attributing a failure across parallel agents is
expensive.

**`proof:local` green is NOT sufficient on its own.** It runs no emulator, so 11
`*.rules.test.ts` suites skip. Any executor deleting or altering code under
`src/services/db/`, `src/server/business/`, or `src/server/share/` MUST additionally
run `npm run test:firebase` before reporting done, and must state in its report which
suites ran versus skipped.

That is the self-check. The real gate is still run by the orchestrator on the merged
chunk:

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

---

## Appendix — findings from the pre-campaign tree triage (2026-08-12)

Two defects surfaced while cleaning the tree. Neither is fixed yet; both are
seeded into the campaign backlog.

### F1 (HIGH) — `build-tire-knowledge.mjs` has no output-sanity guard

`scripts/build-tire-knowledge.mjs` documents itself as failing CLOSED, and it does
guard its INPUTS: active harvester, absent snapshot, CSV parse error, missing
columns. It does not guard its OUTPUT.

Snapshot precedence ends at a committed bootstrap seed
(`src/server/tire-knowledge/seed/tire_corpus_seed.csv`) which currently holds a
header and **2 tire rows**. On any machine without harvester snapshots -- which
includes this one, and would include CI -- running the generator parses that seed
successfully, passes every validation, and atomically overwrites a 79,108-barcode
/ 72 MB index with 2 records. Fail-closed does not fire because nothing is
technically invalid.

Fix: refuse to write when the new index is materially smaller than the existing
one (e.g. < 90% of prior `barcode_index_count`) unless an explicit `--force`
flag is passed, and record the refusal in the status file. Add a regression test
that points the generator at the seed with a large prior index present and
asserts it refuses.

### F2 (MEDIUM) — corpus meta drifts on every patch-style commit

`tireKnowledge.generated.meta.json` is only written by a full generator run, but
the corpus JSON is routinely updated by patch/apply scripts. Six commits now
(77e21892, a1899b16, 3f9d2066, b145de2b, 865ea2ee, 10332fa2) have moved the JSON
without the meta, so the meta's `payload_barcode_count` (78,437) understates the
real index (79,108) and its `payload_sha256` matches nothing on disk.

CORRECTION (2026-08-12): the first draft of this note claimed "no test reads those
counts as truth." That was WRONG. `scripts/refresh-tire-meta.test.mjs` asserts them
against an independent hardcoded oracle and failed the moment the meta was
refreshed. It did its job.

The reason the false claim survived: that test is in `vitest.config.ts`'s exclude
list and runs only under `node --test` via `npm run test:refresh-tire-meta`, so
`proof:local` reported 4128 passing while it was red. This is the SAME blind-spot
class as the `*.rules.test.ts` trap in section 3 -- it bit twice in one session.

RESOLVED: `scripts/refresh-tire-meta.mjs` already existed as the correct fix and was
simply never runnable -- it had a `test:` npm entry but no `run` entry, so nobody
ran it. Added `npm run refresh:tire-meta`, ran it (meta now reports the true 79,108
/ 28,017 / 72,956), and updated the test's oracle constants with a comment
explaining why they must stay hardcoded rather than derived.
