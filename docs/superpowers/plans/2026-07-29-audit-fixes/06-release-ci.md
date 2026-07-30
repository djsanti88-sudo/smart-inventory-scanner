# Agent 6 — Release & CI

> Read `00-orchestration.md` and master plan Tasks 5, 11, 12 first. Implement those steps verbatim.

**Sub-branch:** `audit-fixes/06-release-ci`.

**Scope:** master-plan **Task 5 (F-06)** — diagnose + fix the red required Mock E2E gate;
**Task 11 (F-13)** — pin GitHub Actions to immutable SHAs; **Task 12 (F-15)** — reconcile
`docs/DEPLOY_TRUTH.md` (four → five required checks).

**Files you OWN:**
- `e2e/**` specs + `playwright.config.ts` **EXCEPT the 3 reconcile specs** (`e2e/reconcile.spec.ts`,
  `e2e/phase4-fuzzy-reconcile.spec.ts`, `e2e/phase4-universal-import.spec.ts`) — those belong to Agent 2
  because F-12 changes their API contract. If your F-06 failure is in one of those, do NOT fix it here;
  coordinate with Agent 2 so it is fixed as part of F-12.
- `.github/workflows/ci.yml`, `.github/workflows/playwright.yml`
- `docs/DEPLOY_TRUTH.md`

If the reproduced E2E failure points to product code outside this owned set, do not edit it. Report the exact
file/symbol to the integrator, who must assign it to the existing owner or record an explicit ownership
transfer in `00-orchestration.md`. "Whatever the test points to" is not an exception to disjoint ownership.

**Dependency:** Agent 2's reconcile changes (route + callers + those 3 specs) must land before the
integrator's final full `npm run test:e2e`. Your F-06 fix targets the non-reconcile failing spec; the
integrator runs the whole E2E suite green after both you and Agent 2 merge.

**Internal order:** E2E, workflows, and the doc are disjoint and may be sequenced in either order.

**Executor sequence (the file groups are disjoint, but this lane has one executor):**
- Reproduce `npm run test:e2e`, diagnose root cause via `superpowers:systematic-debugging`,
  fix root cause (NOT by weakening/deleting the test), prove stable-green.
- SHA-pin all `uses:` in both workflows (+ version comments). Dependency-update automation is out of scope.
- Update DEPLOY_TRUTH.md required-check list to five and reconcile the trigger claim.

**Port note:** `npm run test:e2e` binds port 3100 and sets `IS_E2E=1`. First run once:
`npx playwright install chromium`. Do not run concurrently with another 3100 consumer.

**Proof gates:** `npm run test:e2e` (stable green, run twice for flake), workflow YAML valid.

**Owner note:** re-running the GitHub required check happens on the owner's next push of a reviewed commit;
do NOT mutate the historical check. Do NOT push.

**Definition of done:** Mock E2E green + stable locally with diagnosis documented; actions SHA-pinned;
DEPLOY_TRUTH matches live branch-protection reality. Merge into `audit-fixes`.
