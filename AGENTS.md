<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Scanbin / Smart Inventory Scanner agent guide

Private Next.js 16 + React 19 inventory scanner for shop owners. A hardware/keyboard scanner submits raw codes; the app cleans, resolves deterministic aliases/catalog hits, immediately counts every physical scan, then syncs/persists and optionally enriches unknown identity through a cost-gated decode ladder. Tires are the beachhead, not the only domain.

Full project rules: `CLAUDE.md`. Architecture map: `docs/ARCHITECTURE.md`. Commands + paid-script
warnings: `docs/COMMANDS.md`. Plan workflow: `docs/PLAN_EXECUTION.md`.

## Non-negotiable product rules

- TOP LAW: every scan immediately appears in the live feed and counts, even if unknown, suggested, rejected by trust gates, or sent to Needs Review. Identity gates decide labels only; they never suppress the row or quantity.
- Wrong identity is worse than unknown. Deterministic `known` requires approved aliases or verified product identifiers; AI/provider output is suggestion/enrichment unless the app verifies exact-code evidence.
- Do not deploy, push, run live/paid providers, write production Firebase/Turso, send emails, or import real customer data without explicit owner approval in the current session.

## Toolchain and setup

- Node/npm project with `package-lock.json`; CI uses Node 20 and `npm ci` (`.github/workflows/playwright.yml`). No `engines` or packageManager pin exists.
- Main stack: Next.js `16.2.9`, React `19.2.4`, Zustand 5, Firebase 12/Admin 14, Vitest 4, Playwright 1.61, Tailwind v4.
- Local dev default is mock backend: `npm run dev` (port 3000). Firebase emulator mode: run `npm run emulators` (Auth 9099, Firestore 8080, UI 4001), then `npm run dev:emulator`.
- `npm run dev:prod`, `npm run qa:bots:live`, `npm run test:firebase:cloud-smoke`, `npm run deploy:rules:prod`, `npm run benchmark`, live decode/eval/harvest/intel/weekly scripts are owner-gated.

## Verified commands

- Build: `npm run build`
- Lint: `npm run lint`; focused lint: `npx eslint <paths>`
- Unit/dom tests: `npm run test`; focused test: `npx vitest run <path> -t "name"`
- Typecheck + unit suite: `npm run proof:local`; plus build: `npm run proof:full`
- Ledger invariant gate: `npm run test:ledger` for any counting, replay, retry, scan-event, or mark-wrong change.
- Firebase rules/repository gate: `npm run test:firebase` for Firestore sync, tenancy, auth-backed persistence, or security-rule changes.
- Mock Playwright E2E: `npm run test:e2e` (port 3100, `IS_E2E=1`, AI route mock-only). First install: `npx playwright install chromium`.
- Corpus gates: `npm run test:corpus-drift`, `npm run test:golden`, `npm run build:tire-knowledge`, `npm run build:knowledge-db`.
- Release safety read-only check: `npm run release:check`; full revision gate: `npm run qa:revision`.

## Layout and boundaries

- `src/app/` is the Next App Router; `src/app/api/ai-lookup/route.ts` fronts the decode ladder.
- `src/components/` has client UI and co-located `.test.tsx`; `src/stores/scanStore.ts` is the large Zustand scan state monolith.
- `src/services/` are pure services: no React or `next/*`; API routes must not import the client Firebase SDK (`eslint.config.mjs` blocks direct imports, import-graph tests cover transitive cases).
- `src/server/` is server-only: decode pipeline, UPC providers, tire/retail knowledge, better-sqlite3/Turso stores. Client code must not import `@/server/upc`; use `src/services/upc/*` for client-safe utilities.
- `src/services/inventory.ts` is the count ledger core; `src/services/inventory.replay.ts` rebuilds counts from `scanFeed`.
- `src/services/db/firebase/firebaseSyncTarget.ts` is the Firestore sync target; idempotency keys and `_appliedKeys` prevent double-counting.

## Decode and data rules

- Real decode orchestrator: `src/server/decode/pipeline.ts` (`runDecodePipeline`). `src/services/ai/decodeOrchestrator.ts` is deprecated/types-only; do not extend it.
- Ladder is cheapest-first: L1 cache -> tire corpus -> retail corpus -> learned tier -> L2 cache -> UPCitemdb/OpenFoodFacts -> lazy daily paid cap -> Go-UPC/FetchV2/GPT.
- Gemini is hard-disabled for decode. Do not reintroduce it into the decode path.
- Evidence truth lives in `services/ai/evidenceVerifier.ts`, `crossCheckEngine.ts`, `decode.ts`, `prefixFirewall.ts`, and `identityMerge.ts`; provider self-claims are not proof.
- Generated corpus artifacts live under `src/server/tire-knowledge/`, `src/server/retail-knowledge/`, and `src/server/knowledge.generated.db(.gz)`. Do not hand-edit generated JSON/DB outputs; change generators/tests and rebuild.
- Preserve raw scan/source evidence. Canonical tire cleanup should normalize noisy identity fields, not delete useful exact-code rows just because optional fields are blank.

## Testing conventions

- Vitest has two projects in `vitest.config.ts`: `unit` for services/server/app/lib/scripts in node, and `dom` for components/stores/camera in jsdom.
- Firestore `.rules.test.ts` files self-skip under plain `npm run test`; use `npm run test:firebase` to actually exercise emulator rules and sync behavior.
- Playwright configs are separated: mock E2E (`playwright.config.ts` port 3100), Firebase E2E (`playwright.firebase.config.ts` port 3200), QA bots (`playwright.bots.config.ts` port 3300), Teach Bot (`playwright.teach.config.ts`).
- Human-bot proof (`npm run qa:bots:*`) is required by project doctrine for customer-facing scanner/inventory/auth/reconcile changes; live bot proof is owner-gated.

## Pitfalls that waste time

- `scanStore.ts` is ~6,500 lines; search symbols instead of browsing top-to-bottom.
- "Every scan counts" is enforced by call ordering (`ensureProvisionalCount` before awaits/network), not by a single guard function.
- `markWrong` transfers quantity by repointing scan events to a provisional product; never zero/delete counted physical quantity.
- `createdAt` on `ScanEvent` is physical event time. Server write time belongs in separate fields like `syncedAt`/`updatedAt`; do not overwrite event chronology with `serverTimestamp()`.
- `.env.local` is gitignored; never print secrets. Client-exposed vars must be `NEXT_PUBLIC_*`; server API keys stay server-only and are checked by key-safety tests.
- `next.config.ts` `serverExternalPackages` for `firebase-admin`, `better-sqlite3`, and `@libsql/client` is load-bearing; bundling/native-module mistakes can fall through to paid AI.
- Default `npm run lint` currently scans broad repo artifacts; if it fails outside touched files, also run focused lint on changed paths and report unrelated failures separately.
