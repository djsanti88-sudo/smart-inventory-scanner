# Authentication

Signing in, signing out, email verification, password reset, and the guard that blocks
logged-out users.

**Frontend + Backend (shared).** The sign-in calls run in the browser; the token and session
checks run on the server.

## What is here

| Path | What it does |
|---|---|
| `auth.ts` | The auth surface: sign in/up/out, password reset, email verification, membership lookup |
| `firebaseClient.ts` | The browser Firebase app/auth instance |
| `AuthGuard.tsx` | Blocks rendering until a user is known; redirects when logged out |
| `EmailVerifyBanner.tsx` / `EmailVerifyBannerGate.tsx` | "Verify your email" prompt and its auth subscription |
| `service/authMode.ts` | Which auth mode is active (mock vs live) |
| `service/authBypass.ts` | The E2E test bypass. Off in production |
| `service/authService.ts` | Auth types shared across the app |
| `service/signOutFlow.ts` | Sign-out ordering, including flushing pending work first |
| `service/firebaseError.ts` | Turns Firebase error codes into readable messages |
| `service/provisioningTypes.ts` | Types shared with account provisioning |

## What is NOT here

- **The login page** lives at `src/app/login/`. Next.js resolves pages by folder location, so
  route entry points cannot move. Change the login screen there; change what it calls here.
- **Who you belong to and what you may do** (businesses, members, roles) is
  `src/users-businesses/`. Authentication answers "who are you", not "what may you do".

## Before you change anything

`service/authBypass.ts` is load-bearing for the test suites. `playwright.no-bypass.config.ts`
exists specifically to prove the app still works with the bypass off, so run
`npm run test:e2e:no-bypass` after touching it.
