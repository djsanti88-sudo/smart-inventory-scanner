# Weekly Report - Design Spec (merged v2)

Date: 2026-06-28
Owner: Santiago
Status: APPROVED direction, in build. No `src/` app code. Report-only unless `--apply`.

## 1. Goal

One command, `/weekly-report`, producing ONE self-contained HTML owner report (Santiago, a
non-engineer) that answers: what is broken, what is risky, what makes the product less valuable,
what makes it less secure, what blocks sales, what to fix first, and what changed since last time.
Plain English, visual, prioritized, organized BY TEAM, every item NUMBERED. Builds on the existing
`/inventory-review` fleet and `qa:bots`; never replaces them; never touches `src/`.

## 2. Two modes ONLY (no third mode, no deep-plus, one report format)

| Mode | When | Claude fleet | Third-party cash | Depth |
|------|------|--------------|------------------|-------|
| **lean** (default) | regular weekly | ~10 core lenses on Sonnet + final Opus qa-triage | ~$0.15, hard cap $0.50 | single-pass, light verification |
| **`--deep`** | on demand, war-room | full fleet on Sonnet + Opus judges (every high/blocker) + Opus critic + Opus synthesis | up to **$2**, hard cap | adversarial refute, loop-until-dry, judge panels, persona sim, completeness critic, cross-checked decode |

Both render the SAME HTML format. Difference is only how much investigation/verification runs first.
Claude fleet runs on the owner subscription = $0 cash both modes.

**Model routing (owner policy, 2026-06-28).** Haiku: mechanical helpers ONLY (file/artifact finding,
log summarizing, JSON formatting, cheap extraction) - none currently dispatched as agents. Sonnet:
the DEFAULT for all real analysis in BOTH modes (red-team, tenant-isolation, feature-synthesizer,
competitor-intel, the finding-verifier, UX/product/security/business/decode review). Opus: reserved
for crucial judgment - the final owner summary (written by the main agent), the final qa-triage
synthesis, the severity / business-impact / security-data-leak / tenant-raw-barcode-exposure judges,
the completeness critic, and EVERY blocker or high-severity finding (Verify judge panel).
Deep mode does not care about time.

## 3. Two owner requirements baked into the format

1. **Report by teams.** Findings are grouped under five teams, each its own visual section:
   `Technical & QA`, `Security & Data Protection`, `Barcode / Inventory / Decode`,
   `Business & Product`, `Verification & Synthesis`. Each team section has a header, a team score,
   and its numbered findings.
2. **Everything is numbered.** Every finding, recommendation, and proposed fix gets a stable
   reference number (`#1`, `#2`, ...) assigned deterministically at render (sorted severity then
   team). The owner can say "do all except #4 and #9" and the numbers are unambiguous. Top
   Priorities and Proposed Fixes reference the same numbers.

## 4. Architecture

`/weekly-report` command (prose, `.claude/commands/`) drives the run; the heavy parallel verified
judgment is a **budget-capped Workflow** (`scripts/weekly-report.workflow.js`).

```
/weekly-report [--mode=lean|deep] [--deep] [--refresh] [--apply]
  1. Evidence      (main agent: Bash/Read) - branch/commit, changed files, package scripts,
  |                 screenshots manifest, qa:bots + inventory-review reports, intel store,
  |                 API-route map, decode map. `--refresh` -> npm run qa:bots first.
  2. Accuracy bot  (main agent: Bash) - scripts/weekly-accuracy.ts on 10 ground-truth codes.
  |                 Weekly ASKS before paid spend; on-demand runs. Writes accuracy + cost.json.
  3. Judgment WF   (scripts/weekly-report.workflow.js) - fan-out lenses, refute, loop-until-dry
  |                 (deep), judge panels, completeness critic, qa-triage. HARD budget cap.
  4. Render        (main agent: node scripts/lib/report-render.mjs) - deterministic HTML:
  |                 teams, numbered findings, score grid, real screenshots, cost ledger.
  5. Intel+STATUS  (main agent) - update known-issues/scores-history; print STATUS line.
```

Rendering is deterministic (a script), NOT an agent, so screenshot paths are never invented and the
layout is consistent. At most one agent writes the short plain-English owner summary TEXT.

## 5. Agents: ~3 new files, NOT 58

ChatGPT's 58-role list is adopted as LENSES, not as 58 files. Mapping:
- **~50 lenses = existing agents** dispatched by `agentType` (scanner-flow, ux-vision personas,
  accessibility, security, data-integrity, performance-device, chaos-resilience, design-system,
  visual-polish, trust-signals, copy-clarity, decision-fatigue, microinteraction, psychology,
  live-walkthrough, code-review, value-roi, pricing-strategy, retention-churn, conversion-activation,
  growth-loops, marketing-angle, product-strategy, simplicity-enforcer, competitor-intel, qa-triage).
- **Verification + persona roles = INLINE workflow prompts** (refuter x3, evidence-validator,
  severity-judge, business-impact-judge, fix-realism-judge, completeness-critic, sales-demo-critic,
  support-ticket-simulator, skeptical-buyer). These are `agent()` calls in the Workflow, not files.
- **3 NEW agent files** (genuinely missing lenses):
  1. `red-team` - static (grep API routes for missing guards) + active local-only probing
     (authz bypass, IDOR, injection, scrape/flood) against `localhost`, flood path forced to
     IS_E2E mock so it triggers ZERO paid AI. Server down -> static-only, says so.
  2. `feature-synthesizer` - merges value-roi + manager_insights + product-strategy + competitor
     gaps into ONE ranked "killer missing feature" wishlist with ROI.
  3. `tenant-isolation` - the access-model auditor (Section 8).
- **1 edit:** `competitor-intel` -> 7+ competitors + comparison table.

## 6. The judgment Workflow (quality engine)

- **Fan-out:** lean ~10 core lenses; deep full set + ux-vision ALL personas.
- **Adversarial verification (deep):** each finding challenged by refuter + evidence-validator +
  severity-judge + business-impact-judge + fix-realism-judge. Only survivors reach the report.
- **Loop-until-dry (deep):** repeat discovery rounds (security, decode, UX, role/data leaks, sales
  blockers, missing proof) until two consecutive rounds add no new high/medium, OR cap hit, OR a
  safety gate blocks, OR server/artifacts unavailable.
- **Persona simulation (deep):** the 9 personas (Section 8b) each answer the friction questions.
- **Judge panels (deep):** strategy advisors produce several takes; judges score; best synthesized.
- **Completeness critic (deep):** "what did we miss - which screen, claim, endpoint?" -> one more round.
- **Budget enforcement:** Workflow `budget` primitive stops dispatch at cap; report states
  "stopped at budget, N agents skipped".
- **Transparency block (deep):** rounds run, findings proposed, refuted, accepted, downgraded, uncertain.

## 7. Finding format (every finding carries all of this)

`ref` (assigned #), `team`, `title`, `severity` (blocker|high|medium|low|info), `confidence`
(high|medium|low), `area`, `affects` (who), `evidence[]`, `screenshot` (real path or null),
`file` (path/route or null), `businessImpact`, `securityImpact` (if any), `explanation` (plain
English), `fix`, `autoFixable` (y/n), `ownerActionNeeded` (y/n), `refuterResult` (deep), `status`
(new|repeated|worsened|improved|resolved|uncertain).

## 8. Access-model auditor (`tenant-isolation`)

Two distinct meanings of "owner", checked explicitly:
1. **platformOwner / superAdmin / Santiago** (software creator) - MAY see raw barcodes, aliases,
   GTIN/UPC/EAN, raw QR, source evidence, decode logs, AI/provider details, full debug exports.
2. **businessOwner / shopOwner / admin / counter / viewer** (customer-side) - may scan, count,
   approve shop-level review, see product-facing info. MUST NOT extract the raw barcode/alias DB.

Explicit checks (report CURRENT truth; role gating is DEFERRED today so expect "exposed"):
- Can customer-side roles see raw barcodes? Export aliases? Infer the global barcode DB?
- Can they reach another shop's data (Falken/Camel cross-tenant class)?
- Can they see source evidence or AI provider logs?
- Can platformOwner still inspect/repair global data safely?

### 8b. Personas (deep)
platformOwner(Santiago), businessOwner/shopOwner, counter employee, tire technician, brand-new
employee, skeptical buyer deciding on ~$100/mo, bad actor scraping raw barcode/alias data, support
user hitting an unknown barcode, manager trusting the count. Each answers: what confused me, what
slowed me, what built/broke trust, would I pay, what feature makes it obviously valuable, biggest blocker.

## 9. Score grid (16 dimensions, each: 0-100, delta, confidence, plain reason, evidence count, top fix)

overall product readiness, demo readiness, security posture, customer data protection, multi-tenant
isolation, mobile usability, scanner flow, decode accuracy, needs-review quality, AI cost safety,
offline readiness, import/export readiness, business value, pricing confidence, competitive position,
supportability.

## 10. Live accuracy bot (20 general product codes + 100 tire codes = 120)
Standing config (owner, 2026-06-28): `data/accuracy/hard-codes.json` holds `targets {general:20, tire:100}`.
Tire codes are auto-sourced from the trusted tire corpus (real barcode + brand/model), so they are
confirmed and mostly resolve deterministically (corpus hit, ~$0 live). The 20 general codes test the AI
decode path and need owner confirmation. The bot reports general and tire accuracy SEPARATELY.


`scripts/weekly-accuracy.ts` + `data/accuracy/hard-codes.json` (10 codes + expected brand/product/
type). Lean: asks before paid spend, dry mode $0, scores correct/wrong/needs-review. Deep: cross-
checks all 10 across the real decode path (when owner allows), flags weak confidence, source
conflicts, category mismatch, suspicious anatomy; checks deterministic-before-AI, alias-conflict,
wrong-decode correction. Writes accuracy + cost to cost.json. **If the 10 codes are not owner-
confirmed, the report labels the score PROVISIONAL and not trustworthy.**

## 11. Cost ledger (bottom of report)

Two currencies, never conflated:
1. **Claude subscription usage** - "zero out-of-pocket cash under subscription"; estimate agent
   count + approx tokens; label as approximation honestly.
2. **Third-party out-of-pocket** - Gemini, OpenAI, Firecrawl, web search, itemized, total, active
   cap, and whether any calls were skipped / any live-AI gate was not approved.
Backed by `reports/product-intel/<date>/cost.json`; rendered by `scripts/lib/cost-ledger.mjs`.

## 12. Report layout (one HTML, by teams, numbered)

1. Header: product, date, mode, branch, commit, overall score + delta.
2. Owner summary (short, non-technical).
3. Top 5 priorities (plain English, by number).
4. Blockers & regressions (loud, red).
5. Score grid (16, deltas, confidence).
6. Team sections, each with team score and numbered findings + real screenshot thumbs:
   Technical & QA / Security & Data Protection / Barcode-Inventory-Decode / Business & Product /
   Verification & Synthesis.
7. Security red-team + customer-data-protection / raw-code exposure verdict (in the Security team).
8. Decode accuracy scorecard.
9. Competitor comparison table (7+).
10. Missing-feature wishlist (ranked, numbered, ROI).
11. What changed / better / worse / still unknown.
12. Still-open (with age). Proposed fixes (numbered, auto-fixable y/n; applied only with `--apply`).
13. What this report cost (Section 11) - very bottom.

No em or en dashes in any report copy (commas, periods, parentheses, normal hyphens only). Real
screenshot paths only; never invent a thumbnail.

## 13. Optional engines (PENDING owner authorization - baseline works without them)

The red-team and repo-health lenses run on grep + local probing today. They get MUCH stronger with
real engines (all free, local, dev-only, no production, no cloud):
1. **Semgrep** - real SAST (OWASP/CWE/injection/secrets, Next.js rules). Turns red-team static from
   heuristic grep into a real scanner.
2. **gitleaks** - secret scanning across the repo + git history.
3. **osv-scanner** (or `npm audit`, already present) - dependency CVEs / supply chain.
4. **autocannon** - tiny local load tool to PROVE the rate-limit/scrape exposure quantitatively
   against localhost (safe, no paid AI via IS_E2E).
If authorized, the red-team agent and a repo-health lens call these and cite real output. If not,
they run the baseline and the report says "engine not installed, heuristic only".

## 14. File manifest (all additive, nothing in `src/`)

`.claude/commands/weekly-report.md`; `.claude/agents/{red-team,feature-synthesizer,tenant-isolation}.md`;
edit `.claude/agents/competitor-intel.md`; `scripts/weekly-report.workflow.js`;
`scripts/weekly-accuracy.ts`; `scripts/lib/{cost-ledger,report-render}.mjs`;
`data/accuracy/hard-codes.json`; output `reports/product-intel/<date>/{report.html,findings.json,
scores.json,cost.json}`.

## 15. Command behavior

`/weekly-report` = lean. `--deep` = shorthand for `--mode=deep`. `--refresh` = refresh screenshots.
`--apply` = reuse ONLY existing safe `/inventory-review` auto-fix behavior, report-only by default,
no expansion without approval. Scheduling is out of scope now (on-demand works; cron wired later).

## 16. Safety rules

No deploy, push, merge, or production change. No red-team traffic to production. No data
write/delete/mutate during red-team. No auth/CAPTCHA bypass. No secrets or `.env` values printed.
No `src/` edits. No paid live AI unless the owner gate allows. Flood/scrape tests never trigger paid
AI (IS_E2E). No third mode. No separate reports - everything in one HTML.

## 17. Acceptance criteria

1. lean produces the complete HTML (all sections, teams, numbered findings, 7+ competitor table,
   red-team, accuracy scorecard, cost ledger) from existing screenshots.
2. deep runs the verification swarm and stays within the $2 cap + subscription; prints the
   transparency block (rounds/proposed/refuted/accepted/downgraded/uncertain).
3. red-team active layer is localhost-only and triggers ZERO paid AI (IS_E2E proof); static-only fallback.
4. accuracy bot scores 10 codes, dry run spends $0, live run gated; provisional label if codes unconfirmed.
5. cost ledger shows subscription usage + itemized third-party + active cap + any skips.
6. hard caps enforced by the Workflow budget; report says when it stopped at budget.
7. every finding/fix carries a stable number; report is grouped by team.
8. no `src/` change; no deploy/push/merge; no em/en dashes; real screenshot paths only.

## 18. Proof plan

Render a sample report.html from fixture findings -> confirm teams + numbering + score grid +
cost ledger render and the HTML is em/en-dash clean. Accuracy bot dry-run -> $0, prints status.
Red-team -> a scrape/flood test against `/api/ai-lookup` with AI status proving mock mode + a static
finding (no inbound rate limiting). A subagent adversarially reviews the build before handoff.

## 19. Risks

| # | Risk | Sev | Mitigation |
|---|------|-----|------------|
| 1 | Red-team flood triggers paid AI | high | Force IS_E2E mock; assert $0 |
| 2 | Red-team hits cloud/prod | high | Hard localhost allowlist; no write methods; prompt + code guard |
| 3 | Deep overspends third-party | med | Workflow hard cap $2; per-provider caps; emergency stop |
| 4 | Opus weekly quota hit | med | Opus-max only for ~6 agents; Sonnet swarm |
| 5 | Accuracy meaningless w/o ground truth | med | Provisional label until owner confirms 10 codes |
| 6 | Report noise | med | Adversarial verification; precision over volume; qa-triage ranking |
| 7 | Report too long for a non-engineer | med | Depth in engine, brevity up front; teams + numbers keep it navigable |

## 20. Open items needing owner input

1. Authorize which optional engines to install (Section 13).
2. Confirm/correct the 10 hard codes + expected answers in `data/accuracy/hard-codes.json`.
3. (Later) pick the schedule mechanism after the first real report.
