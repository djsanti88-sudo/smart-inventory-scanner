# Go-UPC Decode Rung — Design (v2)

Date: 2026-07-08 (v2, same day: updated after reading the full Go-UPC docs and pricing)
Status: v2 pending owner review
Supersedes: the 2026-07-05 owner-locked "ungrounded Gemini first" ladder rule.
Gemini is REMOVED from the decode ladder by owner decision (this session).

## Goal

Add the Go-UPC database lookup as the cheap deterministic rung between the local
database/corpus and the GPT-5.5 grounded rung, so AI spend only occurs for codes no
database knows, and every paid answer becomes a free local answer forever after.
This is the target architecture for barcode decoding in the actual program.

## Owner state (2026-07-08)

- Go-UPC **Developer plan already purchased**: $74.95/mo, **5,000 lookups/month**,
  flat subscription, JSON only. The owner HAS the API key.
- Key handling: owner provides the key once; it goes in `.env.local` as
  `GO_UPC_API_KEY` (gitignored, server-side only, name-only entry in `.env.example`).

## Decisions (owner-selected)

1. Ladder order: **local DB/corpus -> Go-UPC -> GPT-5.5 (grounded)**. No Gemini rung.
2. Go-UPC EXACT hit (`inferred: false`): **auto-counts with NO app-side checks**.
   Alias saved permanently.
3. Go-UPC INFERRED hit (`inferred: true`, Go-UPC reconstructed missing digits — the
   answer is for a code that is not exactly what was scanned): **suggestion only** —
   routed to Needs Review with the product attached, never auto-counted. This is the
   single owner-approved exception to "no checks", because an inferred match is the
   one case where the database itself is guessing.
4. GPT-5.5 answer: **existing evidence gate unchanged** — auto-count only when the
   app-verified evidence gate passes (exact code in evidence, confidence >= 0.8,
   public barcode, no brand-prefix conflict); otherwise suggestion in Needs Review.
5. Go-UPC spend: **no app-side cap**. The 5,000/mo plan quota is the only limit.
   Usage is still counted locally for observability.
6. Go-UPC misses are **negative-cached for 30 days** so rescans do not re-bill.

## Go-UPC API contract (read from https://go-upc.com/docs, 2026-07-08)

- Endpoint: `GET https://go-upc.com/api/v1/code/:code`
- Auth: `Authorization: Bearer <GO_UPC_API_KEY>` header (production method; never the
  query-param form, which would leak the key into logs/URLs).
- Accepts: UPC-A (GTIN-12), EAN-13, EAN-8, GTIN-14.
- Response fields to harvest: `product.name`, `product.brand`, `product.description`,
  `product.imageUrl` (feeds the existing hover preview), `product.category`
  (Google Shopping taxonomy), `product.specs` (key-value pairs, industry-specific —
  may carry tire specs), `codeType`, `inferred`.
- Errors: 400 unrecognized code format; 401 auth failure; 404 product not found;
  429 quota or rate-limit exceeded.
- **Rate limit: 2 requests/second** on all plans.

## Architecture

- New service directory: `src/services/upc/`
  - `goUpcClient.ts` — pure fetch wrapper. Typed response, request timeout, Bearer
    auth, no React / next imports. Key read server-side only.
  - `goUpcThrottle.ts` — client-side queue enforcing max 2 req/s PLUS in-flight
    dedup: two concurrent scans of the same unknown code produce exactly one API
    call (both callers await the same promise).
  - `gtin.ts` — GTIN utilities: normalize UPC-A/EAN-13 leading-zero equivalence to
    ONE canonical form (used for the lookup, the negative cache key, and the corpus
    key, so one product is never paid for or stored twice), and check-digit
    validation (invalid check digit = misread scan = skip Go-UPC, route to Needs
    Review without spending a lookup).
  - matching `*.test.ts` for each (mocked fetch, never live).
- Env var: `GO_UPC_API_KEY` (server-side only). `keySafety.test.ts` extended so
  client code can never read it.
- Usage counter: local monthly counter file (same pattern as `.ai-lookup-usage.json`)
  tracking lookups used this month, visible without opening the Go-UPC console.
- Wiring point: `src/services/ai/decodeOrchestrator.ts` gains the Go-UPC rung before
  the GPT rung, inside the existing server-side decode route.

## Data flow

```
scan
 -> deterministic resolver (approved aliases / verified products)   [free]
 -> decode cache + local corpus (4M+ products)                      [free]
 -> code-type gate: X00 / FNSKU / ASIN / vendor labels SKIP Go-UPC  [free]
 -> GTIN normalize + check-digit validation (invalid -> Needs
    Review, no lookup spent)                                        [free]
 -> Go-UPC lookup (throttled 2/s, in-flight deduped)                [paid quota]
      exact hit    -> structurer filter (same one GPT results use)
                   -> corpus save, provenance source:"go-upc"
                   -> AUTO-COUNT, alias saved
      inferred hit -> structurer filter -> suggestion in Needs
                      Review (product attached), corpus save only
                      after human approval
      miss (404)   -> negative cache 30 days -> GPT-5.5 rung
 -> GPT-5.5 grounded rung (unchanged, existing caps + evidence gate)
      verified -> auto-count; else suggestion -> Needs Review
 -> nothing anywhere -> Needs Review
```

- One structurer, both paths: Go-UPC hits and GPT answers are normalized through the
  same filter so the corpus holds a single uniform shape. The structurer maps ALL
  harvested Go-UPC fields: name, brand, description, imageUrl, category, specs.
- Every corpus row saved by this pipeline carries `source: "go-upc" | "gpt" | "human"`
  so bad data can later be traced and purged by origin.

## Error handling

| Go-UPC outcome            | Treatment                                                          |
|---------------------------|--------------------------------------------------------------------|
| 200, inferred: false      | Exact hit: structurer -> corpus -> auto-count                      |
| 200, inferred: true       | Suggestion in Needs Review; never auto-counted                     |
| 404                       | Genuine miss: negative-cache 30d (canonical GTIN key), fall to GPT |
| 400                       | Bad format (should be pre-caught by check-digit gate): treat as    |
|                           | non-GTIN, route per code-type gate, no negative cache              |
| 401                       | Key invalid: rung disabled with explicit reason, surfaced to owner |
| 429                       | Quota/rate exceeded: fall to GPT (bounded by existing AI daily     |
|                           | cap); scan row reason "Go-UPC quota exhausted" — never silent      |
| Timeout / 5xx             | Transient: fall to GPT rung, do NOT negative-cache                 |
| Malformed JSON            | Treated as transient miss, logged, not negative-cached             |
| Key missing               | Rung skipped with explicit reason; ladder continues                |

## Cost truth (hard rule compliance)

- Pricing read 2026-07-08 (https://go-upc.com/plans): flat $74.95/mo subscription,
  5,000 lookups/mo, no per-lookup metering outside the quota, no hidden per-use fees
  identified. Billing unit = one lookup per API request; observable 1:1 in our own
  request log, so spend IS meterable (unlike Gemini grounding).
- Effective floor ~1.5 cents/lookup at full quota use; unused quota raises it.
- Provider-side quota is the backstop (owner chose no app-side cap).
- Reconcile the local usage counter against the Go-UPC console after the first live
  run and monthly thereafter.

## Testing

- Unit (Vitest, node project, all mocked fetch):
  - client: exact hit, inferred hit, miss, 400/401/429, timeout, malformed JSON,
    missing key; Bearer header used (never query param)
  - gtin: UPC-A/EAN-13 normalization equivalence, check-digit accept/reject
  - throttle: 2/s ceiling honored, concurrent same-code scans -> one call
  - orchestrator: order proof (local -> Go-UPC -> GPT), an exact Go-UPC hit NEVER
    triggers GPT, inferred hit routes to Needs Review AND does not call GPT,
    code-type gate skips vendor labels, negative cache prevents second call,
    transient failures are not negative-cached
  - keySafety: `GO_UPC_API_KEY` never readable client-side
- E2E (Playwright, `page.route` mock, `IS_E2E=1`): unknown code -> Go-UPC-decoded
  product auto-counted on the feed; inferred -> Needs Review with suggestion;
  quota-exhausted mock shows the reason text. Proof screenshots to `e2e/proof/`.
- Live proof (manual, owner-gated): after the key is in `.env.local`, run the
  existing 100-code own-DB benchmark set (retail + tires) through the rung
  (~2% of monthly quota) to measure the REAL hit rate on the owner's inventory —
  especially tires, where every prior database was weak. Report hit rate by
  category + usage-counter-vs-console reconciliation. Documented in
  MANUAL_LIVE_TEST.md.

## Out of scope

- Any change to the GPT-5.5 rung internals (owner has a replacement planned).
- Re-adding Gemini anywhere in decode.
- Backfilling the corpus by bulk Go-UPC export (Go-UPC docs mention bulk lookup but
  publish no endpoint; separate future project if wanted).
- Image downloading/re-hosting: `imageUrl` is stored and rendered by the existing
  hover-preview path as a remote URL; no new fetch surface is added.
