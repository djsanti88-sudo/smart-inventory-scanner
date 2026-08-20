# Manual Live Decode Test

Automated tests NEVER call live providers (the Playwright webServer runs `IS_E2E=1`, which forces
the AI route to mock-only). Use this checklist to do ONE controlled real decode by hand. Live
provider calls are owner-gated: run this only with the owner's explicit OK in the moment.

The decode ladder is cost-ordered (`src/server/decode/pipeline.ts`): free rungs first (local tire +
retail corpus, decode cache, learned tier, UPCitemdb, Open Food Facts), then daily-cap-gated paid
rungs (Go-UPC for valid GTINs, Fetch V2, GPT). The first settled rung stops the ladder. Gemini is
not used anywhere in the app.

## 1. Configure keys (server-side only)

Edit `.env.local` (gitignored, never committed). Names only, per rung:

```
OPENAI_API_KEY=...        # GPT ladder rung
GO_UPC_API_KEY=...        # Go-UPC rung (GTIN-shaped codes only)

ENABLE_LIVE_AI_LOOKUP=true   # server-enforced master switch for paid rungs
AI_LOOKUP_DAILY_LIMIT=100    # daily paid-rung cap (only paid rungs charge it)
```

`ENABLE_LIVE_AI_LOOKUP=false` disables every paid rung server-side; `AI_LOOKUP_KILL_SWITCH` stops
every decode entirely (see `src/server/upc/paidWorkPossible.ts`). Restart the dev server after
editing env. Full env reference: `docs/COMMANDS.md`.

## 2. Verify the app sees the keys

1. Open http://localhost:3000.
2. Settings shows the ladder status and the daily paid-rung counter. Confirm live lookup is on and
   the counter is below the cap.

## 3. Run one live decode

1. Go to Scan and scan or type a code that is NOT in the local corpus, then Enter.
2. The row appears and counts IMMEDIATELY (top-level law), then updates with the decode result:
   verified, suggested (with a confidence band and Approve/Edit), or unidentified with an honest
   reason - never a silent failure.
3. Settings' daily counter increments ONLY if a paid rung actually fired; corpus/cache hits are
   free.
4. If you Approve a suggestion, a tenant alias is saved. Re-scan the same code: it resolves
   instantly and deterministically with ZERO provider calls (shared decode cache + alias).

## 4. Safety

- Keys are read server-side only (`src/services/keySafety.test.ts` proves they never reach the
  browser bundle).
- The daily cap gates paid upgrades only; it never hides or discards a free identity already in
  hand, and a cap-blocked scan shows its real reason.
- A researched code is paid for once: the shared decode cache replays it for $0 afterward
  (`docs/DECODER_ARCHITECTURE.md` section 2b).
- Do not run uncontrolled live loops; one manual scan is the intended scope of this checklist.
