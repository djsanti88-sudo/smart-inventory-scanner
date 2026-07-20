# Scanbin Master Plan — Sell-Ready Product (FINAL — v3 + final-gate edits)

> **Status:** APPROVED by owner 2026-07-19 — execution started with Phase 1. Passed all 3 critique loops (5 critics: engineering, product/GTM, red-team feasibility, simplicity+ambition, final-gate coherence); final gate verdict: APPROVE — all 12 owner requirements covered, no contradictions, every phase planner-ready. Owner decision: the P3 tire wedge (DOT date-code) keep/cut call is DEFERRED to Phase 3 plan-writing.
> **For agentic workers:** This is the PHASE-LEVEL master plan (owner order: big phases, long tasks).
> Each phase gets its own detailed bite-sized implementation plan (superpowers:writing-plans) at phase start,
> executed via superpowers:subagent-driven-development, one phase at a time, owner reviews between phases.

**Goal:** Take the inventory scanner from a proven prototype to a sellable multi-account product — balanced books, real accounts, cross-device sessions, a boss-ready report that shows off the moat, universal import, honest decode trust, and a launch pack — critical path to the closing demo ~week 4; roughly 6-7 weeks to full completion.

**Architecture:** Local-first optimistic scanning (Zustand) synced idempotently to Firebase (Auth + Firestore, via the existing transactional `firebaseSyncTarget` + `_appliedKeys` dedup), a cost-ordered decode ladder (corpus -> retail -> free rungs -> paid rungs), and a two-database identity model: per-account truth vs. program-owned master (Turso/JSON corpus + Firestore `catalogEntries` append surface).

**Tech stack:** Next.js 16 / React 19 / TypeScript / Tailwind v4 / Zustand / Firebase (Auth, Firestore, emulator) / Vitest / Playwright / Turso (corpus) / exceljs (already installed).

## North-star invariants (owner law — every phase must preserve these)

1. **Every scan appears and counts.** Quantity is a fact; identity is a hypothesis. No gate ever suppresses a row or a count.
2. **The books balance.** For every product, replayed quantity === displayed quantity, and the set of scanEventIds per count is identical across replay. Always.
3. **Wrong identity is failure; unknown is acceptable.** Never guess. Conflicts and ambiguity go to review.
4. **Two databases.** Account truth belongs to the account. Master is program-owned: only the admin (owner) and the strong-confidence app-verified ladder rule may write it. User edits never pollute master.
5. **Cost-ordered ladder, first settled stops, honest reasons.** Never pay when a cheaper rung answered. Never hide why. (A hard-timeout ladder settles on best-so-far and records an `aborted` reason — that is a settle, not a bypass.)
6. **Tests never call live paid providers.** Mock-first; live proofs are explicit, budgeted, owner-gated.
7. **A scan never hangs the screen.** Hard decode ceiling; identity work stays off the count path (verified: `processScan` is synchronous today; decode is dispatched async).

## Cross-cutting rules (apply to every phase)

- **Phone-first proof:** every user-visible phase includes phone-viewport (390px) Playwright proofs. Camera-scan on a phone is a first-class supported path AND a headline selling point ("no scan gun to buy — point your phone").
- **Moat visibility:** the corpus/ladder advantage must be VISIBLE, not plumbing — the coverage line ("142 of 150 identified automatically") and the retail-catalog badge are product surface, not internals. (Built in P3/P5.)
- **Brand-neutral build:** all user-facing naming flows through one `PRODUCT_NAME` constant. The uncleared name (Scanbin) appears on NOTHING a prospect sees until legal clearance lands.
- **Visual-polish gate, once per surface:** boss-visible surfaces (session log, Boss Report, import preview) pass a first-impression/visual-polish agent review (desktop + phone) in the phase where they are BUILT; re-gated only if changed.
- **Build on what exists (verified in-repo):** auth primitives (`src/lib/auth.ts`: email/password, onAuthStateChanged, ensureUserProfile, createBusiness, memberships w/ roles owner|admin|counter|viewer), the transactional sync target (`firebaseSyncTarget.ts` `_appliedKeys` + read-add-write txn, already idempotent per event), the corpus golden gate (`src/eval/goldenBaseline.test.ts`, 84 codes), `catalogEntries` rules already denying client writes (passing test), exceljs. Phases extend these; parallel rebuilds are plan violations.
- **One phase at a time.** Detailed plan -> owner OK -> subagent-driven execution (Sonnet workers, Opus reviews) -> full gates -> owner review -> next phase. Every phase ends releasable (AUTH_MODE contract in P2 covers the nuanced case).
- **Spend policy:** automated tests $0/mocked; live proofs explicit + owner-gated (Paid API Cost Truth Rule). Firecrawl exempt from capping (owner decision — free credits).

## Verified defect register (all confirmed with file:line evidence 2026-07-19)

| # | Defect | Where | Phase |
|---|---|---|---|
| D1 | First unknown scan stored `quantityDelta: 0`, fake-`synced`, never enqueued to sync | scanStore.ts:1369, :2993 | P1 |
| D2 | `markWrong` deletes the count row — physical quantity vanishes | scanStore.ts:4562 | P1 |
| D3 | Provisional merge drops `scanEventIds`/idempotency keys (replay double-apply vector) | scanStore.ts:3894 | P1 |
| D7 | Ladder deadline gates rung starts only; an in-flight rung is never aborted (36-70s hangs = demo-killer) | ladder.ts:64 (verified: unbounded `await r.run()`) | **P1** |
| D4 | Client-supplied `confidenceThreshold` unclamped; `codeType` trusted from client | route.ts:206,245 | P2 |
| D5 | No cross-tier conflict detection in deterministic resolver | aliasMatcher.ts:146 | P5 (interface slots in P1/P2) |
| D6 | GPT self-report becomes permanent VERIFIED identity + alias with no app evidence | scanGates.ts:95, gptLadderRung.ts:126 | P5 |
| D8 | Plan D re-queries UPCitemdb uncounted (2x real trial-quota burn) | barcodeDbProvider.ts:22 | P5 |
| D9 | Reconcile header matching is a 4-name exact list; one miss rejects the whole file | shopwareCsvAdapter.ts:26 | P4 |
| D10 | Corpus drift floor stale (75,411 from the old 76,173 manifest; regenerate against the live corpus count); drift test not in CI | corpusDrift.test.ts:18 | P6 |
| D11 | Stale manifests + CLAUDE.md contradictory trust statements | meta.json, CLAUDE.md | P6 |

(Owner decisions: Firecrawl needs NO cap — credits free. `removeFromCount` stays — deliberate + reversible.)

## The sales spine (what "sellable" means, when)

- **Demo-that-closes = end of P3 (~week 4):** scan live on a phone or gun -> items count instantly -> "142 of 150 identified automatically" -> session log "Jul 19, 4:00 PM — 50 items" -> click -> full timeline -> **send the boss a link to the report** (and print it). Optional tire-wedge beat: "3 tires over 6 years old."
- **Second-meeting upsell = P4:** "drop in the spreadsheet your shop already keeps — it maps the columns itself and reconciles against the scans."
- **Charge strangers = after P6:** trust hardening, launch pack, beta evidence from at least one non-captive shop.

---

## Phase 1 — Bulletproof the Count Ledger (+ the never-hang guarantee)

**Why first:** Everything downstream stands on the books balancing. Today the first scan of every new unknown code is a ghost in the ledger (D1), corrections destroy quantity (D2), merges discard anti-double-count history (D3), and one slow rung can hang identity resolution 25s+ (D7). A paying shop cannot be given books that don't reconcile or a scanner that freezes mid-demo.

**Scope (one long task):**
- Every physical scan event is born with `quantityDelta: 1` and is **enqueued** (`SAVE_SCAN_EVENT`, `INCREMENT_COUNT`, `SAVE_PRODUCT` for a new provisional) through the existing sync queue. Kill the fake `synced` stamp; a row is `synced` only after a real sync ack. (The idempotency-key contract needs no rework — verified: `buildIdempotencyKey(businessId, ...)` already carries the businessId slot as segment 0 everywhere; P2 fills the slot, nothing re-keys.)
- `ensureProvisionalCount` reworked: the stored feed event and the counted delta are the same fact, not a patched copy. Same repair for `applyDecodeFallback` and the context-conflict branch (same code family).
- **Provisional products carry a `provenanceTier` field from birth** (defaulted) — the P2 tier interface becomes a fill-in, not a data migration.
- `markWrong` transfers the row's full quantity to an "Unidentified item" provisional row, repoints affected feed events, reopens review — total physical quantity is invariant across any identity correction. The transfer preserves example/test-barcode classification (never mints a counted provisional that re-trips the b4ff79a example-gate).
- **Hard decode budget (D7):** per-rung hard timeouts (AbortController threaded through providers — verified necessary: `runLadder` does an unbounded `await r.run()`); total ladder wall-clock ceiling enforced (target p95 < 10s, hard ceiling 15s); a timed-out rung records an `aborted` reason; ladder moves on or settles best-so-far.
- Merge logic unions `scanEventIds`, `aliasesSeen`, `appliedIdempotencyKeys` in the target-exists branch (orphan history survives merges; replays stay no-ops).
- **NET-NEW ledger invariant suite** (the phase's crown — this is new machinery driving `processScan`, NOT an extension of the corpus golden gate): for every scan path (known, unknown-first, unknown-repeat, misread, example, conflict, cap-blocked, offline, breaker-open, decode-in-flight, post-resolution, post-markWrong, post-merge): per productId, `sum(feed deltas) === finalCounts.quantity`; replay from the event ledger reproduces every count's quantity AND exact scanEventIds set; sync retry N times changes nothing.
- The existing corpus golden gate (`goldenBaseline.test.ts`, 84 codes) stays as-is; add misread/example/vendor/conflict code classes to its fixture set (identity-outcome assertions only — ledger assertions live in the new suite).

**Not in scope:** Firestore/cloud changes (queue shape only — P3 consumes it), UI redesign, auth.

**Acceptance criteria:**
1. Ledger invariant suite green on every path; replay: per-product quantity identical + scanEventIds sets identical.
2. `markWrong` on a counted product keeps total quantity constant (Playwright, desktop + phone); example-gate regression locked.
3. No scan path leaves an event unenqueued or falsely `synced` (assertions on pendingSyncQueue contents per path).
4. A provider that never resolves is aborted at its rung timeout (spy on AbortController.abort); total decode wall-clock <= 15s under fake timers.
5. Ledger suite + extended golden fixtures in CI, $0, < 90s; existing suites (2294+ unit, Playwright) stay green.

**Proof:** net-new Vitest ledger suite + Playwright ledger spec (both viewports) + CI + screenshots.
**Est:** 4-6 days (the ledger suite is net-new — budgeted as such). **Risk:** `processScan` hot path — mitigated by writing the invariant suite FIRST (TDD) and the existing "scan 10 = count 10" e2e locking visible behavior.

---

## Phase 2 — Accounts & the Two-Database Foundation (complete what exists)

**Why second:** Cross-device sessions (P3) and per-account truth need identity; auth properly closes the endpoint trust holes (D4). **Verified reality:** auth primitives exist (`src/lib/auth.ts` — email/password, profiles, businesses, memberships with roles); `catalogEntries` client-write denial already passes rules tests. This phase COMPLETES and hardens; it does not greenfield, and it keeps the existing role model (the persist access-level firewall depends on it).

**Scope (one long task):**
- **Finish auth surface:** Google sign-in + password reset (the genuinely missing pieces); session persistence; sign-out clears state; keep the 4-role model as-is (full role UX post-revenue).
- **Tenancy for real:** `businessId` derived from the authenticated membership at every entry point (store, sync queue, API routes, rules). P1's key contract makes this a slot fill-in, not a re-key.
- **localStorage tenancy (the landmine):** namespace the persist key by uid/business (`sis-scan-${uid}`); migrate the legacy `sis-scan-v1` blob into the signed-in owner's namespace exactly once, sequenced BEFORE any schema-version bump that could trip the version-migrate reset; clear on sign-out. Acceptance tested at the localStorage level, not just rules.
- **Two-database model (stores named precisely):**
  - *Tenant DB (Firestore, per account):* approved aliases, approved/edited/custom products, spec edits, sessions, scans, counts. An account's approval = deterministic truth for that account only.
  - *Master corpus (Turso/committed JSON — 78k tires + 4M retail):* read-only at runtime; admin-batch-written offline by the owner's pipelines. NOT duplicated into Firestore.
  - *Master append surface (`catalogEntries`, Firestore):* ladder-learned entries with provenance tiers (`corpus_verified`, `ladder_verified_strong`, `ai_suggested`). Client writes already rules-denied (extend the passing test, don't rebuild). Strong-confidence app-verified ladder results append here as master truth (server-side); everything else appends suggestion-tier. Tenant edits/approvals NEVER write any master store.
  - **Resolver tier interface defined here** (tenant truth + master truth presented to `resolveScanToProduct`, consuming P1's `provenanceTier` slot) — P5 builds conflict logic on this contract.
- **Server-side trust (D4):** `/api/ai-lookup` + reconcile routes require auth (in `live` mode); `codeType` recomputed server-side from the sanitized code; `confidenceThreshold` clamped to server policy; per-account daily quotas layered on the global cap (default chosen in phase design — e.g. mirror the global cap per account).
- **Destructive-action guard:** owner-confirm (existing role model + the shipped SessionLockControl PIN pattern) on markWrong-class, clear-cache, and count-removal actions — the cheap answer to "can my employee wreck my counts" before full RBAC UX.
- **Releasability contract:** coarse `AUTH_MODE = mock | live`; `mock` = current demo behavior (DEMO_BUSINESS_ID, e2e/QA-bot substrate untouched), `live` exercised in emulator + preview project. Demo mode is permanent (sales demos + tests never need real credentials).
- **Deferred out of this phase** (moved to P6 — do not build now): account-wide export archive, hard account deletion, plan/entitlements shape (Firestore is schemaless; adding `plan` when pricing is real costs nothing).

**Acceptance criteria:**
1. Two test accounts cannot see each other's data — proven at BOTH layers: Firestore rules (emulator) AND localStorage (sign out A, sign in B same browser -> B sees zero of A's rows).
2. Tenant approve/edit/custom-product actions: client writes to `catalogEntries` REJECTED (extended passing test); master corpus untouched by definition (read-only runtime path — asserted by absence of any write API).
3. Unauthenticated API calls rejected in `live` mode; client-sent `codeType`/`confidenceThreshold` demonstrably ignored (server recompute/clamp tests).
4. Owner's existing local data intact after adopt flow: per-product quantities identical before/after, proven with P1's replay tooling.
5. Google + email sign-in + reset proven in browser (Playwright, both viewports); sign-out clears local state.
6. Destructive actions gated behind owner confirm (Playwright).

**Proof:** emulator rules tests, localStorage isolation tests, route auth tests, Playwright auth flows, adopt-flow replay proof.
**Est:** 6-8 days (completion + tenancy plumbing through a 5,173-line store + migration; estimate raised per red-team). **Risk:** auth x persist entanglement — highest-variance item; AUTH_MODE=mock default keeps every existing test green while `live` matures in emulator.

---

> **P1 handoff note (final-review finding, 2026-07-19):** before ANY runtime feed replay/reconcile is wired (P3 sync work), bump the scanStore persist version with a `quantityDelta` normalization/backfill - legacy v7 localStorage carries provisional feed rows with a literal `quantityDelta: 0` (pre-D1), and `applyScanEventOnce`'s `?? 1` does not correct a non-nullish 0. Inert today (replay is test-only); a real landmine the moment P3 replays feeds against server truth.

## Phase 3 — Sessions, Cross-Device Sync, Locations & the Boss Report (the demo-that-closes)

**Why third:** This phase IS the demo: scan -> count live -> coverage line -> session log -> report link. Needs P1 (trustworthy deltas) and P2 (whose sessions).

**Scope (one long task):**
- **Automatic sessions:** any scan with no active session auto-opens one (timestamped); inactivity auto-close (default 30 min, configurable); manual start/name/finish/lock still works; auto-names like "Jul 19, 4:00 PM". Auto-open idempotent per (account, device, time-window); two devices may hold concurrent sessions by design; the log shows both.
- **Session history log:** list newest-first with date + **time**, item count, location(s), status. Click -> full scan-by-scan timeline (time, code, product, qty, status, location) via a new `getScanEventsBySession` query. Per-session export: scan-level CSV + count-level CSV.
- **Cross-device sync = harden the EXISTING target (red-team verified):** `firebaseSyncTarget.ts` already applies `INCREMENT_COUNT` via transactional read-add-write with `_appliedKeys` per-event dedup — correct under contention. Work here is coverage + wiring, not new mechanism: route sessions/scans/counts/review through it under the account; device B sees updates within an explicit staleness bound (N seconds or on-focus — fixed in phase design, then asserted). NEVER replace the transaction with a bare `increment()` sentinel (it would regress the scanEventIds union). Offline unchanged: local-first, pending queue, retry, no scan ever lost.
- **Locations:** free-text location input at the scan surface with per-account recents autocomplete; stamps every `ScanEvent.location` (defaults to session location until changed); feed column, timeline column, CSV column. Replaces the hardcoded 5-option dropdown.
- **The Boss Report (the artifact that closes):** one printable page (print CSS + `window.print()`): total items, counts by brand/category, **estimated inventory value** (optional per-product cost; value shown only where cost exists — never fabricates), top variances when an import exists, "counted by / when / where."
  - **The moat line, top of page:** "142 of 150 items identified automatically — no manual entry." (Same coverage stat on the scan screen.)
  - **Shareable link:** read-only tokenized report route (token scoped to one session, expiring, no tenant leak) — the boss opens it on his phone; the demo leaves the room.
  - Brand-neutral header; phone-readable; print-clean.
- **Tire wedge (owner-cuttable, 1-2d):** optional DOT date-code capture per scan (camera/manual) -> Boss Report flags "3 tires over 6 years old — $X at risk." Rides on report + location infra; nothing else depends on it.

**Acceptance criteria:**
1. Scan 50 items with no session started -> log shows "Jul 19, 4:00 PM — 50 items"; click shows all 50 rows with locations. (Playwright, both viewports.)
2. Device A and device B each scan the same product 10x concurrently -> count = 20; exactly one application per event id (two-context emulator test against the existing txn target).
3. Device B sees device A's session within the declared staleness bound (asserted).
4. Location typed once persists across scans, appears in feed/timeline/CSV; recents offered.
5. Boss Report renders complete on one printed page from a 400-item session; coverage line correct against resolver stats; value totals only over items with cost; shareable link opens read-only on a phone with no login and expires.
6. Camera-scan -> count -> session -> report proven on a phone viewport.
7. P1 ledger suite re-run unchanged inside a session wrapper (regression gate — no new invariant assertions authored here).
8. Session log + Boss Report pass the visual-polish gate (built here -> gated here).

**Proof:** Playwright flows (both viewports), two-context emulator sync test, rules tests, CSV fixtures, print + shared-link screenshots, polish-gate review.
**Est:** 6-8 days (5-7 + wedge if kept). **Risk:** concurrent-writer edge cases — bounded because the transactional target already exists; the two-device test is written first.

**MILESTONE: Demo-that-closes. Owner demos to the boss, takes a soft commit, sends the report link.**

---

## Phase 4 — Universal Import & Smart Reconcile (the second-meeting wow)

**Why fourth:** The upsell that lands after the demo: "drop in the spreadsheet your shop already keeps." Needs P2 (whose inventory); does not block the first demo.

**Scope (one long task, staged internally):**
- **Any-file ingestion:** `.csv`, `.tsv`, `.xlsx`, `.xls` via the ALREADY-INSTALLED exceljs; tolerant of BOM, delimiters, quoting, extra header rows, merged/blank leading rows.
- **Stage A — column intelligence (D9, solves the boss's failure):** expanded synonym library per field; fuzzy header normalization ("Part #", "PN", "Item No.", "Mfg Part Number"...); content-based inference when headers are useless; **column-mapping UI fallback** when confidence is low — shows the file's actual headers + sample rows, user assigns, mapping remembered per account + source signature. Errors always show what was seen. Ships with the EXISTING identity matcher (PN-first + brand/size corroboration + Jaccard) — this alone fixes D9 and powers the demo beat.
- **Stage B — typo-tolerant product matching (owner-ratified):** normalized edit distance + token similarity over the existing Jaccard; size-notation normalization — "pretty much the same thing = same product," with the hard guardrail: every fuzzy match below threshold T routes to review; ambiguity NEVER silent-merges (invariant #3). Tuned ONLY against the fixture battery. (Staged second so a tuning rabbit-hole can never delay Stage A's shippable value.)
- **Preview-before-apply:** staged preview — X matched exactly, Y fuzzy (reasons + confidence), Z unmatched -> review. Nothing writes until apply. **Happy path scripted as a demo beat:** "Matched 380 of 400 automatically" on one satisfying screen. Non-tire items resolving from the retail corpus surface the badge "identified from the 4M-product catalog" (moat visibility for non-tire prospects).
- **Test battery (owner order: works for everything, tested):** fixtures for Shop-Ware, generic Excel, reordered/renamed/extra/missing columns, typo'd brands/models, unit rows, thousands-of-rows scale; adversarial near-duplicate-brand fixtures assert 0 auto-applied merges below T with expected match/review/reject counts per fixture. **The boss's real export becomes a fixture the moment we get it — the demo IS the test.**
- Variance report consumes the improved matcher; feeds the Boss Report's variance section.

**Acceptance criteria:**
1. Every fixture format imports without code changes; the 4-name header list is gone; "PN / Make / Model / Tire Size / QOH" imports clean.
2. Per-fixture expected counts (auto/review/reject) asserted; 0 auto-applied merges below threshold on adversarial fixtures.
3. Column-mapping UI proven: nonsense-header file imports after manual mapping; mapping remembered on re-import.
4. 5,000-row file imports + previews < 10s locally.
5. Import -> preview -> apply -> variance -> Boss Report proven end-to-end (Playwright, both viewports); preview passes the polish gate.

**Proof:** fixture battery in CI, Playwright full-flow, polish-gate screenshots.
**Est:** 5-7 days. **Risk:** Stage-B fuzzy precision is open-ended — contained by staging (Stage A ships regardless), preview gate, review-first ambiguity, fixture-only tuning.

---

## Phase 5 — Decode Trust Round (honest identity at scale)

**Why fifth:** Identity honesty for the decode-anything story, on P2's tier interface. (D7 speed shipped in P1; the tire-corpus demo path never waited on this phase.)

**Scope (one long task):**
- **GPT demotion (D6, owner-ratified):** GPT self-report -> `suggested` (auto-applied to the counted row, still displayed). `verified` requires app-verified exact-code evidence or account approval. Account approval writes tenant truth; strong-confidence app-verified results append to `catalogEntries` as master truth (P2 rules). Badges distinguish "Verified (app-confirmed)" vs "Suggested (AI)". Go-UPC evidence relabeled honestly (API self-report, not `fetched_source`).
- **Cross-tier conflict detection (D5):** resolver collects ALL trusted matches (approved aliases + verified identifiers + tenant + master, via the P2 interface); distinct product identities anywhere -> conflict -> review. Tier priority applies only when all agree. Test matrix: alias-vs-barcode, UPC-vs-SKU, padded-GTIN, case variants, tenant-vs-master.
- **Plan D cleanup (D8):** free-rung UPCitemdb/retail results passed into Plan D (no re-query, no double quota burn); the valuable 2-DB agreement path preserved; comments rewritten to match reality.
- **Golden precision gates:** expanded fixture set + CI gates: 0 wrong auto-verified identities; suggested-precision floor; per-class outcome assertions.

**Acceptance criteria:**
1. No path mints a verified identity or permanent alias from unverified model claims (unit + gate tests across scanGates + gptLadderRung + pipeline).
2. A code that is an approved alias for A and a verified barcode for B resolves CONFLICT (cross-tier tests incl. tenant-vs-master).
3. UPCitemdb called at most once per request (spy tests).
4. Golden precision gates green; the 100/100 owner-loved corpus baseline preserved.
5. Review-volume guardrail: corpus/retail/verified-evidence paths auto-verify exactly as before — demotion affects ONLY model-self-report identities.

**Proof:** unit suites, golden gates in CI, Playwright badge/conflict flows.
**Est:** 3-5 days. **Risk:** review volume for correct GPT answers — mitigated by auto-applied suggested display + one-tap approve + criterion 5.

---

## Phase 6 — Sell-Ready Hardening & Launch Pack (charge strangers safely)

**Why last:** Everything customer-visible is now true; make it provable, presentable, portable, and safe for paying shops.

**Scope (one long task):**
- **Truth & docs:** regenerate corpus manifests (real counts); raise drift floor to current; committed-corpus drift check in CI (D10). One-page decode trust truth-table; CLAUDE.md contradictions removed; real README; architecture doc current (D11).
- **Data portability (deferred here from P2):** "Export my entire account" (all products/counts/sessions -> CSV/JSON archive) + hard account deletion (tenant docs purged — rules test; master stores untouched per invariant #4). Plan/entitlements shape added to account docs now that pricing is imminent.
- **Ops & safety:** durable rate limiting (Turso-backed, per-account); secrets audit; Firestore backup/PITR at go-live; error monitoring on API routes + breaker/cap alerts; release-hygiene green.
- **Product polish for sale:** first-run onboarding (empty states, "scan your first item"), copy pass, account settings surface.
- **Beta -> evidence program:** boss's shop onboarded on preview: full real inventory (real import, real week of scanning). Capture before/after ("400 tires in 22 min vs half a day"), a one-line quote, report screenshots — the landing page's only real proof. Lightweight privacy-safe activation/retention instrumentation (first-successful-scan, weekly return). **A second, non-captive beta shop before quoting strangers a price.**
- **Launch checklist:** production promote runbook (owner-gated), name clearance resolved BEFORE the name appears on any prospect-facing artifact, terms/privacy stubs, rollback path.

**Acceptance criteria:**
1. CI enforces: unit, Playwright (mock), ledger suite, golden gates, committed-corpus drift, lint, typecheck, build.
2. Manifest counts match reality; drift floor current.
3. A new engineer (or agent) answers "what auto-counts and why" from ONE document.
4. Account export produces a complete archive; deletion purges tenant docs with master stores untouched.
5. Beta shop #1 completed a real cycle; evidence captured; instrumentation shows repeat use; beta shop #2 identified.
6. Production promote only on explicit owner word (standing rule).

**Proof:** CI run, docs review, export/deletion tests, beta evidence pack, release-hygiene report.
**Est:** 5-7 days (absorbed P2's deferred portability work).

---

## Timeline (focused-work estimates)

| Phase | Est. | Cumulative | Milestone |
|---|---|---|---|
| P1 Ledger + never-hang | 4-6 d | week 1 | books balance, scans never hang |
| P2 Accounts/two-DB | 6-8 d | week 2-3 | real accounts, tenant isolation |
| P3 Sessions/sync/report | 6-8 d | week 3-4 | **DEMO-THAT-CLOSES** |
| P4 Universal import | 5-7 d | week 5 | second-meeting wow |
| P5 Decode trust | 3-5 d | week 6 | honest identity |
| P6 Launch pack | 5-7 d | week 6-7 | charge strangers |

**First-dollar path:** P3's milestone lets the owner demo + take a soft commit ~3 weeks before full completion. P4-P6 convert the commit into referenceable, chargeable evidence. (Simplicity review confirmed: deferring portability/plan-shape out of P2 and staging P4's fuzzy work keeps the critical path ~5.5 weeks without cutting any owner requirement.)

## Top 3 timeline risks (named, owned)

1. **P2 auth x persist/role entanglement** — highest variance; AUTH_MODE=mock default keeps all tests green while live mode matures in emulator; localStorage namespace migration sequenced before any version bump.
2. **P3 concurrent-writer edge cases** — bounded: the transactional `_appliedKeys` sync target already exists and is idempotent per event; work is coverage, not invention; two-device test written first.
3. **P4 Stage-B fuzzy precision** — open-ended tuning contained by staging (Stage A ships alone), preview gate, review-first ambiguity, fixture-only tuning, boss's real file as ground truth.
