# Smart Inventory Scanner

A private, smart barcode inventory scanner web app. A keyboard-wedge barcode scanner types a code
and sends Enter; the app captures the raw scan, cleans it, matches it deterministically to a product
via an alias table, and increments that product's quantity instantly in local optimistic state.
Unknown codes run a cost-ordered decode ladder (local tire corpus -> Go-UPC -> Fetch V2 -> GPT-5.5);
anything not app-verified goes to a Needs Review queue where human resolution permanently teaches a
new alias. Built to become a multi-tenant SaaS (every record is scoped by `businessId`) and to work
for any physical inventory: tires, auto parts, supplements, tools, retail, and more.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind v4 (CSS-first), Zustand 5 (+ persist) for optimistic scan state
- Vitest (node project for pure services, jsdom for components/stores), Playwright for E2E proof
- Turso/libsql + local SQLite for the tire corpus and ladder usage storage
- Firebase Auth/Firestore foundation (emulator-first) for the multi-tenant backend path
- Vercel for preview deploys (production promotion is owner-gated)

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000 (tests pin port 3100)
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run test` | All Vitest unit suites (always run from this directory) |
| `npm run test:e2e` | Playwright E2E (first time: `npx playwright install chromium`) |
| `npm run qa:bots:*` | Human-bot browser proof suites (see `docs/QA_BOTS.md`) |
| `npm run emulators` | Firebase Auth + Firestore emulators |
| `npm run test:firebase` | Tenant-isolation + repository proof against the emulator |

## Documentation map

| Doc | Purpose |
|---|---|
| `CLAUDE.md` | Agent rules: decode ladder, resolver trust, scanner buffer, safety gates |
| `PROGRESS.md` | Live status checkpoint (current phase, pending owner decisions) |
| `DECISIONS.md` | Technical decisions and why |
| `TESTING.md` | Test commands, coverage map, acceptance checklist |
| `LESSONS_LEARNED.md` | Hard-won permanent lessons |
| `RISK_REGISTER.md` | Known risks + mitigations |
| `RECONCILIATION.md` | Instruction reconciliation markers |
| `CHANGELOG.md` | Decode-pipeline architecture versions |
| `MANUAL_LIVE_TEST.md` | Owner-gated manual live decode test |
| `FIREBASE_SETUP.md` / `FIREBASE_SECURITY.md` | Backend foundation setup + security model |
| `docs/CURRENT_CONTEXT.md` | Working-memory snapshot for active tracks |
| `docs/DECODER_ARCHITECTURE.md` | Decode pipeline architecture |
| `docs/QA_BOTS.md` / `docs/REVISION_GATE.md` | Human-bot proof gate |
| `docs/superpowers/plans/` | Dated implementation plans |
| `docs/archive/` | Historical point-in-time reports (not kept current) |

## Safety model (short version)

- Deterministic-first: known codes resolve instantly with NO AI. AI is only for unknown codes,
  behind a daily cap that charges paid rungs only.
- Wrong product identity is FAILURE; Unknown is ACCEPTABLE. AI results are suggestions unless the
  app itself verifies exact-code evidence.
- API keys are server-side only. Automated tests never call live providers.
- Deploy, push, paid/live API calls, and real-data writes are owner-gated.
