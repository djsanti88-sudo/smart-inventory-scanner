# Scanbin

A private, smart barcode inventory scanner web app (product name: Scanbin, legal clearance pending).
A keyboard-wedge barcode scanner types a code and sends Enter; the app captures the raw scan, cleans
it, matches it deterministically to a product via an alias table, and increments that product's quantity
instantly in local optimistic state. Unknown codes run a cost-ordered decode ladder (free cache, tire
corpus, retail corpus, learned tier, Turso cache, UPCitemdb, Open Food Facts, then daily-cap gated paid
Go-UPC, Fetch V2, GPT); the first settled result stops the ladder. Anything not app-verified goes to a
Needs Review queue where human resolution permanently teaches a new alias. Built to become a
multi-tenant SaaS (every record is scoped by `businessId`) and to work for any physical inventory:
tires, auto parts, supplements, tools, retail, and more (multi-trade, tires are the beachhead).

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind v4 (CSS-first), Zustand 5 (+ persist) for optimistic scan state
- Vitest (node project for pure services, jsdom for components/stores), Playwright for E2E proof
- Turso/libsql + local SQLite for the 78,000+ tire and 4M+ retail barcodes, decode cache, and ladder usage
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
| `CLAUDE.md` | Project rules: decode ladder, resolver trust, scanner buffer, safety gates, tech stack |
| `docs/ARCHITECTURE.md` | Full verified architecture map with 14 verified traps |
| `docs/COMMANDS.md` | Every script + port + env var name, with PAID/LIVE warnings |
| `docs/PLAN_EXECUTION.md` | How plans are created, attacked, executed, and proven done |
| `docs/DECODER_ARCHITECTURE.md` | Canonical decode-pipeline architecture and decision history |
| `docs/QA_BOTS.md` / `docs/REVISION_GATE.md` / `docs/AGENT_BOT_ROLES.md` | Human-bot proof gate |
| `docs/superpowers/plans/2026-07-19-master-plan.md` | Owner-approved 6-phase plan (phase source of truth) |
| `PROGRESS.md` | Live status checkpoint (current phase, pending owner decisions) |
| `DECISIONS.md` | Technical decisions and why |
| `TESTING.md` | Test commands, coverage map, acceptance checklist |
| `LESSONS_LEARNED.md` | Hard-won permanent lessons |
| `RISK_REGISTER.md` | Known risks + mitigations |
| `FIREBASE_SETUP.md` / `FIREBASE_SECURITY.md` | Backend foundation + multi-tenant security model |
| `MANUAL_LIVE_TEST.md` | Owner-gated manual live decode checklist |
| `docs/superpowers/plans/` | Dated implementation plans |
| `docs/archive/` | Historical point-in-time reports (not kept current) |

## Safety model (short version)

- Deterministic-first: known codes resolve instantly with NO AI. AI is only for unknown codes,
  behind a daily cap that charges paid rungs only.
- Wrong product identity is FAILURE; Unknown is ACCEPTABLE. AI results are suggestions unless the
  app itself verifies exact-code evidence.
- API keys are server-side only. Automated tests never call live providers.
- Deploy, push, paid/live API calls, and real-data writes are owner-gated.
