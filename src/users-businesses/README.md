# Users & Businesses

Which shop you belong to, who else is on the account, what each person is allowed to do, and
account lifecycle (export your data, delete your account).

**Frontend + Backend (shared).** The context gate and role hints run in the browser; provisioning
and the access checks that actually protect data run on the server.

## What is here

| Path | What it does |
|---|---|
| `selectedBusiness.ts` | Which business the current session is working in |
| `BusinessContextGate.tsx` | Blocks the app until a business context exists; handles orphaned and recovery cases |
| `roles/roleAccess.ts` | Owner / admin / counter / viewer, and the platform-owner vs business-customer access level |
| `roles/useAccessLevel.ts` | The React hook form of the above, for UI gating |
| `provisioning/provisioning.ts` | Creating and setting up a new shop account |
| `account/accountDeleteRateLimit.ts` | Rate limit on account deletion |
| `account/audit.ts` | The audit trail for account-level actions |

## What is NOT here

- **Signing in** is `src/authentication/`. That answers "who are you"; this answers
  "what may you do".
- **The API routes** (`/api/businesses/*`, `/api/account/*`) and the business page stay under
  `src/app/`, because Next.js resolves routes by folder location. They call into this folder.
- **Firestore rules** live in `firestore.rules` at the repo root. Role logic here and rules there
  must agree; changing one without the other is how tenant isolation breaks.

## Before you change anything

This folder holds the multi-tenant boundary. Every tenant-owned record is scoped by `businessId`,
and `roleAccess.ts` decides platform-owner vs customer. After any change here run:

    npm run test:firebase

Those suites self-skip under a plain `npm run test`, so a tenancy regression will pass CI-looking
runs unless you invoke them explicitly.
