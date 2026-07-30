# Claude Code Handoff — Smart Inventory Scanner (inventory)

*Written 2026-07-06 from a grounded Cowork analysis. Run in Claude Code, in the inventory repo. **Model: Claude Fable 5 (`claude-fable-5`)** as the owner requested.*

> **Model heads-up (owner's call):** Fable 5 is set per your request. For the *code-heavy* tiers (3–4: build/test/refactor/deps) a coder-tuned model (Sonnet 5 or Opus 4.8) is usually stronger; Fable 5 shines on the *writing-heavy* tiers (README, doc consolidation, reports). Consider switching models per tier — or keep Fable 5 throughout; your choice.

---

## 0. How to work (read first)
- This project runs under the master **Engineering Doctrine** (`C:\Users\djsan\.claude\ENGINEERING_DOCTRINE.md`): **prove don't assume · plan-gate non-trivial work · no partials · sized proof + reports.** Honor it. `PROGRESS.md` is the status source-of-truth — update it after every phase.
- Use the full arsenal: subagents for parallel work, the project's own **Vitest + Playwright** for proof (screenshots on any UI change), eslint, `npm run build`. Don't hand-wave — prove with test/build output.
- **Branch → PR → `master`**, one task per branch, each master promotion gets a merge-card + owner approval. Never self-merge or deploy.
- **HARD GATES — stop and ask:** production deploy · deploying/altering **Firestore security rules** · live Firebase data/billing · DNS · paid/live API calls · real user data · deleting data.
- Never say "done" without proof.

## What this app is (grounded)
A private **smart barcode inventory scanner** (barcode acts as a keyboard: types code + Enter). Flow: capture raw scan → clean → deterministically match to a product via an **alias table** (many codes → one product) → **optimistic** quantity increment (Zustand + localStorage) → **idempotent** DB sync (keys prevent double-counting) → unknown codes go to a **Needs Review** queue → human resolution permanently teaches a new alias. Domain-agnostic (tires, auto parts, supplements, tools, warehouse, retail, medical…). Built to become **multi-tenant SaaS** (every record scoped by `businessId`).
**Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 · Zustand · Vitest (node + jsdom projects) · Playwright E2E. **~194 TS/TSX source files.** A "decode brain" (`decodeOrchestrator`, `evidenceScoring.decideAutoVerification`) currently in **"trust the AI + fast"** mode (strict confidence-gating was removed per owner directive, 2026-06-14).

## Findings to fix (why this handoff exists)
1. **Doc-vs-reality gap (highest):** `CLAUDE.md` says "Local mock data mode (no Firebase wired). Firebase is a documented future path." **Reality:** Firebase Phase 2 IS wired — `src/lib/firebaseAdmin.ts`, `e2e/firebase-phase2/`, `scripts/seed-business-catalog.ts`, `scripts/cloud-smoke.mjs`, `firebase-admin@14`, `firestore.rules`, a `firestore-debug.log`. A fresh session reading CLAUDE.md would be actively misled.
2. **On OneDrive → files are cloud-only:** git isn't even readable by tooling and `src/` doesn't stat until hydrated. Same disease we just cured on quiz-ai. Move it to a local path.
3. **No `.gitattributes`** → CRLF phantom-changes risk (same as quiz-ai).
4. **24 root `.md` docs + boilerplate README** (still the default create-next-app text) → sprawl + a useless front door.
5. **Worktree clutter** under `.claude/worktrees/agent-*`.
6. **Secrets hygiene:** confirm `.env.local` is gitignored (not tracked) and `firestore-debug.log` isn't committed.

---

## THE BACKLOG — highest ROI first

### TIER 1 — foundation (do first, low risk, high leverage)
**A. Reconcile docs to reality — Firebase status.** ★★★★★ — Determine the TRUE current mode: run `npm run dev:emulator` and `npm run dev:prod` and `node scripts/cloud-smoke.mjs`; inspect `firebaseAdmin.ts` + where Firestore is actually read/written. Then FIX `CLAUDE.md`, `FIREBASE_SETUP.md`, `FIREBASE_SECURITY.md`, `PHASE1/2_*` to state exactly what's wired vs mock. Prove it (paste the smoke output). This is the single most misleading thing in the repo.
**B. Move off OneDrive → local.** ★★★★★ — Copy the repo to a local non-synced path (e.g. `C:\Users\djsan\Projects\inventory`), verify git integrity + `npm run build` there, keep the OneDrive copy as fallback, then work from the local one. (This is why tooling couldn't read `.git`/`src`.)
**C. Git hygiene.** ★★★★ — In the local copy: add `.gitattributes` (`* text=auto eol=lf`, `*.ps1/.bat/.cmd eol=crlf`, binaries `binary`), `git add --renormalize .`, commit. Tag every branch tip `bkp/*` first. Prune merged branches (`git branch -d`) + stale worktrees (`git worktree remove --force`). Confirm `.env.local` + `firestore-debug.log` are gitignored (untrack if committed).

### TIER 2 — docs (writing-heavy — good for Fable 5)
**D. Rewrite the README.** ★★★★ — Replace the create-next-app boilerplate with the real thing: what the scanner does, the scan→alias→optimistic→idempotent-sync→needs-review flow, run/test/deploy commands, architecture, Firebase status. This is the project's front door.
**E. Consolidate the 24 root docs.** ★★★ — Keep live: `PROGRESS.md`, `DECISIONS.md`, `RISK_REGISTER.md`, `CLAUDE.md`, `AGENTS.md`, `TESTING.md`, `README.md`, `FIREBASE_SECURITY.md`, `PLAN_TEMPLATE.md`. Archive dated one-time reports → `docs/archive/`: `PHASE1_*`, `LIVE_DECODE_DIAGNOSIS`, `LIVE_FALLBACK_PROOF`, `LOOKUP_BENCHMARK_SPRINT`, `RECONCILIATION`, `RESOLVER_AUDIT`, `MANUAL_LIVE_TEST`, `COMPETITOR_ANALYSIS` (move `competitor-analysis.html` too). Fix stale facts (esp. any "mock only" claims). Ask owner before deleting anything.

### TIER 3 — prove the code works (code-heavy — consider Sonnet/Opus)
**F. Full proof run.** ★★★★ — `npm install` → `npm run build` (must pass) → `npm run lint` → `npm run test` (Vitest) → `npm run test:e2e` (`npx playwright install chromium` first). Fix failures; capture E2E screenshots. Report pass/fail counts.
**G. Dependency + engine review.** ★★★ — Next 16 / React 19 are bleeding-edge: `npm audit`, check for known issues, confirm the `patch-jwks-rsa.cjs` postinstall is still necessary (or replace the hack). Review the decode brain (`decodeOrchestrator`, `evidenceScoring`) for dead strict-gate code left after the "trust the AI" revert.

### TIER 4 — product decision (gated)
**H. Firebase Phase 2 completion.** — Decide with owner: is multi-tenant (`businessId` scoping) + Firestore rules meant to be fully live now, or staged? Do NOT deploy/alter `firestore.rules` or touch prod data without approval. Prove rules with the emulator + rules tests, not against prod.

### TIER 5 — capstone
**I. Forensic verification + preview.** ★★★ — Green build + all Vitest + Playwright passing (screenshots) + a Vercel **preview** deploy; walk the scan→count→idempotent-sync→needs-review→teach-alias flow end-to-end; verify Firestore rules + no leaked secrets + git health. Report healthy/at-risk/changed + next steps. Deploy to prod only on owner approval.

## Definition of done (every task)
Branch + PR + merge-card + owner OK; sized proof (build/test/E2E output + screenshots) per the Engineering Doctrine; `PROGRESS.md` updated; backups (`bkp/` tags + OneDrive copy) retained until owner says otherwise.
