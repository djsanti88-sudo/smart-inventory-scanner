# Go-UPC Decode Rung — Design

Date: 2026-07-08
Status: Approved by owner (this session)
Supersedes: the 2026-07-05 owner-locked "ungrounded Gemini first" ladder rule.
Gemini is REMOVED from the decode ladder by owner decision (option B, this session).

## Goal

Add a paid Go-UPC database lookup as the cheap deterministic rung between the local
database/corpus and the GPT-5.5 grounded rung, so AI spend only occurs for codes no
database knows, and every paid answer becomes a free local answer forever after.

## Decisions (owner-selected)

1. Ladder order: **local DB/corpus -> Go-UPC -> GPT-5.5 (grounded)**. No Gemini rung.
2. Go-UPC hit: **auto-counts with NO app-side checks**. Alias saved permanently.
3. GPT-5.5 answer: **existing evidence gate unchanged** — auto-count only when the
   app-verified evidence gate passes (exact code in evidence, confidence >= 0.8,
   public barcode, no brand-prefix conflict); otherwise suggestion in Needs Review.
4. Go-UPC spend: **no app-side cap**. The provider-side plan quota is the only limit.
   Usage is still counted and logged for observability.
5. Go-UPC misses are **negative-cached for 30 days** so rescans do not re-bill.

## Architecture

- New service directory: `src/services/upc/`
  - `goUpcClient.ts` — pure fetch wrapper for the Go-UPC REST API. Typed response,
    request timeout, no React / next imports. Key read server-side only.
  - `goUpcClient.test.ts` — mocked-fetch unit tests (never live).
- Env var: `GO_UPC_API_KEY` (server-side only; added to `.env.example` by name only).
  `keySafety.test.ts` extended so client code can never read it.
- Wiring point: `src/services/ai/decodeOrchestrator.ts` gains the Go-UPC rung before
  the GPT rung. The rung runs inside the existing server-side decode route.

## Data flow

```
scan
 -> deterministic resolver (approved aliases / verified products)   [free]
 -> decode cache + local corpus (4M+ products)                      [free]
 -> code-type gate: X00 / FNSKU / ASIN / vendor labels SKIP Go-UPC
    (guaranteed misses; protects quota)                             [free]
 -> Go-UPC lookup                                                   [paid, flat]
      hit  -> structurer filter (same one GPT results use)
           -> corpus save with provenance tag source:"go-upc"
           -> AUTO-COUNT, alias saved
      miss -> negative cache (30 days) -> GPT-5.5 rung
 -> GPT-5.5 grounded rung (unchanged, existing caps + evidence gate)
      verified -> auto-count; else suggestion -> Needs Review
 -> nothing anywhere -> Needs Review
```

- One structurer, both paths: Go-UPC hits and GPT answers are normalized through the
  same filter so the corpus holds a single uniform shape.
- Every corpus row saved by this pipeline carries `source: "go-upc" | "gpt" | "human"`
  so bad data can later be traced and purged by origin.

## Error handling

| Go-UPC outcome            | Treatment                                                          |
|---------------------------|--------------------------------------------------------------------|
| 200 with product          | Hit: structurer -> corpus -> auto-count                            |
| 404 / empty               | Genuine miss: negative-cache 30d, fall to GPT rung                 |
| Timeout / 5xx             | Transient: fall to GPT rung, do NOT negative-cache                 |
| 429 / quota exceeded      | Rung unavailable: fall to GPT (bounded by existing AI daily cap);  |
|                           | scan row reason states "Go-UPC quota exhausted" — never silent     |
| Malformed JSON            | Treated as transient miss, logged, not negative-cached             |
| Key missing               | Rung skipped with explicit reason; ladder continues                |

## Cost truth (hard rule compliance)

- BEFORE the first live call: read Go-UPC's pricing page, confirm the billing unit
  (per-lookup vs subscription quota) and verify each billed unit is observable in the
  response/headers. If any component is unmeterable, budget its documented worst case.
- Provider-side quota is the backstop (owner chose no app-side cap).
- Wallet reporting: "computed floor $X; true spend = provider console", reconciled
  against the Go-UPC console after every live run.

## Testing

- Unit (Vitest, node project, all mocked fetch):
  - client: hit, miss, timeout, quota, malformed JSON, missing key
  - orchestrator: order proof (local -> Go-UPC -> GPT), a Go-UPC hit NEVER triggers
    GPT, code-type gate skips vendor labels, negative cache prevents second call,
    transient failures are not negative-cached
  - keySafety: `GO_UPC_API_KEY` never readable client-side
- E2E (Playwright, `page.route` mock, `IS_E2E=1`): scan an unknown code, feed shows
  the Go-UPC-decoded product auto-counted; quota-exhausted mock shows the reason text.
- Live proof: manual only, after the owner buys the key — a small hand-run batch,
  documented in MANUAL_LIVE_TEST.md. Automated tests never call Go-UPC live.

## Out of scope

- Buying the Go-UPC key (owner action).
- Any change to the GPT-5.5 rung internals (owner has a replacement planned).
- Re-adding Gemini anywhere in decode.
- Backfilling the corpus by bulk Go-UPC export (separate future project if wanted).
