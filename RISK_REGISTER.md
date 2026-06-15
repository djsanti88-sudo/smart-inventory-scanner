# Risk Register

Per `ENGINEERING_DOCTRINE.md`. Significant tasks log risks here: risk, severity, likelihood, mitigation, approval, status.

## A/B/C batch (2026-06-14)

| # | Risk | Severity | Likelihood | Mitigation | Approval | Status |
|---|------|----------|-----------|------------|----------|--------|
| 1 | Junk cleanup deletes real inventory data; `inventory` has no git safety net | High | Low | Full JSON backup auto-downloads BEFORE removal; persisted `lastCleanupBackup` + in-app Undo; only junk-named, unreferenced rows removed | Owner approved A/B/C plan | Mitigated |
| 2 | Removing a product/alias breaks the deterministic resolver | Med | Low | A product/alias is removed only when no surviving good count references it; snapshot enables exact restore | — | Mitigated |
| 3 | Bumping persist version to add a setting wipes learned data (migrate resets to seed) | High | — | Did NOT bump version; read `decodeBudgetMs` defensively (`?? 13000`) | — | Avoided |
| 4 | Client sets an abusive decode budget (e.g. 10 min) | Low | Low | Server-side clamp to [5000, 20000] in `decodeBudget.ts` | — | Mitigated |
| 5 | Firewall expansion over-blocks a real product name | Low | Low | Conservative phrase/word-boundary patterns; regression test asserts real names still pass | — | Mitigated |
| 6 | Undo overwrites scans made after a cleanup | Med | Low | Undo restores additively (merge by id), never a full-state overwrite | — | Mitigated |

No production systems, paid APIs, new dependencies, or external calls were involved. All proof was mocked/local (no live tokens).

## Shared catalog + recommendation-first cleanup (2026-06-14)

| # | Risk | Sev | Likelihood | Mitigation | Approval | Status |
|---|------|-----|-----------|------------|----------|--------|
| 1 | Private/shop/customer data leaks into the global catalog | High | Low | Type separation (CatalogEntry has no private fields); `sanitizeCatalogEntry` drops unknown fields + masks PII/cost; overrides/feedback are businessId-scoped; leak test | Owner rules #3/#4/#6 | Mitigated |
| 2 | AI overwrites a verified catalog entry | High | Low | `applyAiCandidate` never changes a verified entry's identity/status (observe-only); AI writes pending; dedicated test | Owner rules #1/#2 | Mitigated |
| 3 | Catalog-first wiring regresses scan/auto-decode | Med | Low | Pure `decideLookup` + tests; resolver untouched; catalog consulted only on needs_review; full regression suite green | — | Mitigated |
| 4 | Recommendation engine recommends removing a real product | High | Low | Seed/manual + still-counted products never offered; verified-status gate; weak/conflict default unchecked; backup + Undo + final owner click | Owner Q5/rules #7-9 | Mitigated |
| 5 | False-green tests (wrong working directory) | Med | Observed | Always `cd` into inventory before vitest/tsc/eslint; re-ran correctly and fixed the 3 hidden failures | — | Resolved |
| 6 | Stored URLs unsafe (javascript:/file:) | Low | Low | `safeHttpUrl` restricts catalog URLs to http(s) | — | Mitigated |
| 7 | localStorage growth (catalog/feedback) | Med | Low | Feedback ring-buffer (cap 500); catalog bounded by distinct barcodes; persist try/caught | — | Mitigated |

No cloud dependency added (owner rule #11). No live AI, no deploy, no persist-version bump.

## Confidence-based auto-verify (2026-06-14)

| # | Risk | Sev | Likelihood | Mitigation | Status |
|---|------|-----|-----------|------------|--------|
| 1 | Auto-saving a wrong product without approval | High | Low | Deterministic evidence score (not AI's word) + exact-barcode-evidence required + conflict/unsafe gates before threshold + tier caps + never overwrite verified | Mitigated |
| 2 | Added latency / slower scans | Med | Low | Zero new network calls - scoring is synchronous on the existing decode response; decode budget untouched; E2E asserts exactly one decode call + zero on 2nd scan | Mitigated |
| 3 | Over-sending good results to review | Med | Low | Fast path anchored on the existing accurate "verified + exact-evidence" signal; Tier 1/2 exact auto-verifies at 100/90+ | Mitigated |
| 4 | Lowering the threshold bypasses safety | High | Low | Safety/conflict/AI-only gates applied before the threshold; unit-proven at threshold 70 | Mitigated |
| 5 | Behavior change (suggested no longer auto-counts) surprises owner | Med | Confirmed | Approved by owner; 4 tests updated to the new policy; documented | Resolved |
| 6 | Junk/SEO/cart/login source treated as trustworthy | Med | Low | sourceTrust junk-page detection -> Tier 4 (cap 50, blocked); unit-tested | Mitigated |

No cloud dependency, no live AI in tests, no destructive migration, no persist-version bump.

## Hotfix: verified-decode fast path (2026-06-14)

| # | Risk | Sev | Likelihood | Mitigation | Status |
|---|------|-----|-----------|------------|--------|
| 1 | Verified decoded products show "Unknown"/uncounted (the reported regression) | High | Was occurring | Fast path auto-saves app-verified exact-evidence decodes regardless of tier/single-provider; regression test + live smoke confirm | Fixed |
| 2 | Fast path lets a wrong product through | Med | Low | Fast path runs AFTER all real blockers (conflict, no-name, junk source, vendor code, private data, no-exact-evidence); only app-INDEPENDENTLY-verified exact evidence qualifies | Mitigated |
| 3 | "Verified AI Decode + Unknown" misleading badge | Med | Was occurring | Feed decodeStatus rewritten to needs_review whenever a decode does not auto-save | Fixed |
| 4 | Speed regression | Med | Low | Scoring stays synchronous; no new network calls; live smoke ~8s (unchanged); 2nd scan zero AI (asserted) | Mitigated |

Live smoke: 2 calls (owner-authorized cap), keys configured, e2e=false. No live tokens in automated tests.

## Hotfix: decode diagnostics + open-web source discovery (2026-06-14)

| # | Risk | Sev | Likelihood | Mitigation | Status |
|---|------|-----|-----------|------------|--------|
| 1 | Real products (e.g. 810118139604) stuck in Needs Review because the open web is never searched | High | Was occurring | Stage-2 fallback reads AI-cited URLs then Firecrawl-discovered pages; mocked regression + E2E prove the Faire product now resolves | Fixed |
| 2 | Fast path slowed by the new fallback | High | Low | `shouldRunFallback` runs Stage 2 ONLY on a Stage-1 miss (no product, not timed-out, not conflict, not E2E); E2E asserts exactly ONE POST on a fast-path success | Mitigated |
| 3 | App says "not found" when a provider actually failed/timed-out/was rate-limited | High | Was occurring | Per-provider status captured (no more `.catch(()=>{})`); honest reason codes; `product_not_found_after_search` emitted only after a search was attempted; E2E asserts the rate-limit row never shows "not found" | Fixed |
| 4 | SSRF via arbitrary AI/Firecrawl URLs (internal/metadata/loopback) | High | Possible | Every arbitrary URL filtered through `isSafePublicUrl` before fetch; unit tests cover loopback/private/link-local/CGNAT/metadata/file/non-http(s); E2E-equivalent unit proves Firecrawl never scrapes an unsafe candidate | Mitigated |
| 5 | Firecrawl credits/cost burned (esp. in CI) | Med | Low | Gated by `FIRECRAWL_API_KEY` (absent -> graceful `search_provider_unavailable`); capped <=3 scrapes/failed barcode; ALWAYS mocked in automated tests | Mitigated |
| 6 | Secrets (Firecrawl key) leaked into logs/commits | High | Low | Key read server-side from env only, never logged, never in client; `.gitignore` excludes `.env.local`; `.env.example` lists the NAME only | Mitigated |
| 7 | A "Product Not Found" page that echoes the code is treated as a match | Med | Was possible | Reader rejects not-found pages that only echo the code; requires the exact code AND a usable identity; unit-tested | Fixed |

No cloud dependency in tests, no live AI/Firecrawl in tests, no destructive migration, no persist-version bump.
