# KKM isolated catalog snapshot

## Owner-confirmed goal

Create a separate, resumable KKM catalog database from the K&M/Weblink tire UI,
collecting every user-visible tire record and available data-sheet specification without
touching the existing corpus. KKM is the internal code name. The owner explicitly
authorized K&M collection only, with read-only behavior and conservative request caps.

## Acceptance criteria

1. `data/kkm-catalog/kkm.sqlite` exists separately from the application corpus and has a
   transactional run/shard/product/snapshot/spec ledger. Proof: schema test.
2. Only normal authenticated K&M UI searches are used, with no cart, quote, order,
   image, account, ATD, or NTW action. Proof: recorded run policy and browser evidence.
3. Every completed search leaf has fewer than 250 returned entries. A 250-entry result is
   recorded as capped and recursively split only through a verified UI filter. Proof:
   shard ledger contains no unresolved capped/error leaves before a completion claim.
4. Results retain displayed K&M Part Number, raw row, source URL, time, and source shard;
   UPC is explicitly not exposed rather than inferred. Proof: database query.
5. Data-sheet enrichment is separately resumable and terminally classified for each
   collected part. Proof: `datasheet_attempts` and per-field counts.

## Scope and risk gates

- Included classes: 01, 02, 03, 04, 05, 08, 09, 10, 11, 13, 14, 15.
- Excluded: tubes/flaps, wheels, parts, repair, TPMS, valves, weights, images, all
  other distributors, the existing corpus, cross-referencing, ordering, and account data.
- Rate policy: one request in flight, wait for the ordinary UI to settle, conservative
  gap/backoff, and hard stop for CAPTCHA, access denial, rate warning, or repeated errors.
- No direct endpoint replay, session-secret persistence, cookie/storage inspection, or
  stand-alone browser automation.

## Attacked design

Feasibility, risk, simplicity, and catalog-completeness reviews agreed that the existing
harvest scripts cannot be reused because they create a new browser context and/or touch
the app corpus. The only blocking condition for a complete-catalog claim is a demonstrated,
deterministic normal-UI partition for a 250-row response. Until that is proven, collection
may safely retain non-capped leaves but must report capped work as incomplete.

## Phases

1. Build and prove the isolated schema.
2. Validate one capped parent and its UI-supported, exhaustive subdivision.
3. Seed vendor-by-tire-class shards and collect sequentially with checkpoints.
4. Collect visible data sheets sequentially; validate the final ledger and report the
   dated snapshot metrics.

## Rollback

Stop the browser collection, leave the local database and ledger intact for resume, and
make no changes to the application corpus. The generated database is ignored by Git.
