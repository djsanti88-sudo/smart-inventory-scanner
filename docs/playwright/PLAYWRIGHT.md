# Playwright in this project

Everything Playwright-related that is installed, where it lives, and how to use it.
Verified 2026-07-22 on branch `feat/teach-bot`; feature map + a11y/CT/cross-browser/CI added 2026-07-25.

## What is installed

| Piece | Version | What it is |
|---|---|---|
| `@playwright/test` | 1.61.1 | The test runner (`npx playwright test`) used by all E2E suites |
| `playwright` / `playwright-core` | 1.61.1 | The automation library underneath the runner |
| `@playwright/cli` | 0.1.17 | The agent-oriented terminal CLI (`npx playwright-cli`) for driving a live browser step by step |
| `@axe-core/playwright` | 4.12.x | Accessibility engine wired into `e2e/a11y.spec.ts` (`npm run test:a11y`) - real WCAG scans, not code-reads |
| `@playwright/experimental-ct-react` | 1.61.1 | Component testing (mounts a React component in a browser via Vite); config `playwright-ct.config.ts`, `npm run test:ct`. Optional/thin scaffold |
| Browsers | Chromium 1217/1223/1228 + headless shells, **Firefox 1532, WebKit 2311** | In `%LOCALAPPDATA%\ms-playwright`; rev 1228 matches 1.61.1. All three engines installed. Configs currently target Chromium only; Firefox/WebKit are available for ad-hoc `--browser firefox` / cross-browser runs |
| Claude skill | `.claude/skills/playwright-cli/` | SKILL.md + 9 reference docs (test running/debugging, request mocking, tracing, video, storage state, test generation, sessions) - a byte-identical copy of the `@playwright/cli` package skill, auto-loaded by Claude Code |
| Claude agents | `.claude/agents/playwright-test-{planner,generator,healer}.md` | Official test-plan / test-generate / test-heal agents |
| CI | `.github/workflows/playwright.yml` | Runs the mock E2E suite on push/PR to `master` (Chromium, uploads the HTML report) |
| MCP servers | `playwright-test` + plugin `playwright` | Browser tools available to Claude (snapshot, click, route, test_run, etc.) |

## The three tools and when to use each

1. **`npx playwright test` (test runner)** - run the checked-in E2E suites. This is the proof gate.
2. **`npx playwright-cli` (agent CLI)** - interactively drive a real browser from the terminal:
   `open` -> `snapshot` -> `click e15` / `fill e5 "text"` -> `screenshot` -> `close`.
   Full command list: `npx playwright-cli --help`, or read `.claude/skills/playwright-cli/SKILL.md`.
   Windows note: escape `&` in URLs (`--%` in PowerShell).
3. **Test agents (planner/generator/healer)** - dispatch via the Agent tool to plan a test suite,
   generate specs from a plan, or auto-fix failing specs. They use the `playwright-test` MCP.

## Test runner quick reference (CLI)

```bash
npx playwright test                        # run all tests in the active config
npx playwright test e2e/scan.spec.ts       # one file
npx playwright test -g "counts twice"      # by title
npx playwright test --list                 # list without running
npx playwright test --headed --workers=1   # watch it run
npx playwright test --debug                # inspector, step through
npx playwright test --trace on             # record traces
npx playwright test --last-failed          # rerun only failures
npx playwright show-report                 # open last HTML report
npx playwright show-trace trace.zip        # open a trace
npx playwright install chromium            # (re)install the matching browser
```

Docs: https://playwright.dev/docs/test-cli (runner), https://playwright.dev/docs/intro (library).

## Full feature map (every Playwright capability, and where it is here)

Playwright is more than the test runner. This maps the official feature surface to what exists in
this repo, so nothing looks "missing" when it is really just a one-line command or an agent workflow.

| Capability | Command / location here | When to use it |
|---|---|---|
| **Codegen** (record actions -> code) | `npx playwright codegen <url>` | Quick one-off recording. For agent-driven authoring, prefer the CLI + `test-generation.md` workflow, which emits the same code |
| **UI Mode** (watch, time-travel) | `npx playwright test --ui` | Interactively explore/debug the suite with a live step view |
| **Inspector / step debugger** | `npx playwright test --debug` (or `--debug=cli` to attach the agent CLI) | Step through a failing test; pair with `playwright-cli attach` |
| **Trace Viewer** | `npx playwright show-trace <trace.zip>`; config `trace: "on-first-retry"` | Post-mortem a failure with full DOM/network/console timeline. Deep guide: `references/tracing.md` |
| **HTML report** | `npx playwright show-report` | Read the last run's pass/fail/flaky dashboard |
| **Screenshots / PDF** | `npx playwright screenshot <url> <file>` / `pdf`; specs write to `e2e/proof/` | Visual proof artifacts |
| **Video recording** | `playwright-cli video-start`; `references/video-recording.md` | Record a flow for review/sharing |
| **Network mocking** | `page.route(...)`; `references/request-mocking.md` | The `/api/ai-lookup` mock layer - never remove it |
| **Auth / storage state** | `references/storage-state.md` | Persist a logged-in session across specs |
| **Accessibility (axe-core)** | `npm run test:a11y` -> `e2e/a11y.spec.ts` | Real WCAG 2.1 A/AA scan of the rendered app (critical/serious gate) |
| **Visual comparisons** | `expect(page).toHaveScreenshot()` (built in, no setup) | Pixel-diff regressions (not currently used - available) |
| **Component testing** | `npm run test:ct` -> `playwright-ct.config.ts`, specs in `ct/*.ct.spec.tsx` | Mount one React component in a browser (optional; E2E + vitest are the primary gates) |
| **Cross-browser** | `npx playwright test --browser firefox` (Firefox + WebKit installed) | Ad-hoc Safari/Firefox check; configs default to Chromium |
| **API testing** | `request` fixture (built in) | Hit HTTP endpoints without a page |
| **CI** | `.github/workflows/playwright.yml` | Auto-runs mock E2E on push/PR |
| **VS Code extension** | recommended in `.vscode/extensions.json` (`ms-playwright.playwright`) | Run/debug tests from the editor gutter |
| **init-agents** | `npx playwright init-agents` (already run) | (Re)scaffold the planner/generator/healer agents |

## Project-specific commands and ports (from docs/COMMANDS.md)

| Command | What | Port |
|---|---|---|
| `npm run test:e2e` | Mock-backend Playwright E2E (the standard suite) | 3100 |
| `npm run test:firebase` | Firestore emulator rules + repository suite | 3200 |
| `npm run qa:bots[:tire\|:security\|...]` | Human-bot browser proof runs | 3300 |
| `npm run dev` | App itself (mock backend default) | 3000 |

Proof screenshots land in `e2e/proof/`.

## Project rules that override generic Playwright habits

- **Tests never call live providers.** The Playwright webServer sets `IS_E2E=1`, which forces
  `/api/ai-lookup` mock-only; specs also mock it with `page.route`. Never remove either layer.
- **UI changes require browser proof** (screenshot via Playwright or qa:bots), not just unit tests.
  See `docs/REVISION_GATE.md` and `docs/QA_BOTS.md`.
- **Clean-environment precheck**: stale dev servers on 3000/3100/3300 poison proof runs; kill them first.
- `qa:bots:live` and anything marked PAID/LIVE in `docs/COMMANDS.md` is owner-gated.

## Where the deeper docs live

- Skill + task references: `.claude/skills/playwright-cli/` (SKILL.md is the index)
- Package-shipped skill source: `node_modules/@playwright/cli/.../cli-client/skill/`
- Official docs: https://playwright.dev/docs/test-cli · https://github.com/microsoft/playwright-cli · https://github.com/microsoft/playwright
