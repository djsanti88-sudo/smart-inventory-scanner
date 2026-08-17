# Command Reference

> Every npm script and notable manual script, verified against package.json 2026-07-19.
> Money rule: anything marked **PAID** or **LIVE** is owner-gated. Never run those without explicit
> approval (Engineering Doctrine + Paid API Cost Truth Rule).

## Port map

| Port | Used by |
|---|---|
| 3000 | `npm run dev` default |
| 3100 | Mock Playwright E2E (`playwright.config.ts`, pinned so server and tests never disagree) |
| 3200 | Firebase-emulator Playwright E2E (`playwright.firebase.config.ts`); also `INTEL_PORT` default |
| 3300 | QA human-bots (`playwright.bots.config.ts` and `.bots.cloud.config.ts`) |
| 3400 | Fable 5 measured personas, preview stress runs, and the boss corpus certification harness (e2e/boss-barcode-corpus/production-server.mjs). The harness serves a synthetic allowlist; real accounts always get trusted-exact misses here by design. |
| 8080 / 9099 / 4001 | Firestore emulator / Auth emulator / emulator UI |

## Fable 5 review engine

The Windows wrapper `.\fable5.cmd` and `python -m tools.fable5` are equivalent.

| Command | What it does | Cost and approval |
|---|---|---|
| `python -m tools.fable5 doctor` | Inventories local tools, agents, skills, plugins, and project commands. Add `--json` for machine output. | Free, offline. |
| `python -m tools.fable5 review-plan <plan.md>` | Audits plan structure and verifies acceptance-criterion proof commands, paths, screenshots, and reports. | Free, offline. |
| `python -m tools.fable5 review-build --gate fast|pr|release|monthly` | Runs the selected evidence gate and writes a PASS/BLOCK verdict. PR and monthly include mutation probes; monthly includes personas. | Fast, PR, and release are local by default. Monthly personas use Claude subscription tokens. Safety flags require their matching approval. |
| `python -m tools.fable5 review-build --with-experts` | Adds risk-routed Claude reviewers, verified findings, the findings ledger, and a fix packet. | **SUBSCRIPTION**: requires `claude.ai` auth with no API-key source. Nonzero reported cost fails unless owner-approved `--allow-paid-fallback` is passed. |
| `python -m tools.fable5 review-build --personas` | Measures three localhost flows on port 3400 and produces $150/month purchase verdicts from existing agents. Monthly enables it automatically. | **SUBSCRIPTION** plus local browser work. Uses the same billing preflight. |
| `python -m tools.fable5 review-build --mutation` | Probes changed TypeScript modules in one temporary worktree with shared `node_modules`; automatic for PR and monthly. | Free, offline. No install or native rebuild. |
| `python -m tools.fable5 selftest` | Runs the five isolated detector canaries without worktrees or npm. | Free, offline. |
| `python -m tools.fable5 stress --target <url>` | Runs the fail-closed scan stress battery. Localhost must use port 3400; cloud needs `--allow-cloud`. | Local is free. Every preview run is owner-gated; the monitor aborts on any AI lookup. |

## Teach Bot (live-app learning harness)

Built on `feat/teach-bot` / `feat/teach-bot-clean` (not yet on master; unverified as of 2026-07-22
whether merged). Batch A modules shipped: `e2e/teach/{knowledge,ladder,manifest,sheets,triage}.mjs`
+ matching `node:test` suites, driving `testing/app-knowledge`, `testing/specs`, and
`testing/tests/{candidates,permanent}`.

| Script | What it does | Status |
|---|---|---|
| `npm run teach` | Runs `e2e/teach/teach.mjs` (the harness entry point) | `e2e/teach/teach.mjs` does not exist yet on this branch as of 2026-07-22 - package.json script currently points at a file not yet built |
| `npm run teach:cleanup` | Runs `e2e/teach/cleanup.mjs` | Same gap - file not yet present |
| `npm run teach:test` | `node --test "e2e/teach/**/*.test.mjs"` - the Batch A node:test suite (knowledge/ladder/manifest/sheets/triage) | Exists, runs today |
| `npm run teach:regression` | `playwright test --config=playwright.teach.config.ts` - runs `testing/tests/permanent` against `TEACH_TARGET_URL` (defaults to the real production deployment, no local webServer) | Config exists; this is a LIVE-app-driving config, not mock E2E - treat as owner-gated like other live/production-facing runs |

## Dev servers

| Script | What it does |
|---|---|
| `npm run dev` | Mode-switching launcher (`scripts/dev.mjs`). Default = MOCK backend (`NEXT_PUBLIC_FIREBASE_BACKEND=0`, auth bypass on), green banner, then `next dev`. Pass-through args: `npm run dev -- --port 3100`. |
| `npm run dev:emulator` | Firebase EMULATOR backend. Requires `npm run emulators` running separately. Yellow banner. Local only. |
| `npm run dev:prod` | **LIVE**: real cloud Firestore writes on every scan (`NEXT_PUBLIC_FIREBASE_ALLOW_PROD=1`). Red banner. Owner opt-in only. |
| `npm run emulators` | Firebase Auth (9099) + Firestore (8080) emulators, UI on 4001. |

## Build / lint / typecheck

| Script | What it does |
|---|---|
| `npm run build` | `next build` (no turbopack, deliberate; see DECISIONS.md). |
| `npm run start` | `next start` after a build. |
| `npm run lint` | ESLint flat config. Custom rule: `src/app/api/**` may not import the client Firebase SDK. |
| `npm run proof:all` | THE gate: typecheck + every vitest project + the vitest-excluded node:test suites + teach-bot suite + test-file discovery; prints an explicit NOT RUN list. Use this, not `proof:local`, before claiming green. |
| `npm run proof:local` | `tsc --noEmit && vitest run` (typecheck + vitest only; blind to the node:test suites). |
| `npm run proof:full` | proof:local + `next build`. |

## Unit tests (Vitest)

| Script | What it does |
|---|---|
| `npm run test` | All Vitest projects once: `unit` (node env: services/eval/server/app/scripts) + `dom` (jsdom: components/stores/camera). |
| `npm run test:watch` | Watch mode. |
| `npx vitest run <path>` | ONE test file, e.g. `npx vitest run src/services/resolver.test.ts`. |
| `npx vitest run <path> -t "name"` | One test by name within a file. |
| `npm run test:ledger` | Crown invariant suite: 8 pinned files proving books balance, retry-is-no-op, markWrong transfer, merge union, provenance, replay, ladder timeout. Run for ANY counting change. |
| `npm run test:golden` | Golden Baseline Gate: owner-loved 100/100 preview baseline, corpus slice, deterministic offline (Turso forced off). |
| `npm run test:corpus-drift` | Local corpus gate (plain filesystem reads, no Turso, no skip; wired into `qa:revision`). Three checks: the REAL payload barcode key count in `tireKnowledge.generated.json` stays above a 1%-under floor derived at runtime from `meta.json`; payload is never POORER than the manifest (enrichment pipelines legitimately write the payload ahead of the manifest, but payload < manifest means a stale-snapshot regen wiped enrichments - fails); 10 golden barcodes still resolve. |
| `npm run test:firebase` | `firebase emulators:exec` + the `src/services/db/firebase` suite (tenant isolation via real firestore.rules, audit append-only). These tests self-skip under plain `npm run test`. |

Known flake: `cloudDrainRace.store.test.ts` is timing-flaky only under full parallel load; passes isolated.

## E2E (Playwright)

First time on a machine: `npx playwright install chromium`.

| Script | Config / port | What it does |
|---|---|---|
| `npm run test:e2e` | `playwright.config.ts` / 3100 | The mock E2E suite (~33 specs; excludes firebase-phase2, human-bots). webServer env pins `IS_E2E=1` (AI route forced mock - the guarantee that E2E can never spend money), auth bypass, mock backend. Proof screenshots: `e2e/proof/`. |
| `npx playwright test e2e/scan.spec.ts` | same | One spec. `-g "title"` for one test. |
| `npm run test:e2e:firebase` | `playwright.firebase.config.ts` / 3200 | Emulator-backed E2E with REAL login UI (no bypass). Run only via this script (it wraps emulators:exec). |
| `npm run qa:bots` | `playwright.bots.config.ts` / 3300 | All human-like QA bots, mock backend, screenshot every step. Reports: `reports/human-bots/`. |
| `npm run qa:bots:tire` / `:security` / `:ux` / `:manager` / `:data` / `:performance` | same | Individual bot scenarios (see `docs/QA_BOTS.md`, `docs/AGENT_BOT_ROLES.md`). `qa:bots:all` = explicit no-filter alias of `qa:bots`. |
| `npm run qa:bots:live` | `playwright.bots.cloud.config.ts` / 3300 | **LIVE**: real cloud Firebase, real login (needs `GOD_EMAIL`/`GOD_PASSWORD`), AI still mocked. Stop other dev servers first. |
| `npm run qa:revision` | - | The full handoff gate: tsc + eslint (src e2e) + build + mock E2E + test:firebase + qa:bots. See `docs/REVISION_GATE.md`. |
| `npm run qa:weekly-report` | - | Bot subset bundled for the weekly report. |

## Release / hygiene

| Script | What it does |
|---|---|
| `npm run release:check` | `scripts/release-sentinel.mjs`: pure read-only deploy-safety gate (facts in, blockers/warnings out). Never mutates. |
| `npm run deploy:card` | Same sentinel, deploy-card output mode. |
| `node scripts/release-hygiene.mjs` | Git-only uncommitted/unpushed check (repo lives on OneDrive; pushing is the real backup). `--json` for machine output. |

## Deploy (GitHub-driven: PR = preview, merge to master = production)

Full mechanics and current truth: `docs/DEPLOY_TRUTH.md` - read it before reasoning about any of
this. Short version: opening a PR against `master` gets an automatic Vercel preview URL; merging to
`master` automatically deploys production and triggers the post-deploy smoke workflow. A merge or
push to `master` is therefore an owner-gated production action: explicit owner approval in the
current conversation, every time.

`node scripts/deploy-preview.mjs` is **preview-only** (never `--prod`). It is emergency-only: use it
only when GitHub-driven previews are themselves unavailable (e.g. the Vercel Git integration is down
or misconfigured), not as a routine alternative to opening a PR. It acquires the `.deploy-lock`, runs the fix-lineage and
env-parity gates below, runs a plain `vercel deploy` (never `--prod`), then the post-deploy smoke
fingerprint; `--dry-run` exercises the lock/gates with no `vercel`/network call. It requires the same
explicit owner authorization as any other deploy action before use. A raw `vercel deploy` still works
and skips the lock and both gates - avoid it even so.

Production promote/rollback (`vercel --prod`, `vercel promote`, `vercel rollback`, `vercel alias set`)
is **owner-only** and hard-blocked at the tool layer by `.claude/hookify.vercel-prod-gate.local.md` -
it will not run from an agent session without explicit in-conversation owner approval, even if a
prior session already approved something similar. `npm run deploy:rules:prod` (Firestore security
rules) is a separate production surface outside Vercel entirely and stays owner-gated independently -
merging a PR to master never touches Firestore rules. Run
`npm run release:check` / `npm run deploy:card` (`scripts/release-sentinel.mjs`, see above) as the
preflight gate before proposing any deploy action, GitHub-driven or emergency.

| Script | What it does |
|---|---|
| `node scripts/deploy-preview.mjs [--dry-run]` | Emergency-only preview-deploy wrapper: lock + fix-lineage gate + env-parity gate + `vercel deploy` (preview only) + smoke fingerprint. Requires owner authorization; not the routine path once GitHub-driven previews are live. |
| `node scripts/check-fix-lineage.mjs [ref]` | Fails if `master` (or a pinned commit in `scripts/fix-lineage-pins.json`) is not an ancestor of `ref` (default `HEAD`). |
| `node scripts/check-env-parity.mjs [--env=production\|preview]` | Diffs Vercel env var NAMES (never values) against `scripts/env-manifest.json`'s required/forbidden sets. |
| `node scripts/smoke-fingerprint.mjs <url> [--expect-lineage-mismatch]` | Post-deploy GET-only checks: `/api/ai-lookup` capability JSON, route fingerprint, failed-deploy masquerade page detection. |

## Data / corpus pipelines (local, no paid calls)

| Script | What it does |
|---|---|
| `npm run build:tire-knowledge` | Regenerates the committed tire corpus JSON from a harvester snapshot. Fails closed. |
| `npm run build:knowledge-db` | Builds `src/server/knowledge.generated.db` (better-sqlite3) from the JSON indexes. Needs the 4GB heap flag it already carries. |
| `node scripts/decode-cache-backup.mjs --dump` / `--restore <file>` | Backs up / restores the PAID decode cache to `backups/*.jsonl` so a Turso wipe never forces re-paying decodes. Existing rows win on restore. |
| `npm run eval-decode:corpus` | Scores the generated server-only tire index as ground truth. No AI, no server, no network. |
| `npm run intel:report` | Builds the HTML report from existing intel JSON artifacts (free, offline). |
| `npm run intel:validate` | Validates `.claude/agents/*.md` house style (frontmatter, no em/en dash). Free. |

## PAID / LIVE scripts - owner approval required before EVERY run

| Script | Spend |
|---|---|
| `npm run live-decode-smoke` | GET-only free; **PAID** when `LIVE_AI_TEST=1` (real Gemini/OpenAI). |
| `npm run eval-decode` (`--live`) | Default prints instructions ($0); `--live` is **PAID**, bounded to 10 codes. |
| `npm run benchmark` | **PAID** live ladder benchmark; hard cap 400 Firecrawl credits (`BENCHMARK_FIRECRAWL_CAP`). |
| `npm run intel:now` / `intel:tire-scan` / `npm run weekly-report` | **PAID** live decode monitoring (cents/run) + Gmail send. |
| `npm run harvest` / `harvest:discount-tire` / `harvest:test` | **LIVE** web scraping of retailer sites via Playwright (ToS-sensitive, not billed). Bare `harvest` requires `--site <name>`; `harvest:test` caps at 5 pages, visible browser. |
| `npm run test:firebase:cloud-smoke` | **LIVE** cloud Firebase writes (self-cleaning throwaway business). |
| `node scripts/create-god-account.mjs` / `repair-god-alias.mjs --repair` | **LIVE** real-account provisioning / repair (repair is read-only without `--repair`). |
| `node scripts/gpt-ladder-live-proof.mts`, `scripts/fetchv2-*.mts` | **PAID** provider/discovery probes (credit-capped). |
| `npm run deploy:rules:prod` | **LIVE** deploys `firestore.rules` + `firestore.indexes.json` to the REAL production project (`smart-inventory-scanner-app`, alias `prod` in `.firebaserc`). Not billed, but production-affecting: a wrong rules push changes who can read/write real customer data. Owner approval required before every run. |
| `node scripts/model-bakeoff.mjs` | Dry run (default, $0): prints which models/how many calls WOULD run + a worst-case cost floor, exits 0. **PAID** only with BOTH `--live` and `--yes-i-accept-cost`, and only after `BAKEOFF_OPENAI_KEY`/`BAKEOFF_GEMINI_KEY` are set (dev-tooling-only vars - it never reads `.env.local`'s Lane 2 `OPENAI_API_KEY`/`GEMINI_API_KEY`). Up to `count`(default 10) x 5 models live calls to `api.openai.com` and `generativelanguage.googleapis.com`. Not wired into `package.json`. |
| `LIVE_AI_TEST=1 node scripts/weekly-accuracy.ts` | Safe by default (dry run, $0, prints what would run) unless `LIVE_AI_TEST=1` is set, in which case it POSTs real codes through the app's own `/api/ai-lookup` route (spending against the app's Lane 2 live provider keys), cost-capped via `THIRDPARTY_CAP_USD` (default $0.50 lean / $2 deep). Requires a running dev server. Not wired into `package.json`. |
| `node scripts/import-retail-turso.mjs --force` | **LIVE**: `--force` on an existing >3M-row Turso `retail` table DROPs it and reimports from the local `retailKnowledge.generated.json`. Guarded (F1-style, mirrors `build-tire-knowledge.mjs`): refuses the drop when the local source has under 90% of the live table's row count, unless `--force-shrink` is ALSO passed for a deliberate replacement. Not billed by a provider, but destructive to the production retail corpus - owner approval required before every `--force` run. |
| `node scripts/phase05-prefix-cleanup.mjs`, `scripts/phase1-enrich-build.mjs` | Dry run (default, $0): prints the plan + a worst-case cost floor, exits 0. **PAID** only with BOTH `--live` and `--yes-i-accept-cost`, and only after `PHASE05_GEMINI_KEY` / `PHASE1_GEMINI_KEY` are set (dev-tooling-only vars via `scripts/lib/paidScriptGuard.mjs` - never `.env.local`'s Lane 2 `GEMINI_API_KEY`). `phase1-enrich-build.mjs` also overwrites `src/services/catalog/derivedPrefixMap.json` when live. Hard-capped $10 / $3 respectively. Not wired into `package.json`. |
| `node scripts/proof-full-ladder.mjs`, `scripts/proof-rung-goupc.mjs`, `scripts/proof-rung-3-fetchv2.mjs`, `scripts/proof-rung-4-gpt.mjs` | **LIVE ladder-proof harnesses**: spawn a real `next dev` server with REAL `.env.local` keys and drive it through curated code sets, spending real Go-UPC/Firecrawl/GPT money. All four require BOTH `--live` and `--yes-i-accept-cost` (via `scripts/lib/paidScriptGuard.mjs`); bare invocation now prints a worst-case cost floor and exits 0, $0 spent (previously `proof-full-ladder.mjs` and `proof-rung-goupc.mjs` had no gate at all - fixed 2026-08-13). Spend caps documented in each file's header. Not wired into `package.json`. |
| `npx tsx scripts/fetchv2-benchmark.mts`, `scripts/fetchv2-discovery-shootout.mts`, `scripts/fetchv2-forensic.mts`, `scripts/gpt-ladder-live-proof.mts`, `scripts/stress/rung-isolated-test.mts` | **PAID** Fetch V2 / GPT discovery probes (Brave, Firecrawl, OpenAI), credit/dollar-capped per file. All now require `--live` (`fetchv2-discovery-shootout.mts` defaults to a $0 mock self-test without it) AND `--yes-i-accept-cost` via `scripts/lib/paidScriptGuard.mjs`; `fetchv2-forensic.mts` and `rung-isolated-test.mts` previously had NO gate at all - fixed 2026-08-13. Not wired into `package.json`. |
| `node scripts/stress/sync-preview-keys.mjs` / `sync-production-keys.mjs` | Owner-authorized 2026-07-20: copies already-configured key VALUES from `.env.local` straight into Vercel's preview/production env store (values never printed). Not a paid-API-calling script itself - allowlisted in `scripts/paidScriptGuard.enforcement.test.mjs` with a written reason rather than gated, since it makes no billed call of its own. Owner approval required before every run (it mutates the deployed env). |

Cost truths that always apply: a client-aborted call is still billed server-side; unmeterable fees
reserve documented worst case; reconcile against the provider console before quoting spend.

## Environment variables (names only - never commit values)

Env lives in gitignored `.env.local`. A local `.env.example` (names only) exists on the owner's
machine but is UNTRACKED (`.gitignore` covers all `.env*`), so do not rely on it existing in a fresh
clone - this section is the durable name list. Client-exposed vars are
`NEXT_PUBLIC_*` by Next.js convention; everything else is server-only, and
`src/services/keySafety.test.ts` mechanically enforces that client code never reads `*_API_KEY`.

- Backend mode: `NEXT_PUBLIC_FIREBASE_BACKEND`, `NEXT_PUBLIC_FIREBASE_USE_EMULATOR`,
  `NEXT_PUBLIC_FIREBASE_ALLOW_PROD`, `NEXT_PUBLIC_FIREBASE_*` (app config), `NEXT_PUBLIC_REQUIRE_LOGIN`
- Firebase server: `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON` / `_PATH`,
  `GOOGLE_APPLICATION_CREDENTIALS`, emulator hosts
- AI providers (server-only secrets): `OPENAI_API_KEY` (+ `OPENAI_MODEL`, `GPT_LADDER_MODEL` - decode
  ladder's paid GPT rung, defaults to `gpt-5.4-mini` as of 2026-07-27,
  `GPT_LADDER_DAILY_USD`), `GEMINI_API_KEY` (+ model vars; decode-disabled), `GO_UPC_API_KEY`
  (+ `GO_UPC_MONTHLY_LIMIT`), `FIRECRAWL_API_KEY` (+ `_1..4` rotation), `BRAVE_SEARCH_API_KEY`,
  `UPCITEMDB_DAILY_LIMIT`, `OPENFOODFACTS_PER_MINUTE_LIMIT`
- Spend/rate guards: `AI_LOOKUP_DAILY_LIMIT` (default 2000), `AI_LOOKUP_KILL_SWITCH`,
  `AI_LOOKUP_RATE_LIMIT` / `_WINDOW_MS` / `_GET_RATE_LIMIT`, `ENABLE_LIVE_AI_LOOKUP`,
  `ENABLE_AUTO_DECODE_ON_SCAN`, `AI_LOOKUP_MODE`, `DECODE_CACHE_FILE`, `DECODE_MISS_TTL_MS` (L1 miss, default 10 min), `DECODE_NEGATIVE_TTL_MS` (L2 no-result cooldown, default 7 days; only the cooldown reopens paid rungs)
- Data stores: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
- Roles: `PLATFORM_OWNER_EMAILS` / `_UIDS` (+ `NEXT_PUBLIC_` mirrors)
- Test-only (never real prod): `IS_E2E`, `NEXT_PUBLIC_E2E_AUTH_BYPASS`, `NEXT_PUBLIC_E2E_PLATFORM_OWNER`,
  `LIVE_AI_TEST`
- QA cloud creds: `GOD_EMAIL`, `GOD_PASSWORD`, `GOD_BUSINESS_ID`
- Weekly report: `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `INTEL_PORT`, `INTEL_TIRE_COUNT`

## Quirks

- `postinstall` runs `scripts/patch-jwks-rsa.cjs` (fixes firebase-admin's jose ESM crash on Vercel).
  If installs behave oddly, check it ran.
- `next.config.ts` `serverExternalPackages` (firebase-admin, better-sqlite3, @libsql/client) is
  load-bearing; removing an entry silently broke corpus lookups and fell through to paid AI once.
- No `engines` / `packageManager` pin; plain npm with package-lock.json. No turbopack (deliberate).
