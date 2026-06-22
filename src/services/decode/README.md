# `src/services/decode` — the decode subsystem (isolated front door)

This folder is the **single, documented boundary** for the pipeline that turns a scanned code into a trust
decision. It was added in Phase 2 to isolate the subsystem **without changing any behavior**: the runtime
logic still lives in `src/services/ai/*`; this folder only **re-exports** it under one module and names the
contract. Existing imports are untouched and all tests stay green.

- **`contract.ts`** — type-only: `DecodeRequest` → `DecodeResult`, the `DecodeProviderPort` (identity
  providers: Gemini, OpenAI, mock, and a FUTURE RAG provider all implement `AiProvider`), and the
  `DecodeEnrichPort` (the app's page-fetch retrieval).
- **`index.ts`** — barrel re-exporting the pipeline: `runDecode`, `decideDecode`, `crossCheck`,
  `verifyEvidence`, the providers, `enrichWithPageFetch`, cache/budget/fallback helpers.

## How a decode flows (see `docs/decode/ARCHITECTURE.md` for the cited deep dive)

```
DecodeRequest
  -> runDecode (decodeOrchestrator): Gemini + OpenAI + page-fetch concurrently, one budget
       -> verifyEvidence per result (exact scanned code in REAL text?)
       -> crossCheck(a, b)  (agree | conflict | single_provider | weak)
       -> decideDecode      (verified | suggested | conflict | needs_review)
  -> (hard miss only) Stage-2 fallback: ai-deep + Firecrawl race
DecodeResult  -> store auto-count gate (verified + app-verified code + conf>=0.9 + tireOk + no firewall)
```

## Swapping providers (the point of the port)

To add a new identity source (e.g. a **RAG provider** grounded in the tire prefix table + catalog
flywheel), implement `AiProvider` (`{ name, lookup(req, signal) -> AiLookupResult }`) and register it in the
route's provider list. The verification + cross-check + decision layers treat it like any other source, so
its output is still independently evidence-checked. No pipeline rewrite required.

## Invariants this subsystem must preserve (do not weaken)

- Auto-count requires two-provider **agree** OR full **tire corroboration** (strong prefix family + full
  specs + app-verified exact code). Single provider on weak evidence never auto-counts.
- EvidenceVerifier confirms the **exact** scanned code in real text; the model's self-claim is never
  trusted; a different near-match code (e.g. `7451254957818` for `745125495781`) is not a hit.
- The firewall blocks a non-tire product in tire context (`category_context_conflict`).
- Poison `745125495781` routes to Needs Review at the evidence, corroboration, and firewall layers.
