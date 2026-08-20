> FROZEN ARCHIVE (2026-08-19). Historical log; cites the retired ENGINEERING_DOCTRINE.md. Living
> risks now live in REPO_HEALTH.md (Known issues); decisions in DECISIONS.md.

# Instruction Reconciliation

Per `ENGINEERING_DOCTRINE.md`. Records when old project instructions were reconciled against the
doctrine and the owner's current instructions.

## 2026-06-14 - A/B/C batch

- **Files inspected:** `ENGINEERING_DOCTRINE.md` (global), `CLAUDE.md`, `AGENTS.md`, `PROGRESS.md`,
  `DECISIONS.md`, `TESTING.md`, `docs/archive/superpowers/plans/2026-06-decode-speed-and-pagefetch.md`, plus the source files
  for the three features (`decode.ts`, `scanStore.ts`, `route.ts`, `settings/page.tsx`, `csvExport.ts`,
  `types.ts`).
- **Instruction files found:** CLAUDE.md (project rules), AGENTS.md (Next 16 caveat), the doctrine, prior
  PROGRESS/DECISIONS/TESTING.
- **Conflict found:** the decode-speed hotfix left a note "No UI changes (no FinalCountTable remove row)".
  This batch deliberately adds UI (Settings decode-budget input [B]; "Clean junk product rows" + Undo [C]).
- **Resolution:** the owner's explicit A/B/C approval is a current owner instruction, which outranks an older
  project note (hierarchy: current owner instruction > doctrine > project docs > older notes). The intent
  also differs - C is a backed-up, reversible *bulk* cleanup, not a per-row delete control. Adopted the new
  UI; the older "no UI changes" note is treated as scoped to that earlier hotfix only.
- **Rules adopted:** doctrine proof gates, server-side clamp, no-partial labeling, backup-before-data-change,
  semantic firewall (untrusted data), data-safety over convenience (no destructive persist-version bump).
- **Rules overridden:** "No UI changes" (older hotfix note) - superseded for this approved batch.
- **Open questions / blockers:** none. (Owner offered the option to make C headless instead of a button; not
  requested, so the button + Undo were built.)
- **Marker:** A/B/C reconciliation complete 2026-06-14.

## 2026-06-14 - Shared catalog + recommendation-first cleanup

- **Files inspected:** `ENGINEERING_DOCTRINE.md`, `CLAUDE.md`, `AGENTS.md`, `PROGRESS.md`, `DECISIONS.md`,
  `TESTING.md`, `RISK_REGISTER.md`, plus resolver/store/settings/route/types/mockDb/seed/NeedsReviewTable source.
- **Instruction files found:** doctrine + project CLAUDE.md (resolver trust rules; "AI is a suggestion, never truth,
  never auto-saved"; semantic firewall; persist-no-wipe) + prior reconciliations.
- **Conflicts found:** none new. The catalog reinforces existing rules (catalog-first = a stronger version of the
  resolver's "verified/approved only = known"; AI-never-overwrites-verified extends "AI never sets verified").
- **Owner correction applied:** lookup order changed so a private shop override is checked BEFORE the global catalog.
- **Rules adopted:** provider abstraction (no cloud dep); verified-status (not confidence) gates auto-resolve; privacy
  separation; recommendation-first cleanup with owner-only final action + backup + Undo; clean-env precheck (always
  `cd` before tests).
- **Rules overridden:** none.
- **Open questions / blockers:** none. (Admin review UI intentionally deferred per owner Q9=B; data model is in place.)
- **Marker:** catalog/cleanup reconciliation complete 2026-06-14.

## 2026-06-14 - Confidence-based auto-verify (speed-first)

- **Files inspected:** doctrine + CLAUDE.md + PROGRESS/DECISIONS/TESTING/RISK_REGISTER + the evidence layer
  (evidenceVerifier, decode types), catalog services, scanStore catalog-first/liveDecode, sanitizer/pageFetch SSRF.
- **Owner correction applied:** speed-first - score the evidence the decode already returns; NO extra network calls;
  preserve the ~3-4s path; only weak/conflicting/unsafe/AI-only-no-evidence go to Needs Review.
- **Conflict found + resolved:** the prior blanket auto-add ("medium confidence auto-adds too", `autoAddDecodedProducts`)
  conflicts with the new confidence policy. Resolved: confidence-gated auto-verify replaces blanket auto-add;
  suggested-without-exact-evidence -> Needs Review; `autoAddDecodedProducts=false` kept as a manual-mode master gate.
  Four tests that encoded the old behavior were re-pointed to the new intent (not weakened).
- **Reinforces existing rules:** "AI is a suggestion, never truth, never auto-verifies"; verified data wins; semantic
  firewall + SSRF + PII sanitize all reused unchanged.
- **Rules overridden:** the older "auto-add any verified/suggested decode" behavior only.
- **Open questions / blockers:** none. Direct trusted-source fetching (manufacturer/registry) remains a documented
  placeholder (SSRF-sensitive) - tiers are classified from the decode's existing cited URLs.
- **Marker:** auto-verify reconciliation complete 2026-06-14.

## 2026-07-12 - Docs reorganization + decode-ladder reconciliation

- **Trigger:** owner order to update and organize all MD files to current standards and progress.
- **Files inspected:** ENGINEERING_DOCTRINE.md (global), CLAUDE.md, AGENTS.md, README.md, PROGRESS.md,
  DECISIONS.md, TESTING.md, CHANGELOG.md, LESSONS_LEARNED.md, RISK_REGISTER.md, docs/CURRENT_CONTEXT.md,
  docs/superpowers/plans/2026-07-09 + 2026-07-10, src/server/upc/ladder.ts (source-verified rung order).
- **Conflict found + resolved:** CLAUDE.md's "MASTER BASELINE v1" said decode is GEMINI-FIRST then
  ChatGPT sequential. The built reality on `feat/decode-ladder-goupc` is the cost-ordered ladder
  (local corpus -> Go-UPC -> Fetch V2 -> GPT-5.5) with Gemini permanently OUT of decode (hidden
  grounding billing, L11). Resolution: current owner-approved ladder spec + built code outrank the
  older baseline note; CLAUDE.md updated to LADDER BASELINE v2 with the v1 note kept as history.
  Guardrails carry over unchanged (brand-prefix/family sanity, store auto-count gate, evidence
  verification, test safety).
- **Stale docs resolved:** historical point-in-time reports moved to `docs/archive/` (git mv, history
  preserved) with an index README; PROGRESS.md's 2026-06 phase log archived verbatim to
  `docs/archive/PROGRESS_HISTORY_2026-06.md`; README.md rewritten from create-next-app boilerplate;
  docs/CURRENT_CONTEXT.md rewritten from the 2026-06-15 Track-1 snapshot (durable outcomes folded in).
- **Rules adopted:** doc-hygiene ownership zones (machine-regenerable vs human-owned; flag stale human
  prose, never delete); LESSONS_LEARNED L11-L13 added (the risk register already cited L11).
- **Rules overridden:** the two-provider/Gemini-first decode baseline text only.
- **Open questions / blockers:** push/deploy/T9-backfill/harvest-schedule remain owner decisions
  (PROGRESS.md "Pending owner decisions").
- **Marker:** docs reconciliation complete 2026-07-12.

## 2026-07-29 - Docs consolidation wave (chore/docs-consolidation, agent B7)

- **Trigger:** owner-ordered multi-agent docs consolidation to replace stale-banner band-aids across
  the doc set with verified current content, following the 2026-07-29 `docs(m0)` living-docs merge
  (commit `685f6282`) and the product-readiness master-plan audit.
- **Files inspected:** `CLAUDE.md`, `AGENTS.md`, the global doctrine
  (`ENGINEERING_DOCTRINE.md`/`AUTO_ROUTER_DOCTRINE.md`/`PROJECT_BRAIN_DOCTRINE.md`/
  `BIG_PLAN_EXECUTION_DOCTRINE.md`), `GUARDRAILS.md`, `docs/README.md`, `docs/DEPLOY_TRUTH.md`,
  `docs/RECOVERY.md`, `REPO_HEALTH.md`, `PROGRESS.md`, `docs/GO_LIVE_CHECKLIST.md`, `docs/BACKLOG.md`,
  `docs/superpowers/plans/2026-07-29-product-readiness-master-plan.md`, plus git history for the
  `docs(m0)` merge commit and the deletions of `docs/decode/`, `CHANGELOG.md`, and
  `docs/CURRENT_CONTEXT.md`.
- **Instruction files found:** `GUARDRAILS.md` (new tiny always-loaded standing-invariant anchor,
  covering counting/identity, safety/secrets, decode discipline, and planning); `docs/README.md`'s
  L0-L4 doc hierarchy table (Global doctrine / Root canonical / Topic docs / Work artifacts /
  Skill-agent-hook local) with an explicit promotion law (an L4 citation of a rule CLAUDE.md doesn't
  actually contain is a hierarchy defect, fix by promoting up); `docs/superpowers/plans/` newest-dated
  file as the phase-source-of-truth pointer (currently the 2026-07-29 product-readiness master plan
  for prioritization, still `2026-07-19-master-plan.md` for the completed 6-phase register).
- **Conflicts found:** none new for this wave's scope. `docs/GO_LIVE_CHECKLIST.md` and
  `docs/BACKLOG.md` both carried stale-banner placeholders from 2026-07-27/2026-07-12 pointing at
  `PROGRESS.md`/`DEPLOY_TRUTH.md`/`REPO_HEALTH.md` as current truth rather than stating that truth
  directly - resolved by rewriting both against those sources rather than leaving the redirect.
- **Rules adopted:** `GUARDRAILS.md` as the always-loaded anchor for standing invariants (counting law,
  safety/secrets, decode discipline, planning discipline), each line pointing at its full L1/L2 home;
  the L0-L4 doc hierarchy and promotion law in `docs/README.md` as the standing rule for where a new
  durable fact belongs; the newest-dated file in `docs/superpowers/plans/` as the phase/priority
  pointer, with the 2026-07-29 product-readiness master plan now the priority ordering for backlog
  work (`docs/BACKLOG.md` updated to point at it as primary, itself demoted to secondary hygiene
  punch-list).
- **Rules overridden / retired:** `docs/CURRENT_CONTEXT.md` and root `CHANGELOG.md` as standalone
  files - both retired/merged in the `docs(m0)` commit (`685f6282`, 2026-07-29): CHANGELOG frozen
  verbatim to `docs/archive/CHANGELOG_v1-v2.md`, CURRENT_CONTEXT's poison-guard hazard carried forward
  into `PROGRESS.md` + `RISK_REGISTER.md` rather than kept as a separate snapshot file. The QA trio
  (`docs/QA_BOTS.md`, `docs/REVISION_GATE.md`, `docs/AGENT_BOT_ROLES.md`) as three independently
  canonical standalone docs - same commit merged them into `docs/QA_BOTS.md` as the single canonical
  source, with the other two retained as thinner pointers rather than parallel sources of truth.
  `docs/decode/` as a doc location - deleted in commit `1b53cca5` (superseded by
  `docs/DECODER_ARCHITECTURE.md`, which is the sole canonical decode-pipeline doc per `CLAUDE.md`).
- **Unresolved conflicts:** none found in this agent's owned scope
  (`docs/GO_LIVE_CHECKLIST.md`, `docs/BACKLOG.md`, `RECONCILIATION.md`). Two pre-existing, tracked
  code-round items remain open per `REPO_HEALTH.md` (not reconciliation conflicts, just pending
  fixes): `src/eval/eval.test.ts` still writes to the deleted `docs/decode/eval-baseline.md` path
  (try/catch-wrapped, harmless), and `src/services/decode/{index.ts,contract.ts,README.md}` comments
  still cite the deleted `docs/decode/ARCHITECTURE.md` instead of `docs/DECODER_ARCHITECTURE.md`.
- **Marker:** docs-consolidation wave-2 (agent B7) reconciliation complete 2026-07-29.
