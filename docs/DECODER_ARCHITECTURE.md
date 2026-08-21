# Decoder architecture

How an unknown scanned code receives an identity. Counting is deliberately outside this pipeline:
the scan store creates the provisional counted event before decode or network work begins. Decode can
only enrich that event. It cannot hide it, remove it, or decide whether it counts.

`src/server/decode/pipeline.ts` is the single server-side owner. The API boundary is
`src/app/api/ai-lookup/route.ts`. Client code must not import either module.

## Resolution order

Every request uses this fixed, stop-on-first-usable-result order:

1. Exact tire corpus match.
2. Exact retail corpus match for a valid, non-misread GTIN shape.
3. Shared learned-products match.
4. Owner-approved master-catalog match.
5. Positive persisted decode cache.
6. In-process positive cache and in-flight coalescing.
7. One GPT-5.4 mini Responses API call with capped built-in web search.

There are no other runtime provider rungs. A deterministic or cached hit returns without consuming a
paid slot. Example/test identifiers and likely misreads stop before paid egress. An unresolved result is
not persisted, so a later scan can benefit from newly available corpus data or a later successful GPT
lookup.

## Trust semantics

- Approved aliases and verified products are the only deterministic `known` identities.
- Tire-corpus and owner-approved master-catalog exact hits may be verified by app-owned evidence.
- Retail-corpus and learned-products results remain suggestions under their existing trust rules.
- GPT-5.4 mini can only produce a suggestion or Needs Review result. Model output never creates an
  approved alias and never verifies itself.
- Human approval moves or confirms the counted identity and teaches the appropriate alias. It never
  creates or deletes a scan event.
- Customer-facing reasons pass through `sanitizeCustomerReason`; raw provider diagnostics remain
  platform-only.

## Cache ownership

- `src/services/ai/decodeCache.ts` owns process-local positive caching and same-key in-flight
  coalescing. Failed decodes do not become reusable cache hits.
- `src/server/decodeCacheStore.ts` owns the platform-wide Turso/file positive cache.
- A persisted row is replayed only after all current deterministic sources miss. This lets corpus or
  master-catalog corrections supersede an older paid suggestion immediately.
- Only usable GPT results are persisted with source tier `gpt_5_4_mini`.
- Legacy source-tier labels are accepted only while reading old rows and are normalized to the current
  GPT tier. This is data compatibility, not an executable legacy provider path.
- `forceRetry` bypasses both positive caches but does not bypass spend, account, or safety gates.

## Paid-egress and spend rules

The paid authorization is lazy and occurs immediately before the one GPT request. The free path always
runs first, including when an account or global cap is exhausted.

`createPaidEgressCoordinator` makes cap settlement sticky for the attempt: concurrent callers await one
settlement promise, and a failed settlement cannot be retried into an uncharged egress. Global and
account counters are charged exactly once. God-mode test/owner behavior bypasses caps explicitly; it
does not create a second provider implementation.

The GPT budget reserves the documented worst-case amount before egress. Aborted or timed-out calls are
recorded at worst case because the upstream request can still be billed. Runtime estimates are a
computed floor only; provider-console billing remains the spend source of truth.

Current server-only variables:

- `OPENAI_API_KEY`
- `GPT_DECODE_MODEL` (defaults to exact alias `gpt-5.4-mini`)
- `GPT_DECODE_DAILY_USD`
- `AI_LOOKUP_GPT_DECODE_FILE`
- `AI_LOOKUP_DAILY_LIMIT`, account-limit variables, and the existing kill/rate-limit controls

## Persistence and idempotency boundary

Decode results attach identity to an already-created scan event. The inventory ledger and replay logic
remain deterministic and AI-free. Every event keeps its stable ID and idempotency key across retries;
Firestore or offline retry failures cannot legitimately mint a second count.

## Test safety

- Unit and integration tests inject `mockGptDecode`; they never call OpenAI.
- Playwright runs with `IS_E2E=1`, which disables live GPT calls unless a local fixture is supplied.
- Live scripts require explicit paid flags and must be reconciled against provider billing before any
  spend claim.
- Relevant gates: `npm run proof:all`, `npm run test:ledger`, `npm run test:firebase`, the focused
  decode/count/persistence Playwright set, and `npm run build`.
