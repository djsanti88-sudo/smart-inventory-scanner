# PerformanceBot smoke

| metric | value | budget | result |
|--------|------:|------:|--------|
| scan page load (ms) | 209 | 8000 | PASS |
| scan -> feed row (ms) | 63 | 3000 | PASS |
| localStorage size (bytes) | 12273 | 2000000 | PASS |

> Note: today the local store includes the alias/catalog DB (a correctness + security concern flagged by
> SecurityLeakBot). As the catalog grows, localStorage size will grow with it - another reason the deferred
> server-side customer resolution matters. Screenshots: e2e/proof/agent-bots/performance/
