# Firebase local setup (Launch MVP backend foundation)

The backend foundation runs on Firebase: **Firebase Auth** (login) + **Cloud Firestore** (data) +
**Firestore Security Rules** (tenant isolation), proven on the **Firebase Emulator Suite**. Phase 1 is
emulator-first and SECRET-FREE: a `demo-` project never touches the cloud, so no service account / web
config / production credentials are needed. The live scan/count flow is NOT wired to Firebase yet
(Phase 2).

## Prerequisites
- Firebase CLI (`firebase --version`; already installed: 15.x) and a Firebase login (`firebase login`).
- Java (the Firestore emulator needs it; Java 21 present).
- Deps already added: `firebase` (client), `firebase-admin` (server), `@firebase/rules-unit-testing` (dev).

## Install Firebase CLI / login / select project
```bash
npm i -g firebase-tools        # if not installed
firebase login                 # already done as the owner's Google account
firebase use demo-smart-inventory   # local demo alias (see .firebaserc)
```

## Run the emulators
```bash
npm run emulators              # firebase emulators:start --only auth,firestore (demo-smart-inventory)
```
Emulator ports: Auth 9099, Firestore 8080, UI 4001 (configurable in firebase.json).

## Run the tenant-isolation + repository proof (emulator)
```bash
npm run test:firebase         # firebase emulators:exec --only firestore "vitest run src/services/db/firebase"
```
This boots the Firestore emulator, runs the rules tests under the REAL firestore.rules, and shuts it
down. Plain `npx vitest run` SKIPS these (they require FIRESTORE_EMULATOR_HOST), so the normal gate stays
green without Docker/emulators.

## Env (.env.local, git-ignored)
Emulator-first values (no secrets):
```
NEXT_PUBLIC_FIREBASE_USE_EMULATOR=1
NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-smart-inventory
NEXT_PUBLIC_FIREBASE_API_KEY=demo-api-key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=demo-smart-inventory.firebaseapp.com
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=demo-smart-inventory.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=0
NEXT_PUBLIC_FIREBASE_APP_ID=demo-app-id
```

## Connecting a REAL cloud project (Phase 2, with owner approval)
1. Create the project (intended id: `smart-inventory-scanner`) in the Firebase console (or
   `firebase projects:create`).
2. Add a Web App; copy its config into the `NEXT_PUBLIC_FIREBASE_*` vars and set
   `NEXT_PUBLIC_FIREBASE_USE_EMULATOR=0`.
3. Enable Email/Password (and Google, if desired) in Authentication.
4. For server-side Admin access, set a LOCAL service-account file path (never the JSON contents, never
   committed):
   ```
   FIREBASE_SERVICE_ACCOUNT_PATH=C:\Users\djsan\secure-keys\smart-inventory-firebase-service-account.json
   ```
   or use `GOOGLE_APPLICATION_CREDENTIALS`.
5. Deploy rules: `firebase deploy --only firestore:rules` (NOT done in Phase 1; needs approval).

## Demo data
`demo-smart-inventory` is empty by default. Sign up via `/login`, then create a business at `/business`
(you become its owner). A seed script for an auto/tire demo can be added in Phase 2.

## Security
- Service account / Admin SDK is server-only (`src/lib/firebaseAdmin.ts`, `import "server-only"`);
  `src/services/keySafety.test.ts` fails the build if Admin usage appears in client code.
- The E2E auth bypass (`src/services/auth/authBypass.ts`) is impossible in production.
- `.env.local` is git-ignored; never commit keys or service-account JSON.
