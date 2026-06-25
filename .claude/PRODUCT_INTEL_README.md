# Smart Inventory - Product-Intelligence Review (on-demand AI judgment fleet)

This is the **AI judgment layer** ported from the Sharpenly "21-agent weekly review", adapted for
this inventory scanner. It is the missing half of what this repo already has: the existing
`qa:bots` Playwright suite is the deterministic *capture* layer (it drives the app, asserts facts,
and drops screenshots). This adds a fleet of Claude specialists that *look at* those screenshots and
write a scored, plain-English HTML product-intelligence report (first impression, UX, design, trust,
decision load, plus inventory-specific scanner-flow, data-integrity, and role/privacy lenses).

It is **report-only by default**, runs **on demand** (no scheduler), and **never deploys, never
pushes, never spends on live AI**. Everything here is additive markdown under `.claude/`; delete the
folder to remove it.

## Run it (inside this project, in Claude Code)

```
/inventory-review --mode=daily  --target=local            # quick read of the latest local proof
/inventory-review --mode=daily  --target=live  --refresh  # re-run live bots, then judge real data
/inventory-review --mode=weekly --target=live  --refresh  # full fleet against the real god account
```

- `--target=local` uses the mock/bypass bots (deterministic, $0). `--target=live` uses the real
  cloud Firebase backend + real god-account login (needs `GOD_EMAIL` / `GOD_PASSWORD` in env; the
  AI route is mocked so there is no live spend).
- `--refresh` re-runs the bots first (`npm run qa:bots` or `qa:bots:live`) to regenerate
  screenshots. Without it, the review judges whatever proof already exists in `e2e/proof/`.
- `--apply` (off by default) lets it apply only low-risk visual fixes on a `qa/auto-<date>` branch,
  gated by `simplicity-enforcer` + `lint` + `test`. It never touches resolver/idempotency/security.

## Output

`reports/product-intel/<date>/report.html` - a self-contained HTML dashboard (open it in a browser),
plus `scores.json` and `findings.json`. A small `reports/product-intel/_intel/` store keeps
`known-issues.json` + `scores-history.json` + `PLAYBOOK.md` so repeat runs dedup, detect
regressions, and track score trends.

## The fleet (`.claude/agents/`)

**First-look + UX:** first-impression, ux-vision (multi-persona), decision-fatigue, psychology
**Design + feel:** design-system, trust-signals, microinteraction, simplicity-enforcer
**Inventory-specific (the high-value adds):** scanner-flow, data-integrity, chaos-resilience
**Safety:** security (secrets/XSS + role/tenant leak + price masking - your Falken/Camel leak class)

The synthesis brain is the `/inventory-review` command, which picks the fleet by mode, merges and
dedups findings, scores, and writes the HTML report.

## What was intentionally dropped from the Sharpenly version

`educational`, `content-viz`, `cultural` (bilingual), `gamification-retention`, `virality`,
`attention-eyeflow` - those judge a bilingual learning/quiz app and do not map to a B2B inventory
scanner. `competitor-intel`, `performance-device`, `code-review`, `product-strategy`, and a deeper
`qa-triage` are easy to add later if you want them; ask and they can be ported in the same style.

## Relationship to the existing bots

This does not replace `npm run qa:bots`, `qa:bots:live`, `qa:revision`, or the Human Bot Proof Gate.
Those still prove *facts* (security leaks, data integrity, resolution accuracy) and remain the
release gate. This review adds *judgment* (is it confusing, does it look trustworthy, where is the
friction) on top, on demand.
