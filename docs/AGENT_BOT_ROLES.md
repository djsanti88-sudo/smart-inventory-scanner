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
| ShopOwnerBot / AdminBot / CounterBot / ViewerBot | (folded into SecurityLeak/Export today) | role-segregated visibility | PARTIAL — platformOwner-vs-customer is enforced server-side (`roleAccess.ts` + `resolveScanServer.ts` + `serializers.ts`); the owner/admin/counter/viewer sub-split within "customer" has no enforcement yet, so these bots cannot yet prove sub-role segregation |

## Honest limitations
- **Sub-role segregation (owner/admin/counter/viewer) is not testable end-to-end yet** - the
  `BusinessRole` type is declared in `src/services/security/roleAccess.ts` but has no enforcement
  callers, so every authenticated business member gets the same "business" `AccessLevel` today. The
  platformOwner-vs-customer boundary above that IS enforced (see `resolveScanServer.ts`/
  `serializers.ts`) and is what SecurityLeakBot/ExportBot actually verify. Verify current bot output
  before asserting sub-role coverage either way - this doc records what is wired, not what a live run
  proved this session.
- SecurityLeakBot is strictly non-destructive: visibility/storage/export inspection only. No exploits,
  no writes, no auth attacks.

## Safety
No public deploy, no destructive cloud writes, no auth/CAPTCHA/paywall bypass. The live bot only reads +
scans on the owner's own account.
