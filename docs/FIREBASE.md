# Firebase

This is the canonical guide for Firebase setup, tenancy, credentials, and local proof. Deployment
mechanics live in `docs/DEPLOY_TRUTH.md`; backup and restore procedures live in `docs/RECOVERY.md`.

## Environments

| Environment | Project | Purpose |
|---|---|---|
| Local emulator | `demo-smart-inventory` | Secret-free development and rules tests |
| Preview | `smart-inventory-preview` | Authenticated preview testing, isolated from production |
| Production | `smart-inventory-scanner-app` | Real accounts and customer data |

Mock remains the default local backend. Use the emulator when a change touches authentication,
Firestore sync, tenancy, roles, security rules, or indexes.

## Local setup and proof

Prerequisites are Node dependencies, Java for the Firestore emulator, Firebase CLI authentication,
and the aliases in `.firebaserc`.

```bash
npm run emulators
npm run test:firebase
```

`test:firebase` starts the Firebase emulators, runs the authenticated rules and repository suites
against the real `firestore.rules`, and shuts the emulators down. Plain Vitest runs do not replace
this gate because emulator-dependent rule tests skip without an emulator host.

Local emulator configuration uses the public `NEXT_PUBLIC_FIREBASE_*` names plus
`NEXT_PUBLIC_FIREBASE_USE_EMULATOR=1`. Store values only in gitignored `.env.local`; never commit
credentials or print secret values.

## Tenancy and roles

Business data lives below `/businesses/{businessId}/...`. Membership documents are keyed by
business and user so rules can derive access from the path rather than trusting a client-supplied
field. The supported business roles are `owner`, `admin`, `counter`, and `viewer`.

- Members may read their business data according to the rules.
- Owners and admins manage business configuration and members.
- Counters may create operational scan and count records.
- Viewers are read-only.
- Audit records are append-only.
- Shared catalog data is server-managed; customer clients may not write it.
- Every unmatched path is denied by default.

Any `businessId` stored in a business document must match its path. Server routes must authenticate
the caller and derive tenant scope before using Firebase Admin. UI hiding is not authorization.

## Credential boundary

Browser configuration uses intentional `NEXT_PUBLIC_FIREBASE_*` values. Admin credentials are
server-only:

- Local development may use `FIREBASE_SERVICE_ACCOUNT_PATH` or `GOOGLE_APPLICATION_CREDENTIALS`.
- Hosted environments use `FIREBASE_SERVICE_ACCOUNT_JSON` or its supported base64 fallback.
- Filesystem-path credential variables must not be set on Vercel.

The implementation owners are `src/sync-database/cloud/firebaseAdmin.ts` and
`src/sync-database/cloud/serviceAccount.ts`. Client-import and secret-safety guards live under
`src/shared/privacy/`. The production-impossible test bypass lives at
`src/authentication/service/authBypass.ts`.

## Production changes

Deploying rules or indexes is separate from deploying the web app:

```bash
npm run deploy:rules:prod
```

This command changes production authorization and indexes. It requires explicit owner approval for
every run. Follow the preflight and post-deploy verification in `docs/RECOVERY.md`; never infer rules
parity from a successful Vercel deployment.
