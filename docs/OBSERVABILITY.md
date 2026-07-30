# Observability

Scanbin uses zero-cost structured server logs. It does not send production data to a third-party
telemetry vendor and this document does not add paging.

`logServerEvent` writes one JSON line with the fixed fields `src`, `route`, `event`, and `ts` plus
the optional `reasonCode`, `businessId`, `status`, and a 200-character maximum `detail`. Request
bodies, scan codes, customer identities, prices, tokens, and exception stacks must never be logged.

The public `/api/telemetry` endpoint only accepts `breaker_open` and `client_error`. It forces its
own route, derives status and reason code server-side, discards client business IDs, limits UTF-8
request bodies, and rate-limits callers. Client reporting is best effort: a telemetry failure never
throws or retries itself.

## Owner log watch

In Vercel Logs, search for `src:scanbin` and filter the event field for:

`event:(breaker_open OR client_error OR spend_write_diverged OR charge_pair_incomplete)`

Investigate sustained `breaker_open` events, any `spend_write_diverged`, and any
`charge_pair_incomplete` immediately. These logs are queryable evidence, not a real paging system.
If paging is required, choose and budget an owner-approved alerting provider separately.
