# Agent Bot Roles (Track 1)

Human-like Playwright bots that drive the real UI (paste scan codes — no hardware scanner needed) and
produce screenshots + JSON + markdown. Run against the mock/local backend (`playwright.bots.config.ts`,
port 3300) except the live bot (`playwright.bots.cloud.config.ts`, real god account).

| persona | command | what it proves / reports | status |
|---------|---------|--------------------------|--------|
| PlatformOwnerBot (tire regression) | `npm run qa:bots:tire` | Falken part number in all separator shapes (- · none · space · / · \ · _ · .) + barcode resolve to Falken, never Camel | RUNNING (passing) |
| RegressionBot (live cloud) | `npm run qa:bots:live` (needs GOD_EMAIL/GOD_PASSWORD) | same, on Santiago's REAL god account | RUNNING (passing) |
| SecurityLeakBot | `npm run qa:bots:security` | SAFE, report-only: which internal fields a customer browser holds/sees | RUNNING (reports current exposure) |
| ExportBot | `npm run qa:bots:security` | export CSV headers; flags code-bearing exports | RUNNING |
| DataIntegrityBot | `npm run qa:bots:data` | increment correctness, refresh persistence, unknown→Needs Review | RUNNING (passing) |
| ConfusedHumanBot | `npm run qa:bots:ux` | no-training UX scorecard + top confusions (incl. mobile) | RUNNING (report-only) |
| ManagerBot | `npm run qa:bots:manager` | shop-manager workflow coverage + missing-feature classification | RUNNING (report-only) |
| PerformanceBot | `npm run qa:bots:performance` | load + scan responsiveness + local payload smoke | RUNNING (report-only) |
| ShopOwnerBot / AdminBot / CounterBot / ViewerBot | (folded into SecurityLeak/Export today) | role-segregated visibility | PARTIAL — needs the deferred client-side role model to be meaningful (single auth-bypass user today) |

## Honest limitations
- **Role segregation is not testable end-to-end yet** because client-side role gating is part of the
  DEFERRED foundation (docs/HOTFIX_FOLLOWUPS.md). The role bots therefore report the CURRENT single-role
  exposure truthfully (everything visible to everyone) instead of asserting gates that don't exist.
- SecurityLeakBot is strictly non-destructive: visibility/storage/export inspection only. No exploits,
  no writes, no auth attacks.

## Safety
No public deploy, no destructive cloud writes, no auth/CAPTCHA/paywall bypass. The live bot only reads +
scans on the owner's own account.
