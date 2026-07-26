# Production go-live checklist (Firebase live auth + real cloud data)

> Every step below is against the REAL production Firebase project `smart-inventory-scanner-app`
> (aliased `prod` in `.firebaserc`) and the real Vercel production deployment
> (`inventory-lovat-six.vercel.app`). Steps marked **OWNER-GATED** must never be run by an agent
> without explicit, in-the-moment owner approval - no exceptions, even mid-checklist.
>
> Deploy mechanics referenced below (GitHub disconnected from Vercel, preview vs. production, the
> hookify prod gate) are canonical in `docs/DEPLOY_TRUTH.md` - read it first. Production deploys are
> never automatic: they are explicit, owner-only CLI (`vercel --prod`) or Vercel dashboard promote
> events, each requiring fresh in-conversation approval - do not assume a deploy already happened or
> will happen as a side effect of anything else in this checklist.
>
> Run the steps in order. Do not skip ahead: later steps assume earlier ones are verified, not just
> attempted.

## A. Vercel production environment variables

Already present on Vercel prod (verified by name; values are sensitive and not readable locally):
- The 6 `NEXT_PUBLIC_FIREBASE_*` vars (API key, auth domain, project id, storage bucket, messaging
  sender id, app id).
- `NEXT_PUBLIC_FIREBASE_BACKEND`
- `NEXT_PUBLIC_FIREBASE_USE_EMULATOR`

Since values cannot be verified from this machine, add a runtime verification step instead of trusting
the list:
1. **[OWNER-GATED]** After the owner runs the next explicit production deploy/promote (CLI or
   dashboard - see `docs/DEPLOY_TRUTH.md`), open the deployed site and confirm in the browser dev
   tools (or a temporary debug log) that `NEXT_PUBLIC_FIREBASE_PROJECT_ID` reads
   `smart-inventory-scanner-app`, not `demo-smart-inventory` and not empty.
2. Confirm `NEXT_PUBLIC_FIREBASE_USE_EMULATOR` is unset or `0` in production (an emulator flag left on
   in prod would silently try to talk to a local emulator that does not exist there).

Missing, must be added before go-live:
- `NEXT_PUBLIC_AUTH_MODE=live` (turns on the login wall and membership-derived `businessId`; see
  `src/services/auth/authMode.ts`). Without this the app stays in open-demo `mock` mode in production.
- `FIREBASE_SERVICE_ACCOUNT_JSON` (raw service-account JSON as the env var value). **[OWNER-GATED]**
  the owner generates this key in the Firebase console (Project Settings > Service Accounts > Generate
  new private key) and pastes the JSON directly into the Vercel env var - it is never committed or
  handled by an agent. Use `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` only as a fallback if the platform's
  env var UI mangles raw JSON.
- Confirm `FIREBASE_SERVICE_ACCOUNT_PATH` and `GOOGLE_APPLICATION_CREDENTIALS` are NOT set on Vercel
  (they are local-dev-only path vars; set on Vercel they would point at a nonexistent file and break
  Admin SDK init).

## B. Firebase console configuration

3. **[OWNER-GATED]** In the Firebase console for `smart-inventory-scanner-app`, enable the
   Email/Password sign-in provider under Authentication, and enable Google sign-in if desired.
4. **[OWNER-GATED]** Add `inventory-lovat-six.vercel.app` to Authentication > Settings > Authorized
   domains. Skipping this produces `auth/unauthorized-domain` on every sign-in attempt from production.

## C. Re-deploy Firestore rules and indexes

5. Run `npm run deploy:rules:prod` (wraps
   `firebase deploy --only firestore:rules,firestore:indexes --project smart-inventory-scanner-app`).
   **[OWNER-GATED - LIVE]**. The rules content is identical between `master` and this branch, but the
   copy currently deployed to the real project may predate the membership-bootstrap fix
   (`businessMembers` self-owner-create rule; see `FIREBASE_SECURITY.md`). Re-deploy to be certain the
   live rules match what is proven under `npm run test:firebase`, rather than assuming a stale deploy
   is current.

## D. Production data cleanup

6. **[OWNER-GATED]** Execute `coordination/PROD_CLEANUP_PLAN.md`: dry run first
   (`node scripts/prod-cleanup-poison.mjs`, no writes), review the printed matches and the backup JSON,
   then apply only after explicit owner sign-off (`--apply --soft --yes-write-to-production` plus the
   typed confirmation phrase). This removes poisoned rows (the Manstel/745125495781 misidentification)
   left over from an earlier accidental `dev:prod` run before `dev` defaulted to mock.

## E. Deploy and verify

7. **[OWNER-GATED]** Explicit production deploy/promote event: the owner runs `vercel --prod` (or
   promotes via the Vercel dashboard) for this branch. This is never automatic and never triggered by
   `git push` (see `docs/DEPLOY_TRUTH.md` - GitHub auto-deploy is disconnected). An agent session may
   propose this step and run `npm run release:check` / `npm run deploy:card` as preflight, but the
   deploy command itself is hard-blocked by `.claude/hookify.vercel-prod-gate.local.md` without the
   owner's explicit approval in that exact conversation.
8. Verify end to end, in this order:
   - Sign up a fresh test account through the real production UI.
   - Confirm the Auth user appears in Firebase Authentication for `smart-inventory-scanner-app`
     (not `demo-smart-inventory`).
   - Confirm the matching `businesses/{businessId}` and `businessMembers/{businessId}_{uid}` documents
     land in Firestore under `smart-inventory-scanner-app`.
   - Confirm no red "dev/demo" banner is shown anywhere in the production UI.
   - Spot-check tenant isolation: sign in as two different test accounts in the same browser (e.g. one
     normal tab, one incognito, or sign out/in between) and confirm each only sees their own business's
     data, never the other's.
   - Run `npm run test:firebase:cloud-smoke` locally as the final automated proof (self-cleaning,
     writes to and tears down a throwaway `loop8-biz-<timestamp>` business against the real project;
     refuses to run against anything but `smart-inventory-scanner-app` and refuses to run if emulator
     env vars are set).

## Final go/no-go

Go-live is complete only when every OWNER-GATED step above has been explicitly approved and executed,
step E's verification checklist passes with real evidence (not assumption), and
`npm run test:firebase:cloud-smoke` exits 0 against the real project.
