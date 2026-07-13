# scripts/

One line per living script. Everything else that lived directly in `scripts/tmp-*` has been
archived (see bottom of this file).

- `dev.mjs` — backend-safe dev launcher; picks mock/emulator/production Firebase before
  `next dev` starts and prints a banner so `npm run dev` never silently writes to prod.
- `build-knowledge-db.mjs` — converts tire + retail JSON indexes into the SQLite knowledge DB
  (`src/server/knowledge.generated.db`) for microsecond barcode lookups.
- `build-tire-knowledge.mjs` — generates the committed, versioned tire-knowledge index from the
  Tire Barcode Harvester's stable snapshot; fails closed (never overwrites on validation failure).
- `build-retail-knowledge.mjs` — generates the committed retail barcode index from the Open Food
  Facts JSONL dataset for instant local resolution without AI.
- `build-prefix-index.mjs` — offline derivation of the GS1 prefix-confidence map used by the
  anti-hallucination brand-prefix firewall; statistical evidence, not official GS1 truth.
- `cloud-smoke.mjs` — Cloud Loop 8 smoke test: real Firebase Auth + tenant-isolation/role/audit
  proof against the real Firebase project (not the emulator); self-cleaning and idempotent.
- `corpus-purge.mjs` — CLI to quarantine corpus rows learned from a paid decode source
  (Go-UPC / GPT / Fetch V2); thin wrapper over the unit-tested `purgeBySource` library.
- `eval-decode.ts` — decode eval harness CLI entry; mock baseline by default, `--live` opt-in
  only for a small manual run against the running dev server.
- `benchmark-decodes.ts` — Phase 1 decode benchmark runner; hits the running dev server's
  `/api/ai-lookup` route to exercise the real fast path, fallback, cache, and diagnostics.
- `weekly-report.mjs` — merged weekly report (QA proof bots + product-intelligence pipeline)
  producing one HTML+PDF report, emailed.
- `weekly-intel.mjs` — weekly intelligence pipeline: live tire decode scan on fresh codes
  (speed/accuracy/cost) plus a tire-focused report, PDF, and email.
- `release-sentinel.mjs` — deterministic, read-only deploy-safety gate extending
  `release-hygiene.mjs`; never calls Vercel/Firebase/GitHub and never deploys.
- `patch-jwks-rsa.cjs` — postinstall patch so `jwks-rsa`'s top-level `require('jose')` doesn't
  crash `/api/resolve-scan` on Vercel's Turbopack external loader (jose v6 is ESM-only).
- `email-report.mjs` — sends the weekly report via Gmail SMTP; degrades gracefully with no
  credentials configured.
- `create-god-account.mjs` — provisions an owner ("god") account on the real cloud Firebase
  project via the public Auth/Firestore REST APIs (no Admin SDK, no service account); idempotent.
- `backfill-missing-tires.mjs` — owner-gated, paid decode of tire codes missing from both local
  SQLite and Turso corpus; writes a review JSON only, never upserts directly.
- `barcode-harvester/` — the Tire Barcode Harvester subsystem (owns `data/tire-knowledge`).
- `dt-harvest/` — the weekly DT (Discount Tire) harvest job subsystem.

## Archived tmp scripts

`archive-tmp-2026-07/` holds ~78 one-off `tmp-*` probe/benchmark/report artifacts (scripts and
their JSON/PDF outputs) that were live working files during the decode-ladder + Go-UPC benchmark
work in July 2026. They are frozen history, not part of any active workflow, and safe to delete
on owner order.
