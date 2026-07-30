# Product-Readiness Master Plan — from engineered to sellable at $150/mo

- **Author:** Opus (orchestrator)
- **Date:** 2026-07-29
- **Status:** DRAFT — synthesized from an 8-agent GA gap-audit + a 6-reviewer docs-plan attack panel. PLAN-ONLY (nothing executed this session). Awaiting owner review.
- **North star:** a B2B inventory-scanner SaaS a company pays **$150/month** for — product-ready, not patchwork. Every milestone below is justified against that.

---

## Goal

Ship a multi-tenant B2B inventory-scanner SaaS that a company can sign up for, pay **$150/month**, and rely on to count and reconcile their stock — reliably, legally, and without data loss. **Success = a real paying company using it end to end, not an engineering demo.** This plan turns the already-strong scan / decode / reconcile engine into a product by building the commercial, operational, and legal wrapper it currently lacks.

## 1. Headline

**You have an unusually strong engine with almost no car around it.** Every audit agent independently reached the same shape: the core (scan → count → sync, decode ladder, tenant-isolation *code*, reconciliation matching) is mature, deterministic, and heavily tested — genuinely better than most competitors. But the **commercial, operational, and legal wrapper a company pays for is near-zero**: no billing, no alerting, no backups turned on, no legal docs, and an unresolved question of whether production is even in live-auth mode.

Stop patching the engine. Build the car.

## 2. GA readiness scorecard (audit scores, 0-100)

| Dimension | Score | State |
|---|---|---|
| Security architecture (auth, sanitizer, key-safety) | 78 | STRONG — keep |
| Onboarding / activation | 58 | Good loop, reward mis-fires |
| Reconciliation value | 55 | Real engine, wrong packaging |
| Product/GA strategy | 55 | Great execution docs, no commercial artifact |
| Customer data protection | 55 | Built, not enforced in prod |
| Multi-tenant isolation (in prod) | 40 | Proven in emulator only |
| Observability | 30 | Logs exist, nobody is paged |
| Legal / compliance | 28 | BLOCKERS — no ToS/Privacy/DPA/ODbL |
| Backup / disaster recovery | 22 | BLOCKERS — PITR/delete-protection OFF |

## 3. Critical unknowns — RESOLVED (verified live, 2026-07-29 evening)

- **Production auth mode = LIVE.** Verified from the production JS bundle itself: the baked-in `NEXT_PUBLIC_AUTH_MODE` literal is `"﻿live"` (BOM + "live"; `authMode.ts`'s `.trim()` rescues it — the BOM is a latent gotcha: any code comparing the raw env var without trim would silently fail to `mock`; fix the env var value in Vercel at next touch — **OWNER-GATED: editing a Vercel production env var is a prod-config change, do not perform without explicit owner approval; it is folded into the gated M2 auth-flip work**). `docs/GO_LIVE_CHECKLIST.md` is the stale doc; `docs/DEPLOY_TRUTH.md:193` was correct. Real tenancy enforcement is ACTIVE in production.
- **Firestore PITR + delete protection = ALREADY ENABLED.** Verified via live Admin API read of `projects/smart-inventory-scanner-app/databases/(default)`: `POINT_IN_TIME_RECOVERY_ENABLED`, `DELETE_PROTECTION_ENABLED`, `versionRetentionPeriod=604800s` (7 days). Timestamps indicate enablement ~2026-07-30T01:14Z (very recent). `docs/RECOVERY.md` F-08 is now stale → update in M0. **Still open from RECOVERY.md:** the restore drill has never been run (do once, record result), and F-01/F-07 (stale deployed rules/indexes) still need the redeploy + verification.

Consequence: the two worst "stop the bleeding" items are done. M1 shrinks; alerting/uptime and the `catalogEntries` leak become its headline items.

## 3b. v2 — the 10x revision (owner-approved 2026-07-29)

The v1 milestones below remain the work inventory, but v2 changes HOW they run. Owner constraints honored: **no outside people available** (no lawyer, no pilot shops, no network) — work with what we have; everything aligns to the $150/mo goal even where we are not there yet.

**A. Three parallel lanes replace the serial queue** (same work, much shorter wall-clock):
- **Lane 1 — Safety/ops actions** (mostly Claude-executed now that owner delegated them): ~~check prod auth mode~~ DONE (live). ~~Enable PITR + delete protection~~ DONE (verified). Remaining: run + record the restore drill; redeploy stale rules/indexes (F-01/F-07); uptime monitor (needs a free account — owner-gated signup, per no-account-signup rule); Stripe account EXISTS already (owner-confirmed, parked until needed).
- **Lane 2 — Engineering waves** (the M1–M3 items, executed by the big-plan machine, below).
- **Lane 3 — Virtual shops + evidence**: build 3–5 simulated businesses from the EXISTING harness (scanbin-shop-owner skill, QA personas, teach bot) — e.g. a tire shop with ~800 tires, a small repair shop, a chaotic-spreadsheet shop — living in the app daily (scan, typo, ugly-import, reconcile, return next day). Their friction orders the backlog, replacing the pilot shops we don't have. HONEST LIMIT: virtual shops prove the product works; only a real human eventually proves the price. A "find one real shop" step stays parked for later.

**B. Sell-story commitments** (owner-approved):
- **ICP = tire shops.** v1 is FOR tire shops (78k-tire corpus is the moat). General retail matching cut from v1 scope.
- **The pitch = "we found you $X."** Dollar-variance in reconciliation is both the killer demo and the price justification ("your records say 412, you have 389 — ~$2,800 missing"). Pull the M3 dollar-variance item forward; it IS the sales asset.
- **Price sanity-check** (Claude-executed, web research only): competitor pricing scan + value math + a draft cheap/standard/premium menu. $150/mo stays the north-star target pending evidence.
- **Billing path for customers 1–5 = Stripe Payment Link** (zero code, account already exists) + manual access gating; build full Checkout/webhooks/plan-gating only when manual stops scaling.

**C. Claude-executed support tasks** (owner delegated; run in the execution session): AI-drafted ToS + Privacy Policy from standard templates, clearly labeled "professional review required before charging real companies"; PostHog (free tier, already installed) wired to the signup→first-scan→return→reconcile funnel so virtual-shop and later real usage is measured, not guessed.

**D. Execution engine (owner-specified):** the big-plan machine. Fable orchestrates when available (fallback per doctrine); many agents run at once, each may spawn its own sub-agents; when an agent finishes and work remains it is retired and replacements spawn — the pool stays full until the work is done, always at max useful parallelism, serialize only true file conflicts. Batched gates; phase-end ultra review. NOTHING runs until the owner says execute.

## 4. The five milestones (sequenced to owner priority: reliability + tenancy first, then sell layer, then legal)

> **SEQUENCING OVERRIDE (owner v2, §3b-B): the "we found you $X" dollar-variance demo is the SALES WEAPON and does NOT wait for M1/M2.** It ships in **M1 alongside Lane 3's first virtual shop** so a shareable proof asset ("your records say 412, you have 389 — ~$2,800 missing") exists BEFORE billing is wired. Billing, alerting, and legal are what you need to *charge*; the $X number is what makes someone *want* to pay. Build the want first. The M3 dollar-variance row below is therefore pulled forward (marked ⏫).

### Milestone 0 — Grounding foundation (ends the patch cycle)
Detail lives in `docs/superpowers/plans/2026-07-29-docs-consolidation-and-repo-health.md` (already attacked by 6 reviewers; apply their fixes). Summary:
- `GUARDRAILS.md` (auto-loaded every session) with the $150/mo north star on top + the owner-approved invariants (every-scan-counts, each-scan-once, counts-are-a-calculator/AI-suggests, AI-identity-is-a-suggestion-promoted-via-review-list, markWrong-moves-never-deletes, no-deploy/push/paid-without-OK, keys-server-side-every-env, strip-private-info-before-AI, semantic-firewall, Gemini-out, pay-once-ladder, decode-is-enrichment-only, brainstorm/acceptance-criteria/attack-panel/write-plans, tests-first, fan-out-in-waves-until-done-max-efficiency, root-cause-not-symptom, proof-before-done, no-em-dash).
- `REPO_HEALTH.md` sync-truth doc + propose-only branch report (~60 branches; `audit-fixes` unpushed).
- Docs consolidation: archive 60 historical plans (fix: also update live `.ts`/`.spec` citations that reference them), retire/merge overlapping living docs, `docs/README.md` index, resolve the FIREBASE_SETUP vs DEPLOY_TRUTH and prod-mode contradictions, promote the 5 orphaned facts, tech-debt ledger folded into `REPO_HEALTH.md` (standalone `KNOWN_ISSUES.md` cancelled per docs-plan §8b.1).
- **Reviewer-mandated additions:** preserve the `benchmark-tire-db-automation` "do-not-merge/152k-line poison-guard" warning (currently only in CURRENT_CONTEXT.md); hash-verify the Turso backup before any `backups/` delete; sweep the missed clusters (`docs/decode`, `docs/pilot`, `docs/reviews`, `docs/playwright`, `testing/app-knowledge`); update CLAUDE.md QA-bot citations; keep `mine-report.md`/`siblings-report.md` tracked.

### Milestone 1 — Stop the bleeding (data safety + visibility)
*Do first — if prod is live, customers are exposed today.*

| Item | Effort | ROI | Owner-gated? |
|---|---|---|---|
| ~~Enable Firestore PITR + delete protection~~ **DONE, verified live 2026-07-29**; remaining: run + record a restore drill; redeploy stale rules/indexes F-01/F-07 (`docs/RECOVERY.md`) | S | H | Yes |
| Fix "Clear local cache" wiping un-synced scans; block/warn on pending>0; migrate pending queue to IndexedDB | M | H | No |
| Add error tracking + alerting (Sentry free tier or Vercel log-drain→webhook) on kill_switch/cap_blocked/breaker_open/5xx | M | H | Yes (account) |
| Add `/api/health` + external uptime monitor (UptimeRobot/BetterStack free) | S | H | Yes (account) |
| ⏫ **SALES WEAPON (pulled from M3):** opt-in locally-stored unit-cost column → dollar variance in reconcile, run against Lane 3's first virtual shop, capture a shareable "we found you $X" screenshot/short clip as the demo asset | M | H | No |
| Surface kill-switch state in Settings (add to GET payload + banner) | S | M | No |
| Fix public `catalogEntries` leak (businessId + free-text dispute reasons readable unauthenticated) | S/M | H | No |
| Persist bucketed decode latency + outcome-mix for trend visibility | S/M | M | No |
| Harden `post-deploy-smoke.yml` (flagged by security review 2026-07-29): checkout the default branch and pass the deployment SHA as data (or verify SHA is an ancestor of the protected branch) instead of `ref: github.sha`. Low risk today (solo repo, contents:read, no secrets, persist-credentials:false — deliberate design per in-file comment) but required before collaborators/public PR previews exist | S | M | No — but file is in-flight audit-fixes work; coordinate |

### Milestone 2 — Make it sellable (charge money)
> Billing sequencing per §3b-B: **customers 1–5 = Stripe Payment Link (zero code, account already exists) + manual access gating.** Do NOT build Checkout/webhooks/plan-gating until manual gating actually stops scaling — coding a full billing system before customer #1 is exactly the patching-instead-of-selling trap the owner wants to avoid.

| Item | Effort | ROI | Owner-gated? |
|---|---|---|---|
| Resolve + flip production to `live` auth; complete remaining `GO_LIVE_CHECKLIST.md` steps; verify isolation with 2 real accounts + `test:firebase:cloud-smoke` | L | H | Yes |
| **Billing v1 (customers 1–5): Stripe Payment Link + manual access gating by businessId** — zero code, ships this week | S | H | Yes (Stripe acct exists) |
| Billing v2 (DEFERRED until manual stops scaling): Stripe Checkout + subscription + webhook plan-gating | L | H | Yes — do NOT build pre-revenue |
| ~~Per-tenant usage/cost metering~~ **CORRECTED 2026-07-29 (H2 scout): per-account daily-cap metering is ALREADY BUILT and wired** (`src/services/security/aiSpendGuard.ts`, `perAccountDailyKey`/`chargePerAccountDailySlot`, distinct namespace per `businessId`). The real M2 gap is **plan-tier differentiation of that cap** (today one global default limit, not tier-scoped) **+ owner/customer-facing usage visibility** (no UI surfaces the per-account count/cap today), not building metering from scratch. See `docs/superpowers/specs/2026-07-29-m2-engineering-specs.md`. | S/M | H | No |
| Self-serve signup polish + rewrite `workspace_failed` recovery UX + member-management UI. **NOTE 2026-07-29: partially built already** (workspace_failed retry path and a member UI exist in some form per H2's scout); this item is polish/completion, not greenfield. Live-auth is verified (see §3, "Production auth mode = LIVE"), so the signup-spec dependency this item used to block on is resolved. See `docs/superpowers/specs/2026-07-29-m2-engineering-specs.md`. | M | H | Depends on auth flip |

### Milestone 3 — Win the sale (value + trust)
| Item | Effort | ROI | Owner-gated? |
|---|---|---|---|
| Reconciliation: accept XLSX/TSV (not just Shop-Ware CSV), de-brand the page, merge the two upload surfaces, multi-session scope | S→M | H | No |
| ⏫ **MOVED TO M1** — dollar variance ("we found you $X") is the sales weapon and ships early; see M1 | — | — | — |
| Activation: fire the counted-quantity panel for EVERY scan outcome, not only `known` | S | H | No |
| Activation: "Try a sample scan" affordance; first-run nav hierarchy | S | M | No |
| Role-gate `unitCost`/margin from `counter`/`viewer` (Firestore rule + FinalCountTable) | S | M | No |
| Visual polish / trust pass (deferred agent — schedule a dedicated review) | M | M | No |

### Milestone 4 — Don't get sued
> **Resource reality (owner: NO lawyer available).** Per §3b-C, legal docs are **AI-drafted from standard templates now**, published with a clear "professional review pending before charging at scale" banner. This UNBLOCKS charging your first few virtual-shop-validated customers without a lawyer in the loop. A paid professional review is a **parked** item for when revenue justifies it — it must NOT block the first-dollar path. Only ODbL attribution (a factual credit line, no lawyer needed) and the US geo-fence are true pre-charge musts.

| Item | Effort | ROI | Owner-gated? |
|---|---|---|---|
| AI-draft ToS + Privacy + short-form DPA from templates, publish with "professional review pending" banner — unblocks first customers without a lawyer | M | H | No (Claude-executed per §3b-C) |
| ODbL/Open Food Facts attribution — factual credit line + RISK_REGISTER entry + visible notice (no lawyer needed) | S | H | No |
| US-only geo-fence at launch (sidesteps GDPR/EU paperwork entirely) | S | H | No |
| Confirm Firecrawl commercial-use authorization for a paid product | S | M | Yes |
| Sub-processor disclosure (OpenAI/Gemini/Firecrawl 30-day retention) in Privacy/DPA | S | M | No |
| PARKED (revenue-gated, not pre-launch): paid legal review of the AI-drafted docs; sales-tax nexus monitoring; trademark clearance on "Scanbin" | — | L | Deferred |

## 5. Out of scope / what NOT to build now (freeze — per product-strategy)
- Further decode-ladder precision/evidence tuning (already mature).
- KKM isolated-catalog + further harvest/weekly-intel tooling (corpus depth ≠ first customer).
- Deeper platformOwner/customer data-governance beyond what shipped.
- Automating the Vercel dashboard step beyond doing it once.

## 6. Risks
- **Prod mode ambiguity** (Milestone 0 unknown) — until resolved, we don't know if we're protecting live customer data or a demo. Resolve before anything else.
- ~~Unmetered per-tenant AI cost~~ **CORRECTED 2026-07-29: per-account metering already exists** (`aiSpendGuard.ts`); the live risk is no plan-tier caps + no usage visibility (see M2 correction, §4) + no billing. Onboarding a paying customer before tier caps/billing exist can still lose money silently.
- **Editing load-bearing files while pre-existing `audit-fixes` code changes sit uncommitted** — keep Milestone-0 commits doc-only; never entangle.
- **Legal blockers are cheap to fix, catastrophic to skip** — do not charge a customer before ToS/Privacy/DPA + ODbL are handled.

## 7. Proof approach
- Docs/grounding (M0): link-check, grep for single-source-of-truth, doc-only diffs.
- Code milestones (M1-M3): TDD (failing test first), `test:ledger` on any counting change, `test:firebase` on any rules/tenancy change, `qa:bots:*` for customer-facing flows, browser proof for UX.
- Every "done" claim backed by a run + output. No fake proof.

## 8. Open decisions for the owner
1. Confirm the roadmap ordering (this plan puts reliability/observability + tenancy before billing, per your priority picks; you can move billing earlier if monetizing sooner matters more).
2. ~~Resolve the prod mock-vs-live unknown~~ **RESOLVED: prod is LIVE** (verified from the production bundle, §3).
3. ~~Tires-first wedge vs general retail~~ **DECIDED 2026-07-29: tire shops are the v1 ICP**; general retail cut from v1 (§3b-B).
4. Say "execute" when ready — the big-plan machine (§3b-D) starts Lane 1 + Lane 2 wave 1 + Lane 3 virtual-shop build in parallel. Until then, nothing runs.

## 9. Acceptance criteria (definition of GA-done)

- **M0:** `GUARDRAILS.md` exists and auto-loads every session; `REPO_HEALTH.md` live; exactly one docs index; the prod-mode and FIREBASE_SETUP/DEPLOY_TRUTH contradictions resolved in-doc.
- **M1:** Firestore PITR + delete-protection ON and a restore drill executed + recorded; "Clear local cache" cannot silently destroy un-synced scans; error tracking + alerting fire on kill_switch/cap_blocked/breaker/5xx; `/api/health` + external uptime monitor live; public `catalogEntries` no longer exposes raw businessId/dispute text.
- **M2:** prod auth mode confirmed; if selling, `AUTH_MODE=live` with tenant isolation proven by two real accounts + `test:firebase:cloud-smoke`; Stripe billing live and access gated by plan per businessId; per-tenant paid-decode cost metered and capped (**metering itself already exists**; the remaining acceptance bar is plan-tier caps + visible usage, per the 2026-07-29 correction above).
- **M3:** reconciliation accepts CSV/TSV/XLSX from any POS, de-branded, optional dollar variance; the counted-quantity panel fires on **every** scan outcome, not only `known`; `unitCost` role-gated from `counter`/`viewer`.
- **M4:** AI-drafted ToS + Privacy + DPA published with "professional review pending" banner; ODbL attribution in place + a tracked `RISK_REGISTER.md` entry; US geo-fence live; Firecrawl commercial-use confirmed; sub-processors disclosed. (Paid legal review, sales-tax nexus, trademark = parked, revenue-gated.)
- **Per item:** the relevant gate passes (`test:ledger` for counting, `test:firebase` for rules/tenancy, `qa:bots:*` for customer-facing flows) and a browser/proof artifact exists for UI changes. No "done" claim without a run + output.

## 10. Rollback / recovery

- **M0 (docs):** doc-only commits on `chore/docs-consolidation`; `git revert` or branch-drop restores instantly; archives are `git mv` (history preserved), never `rm`.
- **M1:** PITR/delete-protection are additive toggles; alerting/uptime are external and removable; the `catalogEntries` rules change is revertible via `firebase deploy` of the prior ruleset.
- **M2:** the auth flip is a single env var (`NEXT_PUBLIC_AUTH_MODE`) revertible to `mock`; Stripe stays in test mode until explicit go-live; the billing gate sits behind a feature flag.
- **M3 / M4:** each change is behind a feature flag or purely additive; legal docs are additive.
- **Global:** no production promote / paid-live call / real-data mutation happens without the owner's in-the-moment approval; every risky step is individually revertible.

## 11. Files to touch / affected files / implementation files (by milestone)

- **M0:** `CLAUDE.md`, `AGENTS.md`, `README.md`, **new** `GUARDRAILS.md`, **new** `REPO_HEALTH.md` (includes the tech-debt/KNOWN_ISSUES ledger section), **new** `docs/README.md` (index + L0-L4 hierarchy section), `docs/archive/**`, the merged/retired living docs. (Per docs-plan §8b.1, standalone `docs/DOC_HIERARCHY.md` and `docs/KNOWN_ISSUES.md` are CANCELLED — folded into `docs/README.md` and `REPO_HEALTH.md`.)
- **M1:** `docs/RECOVERY.md` (owner steps), `src/stores/scanStore.ts` (`clearLocalCache` ~6677), `src/stores/scanPersistStorage.ts`, `src/app/api/ai-lookup/route.ts`, `src/app/api/telemetry/route.ts`, **new** `src/app/api/health/route.ts`, `firestore.rules` (catalogEntries), `src/server/catalog/catalogDispute.ts`, `src/services/security/aiSpendGuard.ts`, `src/app/(app)/settings/page.tsx`.
- **M2:** `src/services/auth/authMode.ts`, Vercel prod env, **new** billing module (Stripe route + webhook + plan model), `src/types.ts` (Plan/Subscription), `src/lib/auth.ts`, member-management UI.
- **M3:** `src/components/ReconcilePanel.tsx`, `src/services/reconcile/*`, `src/services/universalFileReader.ts`, `src/components/ScannerInput.tsx`, `src/components/Nav.tsx`, `firestore.rules` + `src/components/FinalCountTable.tsx` (cost role-gate).
- **M4:** **new** `/terms`, `/privacy`, `/legal` pages; `RISK_REGISTER.md`; ODbL notice surface; `data/retail-knowledge` attribution.

## 12. Cost / budget

- **This planning + audit:** ran on the Claude Code subscription (no per-call dollars — reported as effort, never fabricated spend). The Codex plan-review runs on the ChatGPT subscription (Lane 1). Zero paid product-API calls were made this session.
- **Execution external costs (all owner-gated):** Stripe (percentage of revenue, no fixed floor); a lawyer for ToS/Privacy/DPA + ODbL/Firecrawl review (the largest line item); Sentry + uptime monitor (free tiers viable at launch scale); Firestore PITR (small storage cost); a possible Firecrawl commercial-tier upgrade. No unmetered paid-AI spend is introduced — the per-tenant decode caps in M2 bound variable cost before a second customer is onboarded.

## 13. Review provenance (this plan was attacked before you saw it)

- **8-agent GA gap-audit** (product-strategy, tenant-isolation, observability, backup-recovery, security, legal-compliance, conversion-activation, value-roi) produced the scorecard and every work item.
- **Fable 5 / Argus** `review-plan` ran deterministically; this revision adds the Goal / Acceptance / Rollback / Out-of-scope / Files / Cost sections it required. Argus "missing file" flags for `DEPLOY_TRUTH.md:193`, `GO_LIVE_CHECKLIST.md:37-39`, `authMode.ts:22-27` are verified false positives (files exist, lines valid). `docs/README.md`, `GUARDRAILS.md`, `REPO_HEALTH.md`, `docs/archive/superpowers/INDEX.md` are intentional new-file deliverables of M0 (`docs/DOC_HIERARCHY.md` + `docs/KNOWN_ISSUES.md` cancelled per docs-plan §8b.1, folded into those files).
