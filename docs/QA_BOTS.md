# Browser and human-bot QA

This is the canonical browser-proof guide. `docs/COMMANDS.md` owns the complete command and port
reference; this file owns when browser proof is required and what it must demonstrate.

Human-bot proof is required before handoff for changes involving scanning, inventory, identity
resolution, reviews, roles, authentication, exports, customer data, or customer-facing workflows.
Unit tests alone do not prove those paths.

## Choose the right run

```bash
npm run test:e2e            # standard mock-backend customer workflows
npm run qa:bots             # all mock human-bot scenarios
npm run qa:bots:tire        # product resolution and mismatch handling
npm run qa:bots:security    # role visibility and export leaks
npm run qa:bots:data        # counting, sync, persistence, import, export
npm run qa:bots:ux          # usability and mobile checks
npm run qa:bots:manager     # shop-manager workflow
npm run qa:bots:performance # load and scan responsiveness
npm run qa:bots:live        # authenticated real account, owner-gated
npm run qa:revision         # full local handoff gate
```

Mock E2E uses port 3100, Firebase browser proof uses 3200, and human bots use 3300. Test configuration
must force mock decode unless a live run was explicitly approved. Never remove both the environment
guard and request interception protecting automated tests from paid providers.

## Proof contract

A meaningful browser test uses visible controls the way a customer does: focus the scan input, enter
a code, press Enter, navigate through the UI, refresh when persistence matters, and observe the
rendered result. Do not bypass the behavior being claimed through store mutation or a private helper.

For critical workflows, cover the relevant failure and recovery cases:

- repeated physical scans and retry idempotency;
- unknown and suggested identities without losing the counted event;
- refresh, offline/reconnect, failed sync, and pending writes;
- role and tenant boundaries;
- duplicate clicks, loading states, errors, and interrupted sessions;
- mobile sizing, keyboard focus, and visible feedback.

Save useful screenshots, traces, and reports under the existing gitignored proof/output locations.
Inspect screenshots when the claim is visual.

## Handoff

Every readiness statement must label its evidence as automated, mock, emulator, Preview, live,
manual, or untested. For scan and resolution changes, state whether a browser actually submitted the
code and verified the visible identity and quantity. If live credentials or another required lane was
unavailable, name that blocker rather than generalizing from mock proof.

## Safety

- Browser tests never call paid providers unless the owner explicitly approves a live run.
- `qa:bots:live` and any cloud mutation are owner-gated.
- Security inspection is non-destructive and does not attempt auth or CAPTCHA bypass.
- Browser output must not contain secrets, raw credentials, or another tenant's data.

## Weekly report-only run

`npm run qa:weekly-report` chains the security, data, tire, and UX bot groups against the mock app.
It inspects, screenshots, and reports; it does not edit code, deploy, or write production data. It is
not itself proof that an operating-system or hosted schedule is configured.

A future scheduler or aggregator must remain report-only, fail loudly on a P0, record the commit and
environment, and require a separate human decision for remediation. Scheduled output belongs under
`reports/`, never in source documentation.

## Interactive Playwright

Use `npx playwright test` for checked-in proof and `npx playwright-cli` for an interactive browser
session. Common diagnostic commands are:

```bash
npx playwright test --list
npx playwright test -g "test name"
npx playwright test --debug
npx playwright test --trace on
npx playwright show-report
npx playwright show-trace trace.zip
```

The installed package and current configuration are the version source of truth. Avoid maintaining a
handwritten browser-version inventory in documentation.
