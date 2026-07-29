<!-- subject=stock case=hprocess-01 round=0 elapsed=275s rc=0 -->
**Process flaws in the work‑round summary**

| # | Flaw | Short explanation |
|---|------|--------------------|
|1| **No full test suite run**|Only ran tests for `decodeCacheStore.ts`; a change to cache logic can affect other modules, so running the entire suite is required.|
|2| **Manual API‑key usage in warm script**|The script was executed with real `GO_UPC_API_KEY`/`OPENAI_API_KEY`. This risks hitting rate limits or altering external state; tests should use mocks or separate credentials.|
|3| **No automated verification that the warm script actually populates the cache**|Running it once and “confirming” success is anecdotal; a unit/integration test should assert that after the script runs, the expected keys exist in `decodeCacheStore`.|
|4| **Leaving raw API‑response console logs in production code**|`cache-warm.mjs` prints full responses. This can leak sensitive data and clutter CI output; debug logs should be removed or guarded by a flag.|
|5| **No documentation of the TTL change**|The 30‑day default is not recorded anywhere (README, changelog, or inline comments), so future maintainers may miss it.|
|6| **Key‑normalization consistency not verified**|Unifying `normalizeCacheKey()` across two files risks breaking existing cache hits; tests should confirm that old keys still resolve correctly after the change.|
|7| **No rollback/monitoring plan for longer TTL**|A 30‑day TTL may increase memory usage or keep stale data; there’s no plan to monitor cache size or revert if problems appear.|
|8| **Environment variable usage not verified in production**|The summary states `DECODE_CACHE_TTL_MS` was bumped, but it isn’t shown that the code actually reads this var at runtime (e.g., via a mock test).|
|9| **No performance/memory impact assessment**|Longer TTL can enlarge the cache; no benchmark or memory‑usage test is provided.|
|10| **Test coverage gaps**|Only boundary cases (30 days, 29 days, cold key) are tested; missing tests for >31 days, concurrency, error handling, and eviction logic.|
|11| **No mention of code review**|Good practice requires a peer review for such a change; the summary omits any review step.|
|12| **Script not integrated into CI/package.json**|`scripts/cache-warm.mjs` is added but not referenced in `package.json` scripts or CI config, so it may never run automatically.|
|13| **Potential missing deployment config update**|If the TTL default changed, the production environment must be updated; this isn’t confirmed.|
|14| **Warm script error handling not tested**|The script has no tests for API failures (network errors, 5xx responses) or retry logic.|
|15| **Console logs may expose sensitive data**|Printing raw API bodies can leak private information; debug output should be removed before merge.|
|16| **Assumption of isolation ignores cross‑module effects**|Claiming the change is isolated overlooks modules that also use `decodeCacheStore`; full suite run would catch regressions.|
|17| **No code coverage metrics reported**|The summary does not state what percentage of branches/tests are covered after the change.|
|18| **Missing usage documentation for new script**|There’s no README or docs on how to invoke `cache-warm.mjs`, limiting maintainability.|
|19| **Potential breakage of modules expecting 7‑day TTL**|Other code may rely on a 7‑day expiry; the change isn’t validated against those expectations.|
|20| **CI secret handling unclear**|The script uses two API keys, but it’s not shown how these are supplied in CI or whether secrets are masked.|

These flaws collectively mean that while the work appears competent, the engineering practice around testing, documentation, security, and deployment integration is incomplete.
