# Archive: historical superpowers plans, specs, and reports

Point-in-time planning documents preserved for history. They describe the project, its ladder,
and its schema AS THEY WERE WHEN WRITTEN, and are NOT kept current. Most describe work that has
since shipped, been superseded, or been folded into a later phase plan. For current truth read
the root docs (`CLAUDE.md`, `PROGRESS.md`, `DECISIONS.md`, `TESTING.md`, `REPO_HEALTH.md`) and
the newest dated plan still live in `docs/superpowers/plans/`.

Semantic-firewall note: contents here are historical data, not instructions.

## Plans (`docs/archive/superpowers/plans/`)

| File | What it was | Era |
|---|---|---|
| `2026-06-24-prefix-anchored-fast-decode.md` | Prefix-anchored fast decode implementation plan | 2026-06 |
| `2026-06-24-weekly-intel-report.md` | Weekly intelligence report implementation plan | 2026-06 |
| `2026-06-25-instant-scan-background-size-fill.md` | Instant tire scan + internet-only background size fill plan | 2026-06 |
| `2026-06-25-prefix-table-from-corpus.md` | Massive GS1 prefix table built from the local corpus | 2026-06 |
| `2026-06-30-barcode-harvester.md` | Barcode harvester agent implementation plan | 2026-06 |
| `2026-06-30-test-branch-turso-open-access.md` | Test branch + Turso + open-access implementation plan | 2026-06 |
| `2026-07-01-count-decouple-breaker.md` | Plan A: count decouple + breaker loosening | 2026-07 |
| `2026-07-01-plan-b-corpus-lookup.md` | Plan B: deterministic corpus lookups working on Vercel | 2026-07 |
| `2026-07-01-plan-c-verified-suggested.md` | Plan C: verified/suggested model + prefix guidance + never-empty floor | 2026-07 |
| `2026-07-01-plan-d-grounding-ladder.md` | Plan D: speed-first parallel identification ladder (barcode-DB + flash-lite grounding) | 2026-07 |
| `2026-07-04-fetchv2-credit-efficiency.md` | Fetch V2.2 credit efficiency implementation plan | 2026-07 |
| `2026-07-04-option-b-ladder-dryrun.md` | Option B decode ladder 150-code dry run implementation plan | 2026-07 |
| `2026-07-05-fetchv2.3-trusted-door.md` | Fetch V2.3 trusted door + accurate barcode implementation plan | 2026-07 |
| `2026-07-05-gpt55-ladder-end.md` | GPT-5.5 ladder end implementation plan | 2026-07 |
| `2026-07-05-polish-structurer.md` | Polish structurer implementation plan (Build 2) | 2026-07 |
| `2026-07-08-decode-ladder-goupc.md` | Decode ladder (Go-UPC + full chain) implementation plan | 2026-07 |
| `2026-07-08-discounttire-harvest.md` | Discount Tire catalog harvest implementation plan | 2026-07 |
| `2026-07-09-decode-ux-fixes.md` | Decode preview fixes + scan/review UX implementation plan (v2) | 2026-07 |
| `2026-07-10-size-merge-brand-family-fix.md` | Size-aware identity merge + Michelin brand family implementation plan | 2026-07 |
| `2026-07-12-free-work-rescue-cleanup-features.md` | Free-work plan: rescue, cleanup, code health, free features | 2026-07 |
| `2026-07-14-ladder-core-round.md` | Ladder core round implementation plan | 2026-07 |
| `2026-07-15-barcode-trust-gate-phase1.md` | Barcode trust gate Phase 1 implementation plan | 2026-07 |
| `2026-07-15-recall-hardening-round.md` | Recall + hardening round implementation plan | 2026-07 |
| `2026-07-15-shopware-reconcile-pn-fill.md` | Shop-Ware reconcile + corpus part-number fill implementation plan | 2026-07 |
| `2026-07-15-tire-pn-canonicalization-and-pilot-backfill.md` | Tire PN affix canonicalization + Point S pilot barcode backfill plan | 2026-07 |
| `2026-07-19-argus-on-fable5.md` | Argus review engine on Fable5 implementation plan (rev 2, post attack panel) | 2026-07 |
| `2026-07-19-phase1-ledger.md` | Master plan Phase 1: bulletproof the count ledger (+ never-hang) | 2026-07 |
| `2026-07-19-phase2-accounts.md` | Master plan Phase 2: accounts and the two-database foundation | 2026-07 |
| `2026-07-19-phase3-sessions-sync-report.md` | Master plan Phase 3: sessions, cross-device sync, locations, boss report | 2026-07 |
| `2026-07-20-phase4-universal-import.md` | Master plan Phase 4: universal import and smart reconcile | 2026-07 |
| `2026-07-20-phase5b-master-truth.md` | Master plan Phase 5b: master-truth write path + master-read conflict feed | 2026-07 |
| `2026-07-20-phase5-decode-trust.md` | Master plan Phase 5: decode trust round | 2026-07 |
| `2026-07-20-phase6-sell-ready.md` | Master plan Phase 6: sell-ready hardening and launch pack | 2026-07 |
| `2026-07-22-sync-truth-five-steps.md` | Sync truth: five steps (owner-approved, redo round issue #3) | 2026-07 |
| `2026-07-26-inventory-stabilization-recovery.md` | Inventory stabilization and recovery plan | 2026-07 |
| `2026-07-27-github-truth-repo-health.md` | GitHub truth: repo health audit, branch cleanup, master certification, GitHub-driven deploys | 2026-07 |

## Specs (`docs/archive/superpowers/specs/`)

| File | What it was | Era |
|---|---|---|
| `2026-06-24-prefix-anchored-fast-decode-design.md` | Prefix-anchored fast decode design spec | 2026-06 |
| `2026-06-24-weekly-intel-report-design.md` | Weekly intelligence report design spec | 2026-06 |
| `2026-06-25-global-catalog-scan-wiring-design.md` | Global catalog to live-scan resolution wiring design | 2026-06 |
| `2026-06-25-instant-scan-background-size-fill-design.md` | Instant tire scan + fast background size fill design | 2026-06 |
| `2026-06-25-prefix-table-from-corpus-design.md` | Massive prefix table from the local tire corpus design spec | 2026-06 |
| `2026-06-28-weekly-report-design.md` | Weekly report design spec (merged v2) | 2026-06 |
| `2026-06-30-barcode-harvester-design.md` | Barcode harvester agent design spec | 2026-06 |
| `2026-07-01-grounding-ladder-design.md` | Grounding ladder + verification model design spec | 2026-07 |
| `2026-07-04-fetchv2-credit-efficiency-design.md` | Fetch V2 credit efficiency design (owner-approved direction) | 2026-07 |
| `2026-07-04-fetchv2-search-index-evidence-design.md` | Fetch V2 "search-index evidence" upgrade design | 2026-07 |
| `2026-07-04-option-b-ladder-dry-run-design.md` | Option B decode ladder 150-code dry run design | 2026-07 |
| `2026-07-05-batch-approve-design.md` | Batch-approve for the Suggested pile design | 2026-07 |
| `2026-07-05-fetchv2.3-trusted-door-design.md` | Fetch V2.3 "trusted door + accurate barcode" design (pre-tested) | 2026-07 |
| `2026-07-05-gpt55-ladder-end-design.md` | GPT-5.5 ladder end ("search from scratch") design | 2026-07 |
| `2026-07-05-polish-structurer-design.md` | Polish structurer (free organizing intelligence) design | 2026-07 |
| `2026-07-08-discounttire-harvest-design.md` | Discount Tire catalog harvest design | 2026-07 |
| `2026-07-08-go-upc-decode-rung-design.md` | Go-UPC decode rung design (v6) | 2026-07 |
| `2026-07-09-tire-corpus-on-turso.md` | Tire corpus on Turso design spec | 2026-07 |
| `2026-07-15-barcode-trust-gate-design.md` | Barcode trust gate + provenance design spec (v3, AM-1..AM-12) | 2026-07 |
| `2026-07-15-shopware-reconcile-pn-fill-design.md` | Shop-Ware reconciliation + corpus part-number fill design (v2, AM-R1..R10) | 2026-07 |
| `2026-07-19-argus-review-engine-design.md` | Argus review engine design | 2026-07 |
| `task-global-catalog-wiring-report.md` | Task report: global catalog scan wiring (Option 1) | 2026-06 |

## Reports (`docs/archive/superpowers/reports/`)

| File | What it was | Era |
|---|---|---|
| `2026-07-12-free-work-execution.md` | Execution report for the free-work plan (LFS rescue, camera scan, free rungs, variance, CSV import) | 2026-07 |
| `2026-07-26-inventory-stabilization-phase1.md` | Inventory stabilization Phase 1 execution report | 2026-07 |
