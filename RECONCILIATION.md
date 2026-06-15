# Instruction Reconciliation

Per `ENGINEERING_DOCTRINE.md`. Records when old project instructions were reconciled against the
doctrine and the owner's current instructions.

## 2026-06-14 — A/B/C batch

- **Files inspected:** `ENGINEERING_DOCTRINE.md` (global), `CLAUDE.md`, `AGENTS.md`, `PROGRESS.md`,
  `DECISIONS.md`, `TESTING.md`, `plans/2026-06-decode-speed-and-pagefetch.md`, plus the source files
  for the three features (`decode.ts`, `scanStore.ts`, `route.ts`, `settings/page.tsx`, `csvExport.ts`,
  `types.ts`).
- **Instruction files found:** CLAUDE.md (project rules), AGENTS.md (Next 16 caveat), the doctrine, prior
  PROGRESS/DECISIONS/TESTING.
- **Conflict found:** the decode-speed hotfix left a note "No UI changes (no FinalCountTable remove row)".
  This batch deliberately adds UI (Settings decode-budget input [B]; "Clean junk product rows" + Undo [C]).
- **Resolution:** the owner's explicit A/B/C approval is a current owner instruction, which outranks an older
  project note (hierarchy: current owner instruction > doctrine > project docs > older notes). The intent
  also differs — C is a backed-up, reversible *bulk* cleanup, not a per-row delete control. Adopted the new
  UI; the older "no UI changes" note is treated as scoped to that earlier hotfix only.
- **Rules adopted:** doctrine proof gates, server-side clamp, no-partial labeling, backup-before-data-change,
  semantic firewall (untrusted data), data-safety over convenience (no destructive persist-version bump).
- **Rules overridden:** "No UI changes" (older hotfix note) — superseded for this approved batch.
- **Open questions / blockers:** none. (Owner offered the option to make C headless instead of a button; not
  requested, so the button + Undo were built.)
- **Marker:** A/B/C reconciliation complete 2026-06-14.

## 2026-06-14 — Shared catalog + recommendation-first cleanup

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

## 2026-06-14 — Confidence-based auto-verify (speed-first)

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
