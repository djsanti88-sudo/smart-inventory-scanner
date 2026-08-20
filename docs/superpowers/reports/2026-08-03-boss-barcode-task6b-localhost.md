# Task 6B: exhaustive localhost browser certification

## Delivered harness

- `playwright.corpus.config.ts` runs only against localhost port 3400 with real Firebase Auth and
  Firestore emulators, live auth, and a server-only synthetic trusted-exact business allowlist. It
  deliberately omits `IS_E2E`, all auth-bypass flags, provider credentials, and public allowlist vars.
- The harness derives its fixtures from the pinned manifest and reconciliation source. It partitions
  5,316 canonical UI scans and 13,346 accepted route spellings across 32 authenticated synthetic
  `(uid,businessId)` lanes, leaving each ordinary lane below the 600/minute production limiter.
- Browser scans use only focused `page.keyboard.insertText()` plus Enter. Every physical scan waits
  for the count row, periodic and final scanner focus, queue drain, persisted single scan event, no
  tenant alias learning, and no open/suggested review.
- Authenticated deterministic route requests assert verified app evidence, exact corpus provider,
  trusted index fingerprint, no rate limit in normal lanes, no non-exact provider execution, and
  deterministic package blocking. Browser egress instrumentation rejects any non-local host.
- Adversarial coverage includes missing auth, corrupt manifest, package blocking, an intentional
  rate-limit 429 with `Retry-After`, an intercepted external-egress attempt, empty-result/suggestion
  regression, and atomic redacted self-hashed receipts.

## Focused verification

```text
node --test e2e/boss-barcode-corpus/receipt.test.mjs
2 pass, 0 fail

npx playwright test --config=playwright.corpus.config.ts --list
35 tests discovered: 32 exhaustive lanes + 3 adversarial browser tests

npx tsc --noEmit --pretty false
PASS

npx eslint e2e/boss-barcode-corpus playwright.corpus.config.ts
PASS

git diff --check -- e2e/boss-barcode-corpus playwright.corpus.config.ts package.json docs/COMMANDS.md
PASS
```

## Exhaustive run status

**BLOCKED — not a PASS.** The required globally installed Firebase CLI was absent at
`C:\Users\djsan\AppData\Roaming\npm\firebase.cmd`, and neither `firebase` nor `firebase.cmd` was
available on `PATH`. The launcher writes an atomic, redacted, self-hashed failed receipt before its
nonzero exit if this prerequisite is absent.

After making the Firebase CLI available at that path, run:

```text
npm.cmd run test:e2e:boss-barcodes
```

That is the only command that can produce the authoritative exhaustive localhost PASS/FAIL receipt
under `outputs/boss-barcode-certification/`. No deploy, cloud Firebase/Turso write, paid/live provider,
stage, commit, or push was performed.
