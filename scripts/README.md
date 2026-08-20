# scripts/

Operational tooling for Scanbin. One line per living entry, grouped by domain. Full command reference,
ports, env vars and PAID/LIVE warnings: `docs/COMMANDS.md`. Paid scripts import
`lib/paidScriptGuard.mjs` (`--live --yes-i-accept-cost` + dev-tooling key); `paidScriptGuard.enforcement.test.mjs`
walks this whole folder and fails on any unguarded billed call.

## Gates, dev, release (wired into package.json)

- `proof-all.mjs` - THE honest local gate (`npm run proof:all`): tsc + vitest + the vitest-excluded node:test suites + teach suite + orphan-test self-detection. Node:test suites that need gitignored local data self-skip visibly (`lib/localDataSkip.mjs`).
- `dev.mjs` + `dev-environment.mjs` - backend-safe dev launcher (mock / emulator / prod banner).
- `release-hygiene.mjs`, `release-sentinel.mjs` (`release:check`, `deploy:card`) - read-only uncommitted/unpushed/undeployed checks.
- `deploy-preview.mjs` - the only sanctioned emergency preview-deploy path; runs `check-fix-lineage.mjs`, `check-env-parity.mjs` (+ `env-manifest.json`, var NAMES only) and `smoke-fingerprint.mjs` (+ `smoke-expected.json`; also run by `.github/workflows/post-deploy-smoke.yml`).
- `vercel-ignore-build.mjs` - Vercel `ignoreCommand` (see `vercel.json`).
- `patch-jwks-rsa.cjs` - postinstall patch (jose v6 ESM) for the Admin SDK on Vercel.
- `provision-worktree.mjs` - copies the generated corpus DB and stress fixtures into a fresh worktree.
- `check-section.mjs` - `npm run check:section`: review the project one `codemap.json` section at a time.
- `hooks/` - Fable 5 review-engine Claude Code hooks.

## Knowledge corpus (tire + retail)

- `build-tire-knowledge.mjs` (+ `corpusRules.mjs`) - canonical generator of the committed tire index; output-sanity shrink guard.
- `refresh-tire-meta.mjs` - metadata-only refresh of the tire index meta (`npm run refresh:tire-meta`).
- `build-tire-exact-index.mjs` - read-only projection of the approved corpus + boss reconciliation into the exact-index shards.
- `build-retail-knowledge.mjs`, `retailImportGuard.mjs`, `import-retail-turso.mjs`, `retail-quality.mjs` - retail index generation, import guard, Turso import, quality checks.
- `build-knowledge-db.mjs` - tire + retail JSON -> SQLite `knowledge.generated.db` (`npm run build:knowledge-db`).
- `import-tires-turso.mjs`, `pilot-apply-turso.mjs`, `pilot-backfill-worklist.mjs` - Turso tire import and the Point S pilot tooling.
- `tire-db-repair/` - the numbered repair/reconcile/promote pipeline (runbook inside).
- `prefix-mining/` - GS1 prefix -> brand derivation tooling and its CSV inputs (`data/tire-knowledge/prefixes/`).
- `kkm-catalog/`, `distributor-catalog/` - distributor catalog ingestion.
- `barcode-harvester/` (generic Playwright scraper) and `dt-harvest/` (the weekly Discount Tire harvest job, cron-registered).
- `corpus-purge.mjs` - quarantine corpus rows learned from a paid source; `purge-*-examples.mjs` - remove textbook GS1 example rows.
- `decode-cache-backup.mjs`, `decode-outcomes-report.mjs` - dump/restore the paid decode cache; offline outcome rollup.

## Boss barcode certification

- `certify-boss-barcodes.mjs` (direct mode), `boss-workbook-reconcile-dryrun.mjs`, `boss-override-2026-08-05.mjs`, `assert-tire-exact-index-trace.mjs`. UI-mode harnesses live in `e2e/boss-barcode-corpus/` and `e2e/boss-barcode-preview/`.

## Decode proofs and benchmarks (mostly PAID; all guarded)

- `eval-decode.ts`, `benchmark-decodes.ts`, `live-decode-smoke.ts`, `scan-matrix.mjs`, `build-golden-baseline.mjs` (regenerates `benchmarks/golden/`).
- `proof-full-ladder.mjs`, `proof-rung-{corpus,goupc,3-fetchv2,4-gpt}.mjs`, `gpt-ladder-live-proof.mts`, `model-bakeoff.mjs` (the guard's reference pattern).
- `fetchv2-benchmark.mts`, `fetchv2-discovery-shootout.mts`, `fetchv2-forensic.mts`, `fetchv2-db-sample*.mjs`, `fetchv2-ladder-handoff.mjs`.
- `polish-backfill.mts`, `polish-eval.mts` - deterministic structurer backfill and eval.
- `stress/` - decode-ladder stress harness and Vercel env key sync.
- `archive-tmp-2026-07/` - frozen July-2026 tmp probes; named in the guard test's exclusion list, safe to delete on owner order.

## Cloud, accounts, data

- `cloud-smoke.mjs` (`test:firebase:cloud-smoke`), `create-god-account.mjs`, `repair-god-alias.mjs`, `seed-business-catalog.ts`, `seed-tires-from-corpus.ts`, `verify-live-scans.ts`, `backfill-missing-tires.mjs` (owner-gated paid).

## Weekly intelligence

- `weekly-report.mjs` (`npm run weekly-report`, merged QA bots + intel; `weekly-report.workflow.js` is its judgment-fleet workflow), `weekly-intel.mjs` (`intel:now`), `weekly-tire-scan.ts`, `weekly-accuracy.ts`, `build-report-html.mjs`, `render-report-pdf.mjs`, `email-report.mjs`, `register-weekly-task.ps1`, `validate-agents.mjs`, `build-oracle-codes.mjs` (Teach Bot oracle).

## Shared

- `lib/` - `paidScriptGuard.mjs`, `localDataSkip.mjs`, `load-env.mjs`, `cost-ledger.mjs`, `prefix-miner.mjs`, `publish-gap.mjs`, `report-render.mjs`.
- `__tests__/` - vitest specs for the report/prefix/validate helpers.
