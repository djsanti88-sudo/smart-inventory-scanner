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
- Vercel: PR previews via the GitHub connection; merging to `master` auto-deploys production
  (owner-gated action, see `docs/DEPLOY_TRUTH.md`)

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000 (tests pin port 3100)
```

## Documentation

Full documentation map and doc hierarchy: `docs/README.md`.

## Safety model

Project rules, safety gates, and standing owner orders: `CLAUDE.md`.
