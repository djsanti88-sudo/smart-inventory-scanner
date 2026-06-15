# Launch MVP - Firebase Backend Foundation - Report (2026-06-14)

## 1. Executive summary
Replaced the Supabase Phase-1 foundation with an equivalent, PROVEN **Firebase** foundation (Auth +
Cloud Firestore + Security Rules), built **emulator-first and secret-free** on the demo project
`demo-smart-inventory`. Tenant isolation is proven via the real `firestore.rules` against the Firestore
emulator, as **authenticated User A / User B** (Admin used only to seed). The app runtime no longer
requires Supabase. Foundation + proof only - the live scan/count flow is unchanged (Phase 2). No cloud
project was created/connected, no secrets were used or committed.

## 2. Supabase pieces removed / archived
- Removed from runtime (deleted): `src/lib/supabaseClient.ts`, `src/lib/supabaseServer.ts`,
  `src/services/db/{repositories.ts, database.types.ts, repositories.integration.test.ts,
  tenantIsolation.integration.test.ts}`.
- Deps removed: `@supabase/supabase-js`, `supabase` (CLI). Local Supabase Docker stack stopped.
- Archived (git history + on disk): `archive/supabase-foundation/{supabase/, SUPABASE_SETUP.md}`.
- `grep -rni supabase src` -> clean (no runtime references).

## 3. Firebase pieces added
- Config: `firebase.json`, `.firebaserc` (demo alias), `firestore.rules`, `firestore.indexes.json`;
  scripts `emulators`, `test:firebase`.
- Libs: `src/lib/firebaseClient.ts` (browser, emulator-aware), `src/lib/firebaseAdmin.ts` (server-only).
- Model + repos: `src/services/db/types.ts`, `src/services/db/firebase/repositories.ts` (13 repos over
  subcollections `/businesses/{businessId}/...`).
- Auth: `src/lib/auth.ts` (Firebase email/password, profile-on-signup, create-business), `AuthGuard.tsx`,
  `login/page.tsx`, `(app)/business/page.tsx`. Reused `src/services/auth/authBypass.ts`.
- Tests: `tenantIsolation.rules.test.ts`, `repositories.rules.test.ts`; `keySafety.test.ts` retargeted to
  Firebase Admin. Docs: FIREBASE_SETUP.md, FIREBASE_SECURITY.md, README section.

## 4. Firebase project ID used
`demo-smart-inventory` (emulator demo project; offline, no cloud). Future real project (deferred, with
approval): `smart-inventory-scanner`.

## 5. Credential method (no secrets exposed)
Already-logged-in Firebase CLI (djsanti88@gmail.com) + local emulators. No service-account JSON, no web
config, no production credentials were requested, used, or committed.

## 6. Auth implemented
Email/password sign-in/sign-up; logout; async session AuthGuard; user-profile creation on signup;
create-business flow (creator becomes `owner`); membership listing on `/business`; production-impossible
E2E bypass. (Google sign-in is structured-for but not enabled this phase.)

## 7. Firestore collections modeled
Top-level: `businesses`, `businessMembers` (id `${businessId}_${uid}`), `userProfiles`, `catalogEntries`
(global). Per-business subcollections under `/businesses/{businessId}/`: `products`, `aliases`,
`countSessions`, `inventoryCounts`, `scanEvents`, `unknownCodeReviews`, `settings`, `shopOverrides`,
`auditLog`. Roles: owner | admin | counter | viewer.

## 8. Repository layer implemented
Typed, dependency-injected (`Firestore`) repositories for all 13 entities (`src/services/db/firebase/
repositories.ts`); business-scoped ones bind `(db, businessId)` and operate on the subcollection path.

## 9. Security rules implemented
`firestore.rules`: path-based tenancy + role gates (owner/admin manage; counter creates scans/counts;
viewer read-only); append-only `auditLog`; global `catalogEntries` read-only from client; forged
businessId impossible (writes only under a business path you're a member of); default deny. See
FIREBASE_SECURITY.md.

## 10. Tenant-isolation proof results (authenticated users)
`npm run test:firebase` -> **10/10 passed** (Firestore emulator, real rules):
- bootstrap: a user can create their own business + owner membership.
- (a) User A reads (get + list) and writes Business A.
- (b) User B CANNOT read Business A products/aliases/scanEvents/reviews/settings/audit (get or list).
- (c) User B CANNOT insert into Business A (forged-tenant write blocked).
- (d) User B CANNOT update Business A docs. (e) User B CANNOT delete Business A docs.
- auditLog append-only; catalog client-read-only; userProfiles self-only.
- repository CRUD round-trip works for an authenticated member.

## 11. Commands run and exit codes
| Command | Result |
|---|---|
| `npm run test:firebase` (emulator) | **10/10 passed**, exit 0 |
| `npx vitest run` | **318 passed, 10 skipped** (emulator tests skip w/o emulator), exit 0 |
| `npx tsc --noEmit` | clean, exit 0 |
| `npx eslint src e2e` | clean, exit 0 (1 pre-existing benchmark warning) |
| `npx next build` | success |
| `npx playwright test` | **11/11 passed**, exit 0 |

## 12. Playwright proof
All 11 existing E2E specs pass with the auth swap (Firebase) via the production-impossible E2E bypass; the
scanner/decode flow is unchanged.

## 13. Files changed
See sections 2-3. Net: Supabase libs/repos/tests removed; Firebase config/libs/types/repos/auth/tests
added; `package.json`, `.env.example`, `playwright.config.ts`, README + memory docs updated.

## 14. Docs updated
FIREBASE_SETUP.md, FIREBASE_SECURITY.md (new); README backend section; PROGRESS / DECISIONS / TESTING /
RISK_REGISTER / LESSONS_LEARNED. Archived SUPABASE_SETUP.md.

## 15. Secrets safety check
- `grep` of staged content: no service-account JSON, no private keys, no real API keys.
- Admin SDK server-only (`server-only` import); `keySafety.test.ts` enforces no Admin/service-account in
  client code or `NEXT_PUBLIC_*`.
- `.env.local` and `.env.example` are git-ignored (`git check-ignore` confirmed); not committed.

## 16. Known limitations
- Emulator-only; no real cloud project/rules deployed (by design).
- `gen`-style cloud tooling not used; no service account configured.
- Google sign-in not enabled (email/password only this phase).
- No demo seed data auto-loaded into the emulator (create a business via the UI; Phase 2 can add a seed).

## 17. What remains local
The scan/count/session workflow + decode pipeline still run on the local Zustand store / mock DB
(unchanged). Firebase is the proven foundation, not yet the live data path.

## 18. Deferred to Firebase Phase 2
Wire scanStore scan/count/session mutations onto the repositories (online-required, idempotent); audit
writes; alias approval; CSV import/export; member-management UI; create + connect the real cloud project
(`smart-inventory-scanner`) and deploy rules to staging; optional custom claims; emulator seed script.

## 19-20. Branch / push status
Branch `firebase-foundation` (off `phase1-supabase-foundation`). Committed as a checkpoint. **Not pushed**
- awaiting your review/approval. No secrets committed.

## 21. Next recommended step
Review this Firebase proof. On approval: decide whether to (a) connect the real `smart-inventory-scanner`
cloud project (I'll need the Web App config + a local service-account file PATH, never pasted JSON), and/or
(b) start Firebase Phase 2 (wire the live scan/count flow onto these proven repositories).

> Honesty notes: NOT production-ready - no cloud project/rules were deployed. Security rules ARE proven,
> but against the EMULATOR (not a deployed cloud project). No live Firebase services were touched.
