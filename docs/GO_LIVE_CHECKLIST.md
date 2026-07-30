# Production go-live checklist (Firebase live auth + real cloud data)

Refreshed 2026-07-29 against verified current truth: `docs/DEPLOY_TRUTH.md`, `docs/RECOVERY.md`,
`REPO_HEALTH.md`, `PROGRESS.md`. Supersedes the 2026-07-27 snapshot (removed stale banner - this is
now current).

> Every step below is against the REAL production Firebase project `smart-inventory-scanner-app`
> (aliased `prod` in `.firebaserc`) and the real Vercel production deployment
> (`inventory-lovat-six.vercel.app`). Steps marked **OWNER-GATED** must never be run by an agent
> without explicit, in-the-moment owner approval - no exceptions, even mid-checklist.
>
> Deploy mechanics (Vercel Git connection status, preview vs. production, the hookify prod gate) are
> canonical in `docs/DEPLOY_TRUTH.md` - read it first. As of PR #21 the `vercel.json` flag blocking Git
> auto-deploy for `master` is removed, but a merge to `master` still does NOT deploy to production by
> itself: the Vercel dashboard Production Branch = `master` connection is a separate, pending owner
> action (see "Open - owner-gated" below). Until that step is done, production deploys stay explicit
> owner-only CLI (`vercel --prod`) or Vercel dashboard promote events, each requiring fresh
> in-conversation approval.

## Done - verified live (2026-07-29)

1. **`NEXT_PUBLIC_AUTH_MODE=live` is active in production.** Verified directly from the deployed
   production JS bundle: the baked-in literal is `"﻿live"` (a BOM character precedes `live`).
   `src/services/auth/authMode.ts`'s `.trim()` rescues this today, so the login wall and
   membership-derived `businessId` ARE enforced in production. **Known gotcha (not yet fixed):** any
   future code that compares this env var without `.trim()` would silently fall back to `mock` mode -
   flag this the next time the Vercel env var is touched (OWNER-GATED - editing a production env var
   is a prod-config change).
2. **Firestore PITR + delete protection are ENABLED.** Verified via a live Admin API read of
   `projects/smart-inventory-scanner-app/databases/(default)`:
   `pointInTimeRecoveryEnablement = POINT_IN_TIME_RECOVERY_ENABLED`,
   `deleteProtectionState = DELETE_PROTECTION_ENABLED`, `versionRetentionPeriod = 604800s` (7-day
   continuous change history). A mistaken delete, bad migration, or mass-corruption bug now has a
   7-day restore window, and the database itself cannot be deleted without first disabling delete
   protection. Full detail and the cost note (PITR bills separately from storage): `docs/RECOVERY.md`
   section 1-2.
3. **Vercel production env vars present** (verified by name only; values are sensitive and not
   readable locally): the 6 `NEXT_PUBLIC_FIREBASE_*` vars (API key, auth domain, project id, storage
   bucket, messaging sender id, app id), `NEXT_PUBLIC_FIREBASE_BACKEND`,
   `NEXT_PUBLIC_FIREBASE_USE_EMULATOR` (must read unset or `0` in prod), and
   `NEXT_PUBLIC_AUTH_MODE=live` (item 1 above).
4. **Branch protection + CI required checks are live on `master`.** Five required checks
   (`typecheck`, `unit-tests`, `build`, `lint`, `Mock E2E (chromium)`), `strict: true`,
   `enforce_admins: true` - confirmed via `branches/master/protection`. A PR cannot merge red,
   including for the repo owner. See `docs/DEPLOY_TRUTH.md`.

## Open - owner-gated

5. **Restore drill (F-08 closure).** PITR being enabled proves the setting is on, not that a restore
   works end to end. Run once and record the result:
   ```bash
   gcloud firestore databases restore \
     --source-database='projects/smart-inventory-scanner-app/databases/(default)' \
     --snapshot-time='<recent-ISO-timestamp>' \
     --destination-database='restore-drill-<date>' \
     --project=smart-inventory-scanner-app
   ```
   Spot-check the restored database, then delete the scratch database (disable its delete protection
   first if enabled). Full steps: `docs/RECOVERY.md` section 3. F-08 stays open until a passing drill
   is logged there.
6. **F-01/F-07: redeploy Firestore rules and indexes.** The tracked `firestore.rules` and
   `firestore.indexes.json` are already the hardened, correct source; production has the OLDER
   ruleset and only 1 of 3 declared composite indexes deployed. Run:
   ```bash
   npm run deploy:rules:prod
   ```
   (wraps `firebase deploy --only firestore:rules,firestore:indexes --project smart-inventory-scanner-app`).
   Then verify per `docs/RECOVERY.md` section 4: rules diff clean, all 3 indexes report `READY`, and
   an admin-role account can no longer self-escalate to `owner`.
7. **Vercel dashboard Git-connect step.** Confirm/set Production Branch = `master` in the Vercel
   dashboard's authenticated Git integration settings. This is the one remaining step that makes a
   merge to `master` actually trigger a production deploy - see `docs/DEPLOY_TRUTH.md`. Until done,
   treat merges as deploying nothing by themselves.
8. **Uptime monitor.** Needs a monitoring-service account signup (owner-gated per the no-account-signup
   rule) - e.g. a free-tier uptime checker pinging the production URL and `/api/ai-lookup` capability
   endpoint. Not yet configured; production failures are currently invisible until a customer reports
   them.
9. **Post-deploy-smoke hardening.** `post-deploy-smoke.yml` still needs `ref: github.sha` hardening so
   the workflow always smoke-tests the commit that was actually deployed, not a moving branch ref
   (tracked in `REPO_HEALTH.md`).
10. **`FIREBASE_SERVICE_ACCOUNT_JSON` verification.** Confirm this is set on Vercel prod (owner
    generates it in Firebase console > Project Settings > Service Accounts > Generate new private key,
    pastes directly into the Vercel env var - never committed or handled by an agent). Confirm
    `FIREBASE_SERVICE_ACCOUNT_PATH` / `GOOGLE_APPLICATION_CREDENTIALS` are NOT set on Vercel (local-dev
    path vars that would break Admin SDK init if present in prod).
11. **Firebase console configuration.** Confirm Email/Password sign-in (and Google sign-in if desired)
    is enabled under Authentication for `smart-inventory-scanner-app`, and that
    `inventory-lovat-six.vercel.app` is in Authentication > Settings > Authorized domains (missing this
    produces `auth/unauthorized-domain` on every production sign-in attempt).
12. **Production data cleanup.** Execute `coordination/PROD_CLEANUP_PLAN.md`: dry run first
    (`node scripts/prod-cleanup-poison.mjs`, no writes), review printed matches and the backup JSON,
    apply only after explicit owner sign-off (`--apply --soft --yes-write-to-production` plus the typed
    confirmation phrase). Removes poisoned rows (Manstel/745125495781 misidentification) from an
    earlier accidental `dev:prod` run.

## Final go/no-go

Go-live is complete only when every "Open - owner-gated" item above is explicitly approved and
executed, and end-to-end verification passes with real evidence (fresh sign-up appears in
Authentication for `smart-inventory-scanner-app` and matching `businesses`/`businessMembers` docs land
in Firestore, tenant isolation spot-checked across two accounts, no dev/demo banner shown, and
`npm run test:firebase:cloud-smoke` exits 0 against the real project).
