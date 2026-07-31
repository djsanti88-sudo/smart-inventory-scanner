# Universal Hybrid Reconcile Identity Engine - Design

- Date: 2026-07-31
- Status: Proposed for owner review
- Starting category: Tires
- Expansion target: Category-aware matching for general inventory
- Cost boundary: Local/offline by default. No paid or live provider calls in preview or apply.

## Purpose

Businesses will upload inventory exports from systems such as Shop-Ware, Shopify, Tekmetric, distributor portals, and spreadsheets. These exports may describe the same product with different columns, incomplete fields, vendor-specific SKUs, part-number aliases, abbreviations, punctuation, reordered descriptions, or no barcode.

Scanbin must reconcile those records without silently losing rows or turning a plausible guess into a verified identity. The system should maximize safe automatic matching while preserving uncertain rows for review.

"Almost perfect" means:

1. Every input row is accounted for exactly once.
2. No uncertain identity is automatically marked verified.
3. No physical quantity is lost or duplicated.
4. Every decision is explainable and replayable.
5. Confirmed business mappings improve later imports without poisoning other tenants or the shared catalog.
6. Promotion requires zero false automatic matches on locked real-export tests, not merely zero observed failures in synthetic examples.

The product will not claim that every row can be automatically matched. Safe abstention is a correct result when evidence is incomplete or contradictory.

## Evidence from the initial spike

Three independent local-only 100-query benchmarks used the 78,437-row tire corpus:

| Approach | Correct automatic | Correct review | Safe abstain | Wrong suggestion | Verified-safe automatic |
|---|---:|---:|---:|---:|---:|
| Deterministic | 80 | 0 | 20 | 0 | Optimistic synthetic result |
| Semantic text | 0 | 50 | 20 | 30 | 0 |
| Hybrid | 40 | 12 | 48 | 0 | 40 |

The deterministic result was intentionally eligible and corpus-derived. It demonstrates an upper bound for controlled rules, not real-export recall. Semantic similarity is useful for review ranking but unsafe for verification. The hybrid result is the selected architecture because it recovered strong identities while producing no false automatic decisions in the spike.

## Scope

### In scope

- Universal CSV, TSV, and XLSX ingestion using the existing reader and column intelligence.
- Explicit preview and mapping correction before matching or application.
- Typed product identifiers instead of mixing barcodes, part numbers, and vendor codes.
- A versioned pure identity-decision engine.
- Tire-specific normalization and hard constraints first.
- A minimal generic category plugin for exact identifiers and review-only text candidates.
- Business-, vendor-, and source-scoped identity-link memory.
- Explainable automatic, review, and abstain decisions.
- Durable import runs and per-row idempotent operations.
- Reconciliation report and correction workflow.
- A repeatable local benchmark and threshold-calibration loop.

### Out of scope for the first implementation

- Production deployment or production database changes.
- Direct write-back to Shopify, Tekmetric, Shop-Ware, or another source system.
- Paid AI or live provider enrichment.
- Automatically promoting business mappings into the shared master catalog.
- Claiming general-category accuracy before category-specific fixtures and constraints exist.
- Legacy binary XLS support unless a safe parser is deliberately added and proven.

## Architecture

Create a pure identity subsystem under `src/services/identity/`. UI, persistence, catalog mutation, and count mutation remain outside the decision engine.

### Core contracts

```ts
type IdentifierType =
  | "gtin"
  | "upc"
  | "ean"
  | "barcode"
  | "manufacturer_part_number"
  | "vendor_sku"
  | "oem_number"
  | "internal_code"
  | "shelf_code"
  | "source_alias";

type EvidenceAuthority =
  | "approved_tenant_link"
  | "human_verified_master"
  | "verified_exact_code_corpus"
  | "vendor_import"
  | "unverified_master"
  | "provider_suggestion";

interface ScopedIdentifier {
  type: IdentifierType;
  raw: string;
  normalized: string;
  namespace?: string;
  source: string;
  evidenceAuthority: EvidenceAuthority;
  evidenceId: string;
  evidenceVersion: string;
}

interface IdentityInput {
  businessId: string;
  sourceSystem: string;
  sourceSignature: string;
  vendorId: string;
  sourceFileFingerprint: string;
  sourceFileOrdinal: number;
  sheetName: string;
  sourceRowNumber: number;
  categoryHint?: string;
  identifiers: ScopedIdentifier[];
  brand?: string;
  title?: string;
  description?: string;
  attributes: Record<string, string>;
  quantity: number;
  unitOfMeasure?: string;
  rawRecordFingerprint: string;
}

interface IdentityCandidate {
  productId: string;
  category: string;
  businessScope: "tenant" | "master";
  verificationTier: "approved" | "human_verified" | "exact_code_verified" | "suggested";
  automaticEligible: boolean;
  evidenceId: string;
  evidenceVersion: string;
  exactCodeEvidence: boolean;
  identifiers: ScopedIdentifier[];
  brand?: string;
  title?: string;
  attributes: Record<string, string>;
  catalogVersion: string;
  catalogSnapshotHash: string;
}

type ConstraintResult =
  | { outcome: "pass"; corroborated: string[]; missing: string[] }
  | { outcome: "reject"; contradictions: string[]; missing: string[] };

interface SemanticFeatures {
  score: number;
  orderedFeatureScores: Array<{ feature: string; score: number }>;
}

interface IdentityCandidateSource {
  readonlyOnly: true;
  lookupBatch(inputs: IdentityInput[]): Promise<{
    catalogVersion: string;
    catalogSnapshotHash: string;
    candidatesByRecord: Map<string, IdentityCandidate[]>;
  }>;
}

type IdentityDecisionKind = "automatic" | "review" | "abstain" | "non_product" | "invalid";

interface IdentityDecision {
  kind: IdentityDecisionKind;
  targetProductId?: string;
  candidates: Array<{
    productId: string;
    rank: number;
    score?: number;
    evidence: string[];
    missingFields: string[];
    contradictions: string[];
  }>;
  selectedCandidateId?: string;
  decisionBasis: Array<{ rule: string; evidenceId: string; evidenceVersion: string }>;
  normalizedKeys: Array<{ type: IdentifierType; namespace?: string; value: string }>;
  constraintOutcomes: Array<{ candidateId: string; result: ConstraintResult }>;
  candidateSnapshotHash: string;
  engineVersion: string;
  pluginVersion: string;
  sourceRecordFingerprint: string;
  decisionFingerprint: string;
}
```

This five-kind union is the single decision/serialization/accounting contract. `invalid` is a terminal, visible, non-countable row whose shape, quantity, unit, identifier, or required scope failed validation; `non_product` is a terminal, visible, non-countable valid row deterministically identified by an explicit source-adapter record type or an exact allowlisted normalized category (`labor`, `service`, `fee`, `subtotal`, or `header`). Free text, semantic similarity, missing identity, or a model guess can never classify `non_product`; those rows abstain or are invalid.

Identifiers are typed and namespaced. A vendor SKU must not be queried as a global manufacturer part number. Raw values and provenance are retained; normalization never destroys the original evidence.

Evidence authority is derived server-side from allowlisted repositories. Imported text cannot declare itself approved, verified, or authoritative. UPC/EAN normalization must validate GTIN checksums and package-level meaning; non-GTIN codes retain leading zeros and remain in their declared namespace.

### Category plugin contract

Each category plugin provides:

```ts
interface IdentityCategoryPlugin {
  category: string;
  version: string;
  normalize(input: IdentityInput): IdentityInput;
  deterministicKeys(input: IdentityInput): string[];
  hardConstraints(input: IdentityInput, candidate: IdentityCandidate): ConstraintResult;
  semanticFeatures(input: IdentityInput, candidate: IdentityCandidate): SemanticFeatures;
}
```

The tire plugin reuses the proven `tireSizeToken`, brand-family rules, `nameTokens`, Jaccard comparison, and `plusGenerationDiff`. It treats size and model generation as identity-defining constraints. Future plugins define their own variant boundaries:

- Auto parts: OEM number, fitment, position, engine, and model year.
- Electronics: model, generation, capacity, and region.
- Apparel: style, size, and color.
- Packaged goods: package count, weight, flavor, and formulation.

The generic plugin supports exact GTIN and explicitly scoped identifiers. Text similarity remains review-only until a category plugin defines safe variant constraints.

Candidate retrieval is a server-only, read-only dependency. It returns all hits for every key, never `LIMIT 1`, and includes the catalog/link snapshot version used for the decision. Preview tests must fail if candidate retrieval initializes write-capable storage. Candidate ordering is deterministic: hard-constraint outcome, automatic eligibility, evidence authority, structured score, semantic score, then stable product ID. An exact tie cannot be automatic.

## Decision pipeline

The engine processes each row in this order:

1. Validate row shape, quantity, unit, and typed identifiers.
2. Load only tenant-authorized approved business/vendor identity links through the read-only candidate source.
3. Generate all candidates from approved links and exact identifier indexes.
4. Generate controlled deterministic candidates from known source-specific transformations.
5. Apply category hard constraints to every candidate.
6. Remove candidates with contradictions before scoring.
7. Rank surviving candidates using structured and local semantic features.
8. Return automatic, review, or abstain with complete evidence.

Semantic similarity never upgrades a decision to automatic. It only orders review candidates that have survived hard constraints.

### Automatic decisions

Automatic requires one unambiguous candidate backed by immutable evidence:

- Exact valid barcode/GTIN tied to one compatible, `automaticEligible` product backed by approved tenant evidence, human-verified master evidence, or verified exact-code corpus evidence.
- Exact canonical manufacturer part number with required category corroboration.
- Previously human-approved business/vendor/source identity link.
- A controlled, persisted vendor-affix rule with exact category constraints and a unique candidate.

Automatic decisions must record the evidence type, evidence version, catalog version, engine/plugin versions, source fingerprint, and reason.

Package, unit, category, and other authoritative variant contradictions can block even an exact GTIN. A suggested, AI-derived, provider-derived, pending-master, or unverified corpus candidate is never automatic merely because its displayed code matches.

### Review decisions

Review includes:

- Part-number affix/core candidates without an approved source rule.
- Adjacent character transposition such as `XN` versus `NX`.
- Fuzzy or abbreviated product descriptions.
- Several candidates that satisfy non-conflicting attributes.
- Master-catalog or retail matches without exact verified-code evidence.
- A candidate that requires creation of a new tenant product.

Review presents ordered candidates and the positive, missing, and conflicting evidence. Confirmation creates a business-scoped identity link; it does not automatically alter the shared master catalog.

### Abstain decisions

Abstain when there is no viable candidate, insufficient evidence, malformed identity, unsupported unit, or any unresolved contradiction. The row and quantity remain visible and auditable.

Missing fields are neutral. Missing data is neither evidence for a match nor a contradiction.

## Hard contradiction rules

Hard contradictions override exact-looking part numbers and all semantic scores:

- A barcode or approved identifier resolves to an incompatible product.
- The same key produces multiple viable products.
- Verified brand conflict outside an explicit reviewed brand-family rule.
- Distinct nonblank authoritative part numbers with incompatible provenance.
- Tire size disagreement.
- Tire generation difference such as `R8` versus `R8+`.
- Package size, unit, volume, count, or variant disagreement for categories where those fields define the sellable item.
- Category/prefix firewall conflict.
- A tenant's approved identity conflicts with the proposed master candidate.

Controlled prefix/suffix removal may generate a candidate. Generic numeric-core stripping and character correction may not automatically verify it.

## Business-scoped learning

Column-mapping memory and product-identity memory remain separate.

Add an `IdentityLink` model:

```ts
interface IdentityLink {
  businessId: string;
  sourceSystem: string;
  vendorId: string;
  sourceSignature: string;
  identifierType: IdentifierType;
  namespace: string;
  rawValue: string;
  normalizedValue: string;
  targetProductId: string;
  status: "proposed" | "approved" | "rejected" | "revoked";
  evidence: string[];
  createdBy: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  version: number;
}
```

The atomic unique key is `(businessId, sourceSystem, vendorId, sourceSignature, identifierType, namespace, normalizedValue)`. Two approved target products for the same key are forbidden transactionally. Rejected and revoked records remain in audit history but never participate in lookup.

Resolution uses the exact source signature first, followed only by an explicitly approved vendor-wide rule. Missing vendor or source scope routes to review; it never broadens the lookup. Only an approved link participates in automatic resolution. Proposed links are review candidates. Links never cross tenants.

A separate versioned `IdentityTransformation` model records source scope, rule kind, examples, approval state, approver, collision tests, version, and revocation. A learned transformation may generate review candidates. It becomes automatic-eligible only after a server-authorized promotion record independently passes the locked real-export and collision gates.

Shared-catalog promotion is a later, separately authorized workflow requiring independent evidence and audit history.

## Preview and correction workflow

Reconcile and Universal Import use one preview path:

1. Read and sanitize the complete file.
2. Surface every non-empty workbook sheet and require the user to choose or combine sheets. Each selected sheet keeps its own mapping, sheet name, source row number, and file ordinal.
3. Infer column mappings.
4. Show headers, representative rows, confidence, skipped sheets, validation errors, and units.
5. Require explicit confirmation for medium/low-confidence mappings.
6. Convert mapped rows into typed `IdentityInput` records.
7. Run the identity engine without writes or provider calls.
8. Show automatic, review, abstain, non-product, and invalid buckets.
9. Allow explicit candidate selection, rejection, or new-product creation.
10. Generate an immutable preview fingerprint before apply.

Preview must not initialize storage that writes, create products or aliases, alter reviews/counts, call decode, or access paid/live providers.

Preview returns `signedPayloads: string[]`, not one unbounded token. Each token signs canonical UTF-8 JSON of at most 512 KiB and carries `manifestVersion`, `chunkIndex`, `chunkCount`, deterministic `sanitizedContentRootHash`, actor/business/source/vendor scope, selected mappings, engine/plugin/catalog/link versions, original file hashes as provenance, issued/expiry metadata, and a contiguous subset of canonical sanitized mapped inputs plus their ordered decisions and fingerprints. Compute `sanitizedContentRootHash` once from the canonical ordered content-identity projection of the chunks: sanitized mapped inputs, ordered mappings/scope, decisions/fingerprints, and stable engine/plugin/catalog/link versions; explicitly omit original file hashes, `sanitizedContentRootHash`, signatures, and issued/expiry metadata. Then insert the root and provenance/time fields and sign each full chunk, so each signature cryptographically binds provenance without making it part of content identity. Apply verifies signatures and the complete chunk set, recomputes the same content-identity projection/root, reconstructs canonical sanitized material, and recomputes import/row/decision/preview fingerprints without reupload. Missing, duplicated, reordered, mixed-root, oversized, expired, or content-changed chunks fail closed.

Fingerprints use canonical JSON with sorted object keys, UTF-8 encoding, and SHA-256 under a versioned `identity-import-v1` domain separator. `sourceFileFingerprint` hashes original bytes at preview and is separately embedded and cryptographically bound by each chunk signature; apply neither recomputes it nor includes it in `sanitizedContentRootHash` or import identity. `importId` hashes recomputable `sanitizedContentRootHash`, business/source/vendor scope, ordered selected-sheet names and mappings, and importer version. `rowId` hashes import ID, file ordinal, sheet name, source row number, and canonical sanitized normalized row data; source position disambiguates duplicates. `decisionFingerprint` hashes engine/plugin/catalog/link versions, candidate snapshot, evidence, constraints, and ordered decision output.

## Durable apply and counting integrity

Introduce tenant-scoped durable records:

- `ImportRun`: source fingerprint, mapping, business, engine/plugin/catalog versions, preview fingerprint, actor, and lifecycle.
- `ImportOperation`: unique `(businessId, importId, rowId)`, chosen action, target, evidence snapshot, idempotency key, state, lease, and result.
- `IdentityReview`: candidate decision and explicit human resolution independent of scan-only reviews.

`importId` is derived from verified `sanitizedContentRootHash`, ordered mappings, business/source/vendor scope, and importer version—not original bytes or preview time metadata. Apply recomputes the content-identity projection/root and import/row IDs from verified canonical sanitized chunk content, rejects content/mapping/scope changes, and treats signed original-file hashes only as non-recomputed provenance. Apply accepts only complete `signedPayloads`, explicit corrections, and selected mode; no preview record or source-byte reupload is required.

Before mutation, apply must:

1. Reauthenticate the tenant and actor.
2. Recompute or revalidate the decision against current catalog/link versions.
3. Reject stale previews, changed mappings, changed source files, tenant mismatches, and newly introduced conflicts.
4. Record or recover the idempotent per-row operation.
5. Apply the operation once.
6. Return prior results on safe retry.

Operation state is `pending | applied | failed_retryable | failed_terminal`. Apply atomically creates or claims the unique operation with a bounded lease. Only the lease owner may perform mutation. The backend ledger mutation uses the operation's stable idempotency key. If a crash occurs after ledger mutation but before operation completion, recovery queries the ledger idempotency record and finalizes the existing result instead of applying again. Concurrent tabs either receive the completed result or a deterministic in-progress response. Approval/revocation racing with apply invalidates the preview and requires a new decision.

Expected-inventory reconciliation and physical-count import are different operations. Reconcile uploads never mutate counts; they only create an expected-inventory session and variance report. A separately selected physical-count/baseline import may change counts. It records one replayable aggregate quantity event per source row with event ID derived from `importId + rowId`, immutable source quantity, session binding, and correction history. It does not manufacture `N` scan events for quantity `N`. Actual scanner events remain one event per physical scan.

Identity resolution can attach or repoint identity, but cannot create or delete physical quantity. Live totals and replay totals must remain equal after apply, retry, review, correction, rejection, and mark-wrong flows. Invalid and non-product rows remain visible terminal records with preserved source quantity; they are non-countable until an explicit audited correction creates a new operation.

Creating a new tenant product is a separate visible action. An exact-looking import must not silently create a product and mark it verified.

## Tenant, security, and cost boundaries

- Match private products and links only inside the active `businessId`.
- Never expose another tenant's alias, candidate, evidence, or inventory.
- Preview and default apply use local corpus and authorized tenant data only.
- The decode pipeline and `/api/ai-lookup` remain unreachable from preview, apply, retry, and review reopening.
- Optional enrichment is a separate owner-authorized workflow with provider caps and explicit cost reporting.
- Imported text is untrusted data. Apply the existing control-character removal, length cap, and formula-injection protections.
- Decision/audit output must not expose secrets, provider keys, or private cross-tenant evidence.
- Server-enforced roles: business managers/owners may apply runs and approve/revoke tenant identity links; clerks may upload and preview but cannot approve links, create products, or apply count-changing imports; platform-owner catalog promotion remains a separate role and workflow.

Local/demo durability is server-owned behind an injected atomic storage port. The concrete local/mock adapter is file-backed under an explicitly resolved repository-local `.tmp/identity-import/<test-or-run-id>/` directory, uses atomic temp-file replacement plus a process mutex for unique claims/applied keys, and is tested across adapter reconstruction/crash recovery. It must refuse paths outside that `.tmp/identity-import` root. Browser IndexedDB may cache signed preview chunks only and never implements uniqueness, claims, links, runs, or ledger durability. Production implementation later requires explicit Firestore collection paths, indexes, and rules for `businesses/{businessId}/identityLinks`, `importRuns`, `importOperations`, and `identityReviews`; no production backend/rule/database change is authorized by this design.

## Evaluation and continuous improvement loop

### Ground truth

Build an immutable, manually double-adjudicated manifest from consented real exports. Retain only fields required for identity testing; omit prices and unnecessary customer data. Every positive case maps to one exact corpus/product UID. Disagreements and unverifiable records become unknown/negative cases, never positive labels.

Split by identity family before corruption so variants cannot leak between sets. Group by canonical UID, barcode, normalized part-number/core, and brand/model family. Use seeded 60/20/20 train/dev/test splits, stratified by brand family, size, tire class, match basis, and positive/negative status.

Also group rows sharing business, source system, source signature, vendor, and transformation-rule family. Approved-link behavior is measured in two explicit modes: cold-link tests contain no learned link; warm-link tests contain only links created before the test time cutoff. Corpus and evidence use an as-of timestamp. A held-out label created from the same export cannot also enter the corpus or alias memory used to resolve that case. Human-independent labels and corpus-derived labels are reported separately.

- Train: error analysis and rule proposals.
- Dev: threshold and rule selection.
- Test: locked and run once for each candidate release.
- Temporal tests: two separately frozen chronological waves created after the original split. Neither wave is used for rule or threshold selection. Both must pass before first promotion. After promotion, both become immutable regressions and two new future waves are reserved for the next promotion.

Synthetic corruptions are generated only after splitting. They measure sensitivity and safety but never provide promotion evidence by themselves.

### Required suites

- Real Shop-Ware, Shopify, Tekmetric, and generic spreadsheet rows when consented fixtures are available.
- Case, spacing, punctuation, hyphen, and known vendor-affix variants.
- Missing barcode, MPN, brand, description, or optional specifications.
- Brand abbreviation and limited typo cases.
- Model token reordering and abbreviation.
- Exact size notation variations.
- Same part number across different brands.
- Same brand/model with different size, load, speed, generation, package, or variant.
- Barcode/part-number disagreement.
- Duplicate and ambiguous identifiers.
- Non-product and non-category rows.
- Unsupported units, malformed rows, multi-sheet files, duplicate rows, and retries.
- Cross-tenant aliases and products.

### Metrics

Report counts and rates by suite, decision basis, source, brand family, and category:

- False automatic match rate = wrong automatic decisions / all automatic decisions.
- Correct automatic coverage = correct automatic decisions / all truth-positive matchable rows.
- False abstention rate = abstained truth-positive matchable rows / all truth-positive matchable rows.
- Review recall@k = non-automatic truth-positive rows whose true product appears in deterministic top-k / all non-automatic truth-positive rows. A review with no true candidate is a miss.
- Review precision@k is reported row-wise as correct top-k review rows / all review rows with at least one candidate, and candidate-level precision is reported separately.
- Abstention = abstain decisions / all rows.
- Row accounting: input equals automatic + review + abstain + non-product + invalid, with every case ID exactly once.
- Quantity accounting before and after preview, apply, retry, correction, and replay, preserving terminal bucket and audit lineage for invalid/non-product rows.
- Latency p50, p95, p99, maximum, cold/warm state, and 5,000-row wall time.
- Bootstrap 95% confidence intervals over identity groups.

### Promotion gates

A candidate engine version may replace the baseline only when:

1. It has zero false automatic matches on the locked real-export test, every adversarial safety category, and all prior regressions.
2. At least 300 distinct held-out identity groups that the engine actually decides automatically have zero errors. Use the one-sided exact binomial upper bound `1 - 0.05^(1/n)`; at 300 zero-error groups it is approximately 0.994%. Bootstrap intervals do not replace this zero-event gate.
3. Automatic coverage and review recall@3 do not materially regress from baseline: no more than one percentage point overall or two points in any category unless a documented safety abstention requires it.
4. Row and quantity accounting are exactly 100%.
5. No size, generation, package, identifier-collision, or tenant-isolation negative is automatically matched.
6. Local p95 row latency is within 10% of baseline, the 5,000-row warm batch completes within 10 seconds, decision p95 after batched retrieval is at most 2 ms, and no browser main-thread task exceeds 100 ms under the frozen benchmark protocol.
7. All matcher, ledger, Firebase, import, reconcile, and frozen regression tests pass.
8. Two consecutive independent temporal real-export tests satisfy all gates.

Each promoted automatic decision basis needs real-export evidence, not synthetic-only evidence. Each critical safety stratum must contain at least 30 distinct held-out groups with zero automatic errors: identifier collision, same part number/different brand, tire size/load/speed difference, generation difference, barcode-versus-part-number contradiction, package/variant contradiction, and tenant/source isolation. If 30 real cases do not exist, that basis remains review-only for the affected stratum.

Initial tire targets are at least 70% correct automatic coverage and at least 95% review recall@3 on truth-positive matchable real-export rows, while all safety gates remain green. These targets may be revised only before the first locked test is observed. A system that abstains on every row cannot qualify.

Latency is measured on a frozen 5,000-row manifest and corpus snapshot, on the same recorded machine, Node runtime, concurrency, and warm/cold procedure for baseline and candidate. Report parsing, candidate retrieval, decision, serialization, and UI rendering separately. The initial local budget is no more than 10 seconds warm wall time for 5,000 rows, decision p95 no more than 2 ms after batched candidate retrieval, and no browser main-thread task longer than 100 ms. Changing the budget requires a new pre-test spec revision, not a post-result exception.

### Iteration loop

1. Freeze baseline engine, corpus hash, fixtures, split seeds, and reports.
2. Classify train/dev errors by cause.
3. Propose one narrowly justified rule, candidate source, constraint, or ranking change.
4. Add a focused regression case before the change.
5. Implement the smallest change.
6. Run focused tests and the complete local benchmark.
7. Calibrate thresholds on dev only.
8. Run the locked test once and append an immutable comparison report.
9. Promote only if every gate passes; otherwise retain the baseline.

Do not tune against failed locked-test examples. Add them to a future regression generation and repeat with new train/dev evidence. Every report includes exact baseline deltas by decision basis and safety stratum. All prior locked and temporal cases remain immutable regressions. A prior correct automatic decision may be deliberately demoted only by a documented safety change; it may never be silently misidentified.

Stop increasing automatic coverage when a change causes any false automatic match, violates latency/accounting gates, or produces less than a one-percentage-point real-export dev coverage gain for two consecutive iterations while every safety gate remains green. Any false automatic result resets that counter and retains the baseline.

## Phased delivery

### Phase 1: Pure engine and frozen benchmark

- Add core decision types and category plugin interface.
- Build the tire plugin with parity tests against current safe behavior.
- Add the generic exact-identifier plugin.
- Add the immutable local benchmark runner and report format.
- Check in versioned benchmark manifests, seeds, corruption definitions, corpus hash, evaluator version, and immutable baseline report. The external scratch spike is research evidence only and is not a promotion baseline.
- No persistence or UI mutation.

### Phase 2: Unified preview

- Add a versioned preview service/endpoint with batched candidate access.
- Project identity decisions into the existing import preview UI.
- Add mapping correction, multi-sheet warnings, complete error messages, and candidate explanations.
- Keep existing apply behind a local feature flag until the new apply path is proven.
- Use `NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1=1` only in local/mock mode to expose the new preview/apply path alongside legacy Universal Import/Reconcile. Keep legacy callers intact while the flag is off. Remove the legacy path only after matcher, ledger, import, security, frozen benchmark, and conditional Firebase gates pass and a separate owner-approved cutoff change is reviewed.

### Phase 3: Durable idempotent apply

- Add `ImportRun` and `ImportOperation` repositories and rules.
- Add revalidation and stable per-row idempotency.
- Apply exact approved decisions through narrow catalog/ledger ports.
- Prove duplicate clicks, reloads, offline retries, and overlapping batches cannot double-count.

### Phase 4: Identity review and scoped learning

- Add review actions for candidate confirmation, rejection, new-product creation, and revocation.
- Persist proposed/approved business identity links with provenance.
- Keep master-catalog promotion separate and owner-gated.

### Phase 5: Category expansion

- Add one category plugin at a time.
- Require real fixtures, variant constraints, adversarial negatives, and locked promotion evidence for each category.
- Never reuse tire-specific similarity as universal proof.

## Existing seams to reuse

- File and column contracts: `src/services/importSchema.ts`.
- File mapping and preview: `src/services/universalImportPreview.ts` and `src/components/UniversalImportPanel.tsx`.
- Current reconcile UI/report: `src/components/ReconcilePanel.tsx` and `src/services/reconcile/reconcileReport.ts`.
- Current injected matcher boundary: `src/services/reconcile/identityMatcher.ts`.
- Tire identity primitives: `src/services/catalog/identityMerge.ts` and brand-family helpers.
- Approved tenant aliases: `src/services/aliasMatcher.ts`.
- Column mapping memory: `src/server/importMappingMemory.ts`; do not overload it with product aliases.
- Ledger and replay: `src/services/inventory.ts` and `src/services/inventory.replay.ts`.
- Backend idempotency precedent: `src/services/db/firebase/firebaseSyncTarget.ts`.

The current `applyUniversalImport` client/store path is not the final apply architecture because it lacks a durable file/run identity and per-row operation ledger. The current reconcile route is not a universal candidate provider because it is tire-first and can initialize write-capable storage. Both remain compatibility seams during phased replacement.

## Acceptance criteria

The first tire release is ready for broader local demonstration only when:

- A user can upload a real-format fixture, inspect and correct mapping, and see every source row.
- Automatic matches meet the locked promotion gates.
- Review rows show ranked candidates and clear evidence.
- Contradictions and incomplete records safely abstain.
- Confirmation improves later imports for the same business/source.
- No mapping or identity crosses tenants.
- Preview performs zero writes and zero paid/live calls.
- Apply is idempotent across duplicate click, refresh, crash, offline retry, and concurrent tab scenarios.
- Counts and replay remain identical after every workflow.
- A 5,000-row local fixture completes inside the agreed latency budget without freezing the page.
- Existing safety, ledger, Firebase, corpus, import, and reconcile gates remain green.
- Cold-cache, error, and retry tests install fail-closed spies for persistence initialization, `fetch`, `/api/ai-lookup`, the decode pipeline, paid clients, and provider clients; any unexpected call fails the preview/default-apply test.
- Poisoning and stale-state tests cover forged provenance, pending/AI/unverified master candidates, revoked links, deleted/changed targets, source/vendor mismatch, crash recovery, and concurrent approve/revoke versus apply.

## Open evidence needed

- Consented real exports from Shop-Ware, Shopify, Tekmetric, and other target systems.
- Double-adjudicated identity labels for at least 300 independent automatic-match candidates, plus ambiguous and negative cases.
- Category-specific variant rules beyond tires.
- Recorded baseline hardware/runtime results for the frozen 5,000-row benchmark.

These are evidence dependencies, not permission to use production data or live services automatically.
