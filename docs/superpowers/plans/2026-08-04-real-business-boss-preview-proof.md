# Boss Barcode Fast-Path and Real Preview Proof Plan

> **Execution:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Keep this plan small: reproduce, fix only the proven contracts, then certify.

**Goal:** Every unambiguous, approved Boss barcode or alias resolves immediately for the intended Preview shop without a user-visible Suggested/Needs Review state or a review left open. Conflicts remain blocked rather than guessed.

## Task 1 — Pin evidence and reproduce

- [ ] Get the exact 20 codes that failed for the owner and hash the selected Preview `businessId` from the actual signed-in session.
- [ ] Pin an already-approved offline Boss export and its hash. Do not read live Turso without separate approval.
- [ ] Define two outputs from that export:
  - **Resolvable manifest:** every approved, scannable identifier mapped unambiguously to one stable canonical product ID, including short/non-GTIN identifiers and approved part-number aliases.
  - **Conflict ledger:** blank, unsupported, or cross-product identifiers that must fail closed and are excluded from the zero-review claim until corrected.
- [ ] Decide the implementation baseline in an isolated worktree because the current tree is dirty. No deployment until the owner approves the baseline/branch.

Task 1 uses a deterministic source-derived shortest-20 sample and makes no owner-observed claim. The literal owner-observed 20 codes and selected business are mandatory Task 3 Preview inputs; if unavailable then, stop and report the missing evidence.

### Build the truthful exact manifest

**Primary files:**

- `scripts/build-tire-exact-index.mjs`
- Existing exact-index tests; any Node-only suite must be named `*.node-test.mjs`

- [ ] Add a RED test using at least one real failing short/non-GTIN identifier and one conflict.
- [ ] Extend the existing generator/harness; do not create a second fixture system.
- [ ] Produce counts and hashes for raw rows, normalized identifiers, canonical products, aliases, and conflicts.
- [ ] Require every alias for one product to share the same canonical product ID; never mint a product per spelling.
- [ ] Prove the current Preview behavior for the 20 codes through an authenticated, read-only `deterministicOnly` route probe before changing code. It must stop before catalog/Turso/provider fallback and make no owner-business writes.

## Task 2 — Make the exact hit the first, free path

**Expected files, only where RED proves needed:**

- `src/server/tire-knowledge/tireExactIndex.ts`
- `src/server/tire-knowledge/TireKnowledgeProvider.ts`
- `src/app/api/ai-lookup/route.ts`
- `src/stores/scanStore.ts`
- Their existing route/index/store tests

- [ ] Replace GTIN-only assumptions across index admission, lookup, canonical identity, client acceptance, and request eligibility so approved exact identifiers work end to end.
- [ ] For an authenticated member of an explicitly allowlisted business, attempt the server-only exact index before GTIN rejection, Turso, catalogs, or paid providers.
- [ ] Preserve immediate provisional counting and the existing review-backed decode flow. An exact hit must settle directly to `verified`, atomically close its provisional decoding review, and never expose a user-visible Suggested/Needs Review state. Change review-creation timing only if a focused RED test proves no smaller presentation/settlement fix can meet that contract.
- [ ] A miss or conflict keeps existing fail-closed behavior. It must never be auto-verified.
- [ ] Reuse the existing server-enforced `deterministicOnly` path. Tests must prove an exact hit returns before Turso/catalog/provider code and the response must include an exact-path marker plus corpus digest. Do not add a new customer runtime mode solely for certification.
- [ ] Preserve tenant isolation and corpus secrecy: same-token foreign-business and nonmember requests fail, hit/miss responses have equivalent access checks/rate limiting, and customer responses contain only the resolved product fields needed by the scanner.

**Local gates:** focused RED/GREEN tests, `npm run test:ledger`, `npm run test:corpus-drift`, `npm run test:golden`, `npm run test:firebase`, `npm run proof:local`, and `npm run build`.

## Task 3 — Prove it locally and on one fresh Preview

Parameterize the existing Boss Preview scanner helpers and add a separate normal-business Playwright project/config with its own authentication and setup/teardown. Do not rely on the `boss-preview-...-lane-XX` shortcut.

### Local proof

- [ ] Resolve every entry in the resolvable manifest directly against the built server index.
- [ ] Run the UI scanner proof for the 20 failures plus a small stratified boundary sample at a declared hardware-scanner arrival rate. Record two per-code clocks: input-to-immediate-count and input-to-verified-settlement, including time behind the four-slot queue.
- [ ] Pin scanner submission mode to `both` (restoring it afterward if changed). Assert input focus immediately before and after every 20-code smoke scan and periodically in the larger sample; fail on any session-control or confirmation dialog.
- [ ] Observe the confirmation panel, live feed, final-count table, navigation review count, and reload state. Require correct canonical identity, exact count parity, pending queue zero, and no user-visible Suggested, Needs Review, conflict, or vendor-label state for every UI-tested entry.

### Fresh Preview proof

- [ ] Stop for approval to install the missing Vercel CLI (`npm i -g vercel`) or use another owner-approved Vercel control path, update Preview-only authorization/certification variables, and deploy a clean isolated SHA.
- [ ] Use two normal businesses through the same explicit allowlist branch:
  - **Disposable normal business:** exhaustive authenticated `deterministicOnly` route certification, plus UI proof only for the 20 failures and a small stratified boundary sample, followed by safe whole-tenant cleanup. Use a confirmed non-platformOwner member identity and temporary membership/allowlist entry; record server evidence that the ordinary allowlisted-member branch was used, then remove both.
  - **Owner's actual business/account:** authenticated read-only probes for the exact 20 failures plus a bounded stratified sample. Record its role and authorization branch; do not full-scan thousands of codes into existing inventory.
- [ ] For the required 20-code real-shop UI proof, stop for explicit write approval and an exclusive owner-confirmed write freeze covering snapshot, scans, sync drain, restoration, and final fingerprint. Require pending queue zero and an isolated browser profile. First discover every path the scan flow can create or mutate, including sessions, events, counts, products/provisionals, reviews, descendants, and `_appliedKeys`; snapshot and fingerprint the complete Preview business tree and rehearse restoration in an isolated business.
- [ ] Create a uniquely named certification session with a zero-event baseline. Scan only those 20, reload, then assert exact event IDs, per-canonical count deltas, verified identities/statuses, focus recovery, and pending queue zero for that session. Restore modified and newly created paths and require whole-business before/after fingerprint equality.
- [ ] Immediately before restoration, prove every post-snapshot mutation belongs to the certification run. Abort restoration if any unrelated write appeared; never erase concurrent legitimate work.
- [ ] Require the deployed exact-path marker/corpus digest for every exhaustive route result, a Preview environment attestation that disabled credentials cannot be used during the run, and server tests with Turso/catalog/provider spies proving zero calls. Browser interception alone is not sufficient.
- [ ] At the declared scan rate, target warm input-to-verified P95 under 500 ms and require each exact scan to settle within 2 seconds; report immediate-count latency, cold start, and queue delay separately.
- [ ] Record badge history so a fast transient Suggested/Needs Review state is still a failure.

### Acceptance receipt

The self-hashed receipt must bind:

- deployment ID, Preview URL, clean commit SHA, and prior rollback deployment;
- manifest/export hashes and resolvable/conflict totals;
- hashed actual-business ID and disposable-business ID;
- hashed/redacted forms of the 20 observed failures, sample/exhaustive totals, identities, counts, badge histories, and latency distribution; raw Boss codes and detailed failures remain platformOwner-local only;
- exact-path markers, corpus digest, Preview environment attestation, and the zero-call server test results;
- authorization negatives, reload proof, cleanup/restore fingerprints, and final zero-residue result.

## Done means

- Every entry in the **resolvable manifest** passes the local exhaustive proof and disposable normal-business Preview proof.
- With separate real-shop write approval, the owner's exact 20 failures pass through the actual authenticated UI scan path without Suggested/Needs Review, then the whole-business fingerprint is restored exactly. A read-only route probe alone proves authorization/resolution, not UI badge behavior, and cannot satisfy this final criterion.
- Conflicts remain visibly excluded and fail closed; the receipt cannot call them successes.
- No special certification-ID regex, paid provider, catalog fallback, or Turso round trip contributed to a passing result.
- Preview cleanup/restore and receipt verification pass. Production remains untouched.

## Rollback

Restore the prior Preview deployment and prior Preview environment values. Delete only the disposable test business. For any separately approved real-shop smoke, restore the pre-run document snapshots and require exact fingerprint equality before declaring cleanup complete.
