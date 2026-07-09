# Go-UPC Decode Rung — Design (v6)

Date: 2026-07-08 (v2: real API contract from live docs; v3: identity-merge for
multi-barcode products; v4: owner fixes — count-first hard rule, monthly hard stop,
server-side throttle, provenance quarantine, non-GTIN code path; v5: no proactive
alias discovery, Fetch V2 first for unknown SKUs, tenant trust boundary, live
smoke-test evidence; v6: raw response archive — collect everything)
Status: v6 pending owner review
Supersedes: the 2026-07-05 owner-locked "ungrounded Gemini first" ladder rule.
Gemini is REMOVED from the decode ladder by owner decision (this session).

## HARD RULE 0 — Count-first (owner order, 2026-07-08)

**Every scan is persisted BEFORE any lookup runs. Lookup only decides identity.**

- The scan event (raw code, timestamp, id, idempotency key) is written to the feed
  and local persisted state the instant it is captured — before the local DB match,
  before Go-UPC, before GPT.
- A known code increments its product immediately (existing optimistic behavior).
- An unknown code creates its raw feed row + Needs Review entry immediately; decode
  runs ASYNC afterwards and only UPGRADES the row's identity (decoded product,
  suggestion, or reason text).
- Total failure of every rung — network down, quota gone, all providers dead —
  still leaves the raw scan persisted and visible in Needs Review. No scan is ever
  lost or blocked by the decode pipeline. (This kills the class of bug behind the
  "decode POST blocks the browser 36-70s" incident.)

## Goal

Add the Go-UPC database lookup as the cheap deterministic rung between the local
database/corpus and the GPT-5.5 grounded rung, so AI spend only occurs for codes no
database knows, and every paid answer becomes a free local answer forever after.
This is the target architecture for barcode decoding in the actual program.

## Owner state (2026-07-08)

- Go-UPC **Developer plan already purchased**: $74.95/mo, **5,000 lookups/month**,
  flat subscription, JSON only. Go-UPC terms mention overage fees beyond quota.
  The owner HAS the API key.
- Key handling: owner adds it once to `.env.local` as `GO_UPC_API_KEY` (gitignored,
  server-side only, name-only entry in `.env.example`).

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
5. Go-UPC spend (v4, replaces the earlier "no app-side cap"): **local HARD STOP at
   4,800 lookups/month** (buffer under the 5,000 quota because Go-UPC terms mention
   overage fees). Server-side monthly counter; at 4,800 the rung disables itself and
   scans fall through to GPT with reason "Go-UPC monthly cap reached". Manual unlock
   only: raise `GO_UPC_MONTHLY_LIMIT` (env, default 4800) and restart. Soft warning
   surfaced from 4,000 (feed/settings show remaining quota).
6. Go-UPC misses are **negative-cached for 30 days** so rescans do not re-bill.
7. Multi-barcode products (identity-merge): when a decode resolves a NEW code to a
   product that already exists in the catalog:
   - **Exact canonical-GTIN match**: AUTO-LINK — the new code is saved as an alias
     on the existing product and the scan counts against it. No duplicate row.
   - **Fuzzy identity match** (same normalized brand + high name similarity, no
     shared barcode): one-tap "link to existing product?" suggestion in Needs
     Review. Never auto-merged (protects against variant collisions: same tire in a
     different size, 32 oz vs 64 oz).
   - Result: a product's UPC and its vendor SKU label end as ONE row counted twice,
     after at most one human tap, permanent via the alias table thereafter.

## Non-GTIN codes (SKU / internal part number / vendor label) — the path

HARD RULE — NO PROACTIVE ALIAS DISCOVERY (owner order, 2026-07-08): decoding a UPC
NEVER triggers a background search for that product's SKUs, part numbers, or other
aliases. Aliases are learned LAZILY — only when a code is actually scanned — or by
an optional future batch job run deliberately against the database source (out of
scope for this build). Per-scan reverse lookup would burn paid tokens for links
nobody may ever scan.

When the scanned code is NOT a UPC/EAN/GTIN (fails check-digit/format, or
`detectCodeType` says vendor_label / X00 / FNSKU / ASIN / internal):

1. Count-first still applies: raw row persisted immediately.
2. Go-UPC is SKIPPED (it only knows GTINs; a lookup would be a guaranteed wasted
   quota unit — verified live, see "Validated by smoke test" below).
3. Alias table is checked first as always — if a human ever linked this SKU before,
   it resolves instantly and deterministically. This is the steady-state: each SKU
   costs at most ONE resolution ever.
4. Otherwise: **Fetch V2 first (Brave + Firecrawl, trusted-door engine — proven
   2026-07-05: 57 verified vs 34 baseline, zero wrong, pennies per code), then
   GPT-5.5 grounded ONLY if Fetch V2 finds nothing usable** (owner-selected order,
   2026-07-08). Results pass the existing evidence gate either way.
5. Identity-merge then applies: if the answer carries a GTIN matching an existing
   product, the SKU auto-links as an alias to that product (this is exactly the
   "UPC scanned earlier, SKU scanned now" case). Fuzzy match -> one-tap link
   suggestion.
6. If nothing usable from either engine: Needs Review with the raw row; human
   resolution permanently teaches the alias.

### Validated by smoke test (live, 2026-07-08, $0 — public website, no API quota)

Five non-GTIN codes (FNSKU `X004DY7YUT`, MPNs `DCB205` / `FL-820-S` / `K060841`,
vendor label `ZQX-99417-B`) all returned **HTTP 400** from Go-UPC — it refuses to
even attempt non-GTIN input. Control code `848983006257` (real UPC) decoded
correctly as "Falken Wildpeak A/T3W 265/70R17 115T Tire". Conclusions: (a) the
code-type gate loses nothing and saves quota; (b) a slipped-through SKU cannot
poison results (400, not a wrong answer); (c) first positive tire-coverage signal —
Go-UPC resolved an owner Falken tire barcode with full size/load specs.

## Raw response archive — collect everything (owner order, 2026-07-08)

Every paid answer is archived COMPLETE and RAW, server-side, even though the UI
keeps showing only the basic rows it shows today.

- Go-UPC: the full untouched JSON response (name, brand, description, imageUrl,
  barcodeUrl, category + categoryPath, ALL specs key-values, ingredients, upc/ean,
  codeType, inferred) plus retrieval metadata: scanned code, canonical GTIN,
  endpoint, HTTP status, fetchedAt timestamp.
- Fetch V2 / GPT-5.5: same principle — full raw provider output plus every source
  URL the answer cited or fetched (Fetch V2 already carries sources; they are
  archived, not discarded after the evidence gate).
- Storage: an archive table/collection keyed by canonical code + provider +
  fetchedAt, separate from the normalized corpus row (raw-and-normalized pattern,
  which is already project doctrine for AI results). The normalized corpus row
  references its archive entry.
- The UI renders NOTHING new from this yet — basic rows stay as they are. The
  archive exists so that (a) a future, better structurer can be re-run over every
  answer ever paid for WITHOUT re-billing a single lookup or token; (b) images
  (imageUrl) and source URLs are already on hand the day the UI wants them;
  (c) disputes ("why did it call this a Falken?") are answerable from evidence.
- Images are archived as URLs only (no downloading/re-hosting — no new fetch
  surface, consistent with Out of scope).

## Tenant trust boundary (owner order, 2026-07-08)

Human links are trusted COMPLETELY — but only within the tenant that made them.

- Every human approval (resolveUnknown, alias link, "link to existing product" tap)
  writes ONLY into that customer's own tenant-scoped data (`businessId`-scoped
  aliases, products, counts). Full trust applies there: it counts, it is permanent,
  it is deterministic on every future scan in that tenant.
- Human links NEVER write to the global catalog / master truth-source database
  (the 4M+ product catalog). A malicious or careless customer can therefore poison
  only their own inventory, never the shared source every tenant reads from.
- The global catalog is writable ONLY by the platform owner and the verified
  pipeline (Go-UPC exact hits, evidence-gated decodes) under the platform owner's
  control. Promotion of a tenant-taught alias into the global catalog, if ever
  wanted, is a deliberate platform-owner action — never automatic.

## Go-UPC API contract (read from https://go-upc.com/docs, 2026-07-08)

- Endpoint: `GET https://go-upc.com/api/v1/code/:code`
- Auth: `Authorization: Bearer <GO_UPC_API_KEY>` header ONLY (never the query-param
  form, which would leak the key into logs/URLs).
- Accepts: UPC-A (GTIN-12), EAN-13, EAN-8, GTIN-14.
- Response fields to harvest: `product.name`, `product.brand`, `product.description`,
  `product.imageUrl` (feeds the existing hover preview), `product.category`
  (Google Shopping taxonomy), `product.specs` (key-value pairs, industry-specific —
  may carry tire specs), `product.upc` / `product.ean` (identity-merge keys),
  `codeType`, `inferred`.
- Errors: 400 unrecognized code format; 401 auth failure; 404 product not found;
  429 quota or rate-limit exceeded.
- **Rate limit: 2 requests/second** on all plans.

## Architecture

ALL Go-UPC access lives behind the server decode route. The key, the throttle, the
usage counter, and the hard stop are server-side; client code never sees any of them.

- New service directory: `src/services/upc/`
  - `goUpcClient.ts` — pure fetch wrapper. Typed response, request timeout, Bearer
    auth, no React / next imports. Key read server-side only.
  - `goUpcThrottle.ts` — SERVER-SIDE queue in the decode route process enforcing
    max 2 req/s PLUS in-flight dedup: concurrent scans of the same unknown code
    produce exactly one API call (callers await the same promise).
  - `goUpcUsage.ts` — server-side monthly counter (file-based, same pattern as
    `.ai-lookup-usage.json`): increments per real API call, soft-warn at 4,000,
    HARD STOP at `GO_UPC_MONTHLY_LIMIT` (default 4800), resets on calendar month,
    reconciled against the Go-UPC console monthly.
  - `gtin.ts` — GTIN utilities: normalize UPC-A/EAN-13 leading-zero equivalence to
    ONE canonical form (used for the lookup, the negative cache key, and the corpus
    key), and check-digit validation (invalid = misread scan = skip Go-UPC, raw row
    to Needs Review, no lookup spent).
  - matching `*.test.ts` for each (mocked fetch, never live).
- Env vars: `GO_UPC_API_KEY`, `GO_UPC_MONTHLY_LIMIT` (server-side only).
  `keySafety.test.ts` extended so client code can never read the key.
- Quarantine/purge tooling: every corpus row carries provenance
  `source: "go-upc" | "gpt" | "human"`. A maintenance script
  (`scripts/corpus-purge.mjs`, run as `node scripts/corpus-purge.mjs --source go-upc
  [--revalidate]`) can in ONE command list, purge, or re-queue-for-revalidation all
  rows from a given source — so if a provider turns out to ship bad data, recovery
  is one command, not a manual hunt.
- Wiring point: `src/services/ai/decodeOrchestrator.ts` gains the Go-UPC rung before
  the GPT rung, inside the existing server-side decode route.

## Data flow

```
scan captured
 -> STEP 0 (count-first): persist ScanEvent + show feed row NOW      [always]
 -> deterministic resolver (approved aliases / verified products)    [free]
      known -> increment product, DONE (no lookup of any kind)
 -> decode cache + local corpus (4M+ products)                       [free]
 -> code-type gate: non-GTIN (SKU/MPN/X00/FNSKU/vendor) SKIPS Go-UPC [free]
 -> GTIN normalize + check-digit validation (invalid -> Needs
    Review, no lookup spent)                                         [free]
 -> Go-UPC lookup (server-side throttle 2/s, in-flight dedup,
    monthly counter, hard stop 4,800)                                [paid quota]
      exact hit    -> structurer filter (same one GPT results use)
                   -> identity-merge check -> corpus save,
                      provenance source:"go-upc"
                   -> AUTO-COUNT, alias saved
      inferred hit -> structurer filter -> suggestion in Needs
                      Review (product attached), corpus save only
                      after human approval
      miss (404)   -> negative cache 30 days -> GPT-5.5 rung
 -> GPT-5.5 grounded rung (unchanged, existing caps + evidence gate)
      verified -> identity-merge check -> auto-count
      else    -> suggestion -> Needs Review
 -> nothing anywhere -> raw row stays in Needs Review (already
    persisted at STEP 0 — nothing is ever lost)
```

- One structurer, both paths: Go-UPC hits and GPT answers are normalized through the
  same filter so the corpus holds a single uniform shape. The structurer maps ALL
  harvested Go-UPC fields: name, brand, description, imageUrl, category, specs.
- **Identity-merge on corpus save**: before creating a product row from any decode
  result, look up existing products by canonical GTIN (Go-UPC returns `product.upc`
  / `product.ean`; GPT results carry their reported barcode). Exact GTIN match ->
  attach the scanned code as a new alias on the existing product and count there
  (never a duplicate row). No GTIN match but same normalized brand + high name
  similarity -> "link to existing product?" suggestion in Needs Review.
- Decode is asynchronous: the feed row shows Decoding -> outcome; the scanner input
  stays focused and scanning never waits on the pipeline.

## Error handling

| Go-UPC outcome            | Treatment                                                          |
|---------------------------|--------------------------------------------------------------------|
| 200, inferred: false      | Exact hit: structurer -> identity-merge -> corpus -> auto-count    |
| 200, inferred: true       | Suggestion in Needs Review; never auto-counted                     |
| 404                       | Genuine miss: negative-cache 30d (canonical GTIN key), fall to GPT |
| 400                       | Bad format (should be pre-caught by check-digit gate): treat as    |
|                           | non-GTIN, route per code-type gate, no negative cache              |
| 401                       | Key invalid: rung disabled with explicit reason, surfaced to owner |
| 429 (provider)            | Provider-side quota/rate: fall to GPT (bounded by existing AI      |
|                           | daily cap); reason "Go-UPC quota exhausted" — never silent         |
| Local hard stop (4,800)   | Rung self-disables BEFORE the call; fall to GPT; reason "Go-UPC    |
|                           | monthly cap reached"; unlock = raise GO_UPC_MONTHLY_LIMIT          |
| Timeout / 5xx             | Transient: fall to GPT rung, do NOT negative-cache                 |
| Malformed JSON            | Treated as transient miss, logged, not negative-cached             |
| Key missing               | Rung skipped with explicit reason; ladder continues                |

In EVERY row above, the scan itself was already persisted at STEP 0.

## Cost truth (hard rule compliance)

- Pricing read 2026-07-08 (https://go-upc.com/plans): flat $74.95/mo subscription,
  5,000 lookups/mo. Terms mention overage fees beyond quota — hence the local hard
  stop at 4,800 (never trust the provider to stop billing at the boundary).
- Billing unit = one lookup per API request; observable 1:1 in our own request log,
  so spend IS meterable (unlike Gemini grounding).
- Effective floor ~1.5 cents/lookup at full quota use; unused quota raises it.
- Reconcile the local usage counter against the Go-UPC console after the first live
  run and monthly thereafter; report as "computed floor; true spend = console".

## Testing

- Unit (Vitest, node project, all mocked fetch):
  - client: exact hit, inferred hit, miss, 400/401/429, timeout, malformed JSON,
    missing key; Bearer header used (never query param)
  - gtin: UPC-A/EAN-13 normalization equivalence, check-digit accept/reject
  - throttle: 2/s ceiling honored, concurrent same-code scans -> one call
  - usage: counter increments only on real calls, soft warn at 4,000, hard stop at
    4,800 blocks the call and falls through with the right reason, month rollover
    resets, GO_UPC_MONTHLY_LIMIT override respected
  - count-first: decode pipeline throwing at EVERY rung still leaves the persisted
    scan row + Needs Review entry (regression for the blocking-decode bug class)
  - orchestrator: order proof (local -> Go-UPC -> GPT), an exact Go-UPC hit NEVER
    triggers GPT, inferred hit routes to Needs Review AND does not call GPT,
    code-type gate skips vendor labels/SKUs, negative cache prevents second call,
    transient failures are not negative-cached
  - identity-merge: decode result whose GTIN matches an existing product attaches
    an alias and increments that product (no duplicate row); fuzzy brand+name match
    produces a link suggestion, never an auto-merge; scanning UPC then SKU of the
    same product ends at quantity 2 on one row
  - purge script: dry-run lists by source, purge removes only that source,
    revalidate re-queues without data loss
  - archive: every 200 response writes a complete raw archive entry with retrieval
    metadata; the normalized corpus row references it; archive survives purge of
    the normalized row (evidence is never destroyed by a quarantine action)
  - keySafety: `GO_UPC_API_KEY` never readable client-side
- E2E (Playwright, `page.route` mock, `IS_E2E=1`): unknown code -> Go-UPC-decoded
  product auto-counted on the feed; inferred -> Needs Review with suggestion;
  cap-reached mock shows the reason text; kill-all-providers mock still shows the
  raw persisted row. Proof screenshots to `e2e/proof/`.
- Live proof (manual, owner-gated): with the key in `.env.local`, run the existing
  100-code own-DB benchmark set (retail + tires) through the rung (~2% of monthly
  quota) to measure the REAL hit rate on the owner's inventory — especially tires.
  Report hit rate by category + usage-counter-vs-console reconciliation. Documented
  in MANUAL_LIVE_TEST.md.

## Out of scope

- Batch alias discovery job (bulk-resolving SKUs/part numbers from the database
  source with Fetch V2/Brave in deliberate offline batches) — possible future
  project, explicitly NOT triggered per-scan.
- Any change to the GPT-5.5 rung internals (owner has a replacement planned).
- Re-adding Gemini anywhere in decode.
- Backfilling the corpus by bulk Go-UPC export (Go-UPC docs mention bulk lookup but
  publish no endpoint; separate future project if wanted).
- Image downloading/re-hosting: `imageUrl` is stored and rendered by the existing
  hover-preview path as a remote URL; no new fetch surface is added.
