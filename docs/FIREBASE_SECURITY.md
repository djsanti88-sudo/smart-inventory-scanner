# Firebase security model (Launch MVP Phase 1)

## Tenancy by path (subcollections)
Business-scoped data lives under `/businesses/{businessId}/...`:
`products, aliases, settings, shopOverrides, countSessions, scanEvents, inventoryCounts,
unknownCodeReviews, auditLog`. Top-level collections: `businesses`, `businessMembers`, `userProfiles`,
`catalogEntries`.

Because the tenant is the PATH (`{businessId}` wildcard), every rule derives it without relying on
`resource` - which is null during list/query authorization. This makes get/list/create/update/delete all
enforce membership uniformly, and a **forged businessId write is impossible** (you can only write under a
business path you are a member of).

## Membership + roles
- Membership docs are keyed `${businessId}_${uid}` so rules read them with a single `exists()`/`get()`.
- Roles: `owner | admin | counter | viewer`.
  - `owner`/`admin`: manage products, aliases, settings, members, sessions; delete.
  - `counter`: create scanEvents, inventoryCounts, unknownCodeReviews; update count sessions.
  - `viewer`: read-only (member reads).
- Helpers: `isMember(bid)` = `exists(/businessMembers/{bid}_{uid})`; `hasRole(bid, roles)` =
  member AND `roleOf(bid) in roles`.

## Rule highlights
- `userProfiles/{uid}`: a user reads/writes only their own.
- `businesses/{bid}`: members read; create requires `createdBy == uid`; update admin/owner; delete owner.
- `businessMembers`: bootstrap allows a user to create their OWN `owner` membership (the create-business
  flow); otherwise owner/admin manage members; doc id must equal `${businessId}_${userId}`.
- Business subcollections: read = member; writes = role-gated (see above); `bizFieldOk` requires any
  `businessId` field on a doc to equal its path (defense in depth).
- `auditLog`: append-only (members create; `update`/`delete` denied to everyone); owner/admin read.
- `catalogEntries` (global shared): any signed-in user reads; client writes denied (server/Admin only).
- Default deny on everything else.

## Proof (emulator, authenticated users)
`src/services/db/firebase/tenantIsolation.rules.test.ts` (9 cases) + `repositories.rules.test.ts` (1)
run under the REAL `firestore.rules` via `@firebase/rules-unit-testing`. Service role
(`withSecurityRulesDisabled`) is used ONLY to seed; all isolation assertions run as authenticated User A
/ User B. Proven: A reads (get+list)/writes A; B cannot read/insert/update/delete A; audit append-only;
catalog read-only from client; userProfiles self-only. Run: `npm run test:firebase`.

## Secret safety
- Admin SDK / service account is server-only (`src/lib/firebaseAdmin.ts`, `import "server-only"`).
- `src/services/keySafety.test.ts` fails if Admin usage (`@/lib/firebaseAdmin`, `firebase-admin`,
  `FIREBASE_SERVICE_ACCOUNT_PATH`, `GOOGLE_APPLICATION_CREDENTIALS`, `getAdminDb(`, `getAdminAuth(`)
  appears in client code / `NEXT_PUBLIC_*`.
- E2E auth bypass is production-impossible (`src/services/auth/authBypass.ts`; proven by its test).
- `.env.local` git-ignored; no secrets committed; emulator uses well-known local-only values.

## Not yet (Phase 2)
Custom claims (optional), member-management UI, deploying rules to a real cloud project, wiring the live
scan/count flow + audit writes onto these repositories.
