import type {
  Alias,
  PendingSyncItem,
  Product,
  ScanEvent,
  UnknownCodeReview,
} from "@/types";
import type { ImportPreviewRow, UniversalImportApplySummary } from "@/import/importSchema";
import type { IncrementPayload } from "@/sync-database/mock/mockDb";
import { cleanScanCode } from "@/scanning/clean/scanCleaner";
import { normalizeCode } from "@/scanning/clean/codeNormalizer";
import { evaluateMismatch } from "@/products/match/productMismatchGuard";
import { detectCodeType, codeTypeToAliasType } from "@/products/match/codeTypeDetector";
import { canonicalGtin } from "@/products/barcodes/gtin";
import { resolveScanToProductTiered } from "@/products/match/aliasMatcher";
import { blobContainsCodeToken } from "@/products/match/productDedup";
import { incrementInventoryCount } from "@/inventory/ledger";
import { buildIdempotencyKey } from "@/inventory/idempotency";
import { cleanProductName } from "@/decoding/decode";
import { collectGroundedIdentifiers, discoverableIdentifiers } from "@/products/match/aliasDiscovery";
import { prefixFloorName } from "@/products/catalog/prefixFloor";
import { brandIsOnlyFloorGuess } from "@/products/catalog/prefixFloorEnrich";
import { isCatalogWritable } from "@/products/catalog/sanitizeCatalog";
import { findIdentityMerge } from "@/products/catalog/identityMerge";
import { enrichProductIdentity } from "@/products/catalog/enrichProductIdentity";
import { applyAiCandidate, upsertVerified } from "@/products/catalog/localCatalogProvider";
import { buildAliasesForCodes, buildOrphanTransferSyncOps, buildProductCodeAliases } from "@/stores/scan/aliasBuilders";
import { provisionalPlaceholderName } from "@/stores/scan/placeholders";
import { gateIdentityBarcodeFields, isWeakGuess } from "@/stores/scan/reviewHelpers";
import { makeQueueItem } from "@/stores/scan/queueItem";
import { buildDiscoveredIdentifiers } from "@/products/match/discoveredIdentifiers";
import { safeStructuredFieldsFor } from "@/products/polish/structuredFields";
import { getSession } from "@/authentication/auth";
import { transferOrphanCount } from "@/stores/scanStore";
import type { ScanState } from "@/stores/scanStore";

export function createReviewSlice(ctx: {
  set: (partial: Partial<ScanState> | ((s: ScanState) => Partial<ScanState>)) => void;
  get: () => ScanState;
  idFactory: () => string;
  now: () => string;
  emitAudit: (e: { entityType: string; entityId: string; action: string; metadata?: Record<string, unknown> }) => void;
  enqueueAndSync: (items: PendingSyncItem[]) => void;
  nextReviewDecisionAt: (review: UnknownCodeReview, proposedAt: string) => string;
  buildReviewDecisionWrite: (review: UnknownCodeReview, decisionAt: string) => { review: UnknownCodeReview; item: PendingSyncItem };
  persistReviewDecision: (reviewId: string, decisionAt?: string, allowOpen?: boolean) => void;
}): Pick<ScanState,
  "resolveUnknown" | "batchApprove" | "approveSuggestion" | "confirmRowIdentity" | "declineSuggestion" |
  "evaluateLinkMismatch" | "clearMismatchWarning" | "clearCategoryWarning" | "approveDiscoveredIdentifiers" |
  "clearAliasConflicts" | "unlinkAlias" | "moveAlias" | "removeFromCount" | "correctProduct" |
  "reopenNeedsReview" | "applyUniversalImport" | "markWrong"> {
  const { set, get, idFactory, now, emitAudit, enqueueAndSync, nextReviewDecisionAt, buildReviewDecisionWrite, persistReviewDecision } = ctx;

  return {
      resolveUnknown: (reviewId, action, payload) => {
        const state = get();
        const review = state.needsReviewQueue.find((r) => r.id === reviewId);
        // Idempotency / re-entry guard: only act on a review still AWAITING a decision - OPEN, or a
        // PENDING inline suggestion ("suggested", Task 9b owner-ratified 2026-07-14: the feed row's
        // inline approve routes through this exact core, so a parked suggestion must be resolvable
        // here). A double-click, or a race where a background decode resolves the same review while a
        // human approves it, must NOT re-run applyToCount -> a second count of the same physical item:
        // resolved/ignored stays a hard no-op. Matches the open-status guard already used by
        // liveDecode / backgroundVerifyDeep / cloudCatalogResolve / correctionRecheck.
        if (
          !review ||
          review.businessId !== state.businessId ||
          (review.status !== "open" && review.status !== "suggested")
        ) return;

        if (action === "ignore") {
          const decidedAt = nextReviewDecisionAt(review, now());
          const write = buildReviewDecisionWrite({
            ...review,
            status: "ignored",
            resolvedAt: decidedAt,
            resolvedBy: "human",
            resolutionAction: "ignore",
          }, decidedAt);
          set({
            needsReviewQueue: state.needsReviewQueue.map((r) =>
              r.id === reviewId ? write.review : r,
            ),
          });
          enqueueAndSync([write.item]);
          get().recordFeedback("product_rejected", { code: review.cleanCode });
          emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "alias_rejected", metadata: { code: review.cleanCode } });
          return;
        }

        // Determine target product (existing or newly created).
        let products = state.products;
        let productId = payload.productId ?? "";
        let createdProduct: Product | null = null; // persisted to Firestore (cloud backend) via SAVE_PRODUCT
        // Phase-2 POISON GUARD: set true in the mint branch below when create_new is ACCEPTING the
        // review's evidence-less AI suggestion (the 078742051451 -> "Velvet Torch dress" class). A weak
        // guess is minted UNVERIFIED, its alias is left UNAPPROVED, no verified catalog entry is written,
        // and it is NOT counted - so a future scan never resolves deterministically to a wrong product.
        let weakGuessProduct = false;
        // PHASE 2: set true when this resolution is CONFIRMING an existing PROVISIONAL count (the reused
        // product was provisional). The provisional was already counted, so the approval must NOT re-count
        // (no double-count) - it only upgrades the product to verified + adds the approved alias.
        let approvingProvisional = false;

        // TASK 3 (scan N = count N): ensureProvisionalCount mints a provisional placeholder product for every
        // unresolved scan and counts it synchronously. When the human/decode later resolves that code to a
        // DIFFERENT product (or a genuine conflict), the placeholder must be merged/removed so a unique code
        // never leaves a duplicate product row. `provOrphanId` is that placeholder for THIS review's code;
        // `removeOrphanId` / `orphanTransferTargetId` drive the merge at commit time.
        const countedIdsForOrphan = new Set(state.finalCounts.map((c) => c.productId));
        // STABLE-ID FIX (kills the prefix-floor placeholder-name collision, task-STABLEID): try the review's
        // OWN stable `provisionalProductId` FIRST - captured at review-creation/mint time (see the doc
        // comment on the field in types.ts) and reload-resilient because it is a local product id, never a
        // barcode/gtin (safe to persist to a customer's disk; survives the customer persist split). This is
        // bulletproof against name collisions: a prefix-floor placeholder name is BRAND-ONLY
        // ("<Brand> / product unconfirmed", not code-specific), so two different unresolved codes sharing a
        // GS1-prefix brand mint the IDENTICAL name - the old name-based fallback below could then attribute
        // one code's count to the OTHER code's review. A plain id has no such collision.
        const stableOrphanId =
          review.provisionalProductId &&
          state.products.find(
            (p) => p.id === review.provisionalProductId && countedIdsForOrphan.has(p.id) && p.status !== "archived",
          )?.id;
        const provOrphanId =
          stableOrphanId ??
          state.products.find(
            (p) =>
              p.provisional === true &&
              countedIdsForOrphan.has(p.id) &&
              p.status !== "archived" &&
              [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku]
                .map((c) => (c ?? "").trim())
                .includes(review.cleanCode),
          )?.id ??
          // BACKWARD-COMPAT NAME FALLBACK: only reached when the review has no usable `provisionalProductId`
          // (a review persisted/created before this field existed) AND the strict identifier match above
          // found nothing. A customer's localStorage persist strips a product's `provisional` flag AND its
          // identifier fields (primaryBarcode/gtin/upc/ean/primarySku - CUSTOMER_SAFE_PRODUCT_FIELDS never
          // persists them; see scanPersist.ts / sensitiveFields.ts), so for an OLD review minted before the
          // stable id existed, this reconstructed-name match is the only way left to re-identify the scan's
          // own placeholder after a reload. Known limitation (accepted, low-likelihood, non-blocking per
          // task-FINALREVIEW-report.md): a prefix-floor name is brand-only, so this fallback can still
          // collide for two OLD reviews sharing a prefix-floor brand - closed for every review going forward
          // by the stable id above.
          state.products.find(
            (p) =>
              countedIdsForOrphan.has(p.id) &&
              p.status !== "archived" &&
              p.name === provisionalPlaceholderName(review.cleanCode),
          )?.id ??
          null;
        let removeOrphanId: string | null = null;
        let orphanTransferTargetId: string | null = null;

        if (action === "create_new") {
          const np = payload.newProduct ?? {};
          // A person confirmed this identity (typed it or tapped Approve on it): the weak-guess poison
          // guard, which exists to stop an evidence-less AI suggestion becoming verified by itself, does
          // not apply. "tenant_approval" differs from "human" ONLY in what is written platform/device-wide.
          const humanConfirmed = payload.origin === "human" || payload.origin === "tenant_approval";

          // DEDUP GUARD (data correctness): every auto-add path (AI auto-add, catalog auto-count) funnels
          // through create_new, so without this one barcode could spawn dozens of identical product rows
          // (the 235x "Manstel rivet kit" bug). Before minting a product, look for an existing one this
          // identity already belongs to, using the SAME deterministic matcher the resolver uses (approved
          // alias OR verified product identifier) so dedup never drifts from resolve.
          const identityCodes = [...new Set(
            [review.cleanCode, np.primaryBarcode, np.gtin, np.upc, np.ean, np.primarySku]
              .map((c) => (c ?? "").trim())
              .filter(Boolean),
          )];
          // P5/D5: use the cross-tier-conflict-aware resolver here too so a code that conflicts across
          // tiers (e.g. an approved alias for one product vs. a verified identifier for another) is
          // never silently dedup-merged into a single product row. Master slot stays empty on purpose
          // (GC2/AC6): this dedup guard is a sync helper inside resolveUnknown, not the async
          // cloudCatalogResolve enrichment path where Phase 5b (Task 4, ~scanStore.ts:2460) wires the
          // real tenant-vs-master conflict feed via services/catalog/masterCandidates.ts.
          const matchedIds = new Set<string>();
          for (const codeStr of identityCodes) {
            const res = resolveScanToProductTiered(
              cleanScanCode(codeStr),
              { products: state.products, aliases: state.aliases, masterCandidates: [] },
              state.businessId,
            );
            if (res.matchType === "conflict") (res.conflictProductIds ?? []).forEach((id) => matchedIds.add(id));
            else if (res.productId) matchedIds.add(res.productId);
          }

          // ORPHANED-COUNT DEDUP: also reuse a product that is STILL COUNTED (has a surviving finalCounts
          // row) whose own identifier fields exactly match the scanned code - even if it is no longer
          // verified or approved-aliased. A persist/session reset can drop a counted product's approved
          // alias AND its `verified` flag (the customer-safe persist strips both) while its count survives,
          // which makes resolveScanToProduct miss it and used to mint a duplicate. This is a DETERMINISTIC
          // exact identifier match (never fuzzy name), and it is scoped to products that are ACTIVELY
          // COUNTED, so a markWrong'd product (whose count was removed) is never silently reused.
          //
          // B2 FIX (owner-reported, 268-row review, 2026-07-20): raw string equality here missed a
          // leading-zero GTIN variant of an already-counted identity (848983027580 vs 00848983027580),
          // minting a duplicate product row instead of aggregating the quantity onto the existing one.
          // Compare via the SAME canonical-GTIN key universal import already uses (aggKeyFor, below in
          // this file) - canonicalGtin strips leading zeros then re-pads to 14 digits for any
          // GTIN-shaped code; a non-GTIN-shaped code (e.g. a part number) falls through unchanged, so a
          // part number's leading zeros still carry meaning and are never canonicalized away.
          const canon = (c: string): string => canonicalGtin(c) ?? c;
          const identityCodesCanonical = identityCodes.map(canon);
          const countedProductIds = new Set(state.finalCounts.map((c) => c.productId));
          for (const p of state.products) {
            if (!countedProductIds.has(p.id) || p.status === "archived") continue;
            // The provisional placeholder for THIS code is the row being resolved, not a competing owner -
            // exclude it so it never causes a false "multiple products own this identity" conflict.
            if (p.id === provOrphanId) continue;
            const pCodes = [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].map((c) => (c ?? "").trim()).filter(Boolean);
            if (pCodes.some((c) => identityCodesCanonical.includes(canon(c)))) matchedIds.add(p.id);
            // BARCODE-IN-NAME DEDUP (P2): a legacy product can carry its barcode ONLY inside the name
            // (e.g. "UPC 029142712886 - Discoverer A/T3"), so the identifier-field check above misses it
            // and re-scanning that barcode mints a duplicate. Reuse it when the scanned code appears as an
            // EXACT whole token in its name (never fuzzy name matching). >1 match -> conflict block below.
            else if (blobContainsCodeToken(p.name, identityCodes)) matchedIds.add(p.id);
          }
          if (provOrphanId) matchedIds.delete(provOrphanId); // never let the placeholder count as an owner

          // Identity merge: when the deterministic dedup above finds no owner, still
          // check whether this decoded identity is the SAME countable product as one already in the shop, by
          // canonical GTIN (auto_link) or a fuzzy brand+name match (suggest_link). This links two DIFFERENT
          // scannable codes that resolve to the same product across encodings, so a second scan increments
          // the existing row instead of minting a duplicate. Only consider real (active, non-placeholder)
          // products; the scan's own provisional placeholder is excluded so it is never matched to itself.
          if (matchedIds.size === 0) {
            const mergeCandidates = state.products.filter(
              (p) => p.status !== "archived" && p.id !== provOrphanId && p.provisional !== true,
            );
            const merge = findIdentityMerge(mergeCandidates, {
              gtin: np.gtin ?? null,
              upc: np.upc ?? null,
              ean: np.ean ?? null,
              brand: np.brand ?? null,
              name: np.name ?? null,
              specsShort: np.specsShort ?? null,
              specsFull: np.specsFull ?? null,
            });
            if (merge.kind === "auto_link") {
              // Same product across encodings -> reuse its row (the size===1 path below adds the alias +
              // counts). Never a duplicate.
              matchedIds.add(merge.productId);
              emitAudit({ entityType: "Product", entityId: merge.productId, action: "identity_merge_auto_link", metadata: { code: review.cleanCode } });
            } else if (merge.kind === "suggest_link") {
              // Fuzzy match (brand+name, or a plus-generation / tire-size difference) -> NEVER auto-link.
              // Attach the candidate to the review as a one-tap "link to existing product?" suggestion and
              // keep it OPEN. The scan already counted provisionally (scan N = count N); this only refuses to
              // guess the merge. The review keeps its existing provisional placeholder + count untouched.
              set((st) => ({
                needsReviewQueue: st.needsReviewQueue.map((r) =>
                  r.id === reviewId
                    ? { ...r, suggestedLinkProductId: merge.productId, decodeStatus: "suggested" as const }
                    : r,
                ),
              }));
              emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "identity_merge_suggest_link", metadata: { code: review.cleanCode, productId: merge.productId } });
              return; // stop: do NOT mint a product; wait for the human to confirm the link
            }
          }

          if (matchedIds.size > 1) {
            // MORE THAN ONE existing product owns this identity -> never guess; keep it in Needs Review
            // (same rule as the resolver conflict guard). The human picks the right one via link_existing.
            //
            // OWNER RULE "scan N = count N" (a count already taken is NEVER silently lost): do NOT delete
            // this code's provisional placeholder or its finalCounts row here. The scan may already have
            // counted N times; dropping the placeholder would vanish all N with no transfer. Instead KEEP
            // the placeholder product row + its full retained quantity, keep the review OPEN, and only flip
            // the feed row's badge to "conflict" so the human sees action is needed. When the human resolves
            // (link_existing, or a create_new pick), resolveUnknown recomputes provOrphanId, finds this
            // surviving placeholder, and the orphan merge/transfer machinery below moves the FULL retained
            // quantity onto the chosen product (one product row, one count row, no double-count, no orphan).
            if (provOrphanId) {
              const oid = provOrphanId;
              set((st) => ({
                scanFeed: st.scanFeed.map((e) =>
                  e.matchedProductId === oid
                    ? { ...e, status: "conflict" as const, decodeStatus: "conflict" as ScanEvent["decodeStatus"] }
                    : e,
                ),
              }));
            }
            set({ lastAliasConflicts: [...matchedIds].map((existingProductId) => ({ reviewId, code: review.cleanCode, existingProductId })) });
            emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "alias_conflict_blocked", metadata: { code: review.cleanCode, reason: "dedup_multiple_match", productIds: [...matchedIds].join(",") } });
            return;
          }

          if (matchedIds.size === 1) {
            // EXACTLY ONE existing product owns this identity -> reuse it (count the existing row) and fall
            // through to the alias-add + applyToCount path. Do NOT create a duplicate.
            productId = [...matchedIds][0];
            // TASK 3: this code's provisional placeholder is being merged into a DIFFERENT existing product.
            // Move its count onto that product and remove the placeholder; do NOT re-count (approvingProvisional).
            if (provOrphanId && provOrphanId !== productId) {
              removeOrphanId = provOrphanId;
              orphanTransferTargetId = productId;
              approvingProvisional = true;
            }
            // PHASE 2: if the reused row is a PROVISIONAL count, this resolution CONFIRMS it -> upgrade it
            // in place to a verified, non-provisional product (the approved alias is added below, so future
            // scans resolve it as a normal Known) and do NOT re-count it (it was already counted).
            // POISON GUARD (dedup path): apply the same weak-guess check here. If the user is approving
            // the review's evidence-less AI suggestion, the provisional must NOT be upgraded to verified
            // (same rule as the create-new branch). Only a human typing their OWN product or a suggestion
            // with real evidence upgrades the provisional.
            if (products.find((p) => p.id === productId)?.provisional === true) {
              approvingProvisional = true;
              // When a person confirmed it, they are deliberately confirming the provisional - skip the guard.
              const isWeakGuessReuse = isWeakGuess(review, np) && !humanConfirmed;
              if (isWeakGuessReuse) {
                weakGuessProduct = true;
                // Leave the provisional as-is (not upgraded to verified).
              } else {
                // Upgrade the provisional to a verified product. When the human typed a DIFFERENT name
                // (not the AI suggestion), apply the human's product details to the upgraded row so the
                // product identity reflects what the human actually intended, not the AI's provisional guess.
                const normName = (s: string) => cleanProductName(s ?? "").trim().toLowerCase();
                products = products.map((p) => {
                  if (p.id !== productId) return p;
                  const updates: Partial<Product> = { verified: true, provisional: false, updatedAt: now(), updatedBy: "human" };
                  // FALKEN FIX (owner-reported live bug, 2026-07-20): a name-only decode payload (no
                  // separate brand/category/specsShort/specsFull fields) used to leave every structured
                  // column blank forever, even though the size/brand/model are cleanly parseable from
                  // the name itself (e.g. "Falken Azenis RT660 P 245 /40 R18 97W XL BSW"). Route every
                  // apply through the single shared enrichProductIdentity helper: the payload's own
                  // structured field always wins; a still-empty field falls back to a deterministic
                  // parse of the (cleaned) name - never a guess. `enriched.name` is the CLEANED name
                  // (tireListingNormalizer's cleanListingTitle) - use it wherever np.name would have
                  // been written raw before.
                  // CLASS FIX (2026-08-04, cocacola-bug-report.md): `p.brand` at this point may be
                  // NOTHING MORE than the statistical prefix-floor guess ensureProvisionalCount wrote
                  // synchronously before any decode ever ran (this is the second EXACT unguarded sibling
                  // of the 2026-07-21 "PREFIX-FLOOR BRAND LOCK FIX" - the dedup-reuse path). Compute it
                  // once and pass it through so enrichProductIdentity treats that guess as empty rather
                  // than a trustworthy prior brand.
                  const pBrandIsFloorGuess = brandIsOnlyFloorGuess(p.name, p.primaryBarcode || review.cleanCode);
                  const enriched = enrichProductIdentity({
                    payload: { name: np.name ?? p.name, brand: np.brand, category: np.category, specsShort: np.specsShort, specsFull: np.specsFull },
                    existing: { name: p.name, brand: p.brand, category: p.category, specsShort: p.specsShort, specsFull: p.specsFull },
                    existingBrandIsFloorGuess: pBrandIsFloorGuess,
                  });
                  // B1 FIX (owner-reported, 268-row review, 2026-07-20): this re-match/reuse path used to
                  // drop specsShort/specsFull/primarySku/category entirely - a decode payload's structured
                  // fields never landed on an existing (already-counted) provisional row, so Brand/Model/
                  // Category/Specs/Size stayed blank forever once a row was first counted, even when a
                  // LATER, richer decode re-matched the same physical item. Fill-if-empty ONLY: any field
                  // this row already carries a non-empty value for (human-entered or from an earlier
                  // decode) is never clobbered by a weaker/different later suggestion.
                  if (np.name && normName(np.name) !== normName(p.name)) {
                    updates.name = enriched.name;
                    if (np.brand !== undefined) updates.brand = np.brand;
                    if (np.category !== undefined) updates.category = np.category;
                  }
                  if (!p.category) updates.category = enriched.category;
                  if (!p.specsShort) updates.specsShort = enriched.specsShort;
                  if (!p.specsFull) updates.specsFull = enriched.specsFull;
                  if (!p.primarySku && np.primarySku) updates.primarySku = np.primarySku;
                  // CLASS FIX: a floor-guess-only brand must yield to enrichProductIdentity's resolution
                  // (payload brand, then a name-parsed brand) even though p.brand is technically
                  // non-empty - it was never a trustworthy prior identity in the first place.
                  if (!p.brand || pBrandIsFloorGuess) updates.brand = enriched.brand;
                  if (!p.structuredModel && enriched.structuredModel) updates.structuredModel = enriched.structuredModel;
                  // Task 4: (re)structure only when the name/brand actually changed above; the guard
                  // inside structuredFieldsFor never overwrites a row already stamped "human". Uses
                  // the safe wrapper: a structurer throw must never break this scan flow (Task 4 review fix).
                  Object.assign(updates, safeStructuredFieldsFor(updates.name ?? p.name, updates.brand ?? p.brand, p.structuredBy));
                  // safeStructuredFieldsFor may return its own structuredModel guess (name-only
                  // structurer); prefer OUR still-empty fill above when the structurer found nothing.
                  if (!updates.structuredModel && enriched.structuredModel && !p.structuredModel) {
                    updates.structuredModel = enriched.structuredModel;
                  }
                  return { ...p, ...updates };
                });
              }
            }
            emitAudit({ entityType: "Product", entityId: productId, action: "product_dedup_reused", metadata: { code: review.cleanCode, origin: payload.origin ?? "human" } });
          } else if (provOrphanId) {
            // TASK 3: no OTHER product owns this identity, but this code already has a provisional placeholder
            // (counted synchronously at scan time). Upgrade THAT row in place into the created product: reuse
            // its id + its existing count (never re-count), and run the full create machinery below (multi-code
            // aliases, product_created audit, catalog write) exactly like a fresh mint. The Phase-2 poison
            // guard still applies (an evidence-less AI suggestion stays unverified + provisional).
            productId = provOrphanId;
            approvingProvisional = true;
            weakGuessProduct = isWeakGuess(review, np) && !humanConfirmed;
            const orphan = products.find((p) => p.id === provOrphanId)!;
            // FALKEN FIX (owner-reported live bug, 2026-07-20): this upgrade path used to write
            // np.brand/np.category/np.specsShort/np.specsFull verbatim with no fallback, so a
            // name-only decode payload (all structured fields empty) left every structured column
            // permanently blank even though the size/brand/model are cleanly parseable from the
            // name. Route through the shared helper: payload field wins when present; a still-empty
            // field falls back to a deterministic parse of the (cleaned) name - never a guess.
            //
            // CLASS FIX (2026-08-04, cocacola-bug-report.md): `orphan.brand` at this point may be
            // NOTHING MORE than the statistical prefix-floor guess ensureProvisionalCount wrote
            // synchronously before any decode ever ran (this is the EXACT unguarded sibling of the
            // 2026-07-21 "PREFIX-FLOOR BRAND LOCK FIX" above - the fresh-single-scan path a brand-new
            // 049000-prefixed tire scan actually takes). existingBrandIsFloorGuess tells
            // enrichProductIdentity to treat that guess as empty rather than a trustworthy prior brand.
            const orphanEnriched = enrichProductIdentity({
              payload: { name: np.name, brand: np.brand, category: np.category, specsShort: np.specsShort, specsFull: np.specsFull },
              existing: { name: orphan.name, brand: orphan.brand, category: orphan.category, specsShort: orphan.specsShort, specsFull: orphan.specsFull },
              existingBrandIsFloorGuess: brandIsOnlyFloorGuess(orphan.name, review.cleanCode),
            });
            const upgraded: Product = {
              ...orphan,
              name: orphanEnriched.name || orphan.name,
              brand: orphanEnriched.brand,
              category: orphanEnriched.category,
              specsShort: orphanEnriched.specsShort,
              specsFull: orphanEnriched.specsFull,
              primarySku: np.primarySku ?? orphan.primarySku,
              primaryBarcode: orphan.primaryBarcode || review.cleanCode,
              ...(function () {
                const gated = gateIdentityBarcodeFields(np);
                return {
                  gtin: np.gtin !== undefined ? gated.gtin : orphan.gtin,
                  upc: np.upc !== undefined ? gated.upc : orphan.upc,
                  ean: np.ean !== undefined ? gated.ean : orphan.ean,
                };
              })(),
              vendorCodes: orphan.vendorCodes ?? [],
              aliases: [review.cleanCode],
              imageUrl: np.imageUrl ?? orphan.imageUrl,
              productUrl: np.productUrl ?? orphan.productUrl,
              location: np.location ?? orphan.location,
              source: np.source ?? orphan.source,
              confidence: 1,
              verified: !weakGuessProduct,
              provisional: weakGuessProduct ? true : false,
              updatedAt: now(),
              updatedBy: humanConfirmed ? "human" : orphan.updatedBy,
              // Task 4: structure the upgraded identity (deterministic only, never LLM on the hot
              // path). Guarded against clobbering a prior "human" stamp.
              ...safeStructuredFieldsFor(np.name ?? orphan.name, orphanEnriched.brand, orphan.structuredBy),
            };
            if (!upgraded.structuredModel && orphanEnriched.structuredModel) {
              upgraded.structuredModel = orphanEnriched.structuredModel;
            }
            products = products.map((p) => (p.id === provOrphanId ? upgraded : p));
            createdProduct = upgraded;
          } else {
            productId = `prod-${idFactory()}`;
            // POISON GUARD: is this create_new accepting the review's AI suggestion (the new product's
            // name equals the suggested name)? If so, and the suggestion has NO real evidence the app
            // could back - no brand, no gtin/upc/ean, no source URL - it must not become trusted identity.
            // A human typing their OWN product name (not the AI's guess) is unaffected.
            // Compare NORMALIZED names (cleanProductName + lowercase) so a case difference or an AI hedge
            // phrase (e.g. "(likely wholesale)") that cleanProductName strips cannot slip the guard.
            // NOTE: unlike the two provisional-reuse sites above, this fresh-mint site does NOT gate on
            // origin !== "human" (behavior preserved from before the extraction).
            weakGuessProduct = isWeakGuess(review, np);
            const mintedName = np.name ?? review.cleanCode;
            // FALKEN FIX (owner-reported live bug, 2026-07-20): a fresh mint used to take np.brand/
            // np.category/np.specsShort/np.specsFull verbatim (defaulting to "" when absent) with no
            // fallback to parse them from the name - exactly the shape of the owner's bug row (a
            // single fresh scan whose decode payload carried only a name, no separate structured
            // fields). Route through the shared helper so a still-empty field is deterministically
            // parsed from the (cleaned) name instead of staying blank forever.
            const mintEnriched = enrichProductIdentity({
              payload: { name: mintedName, brand: np.brand, category: np.category, specsShort: np.specsShort, specsFull: np.specsFull },
            });
            const mintedBrand = mintEnriched.brand;
            const newProduct: Product = {
              id: productId,
              businessId: state.businessId,
              name: mintedName,
              brand: mintedBrand,
              category: mintEnriched.category,
              specsShort: mintEnriched.specsShort,
              specsFull: mintEnriched.specsFull,
              primarySku: np.primarySku ?? "",
              // Identity = the scanned code, so the product's primaryBarcode and its first approved alias
              // agree (prevents the alias-miss -> identifier-conflict -> re-decode -> duplicate cascade).
              primaryBarcode: review.cleanCode,
              ...gateIdentityBarcodeFields(np),
              vendorCodes: [],
              aliases: [review.cleanCode],
              imageUrl: np.imageUrl ?? "",
              productUrl: np.productUrl ?? "",
              location: np.location ?? "",
              notes: "",
              status: "active",
              source: np.source ?? "human_review",
              confidence: 1,
              verified: !weakGuessProduct, // trusted ONLY if not accepting an evidence-less AI suggestion (Phase-2 poison guard)
              createdAt: now(),
              updatedAt: now(),
              createdBy: "human",
              updatedBy: "human",
              // Task 4: fresh mint - always deterministic-structure (no prior stamp to protect).
              ...safeStructuredFieldsFor(mintedName, mintedBrand),
            };
            if (!newProduct.structuredModel && mintEnriched.structuredModel) {
              newProduct.structuredModel = mintEnriched.structuredModel;
            }
            products = [...products, newProduct];
            createdProduct = newProduct;
          }
        }

        if (!productId) return;

        // Human-mistake guard: before linking a code to an EXISTING product, check it doesn't look like
        // a different product entirely (e.g. a Falken tire part number being linked to Camel cigarettes).
        // High-risk links are BLOCKED until the human explicitly overrides (confirmedMismatch: true).
        if (action === "link_existing") {
          const target = state.products.find((p) => p.id === productId);
          const hasSuggestion = !!(review.suggestedProductName || review.suggestedBrand || review.suggestedCategory);
          const verdict = evaluateMismatch({
            scannedCode: review.cleanCode,
            suggested: hasSuggestion
              ? { name: review.suggestedProductName, brand: review.suggestedBrand, category: review.suggestedCategory }
              : undefined,
            target: { name: target?.name, brand: target?.brand, category: target?.category },
          });
          if (verdict.risk === "high_risk" && !payload.confirmedMismatch) {
            set({ lastMismatchWarning: { reviewId, productId, verdict } });
            emitAudit({ entityType: "Alias", entityId: review.cleanCode, action: "alias_link_warning_shown", metadata: { code: review.cleanCode, productId, reason: verdict.reason, suggestedName: verdict.suggestedName ?? "", targetProductName: target?.name ?? "" } });
            return; // do NOT link until the owner explicitly confirms the override
          }
          if (verdict.risk === "high_risk" && payload.confirmedMismatch) {
            emitAudit({ entityType: "Alias", entityId: review.cleanCode, action: "alias_link_override", metadata: { code: review.cleanCode, productId, targetProductName: target?.name ?? "", suggestedName: verdict.suggestedName ?? "", suggestedDomain: verdict.suggestedDomain ?? "", reason: verdict.reason } });
          }
          // TASK 3: linking this code to an EXISTING product orphans its provisional placeholder. Merge it -
          // move its count onto the linked product and remove the placeholder (no duplicate row, no re-count).
          if (provOrphanId && provOrphanId !== productId) {
            removeOrphanId = provOrphanId;
            orphanTransferTargetId = productId;
            approvingProvisional = true;
          }
        }

        // Permanently learn the alias (deterministic from now on, even before sync completes).
        const aliasId = `alias-${idFactory()}`;
        const aliasKeyOp = buildIdempotencyKey(
          state.businessId,
          state.sessionId,
          aliasId,
          "RESOLVE_ALIAS",
        );
        const newAlias: Alias = {
          id: aliasId,
          businessId: state.businessId,
          productId,
          rawCodeExample: review.rawCode,
          cleanCode: review.cleanCode,
          // normalizedCandidates is stripped from a customer's persisted (rehydrated) review for privacy;
          // fall back to the cleanCode, which is what this alias is keyed on anyway.
          normalizedCode:
            review.normalizedCandidates?.[review.normalizedCandidates.length - 1] ?? review.cleanCode,
          aliasType: codeTypeToAliasType(detectCodeType(review.cleanCode)),
          source: "human_review",
          confidence: 1,
          approved: !weakGuessProduct, // NOT approved when minting from an evidence-less AI suggestion (Phase-2 poison guard)
          createdAt: now(),
          updatedAt: now(),
          createdBy: "human",
          lastSeenAt: now(),
          syncStatus: "pending",
          idempotencyKey: aliasKeyOp,
        };

        // Avoid duplicate aliases for the same clean code + product.
        const aliasExists = state.aliases.some(
          (a) => a.cleanCode === newAlias.cleanCode && a.productId === productId,
        );
        const aliases = aliasExists ? state.aliases : [...state.aliases, newAlias];

        const resolvedAt = nextReviewDecisionAt(review, now());
        const reviewWrite = buildReviewDecisionWrite({
          ...review,
          status: "resolved" as const,
          resolvedAt,
          resolvedBy: "human",
          resolutionAction: (action === "create_new" ? "create_new" : "link_existing") as
            | "create_new"
            | "link_existing",
        }, resolvedAt);
        const needsReviewQueue = state.needsReviewQueue.map((r) =>
          r.id === reviewId ? reviewWrite.review : r,
        );

        // UI-1 fix (2026-08-13; see docs/HISTORY.md): quantityAfterScan on
        // these rows is a snapshot of the PROVISIONAL PLACEHOLDER's own running count at scan time - only
        // still correct when this resolution reuses that same placeholder id (create_new / dedup-reuse of
        // the SAME product). When removeOrphanId is set, the placeholder is being MERGED into a DIFFERENT,
        // already-counted product (transferOrphanCount below adds the placeholder's quantity onto that
        // product's own pre-merge quantity) - carrying the stale snapshot forward unchanged would make the
        // feed display a number that no longer matches the finalCounts ledger. mergeBaselineQty is that
        // target product's own pre-merge quantity (session-scoped, mirroring transferOrphanCount's own
        // scoping); adding it to each row's already-recorded running value reproduces exactly what
        // finalCounts becomes after the merge, so the feed never shows a stale or wrong quantity.
        const mergeBaselineQty = removeOrphanId
          ? (get().finalCounts.find((c) => c.productId === productId && c.sessionId === state.sessionId)?.quantity ?? 0)
          : 0;

        // Mark any earlier "unknown" feed rows for this code as resolved, so the feed reflects the
        // learned mapping instead of staying red.
        const resolvedScanEvents: ScanEvent[] = [];
        const scanFeed = get().scanFeed.map((e) => {
          if (
            e.businessId === state.businessId &&
            e.cleanCode === review.cleanCode &&
            (e.status === "unknown" || e.status === "needs_review" || e.status === "conflict" || e.matchedProductId !== productId)
          ) {
            const resolved = {
              ...e,
              status: "resolved" as const,
              resolverStatus: "resolved" as const,
              matchedProductId: productId,
              quantityAfterScan: mergeBaselineQty + (e.quantityAfterScan ?? 0),
            };
            resolvedScanEvents.push(resolved);
            return resolved;
          }
          return e;
        });

        // TASK 3: drop the merged provisional placeholder from the product list before committing so the
        // resolved identity never coexists with its own duplicate row.
        if (removeOrphanId) {
          products = products.filter((p) => p.id !== removeOrphanId);
        }

        set({ products, aliases, needsReviewQueue, scanFeed, lastMismatchWarning: null, lastAliasConflicts: null, lastCategoryWarning: null });

        // TASK 3: transfer the merged placeholder's count onto the resolved product and re-point its feed
        // row, then remove its count row. This preserves the scanned quantity (scan N = count N) while
        // keeping exactly one product row + one count row per identity (no double count, no orphan).
        if (removeOrphanId) {
          const oid = removeOrphanId;
          const targetId = orphanTransferTargetId;
          // F-03: sync the repoint (mirrors deleteProductsInternal's balanced-pair fix) - a
          // local-only transfer leaves the backend holding the orphan's count forever.
          const transferOps = targetId
            ? buildOrphanTransferSyncOps({
                finalCountsBeforeTransfer: get().finalCounts,
                scanFeedBeforeTransfer: get().scanFeed,
                oid,
                targetId,
                businessId: state.businessId,
                idFactory,
                now,
              })
            : [];
          set((st) => ({
            finalCounts: transferOrphanCount(st.finalCounts, oid, targetId, now()),
            scanFeed: st.scanFeed.map((e) =>
              e.businessId === state.businessId && e.matchedProductId === oid
                ? { ...e, matchedProductId: targetId ?? null }
                : e,
            ),
          }));
          if (transferOps.length > 0) enqueueAndSync(transferOps);
        }

        // Queue idempotent SAVE_PRODUCT (new products only) BEFORE the alias, so a reloaded alias always
        // references a persisted product. Then queue idempotent RESOLVE_ALIAS.
        const queued: PendingSyncItem[] = [];
        if (createdProduct) {
          // Task 1b fix (same recipe as correctProduct, commit 024c849): in the orphan-merge branch
          // above, createdProduct.id === provOrphanId - the SAME id ensureProvisionalCount already
          // enqueued a SAVE_PRODUCT for (scanStore.ts ~3748). A bare
          // `businessId:sessionId:<id>:SAVE_PRODUCT` key would be identical to that earlier write's key,
          // so this resolved-identity write would be swallowed as "alreadyApplied" and never reach the
          // backend - real data loss (the resolved name never syncs, only the placeholder does). Fold a
          // content fingerprint of the resolved product into the key, minted once here; every retry of
          // this queue item (drain loop / manual retrySync) replays the same PendingSyncItem object, so
          // retry dedupe on THIS write is unaffected.
          const createdFingerprint = `${JSON.stringify(createdProduct)}@${createdProduct.updatedAt}`;
          queued.push(
            makeQueueItem({
              idFactory,
              now,
              businessId: state.businessId,
              sessionId: state.sessionId,
              entityType: "Product",
              entityId: createdProduct.id,
              operation: "SAVE_PRODUCT",
              payload: createdProduct,
              idempotencyKey: buildIdempotencyKey(
                state.businessId,
                state.sessionId,
                `${createdProduct.id}:${createdFingerprint}`,
                "SAVE_PRODUCT",
              ),
              scanEventId: null,
            }),
          );
        }
        if (!aliasExists) {
          queued.push(
            makeQueueItem({
              idFactory,
              now,
              businessId: state.businessId,
              sessionId: state.sessionId,
              entityType: "Alias",
              entityId: aliasId,
              operation: "RESOLVE_ALIAS",
              payload: newAlias,
              idempotencyKey: aliasKeyOp,
              scanEventId: null,
            }),
          );
        }
        for (const event of resolvedScanEvents) {
          const resolutionFingerprint = `${event.id}:${event.matchedProductId}:${event.status}:${event.resolverStatus}`;
          queued.push(
            makeQueueItem({
              idFactory,
              now,
              businessId: state.businessId,
              sessionId: event.sessionId,
              entityType: "ScanEvent",
              entityId: event.id,
              operation: "SAVE_SCAN_EVENT",
              payload: event,
              idempotencyKey: buildIdempotencyKey(
                state.businessId,
                event.sessionId,
                `${resolutionFingerprint}:human-resolution`,
                "SAVE_SCAN_EVENT",
              ),
              scanEventId: event.id,
            }),
          );
        }
        // Settle the review only after its resolved product, alias, and feed rows are queued. The queue
        // is serial for these operations, so cloud readers never observe a terminal review before the
        // identity it points at is durable.
        queued.push(reviewWrite.item);
        if (queued.length > 0) {
          set((s) => ({ pendingSyncQueue: [...s.pendingSyncQueue, ...queued] }));
        }

        // Multi-code: a newly created product registers an approved alias for EVERY other code it carries
        // (part number / SKU / GTIN / UPC / EAN), so scanning the tire's barcode OR its part-number QR both
        // resolve to the same product. Deduped against the scanned alias and any pre-existing aliases.
        if (createdProduct) {
          const extra = buildProductCodeAliases({
            product: createdProduct,
            alreadyAliasedCleanCodes: [newAlias.cleanCode],
            businessId: state.businessId,
            sessionId: state.sessionId,
            idFactory,
            now,
          });
          const existingForProduct = new Set(
            get().aliases.filter((a) => a.productId === createdProduct!.id).map((a) => a.cleanCode),
          );
          const freshAliases = extra.aliases.filter((a) => !existingForProduct.has(a.cleanCode));
          if (freshAliases.length > 0) {
            const freshIds = new Set(freshAliases.map((a) => a.id));
            set((s) => ({
              aliases: [...s.aliases, ...freshAliases],
              pendingSyncQueue: [...s.pendingSyncQueue, ...extra.queued.filter((q) => freshIds.has(q.entityId))],
            }));
            for (const a of freshAliases) {
              emitAudit({ entityType: "Alias", entityId: a.id, action: "alias_approved", metadata: { code: a.cleanCode, productId: createdProduct.id, origin: "multi_code" } });
            }
          }
        }

        // W2: approve the human-SELECTED discovered identifiers as APPROVED aliases onto the resolved
        // product (new or existing). Only codes the human explicitly selected reach here; deduped per
        // product; a code already owned by a DIFFERENT product is a conflict (surfaced, never overwritten).
        const selectedAliasCodes = (payload.selectedAliasCodes ?? []).filter(Boolean);
        if (selectedAliasCodes.length > 0) {
          const targetProduct = get().products.find((p) => p.id === productId);
          if (targetProduct) {
            const built = buildAliasesForCodes({
              product: targetProduct,
              codes: selectedAliasCodes,
              existingAliases: get().aliases,
              businessId: state.businessId,
              sessionId: state.sessionId,
              idFactory,
              now,
            });
            if (built.aliases.length > 0) {
              const builtIds = new Set(built.aliases.map((a) => a.id));
              set((s) => ({
                aliases: [...s.aliases, ...built.aliases],
                pendingSyncQueue: [...s.pendingSyncQueue, ...built.queued.filter((q) => builtIds.has(q.entityId))],
              }));
              for (const a of built.aliases) {
                emitAudit({ entityType: "Alias", entityId: a.id, action: "alias_approved", metadata: { code: a.cleanCode, productId, origin: "human_discovered" } });
              }
            }
            if (built.conflicts.length > 0) {
              set({ lastAliasConflicts: built.conflicts.map((c) => ({ reviewId, code: c.code, existingProductId: c.otherProductId })) });
              for (const c of built.conflicts) {
                emitAudit({ entityType: "Alias", entityId: c.code, action: "alias_conflict_blocked", metadata: { code: c.code, attemptedProductId: productId, existingProductId: c.otherProductId } });
              }
            }
          }
        }

        // Persist any decode-SUGGESTED identifiers the human did NOT approve as UNAPPROVED "discovered"
        // aliases on the resolved product. They never match or count until a human approves them (the
        // resolver ignores approved !== true); they are offered for one-click approval from the count
        // table. Grounded only - we persist codes the decode actually returned, never an invented one.
        const discoveryTarget = get().products.find((p) => p.id === productId);
        if (discoveryTarget) {
          const selectedSet = new Set(selectedAliasCodes.map((c) => normalizeCode(c).clean));
          const grounded = collectGroundedIdentifiers({ extras: review.suggestedAliases ?? [] });
          const discoverable = discoverableIdentifiers(grounded, get().aliases, productId, state.businessId).filter(
            (g) => g.cleanCode !== newAlias.cleanCode && !selectedSet.has(g.cleanCode),
          );
          if (discoverable.length > 0) {
            const built = buildAliasesForCodes({
              product: discoveryTarget,
              codes: discoverable.map((g) => g.rawCode),
              existingAliases: get().aliases,
              businessId: state.businessId,
              sessionId: state.sessionId,
              idFactory,
              now,
              approved: false, // DISCOVERED: never trusted until a human approves it
              source: discoveryTarget.source,
              createdBy: "discovered",
            });
            if (built.aliases.length > 0) {
              const ids = new Set(built.aliases.map((a) => a.id));
              set((s) => ({
                aliases: [...s.aliases, ...built.aliases],
                pendingSyncQueue: [...s.pendingSyncQueue, ...built.queued.filter((q) => ids.has(q.entityId))],
              }));
              for (const a of built.aliases) {
                emitAudit({ entityType: "Alias", entityId: a.id, action: "alias_discovered", metadata: { code: a.cleanCode, productId, origin: "decode_discovered" } });
              }
            }
          }
        }

        // Audit the human/system resolution (product creation + alias approval). Fire-and-forget.
        if (createdProduct) {
          emitAudit({ entityType: "Product", entityId: createdProduct.id, action: "product_created", metadata: { code: review.cleanCode, origin: payload.origin ?? "human" } });
        }
        if (!aliasExists) {
          emitAudit({ entityType: "Alias", entityId: aliasId, action: "alias_approved", metadata: { code: review.cleanCode, productId, origin: payload.origin ?? "human" } });
        }

        // Feed the shared knowledge base (privacy-safe; only barcode/product/evidence is written).
        // Origin controls trust: human -> verified catalog write; ai -> pending only (NEVER overwrites
        // a verified entry, rule #1/#2); catalog -> already observed on the read path, no write here.
        const origin = payload.origin ?? "human";
        const resolvedProduct = products.find((p) => p.id === productId);
        if (resolvedProduct && isCatalogWritable(resolvedProduct.name)) {
          const candidate = {
            barcode: review.cleanCode,
            normalizedBarcode: review.cleanCode,
            barcodeType: detectCodeType(review.cleanCode),
            name: resolvedProduct.name,
            brand: resolvedProduct.brand,
            category: resolvedProduct.category,
            imageUrl: resolvedProduct.imageUrl,
            sourceUrls: review.sourceUrls ?? [],
            confidence: review.confidence || 1,
          };
          if (origin === "human" && !weakGuessProduct) set({ catalog: upsertVerified(get().catalog, candidate, now(), "owner") });
          else if (origin === "ai") set({ catalog: applyAiCandidate(get().catalog, candidate, now()) });
          else if (origin === "auto_verify") {
            const av = payload.autoVerify;
            set({
              catalog: upsertVerified(
                get().catalog,
                {
                  ...candidate,
                  sourceUrls: av?.sourceUrls ?? candidate.sourceUrls,
                  autoVerified: true,
                  autoVerifyReason: av?.reason ?? "",
                  evidenceScore: av?.score ?? 0,
                  sourceTier: av?.sourceTier ?? "",
                  evidenceSummary: av?.evidenceSummary ?? "",
                },
                now(),
                av?.verifiedBy ?? "evidence_score",
              ),
            });
          }
          // origin "tenant_approval" (a tenant's own confirmation: tenant product + alias only), "auto_count"
          // (learning off) and "catalog" -> no shared-catalog write here.
        }
        if (origin === "human" || origin === "tenant_approval") {
          get().recordFeedback(action === "create_new" ? "product_approved" : "alias_linked", {
            code: review.cleanCode,
            productId,
          });
        }

        // Optionally apply this code to the current session count immediately. Fall back to cleanCode:
        // a customer review rehydrated from disk has its rawCode stripped (privacy), but cleanCode is kept
        // and is what the approved alias is keyed on, so the re-scan still matches + counts.
        if (payload.applyToCount && !weakGuessProduct && !approvingProvisional) {
          // Phase 4: an import-origin review carries importQuantity - the full quantity from the source
          // row (already aggregated across duplicate codes by applyUniversalImport) must land in one
          // confirmation, not just 1 unit. A plain scan-born review has no importQuantity, so this stays
          // the existing single-unit processScan call for every non-import path.
          const applications = review.importQuantity ?? 1;
          if (!Number.isSafeInteger(applications) || applications < 0) return;
          for (let index = 0; index < applications; index += 1) {
            get().processScan(review.rawCode || review.cleanCode);
          }
        } else {
          get().syncPending();
        }
      },

      batchApprove: (reviewIds) => {
        const approved: string[] = [];
        const failed: Array<{ id: string; reason: string }> = [];
        // CHUNK_SIZE is cosmetic bookkeeping only: it slices reviewIds into readable groups for the code
        // below and gives per-row containment inside a bounded slice (a throw is still caught per-row by
        // the inner try/catch, chunk or no chunk). It does NOT commit or yield per chunk - there is no
        // intermediate `set()`/persist between chunks and no `await`/tick boundary, so the whole loop
        // (all chunks) runs in one synchronous pass and one synchronous state update per row, exactly as
        // if CHUNK_SIZE were reviewIds.length. It provides no state isolation between chunks and no
        // resumability if the tab closes mid-loop.
        const CHUNK_SIZE = 25;

        for (let i = 0; i < reviewIds.length; i += CHUNK_SIZE) {
          const chunk = reviewIds.slice(i, i + CHUNK_SIZE);
          for (const reviewId of chunk) {
            try {
              const review = get().needsReviewQueue.find((r) => r.id === reviewId);
              if (!review) {
                failed.push({ id: reviewId, reason: "Review not found" });
                continue;
              }
              // Idempotent: a review already resolved/ignored (this call or an earlier one) is silently
              // skipped, exactly like resolveUnknown's own open-status guard - a re-click or a retried
              // batch never double-counts and is not reported as a failure. Task 9b (owner-ratified
              // 2026-07-14): a PENDING inline suggestion (status "suggested") is approvable here too -
              // resolveUnknown accepts it exactly like "open", so the same core path runs unchanged.
              if (review.status !== "open" && review.status !== "suggested") continue;
              if (!review.hasSuggestion || !review.suggestedProductName) {
                failed.push({ id: reviewId, reason: "No suggestion to approve" });
                continue;
              }
              // Task 9b: capture the feed row(s) carrying this suggestion BEFORE resolveUnknown runs
              // (it may remap the row's matchedProductId), so the inline tag can be settled afterwards.
              const pendingRowIds = get()
                .scanFeed.filter(
                  (e) =>
                    e.suggestion?.status === "pending" &&
                    ((e.cleanCode && e.cleanCode === review.cleanCode) ||
                      (e.matchedProductId && e.matchedProductId === review.provisionalProductId)),
                )
                .map((e) => e.id);

              const discovered = buildDiscoveredIdentifiers(review);
              // TRUST RULE (Build 3 review Finding 1): do NOT pass origin: "human" here. That value disables
              // the weak-guess poison guard at the two provisional-reuse branches in resolveUnknown
              // (`isWeakGuess(review, np) && payload.origin !== "human"`), which exists to stop an
              // evidence-less AI suggestion from becoming a verified product/approved alias. The single-row
              // "Approve suggestion" button (NeedsReviewTable.tsx) passes NO origin - batch approval must call
              // resolveUnknown with the IDENTICAL payload shape so the poison guard applies exactly the same
              // way whether a suggestion is approved one at a time or in bulk.
              get().resolveUnknown(reviewId, "create_new", {
                applyToCount: true,
                newProduct: {
                  name: review.suggestedProductName,
                  brand: review.suggestedBrand,
                  category: review.suggestedCategory,
                  specsShort: review.suggestedSpecsShort,
                  primarySku: review.suggestedPrimarySku,
                  primaryBarcode: review.suggestedPrimaryBarcode || review.cleanCode,
                  gtin: review.suggestedGtin,
                  upc: review.suggestedUpc,
                  ean: review.suggestedEan,
                  imageUrl: review.suggestedImageUrl,
                  productUrl: review.suggestedProductUrl,
                },
                // Default = every discovered identifier approved, matching the single-approve row's
                // default UI state (all checked; the human unchecks to exclude) since batch approval
                // has no per-row checkbox interaction.
                selectedAliasCodes: discovered.map((d) => d.code),
              });

              // resolveUnknown silently no-ops on a guard it hit (e.g. a dedup conflict); only count this
              // row as approved if it actually left the awaiting states (open / suggested).
              const after = get().needsReviewQueue.find((r) => r.id === reviewId);
              if (after && after.status !== "open" && after.status !== "suggested") {
                approved.push(reviewId);
                // Task 9b: settle the inline tag on the row(s) this suggestion belonged to.
                if (pendingRowIds.length > 0) {
                  set((st) => ({
                    scanFeed: st.scanFeed.map((e) =>
                      pendingRowIds.includes(e.id) && e.suggestion?.status === "pending"
                        ? { ...e, suggestion: { ...e.suggestion, status: "approved" as const } }
                        : e,
                    ),
                  }));
                }
              } else {
                // Task 9b: an approve that could NOT auto-resolve (identity-merge suggest_link / dedup
                // conflict) surfaces honestly in the OPEN queue for the human instead of staying parked,
                // and the row's dead inline controls are dropped (the review-derived "(suggested)" tag
                // takes over, exactly the pre-9b display for an open suggestion-bearing review).
                if (after && after.status === "suggested") {
                  const reopenedAt = nextReviewDecisionAt(after, now());
                  set((st) => ({
                    needsReviewQueue: st.needsReviewQueue.map((r) =>
                      r.id === reviewId && r.status === "suggested" ? { ...r, status: "open" as const } : r,
                    ),
                    scanFeed: st.scanFeed.map((e) =>
                      pendingRowIds.includes(e.id) ? { ...e, suggestion: undefined } : e,
                    ),
                  }));
                  persistReviewDecision(reviewId, reopenedAt, true);
                }
                failed.push({ id: reviewId, reason: "Could not resolve automatically - needs manual review" });
              }
            } catch (e) {
              failed.push({ id: reviewId, reason: e instanceof Error ? e.message : String(e) });
            }
          }
        }

        return { approved, failed };
      },

      // Task 9b (owner-ratified 2026-07-14): inline approve on the feed row. REUSE, never duplicate:
      // batchApprove -> resolveUnknown "create_new" IS the single-row human-approval path, so the
      // idempotency-keyed alias write, Phase-2 poison guard, dedup guard, and no-double-count
      // provisional upgrade are all inherited. The review is located by the row's cleanCode, with the
      // reload-resilient provisionalProductId fallback (a customer persist strips the event's code).
      approveSuggestion: (scanEventId) => {
        const st = get();
        const ev = st.scanFeed.find((e) => e.id === scanEventId && e.businessId === st.businessId);
        if (!ev || ev.suggestion?.status !== "pending") return; // idempotent double-tap guard
        const review = st.needsReviewQueue.find(
          (r) =>
            r.businessId === st.businessId &&
            r.status === "suggested" &&
            ((ev.cleanCode && r.cleanCode === ev.cleanCode) ||
              (ev.matchedProductId && r.provisionalProductId === ev.matchedProductId)),
        );
        if (!review) return;
        get().batchApprove([review.id]); // settles the row tag itself on success
      },

      // Best-guess identity (owner decision 2026-08-19): confirm a HUMAN-TYPED identity from the feed
      // row. REUSE, never duplicate: everything after locating the review is resolveUnknown
      // "create_new", the same core the Needs Review "Save product" button calls - so the tenant
      // approved alias, the no-double-count provisional upgrade, and the dedup guard are inherited.
      // Nothing platform-wide is written here (no corpus, no learned tier, no shared decode cache).
      confirmRowIdentity: (scanEventId, fields) => {
        const st = get();
        const ev = st.scanFeed.find((e) => e.id === scanEventId && e.businessId === st.businessId);
        const name = (fields.name ?? "").trim();
        if (!ev || !name) return;
        // Double-tap / re-confirm guards: a settled suggestion, or a code that is ALREADY taught as an
        // approved alias, is a hard no-op - a second confirm must never mint a second product or count.
        if (ev.suggestion && ev.suggestion.status !== "pending") return;
        const code = ev.cleanCode || "";
        if (code && st.aliases.some((a) => a.businessId === st.businessId && a.cleanCode === code && a.approved)) return;
        const ownsRow = (r: UnknownCodeReview) =>
          r.businessId === st.businessId &&
          ((code !== "" && r.cleanCode === code) || (!!ev.matchedProductId && r.provisionalProductId === ev.matchedProductId));
        let review = st.needsReviewQueue.find((r) => (r.status === "open" || r.status === "suggested") && ownsRow(r));
        if (!review) {
          // AUTO-APPLIED row (>= 0.8 suggestion applied onto the provisional, review auto-closed, product
          // still unverified): the human's Approve/Edit confirms THAT review, not a blank reopened one, so
          // the decode's confidence/evidence fields stay on the record. Reactivate it in place as OPEN
          // (not "suggested"): if resolveUnknown then refuses to guess (dedup conflict, suggest_link) the
          // review is exactly where those branches expect it - visible in Needs Review - instead of
          // parked in "suggested" where no surface can finish it.
          const autoApplied = st.needsReviewQueue.find((r) => r.status === "resolved" && r.resolvedBy === "auto" && ownsRow(r));
          if (autoApplied) {
            // Stale click: another path already verified this product, so there is nothing left to
            // confirm - never fall through to the blank-reopen fallback on a settled review.
            if (st.products.find((p) => p.businessId === st.businessId && p.id === autoApplied.provisionalProductId)?.verified) return;
            const reopenedAt = nextReviewDecisionAt(autoApplied, now());
            set((s2) => ({
              needsReviewQueue: s2.needsReviewQueue.map((r) =>
                r.id === autoApplied.id
                  ? { ...r, status: "open" as const, resolvedAt: null, resolvedBy: null, resolutionAction: null }
                  : r,
              ),
            }));
            persistReviewDecision(autoApplied.id, reopenedAt, true);
            review = get().needsReviewQueue.find((r) => r.id === autoApplied.id);
          }
        }
        if (!review) {
          // No awaiting review (e.g. an old row whose review was already settled): open one through the
          // existing path so the resolution below runs on a real review record, never on a synthetic one.
          if (!code) return;
          const createdId = get().reopenNeedsReview(code, "Identity typed by the operator");
          // NO-DOUBLE-COUNT (F6): reopenNeedsReview mints a review with NO provisionalProductId, and
          // resolveUnknown's legacy fallbacks for finding the already-counted provisional (identifier
          // fields, reconstructed placeholder name) are exactly what a customer persist strips and what
          // the prefix-floor rename overwrites. Without the row's OWN provisional the resolution mints a
          // fresh product and re-counts the scan - one physical scan, two units. Stamp the row's
          // provisional onto the review so the existing approve-the-provisional path is taken instead.
          if (createdId && ev.matchedProductId) {
            set((s2) => ({
              needsReviewQueue: s2.needsReviewQueue.map((r) =>
                r.id === createdId && !r.provisionalProductId ? { ...r, provisionalProductId: ev.matchedProductId } : r,
              ),
            }));
          }
          review = createdId ? get().needsReviewQueue.find((r) => r.id === createdId) : undefined;
          if (!review) return;
        }
        const reviewId = review.id;
        // origin "tenant_approval" (and deliberately not in batchApprove): a person typed or tapped
        // Approve on this identity, so the weak-guess poison guard - which exists to stop an
        // evidence-less AI suggestion becoming a verified product by itself - must not fire on it; but
        // the confirmation is the TENANT's knowledge only (verified product + approved alias), never a
        // device-shared verified-catalog entry that would auto-resolve the code for another tenant.
        get().resolveUnknown(reviewId, "create_new", {
          applyToCount: true,
          origin: "tenant_approval",
          newProduct: { name, brand: fields.brand ?? "", category: fields.category ?? "", primaryBarcode: code },
        });
        // Settle the inline tag on every row carrying this code's pending suggestion (same bookkeeping
        // batchApprove does), and only when the review really left the awaiting states.
        const settled = get().needsReviewQueue.find((r) => r.id === reviewId);
        if (settled && settled.status !== "open" && settled.status !== "suggested") {
          set((s2) => ({
            scanFeed: s2.scanFeed.map((e) =>
              e.businessId === st.businessId &&
              e.suggestion?.status === "pending" && (e.id === scanEventId || (code !== "" && e.cleanCode === code))
                ? { ...e, suggestion: { ...e.suggestion, status: "approved" as const } }
                : e,
            ),
          }));
        }
      },

      // Task 9b: inline decline ("Not this product"). Order is owner-ratified: rename the counted row
      // to the prefix floor FIRST (a declined identity never stays on the count; the floor/placeholder
      // is a naming aid, NEVER a verified identity), and ONLY THEN create/reopen the OPEN Needs Review
      // item - decline is now the only suggestion path that creates one. reopenNeedsReview is the
      // existing core: it opens (or creates) the review with the decline reason and clears the
      // (declined) suggestion fields so the Suggested batch pile can never re-offer it.
      declineSuggestion: (scanEventId) => {
        const st = get();
        const ev = st.scanFeed.find((e) => e.id === scanEventId);
        if (!ev || ev.suggestion?.status !== "pending") return; // idempotent double-tap guard
        const review = st.needsReviewQueue.find(
          (r) =>
            (r.status === "suggested" || r.status === "open") &&
            ((ev.cleanCode && r.cleanCode === ev.cleanCode) ||
              (ev.matchedProductId && r.provisionalProductId === ev.matchedProductId)),
        );
        const code = ev.cleanCode || review?.cleanCode || "";
        const floor = code ? prefixFloorName(code, detectCodeType(code)) : null;
        const floorName = code ? provisionalPlaceholderName(code) : "Unidentified item";
        const declineReason = "Suggestion declined by operator - needs a correct name";
        const prodId = ev.matchedProductId ?? review?.provisionalProductId ?? null;
        set((s2) => ({
          products: prodId
            ? s2.products.map((p) =>
                p.id === prodId && p.provisional === true && p.verified !== true
                  ? {
                      ...p,
                      name: floorName,
                      brand: floor?.brand ?? "",
                      category: "",
                      specsShort: "",
                      specsFull: "",
                      imageUrl: "",
                      productUrl: "",
                      confidence: 0,
                      updatedAt: now(),
                      updatedBy: "human",
                    }
                  : p,
              )
            : s2.products,
          // The repeat-scan attach puts the SAME pending suggestion on every row of this code, so a
          // decline settles them ALL (the same shape confirmRowIdentity uses). Settling only the clicked
          // row would leave live Approve controls on an identity the operator just rejected.
          scanFeed: s2.scanFeed.map((e) =>
            e.suggestion?.status === "pending" && (e.id === scanEventId || (code !== "" && e.cleanCode === code))
              ? { ...e, suggestion: { ...e.suggestion, status: "declined" as const }, reason: declineReason }
              : e,
          ),
        }));
        if (code) get().reopenNeedsReview(code, declineReason);
        get().recordFeedback("product_rejected", { code });
        emitAudit({
          entityType: "UnknownCodeReview",
          entityId: review?.id ?? code,
          action: "alias_rejected",
          metadata: { code, kind: "inline_suggestion_declined" },
        });
        // F5 bundle-surgery: the declined row was just renamed to the bare/local-floor placeholder above
        // - if the client-safe lookup found no brand, check for a DERIVED-tier hit asynchronously.
        if (code && !floor && prodId) get().enrichPrefixFloorLabel(code, prodId);
      },

      evaluateLinkMismatch: (reviewId, productId) => {
        const state = get();
        const review = state.needsReviewQueue.find((r) => r.id === reviewId);
        if (!review) return null;
        const target = state.products.find((p) => p.id === productId);
        const hasSuggestion = !!(review.suggestedProductName || review.suggestedBrand || review.suggestedCategory);
        return evaluateMismatch({
          scannedCode: review.cleanCode,
          suggested: hasSuggestion
            ? { name: review.suggestedProductName, brand: review.suggestedBrand, category: review.suggestedCategory }
            : undefined,
          target: { name: target?.name, brand: target?.brand, category: target?.category },
        });
      },

      clearMismatchWarning: () => set({ lastMismatchWarning: null }),

      clearCategoryWarning: () => set({ lastCategoryWarning: null }),

      approveDiscoveredIdentifiers: (productId, cleanCodes) => {
        const state = get();
        const product = state.products.find((p) => p.id === productId);
        if (!product) return;
        const { businessId, sessionId } = state;
        const codes = [...new Set(cleanCodes.map((c) => normalizeCode(c).clean).filter(Boolean))];
        if (codes.length === 0) return;
        const aliases = state.aliases;
        const flipIds = new Set<string>();
        const toCreate: string[] = [];
        const conflicts: { code: string; otherProductId: string }[] = [];
        for (const code of codes) {
          const approvedElsewhere = aliases.find(
            (a) => a.businessId === businessId && a.cleanCode === code && a.approved && a.productId !== productId,
          );
          if (approvedElsewhere) {
            conflicts.push({ code, otherProductId: approvedElsewhere.productId }); // never hijack another product
            continue;
          }
          const mine = aliases.find((a) => a.businessId === businessId && a.cleanCode === code && a.productId === productId);
          if (mine) {
            if (!mine.approved) flipIds.add(mine.id); // flip the discovered alias -> approved
            // already approved -> idempotent no-op
          } else {
            toCreate.push(code); // grounded code with no alias yet -> create approved
          }
        }
        const built =
          toCreate.length > 0
            ? buildAliasesForCodes({ product, codes: toCreate, existingAliases: aliases, businessId, sessionId, idFactory, now })
            : { aliases: [] as Alias[], queued: [] as PendingSyncItem[], conflicts: [] as { code: string; otherProductId: string }[] };
        for (const c of built.conflicts) conflicts.push(c);

        if (flipIds.size > 0 || built.aliases.length > 0) {
          const flipped = aliases.filter((a) => flipIds.has(a.id));
          const flipQueue = flipped.map((a) =>
            makeQueueItem({
              idFactory, now, businessId, sessionId,
              entityType: "Alias", entityId: a.id, operation: "RESOLVE_ALIAS",
              payload: { ...a, approved: true },
              idempotencyKey: buildIdempotencyKey(businessId, sessionId, a.id, "RESOLVE_ALIAS"),
              scanEventId: null,
            }),
          );
          set((s) => ({
            aliases: s.aliases
              .map((a): Alias => (flipIds.has(a.id) ? { ...a, approved: true, updatedAt: now(), syncStatus: "pending" } : a))
              .concat(built.aliases),
            pendingSyncQueue: [...s.pendingSyncQueue, ...built.queued, ...flipQueue],
          }));
          for (const a of [...flipped, ...built.aliases]) {
            emitAudit({ entityType: "Alias", entityId: a.id, action: "alias_approved", metadata: { code: a.cleanCode, productId, origin: "discovered_approved" } });
          }
        }
        if (conflicts.length > 0) {
          set({ lastAliasConflicts: conflicts.map((c) => ({ reviewId: "", code: c.code, existingProductId: c.otherProductId })) });
        }
      },

      clearAliasConflicts: () => set({ lastAliasConflicts: null }),

      unlinkAlias: (aliasId) => {
        const state = get();
        const alias = state.aliases.find((a) => a.id === aliasId);
        if (!alias) return;
        const key = buildIdempotencyKey(state.businessId, state.sessionId, `${aliasId}:unlink:${idFactory()}`, "RESOLVE_ALIAS");
        const updated: Alias = { ...alias, approved: false, updatedAt: now(), syncStatus: "pending", idempotencyKey: key };
        // Mark related feed rows as needing review again (scan HISTORY is preserved, just no longer "known").
        const scanFeed = state.scanFeed.map((e) =>
          e.matchedProductId === alias.productId && e.cleanCode === alias.cleanCode
            ? { ...e, status: "needs_review" as const, resolverStatus: "needs_review" as const, matchedProductId: null }
            : e,
        );
        set((s) => ({
          aliases: s.aliases.map((a) => (a.id === aliasId ? updated : a)),
          scanFeed,
          pendingSyncQueue: [
            ...s.pendingSyncQueue,
            makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "Alias", entityId: aliasId, operation: "RESOLVE_ALIAS", payload: updated, idempotencyKey: key, scanEventId: null }),
          ],
        }));
        emitAudit({ entityType: "Alias", entityId: aliasId, action: "alias_moved_or_unlinked", metadata: { fromProduct: alias.productId, toProduct: "", cleanCode: alias.cleanCode, normalizedCode: alias.normalizedCode, reason: "human_mistake_repair" } });
        get().syncPending();
      },

      moveAlias: (aliasId, toProductId) => {
        const state = get();
        const alias = state.aliases.find((a) => a.id === aliasId);
        if (!alias || !toProductId || toProductId === alias.productId) return;
        const fromProduct = alias.productId;
        const key = buildIdempotencyKey(state.businessId, state.sessionId, `${aliasId}:move:${idFactory()}`, "RESOLVE_ALIAS");
        const updated: Alias = { ...alias, productId: toProductId, approved: true, updatedAt: now(), syncStatus: "pending", idempotencyKey: key };
        set((s) => ({
          aliases: s.aliases.map((a) => (a.id === aliasId ? updated : a)),
          pendingSyncQueue: [
            ...s.pendingSyncQueue,
            makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "Alias", entityId: aliasId, operation: "RESOLVE_ALIAS", payload: updated, idempotencyKey: key, scanEventId: null }),
          ],
        }));
        emitAudit({ entityType: "Alias", entityId: aliasId, action: "alias_moved_or_unlinked", metadata: { fromProduct, toProduct: toProductId, cleanCode: alias.cleanCode, normalizedCode: alias.normalizedCode, reason: "human_mistake_repair" } });
        get().syncPending();
      },

      // --- Phase 6: wrong-decode correction -------------------------------------------------------

      removeFromCount: (productId) => {
        if (get().currentSession?.locked) return; // locked session: counts are read-only until unlocked
        const state = get();
        const removed = state.finalCounts.find((c) => c.productId === productId);
        if (!removed) return;
        // Session-only: drop the count row. Product + aliases are untouched (reversible by re-scanning).
        set((s) => ({ finalCounts: s.finalCounts.filter((c) => c.productId !== productId) }));
        emitAudit({ entityType: "InventoryCount", entityId: removed.id, action: "count_removed", metadata: { productId, quantity: removed.quantity, reason: "remove_from_count" } });
      },

      correctProduct: (productId, fields) => {
        if (get().currentSession?.locked) return; // locked session: product edits are blocked until unlocked
        const state = get();
        const product = state.products.find((p) => p.id === productId);
        if (!product) return;
        // Whitelist editable, product-facing fields only. Alias trust (approved/verified) is NEVER touched here.
        const safe: Partial<Product> = {};
        for (const k of ["name", "brand", "category", "specsShort", "specsFull", "primarySku", "imageUrl", "location", "unitCost"] as const) {
          if (k === "unitCost") {
            if (Object.hasOwn(fields, k)) safe.unitCost = fields.unitCost;
          } else if (fields[k] !== undefined) {
            safe[k] = fields[k];
          }
        }
        const updated: Product = { ...product, ...safe, updatedAt: now(), updatedBy: "human" };
        // Task 4: a human editing the name or brand is a PERMANENT correction - stamp structuredBy
        // "human" so no later automatic re-structuring (hot path or the offline backfill) ever
        // overwrites it. Mirror the corrected brand into structuredBrand so the table's Brand column
        // (which prefers structuredBrand) reflects the edit immediately rather than a stale value.
        if (safe.name !== undefined || safe.brand !== undefined) {
          updated.structuredBy = "human";
          if (safe.brand !== undefined) updated.structuredBrand = safe.brand;
        }
        // Task 1 fix: a SAVE_PRODUCT idempotency key built from businessId:sessionId:productId:SAVE_PRODUCT
        // alone is identical for every edit to the same product in the same session - MockDb/
        // FirebaseSyncTarget dedupe on that key, so edit #2 was silently swallowed as "alreadyApplied"
        // and never persisted. Fold a content fingerprint of THIS edit (the changed field values +
        // updatedAt, minted once here) into the key so distinct edits mint distinct keys, matching the
        // existing "${entityId}:<suffix>" pattern used elsewhere in this file (unlink/move/markwrong).
        // A genuine RETRY never calls this function again - the drain loop replays the exact same
        // PendingSyncItem object (same key) via db.apply(), so idempotency on repeated network retries
        // of ONE edit is unaffected.
        const editFingerprint = `${JSON.stringify(safe)}@${updated.updatedAt}`;
        const key = buildIdempotencyKey(state.businessId, state.sessionId, `${productId}:${editFingerprint}`, "SAVE_PRODUCT");
        set((s) => ({ products: s.products.map((p) => (p.id === productId ? updated : p)) }));
        enqueueAndSync([
          makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "Product", entityId: productId, operation: "SAVE_PRODUCT", payload: updated, idempotencyKey: key, scanEventId: null }),
        ]);
        emitAudit({ entityType: "Product", entityId: productId, action: "product_corrected", metadata: { fields: Object.keys(safe).join(",") } });
      },

      reopenNeedsReview: (cleanCode, reason, importContext) => {
        const state = get();
        const code = (cleanCode ?? "").trim();
        if (!code) return null;
        const existing = state.needsReviewQueue.find((r) => r.businessId === state.businessId && r.cleanCode === code);
        if (existing) {
          const reopenedAt = nextReviewDecisionAt(existing, now());
          const write = buildReviewDecisionWrite({
            ...existing, status: "open", reason, resolvedAt: null, resolvedBy: null, resolutionAction: null,
            hasSuggestion: Boolean(importContext?.suggestion), suggestedProductName: importContext?.suggestion?.name ?? "",
            suggestedBrand: importContext?.suggestion?.brand ?? "", suggestedCategory: importContext?.suggestion?.category ?? "",
            suggestedSpecsShort: importContext?.suggestion?.specsShort ?? "", suggestedSpecsFull: "",
            suggestedPrimarySku: importContext?.suggestion?.primarySku ?? "", suggestedPrimaryBarcode: importContext?.suggestion?.primaryBarcode ?? "",
            suggestedGtin: "", suggestedUpc: "", suggestedEan: "", suggestedImageUrl: "", suggestedProductUrl: "",
            suggestedAliases: [], sourceUrls: [], verifiedFacts: [], guesses: [], confidence: 0, providerName: "",
            decodeStatus: "needs_review", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheckDecision: "",
            correctionRecheckStatus: undefined, correctionRecheckedAt: null, correctionRecheckMissingKeys: undefined,
            reopenedFromWrong: true,
            importQuantity: importContext?.importQuantity,
          }, reopenedAt);
          set((s) => ({
            needsReviewQueue: s.needsReviewQueue.map((r) => r.id === existing.id ? write.review : r),
          }));
          enqueueAndSync([write.item]);
          return existing.id;
        }
        const id = idFactory();
        const reopenedAt = now();
        const baseReview: UnknownCodeReview = {
          id, businessId: state.businessId, sessionId: state.sessionId, rawCode: code, cleanCode: code,
          normalizedCandidates: normalizeCode(code).searchVariants ?? [code],
          suggestedProductName: importContext?.suggestion?.name ?? "", suggestedBrand: importContext?.suggestion?.brand ?? "",
          suggestedCategory: importContext?.suggestion?.category ?? "", suggestedSpecsShort: importContext?.suggestion?.specsShort ?? "",
          suggestedSpecsFull: "", suggestedPrimarySku: importContext?.suggestion?.primarySku ?? "",
          suggestedPrimaryBarcode: importContext?.suggestion?.primaryBarcode ?? "", suggestedGtin: "", suggestedUpc: "", suggestedEan: "",
          suggestedImageUrl: "", suggestedProductUrl: "", suggestedAliases: [], sourceUrls: [], verifiedFacts: [], guesses: [],
          reason, providerName: "", confidence: 0, hasSuggestion: Boolean(importContext?.suggestion), decodeStatus: "needs_review",
          evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheckDecision: "", reopenedFromWrong: true,
          status: "open", createdAt: reopenedAt, resolvedAt: null, resolvedBy: null, resolutionAction: null,
          syncStatus: "pending", idempotencyKey: buildIdempotencyKey(state.businessId, state.sessionId, id, "SAVE_UNKNOWN_SCAN"),
          importQuantity: importContext?.importQuantity,
        };
        const write = buildReviewDecisionWrite(baseReview, reopenedAt);
        const review = write.review;
        set((s) => ({ needsReviewQueue: [...s.needsReviewQueue, review] }));
        enqueueAndSync([write.item]);
        return id;
      },

      applyUniversalImport: (rows) => {
        get().ensureAutoSession();
        if (!get().currentSession || get().currentSession?.status !== "active") {
          throw new Error("Start or unlock an active session before applying this import.");
        }
        const summary: UniversalImportApplySummary = { applied: 0, queuedForReview: 0, rejected: 0 };

        // C5 fix (plan-review-mandated): reopenNeedsReview reuses the FIRST review sharing a cleanCode, so
        // two source rows for the same code would otherwise OVERWRITE importQuantity (last row wins) and
        // silently drop the earlier row's quantity - or, on the exact path, mint/count the code twice.
        // Aggregate by resolved code BEFORE any review/count write so each unique code yields exactly one
        // review/count carrying the TOTAL quantity. Order of first appearance is preserved for the summary.
        type AggregatedRow = {
          code: string;
          /** cleanCode passed to reopenNeedsReview. Equal to `code` except on a divergent-identity
           *  collision, where it is disambiguated so the two conflicting identities land as TWO separate
           *  review entries instead of colliding onto one (reopenNeedsReview keys reviews by cleanCode). */
          reviewCode: string;
          status: ImportPreviewRow["status"];
          reason: string;
          quantity: number;
          suggestion: { name: string; brand: string; category: string; specsShort: string; primarySku: string; primaryBarcode: string };
          /** Finding 3 fix (P4 ultra-review HIGH): the resolved identity this aggregate was built from,
           *  used to detect a DIVERGENT collision (same raw key, different real product) so it is never
           *  silently merged under the first row's identity. */
          identitySignature: string;
        };
        // Finding 3 fix: two source rows can share the same raw aggregation key (barcode/partNumber/name
        // fallback) yet resolve to genuinely DIFFERENT products - e.g. two blank-barcode/blank-PN rows
        // that both fall back to a generic name like "Tire" but carry different candidate identities.
        // Merging those under the first row's identity silently discards the second row's identity and
        // misattributes its quantity (resolver-trust law: wrong identity is FAILURE). Compute a resolved
        // identity signature per row - prefer the matched candidate/catalog identity over raw free text -
        // and only sum quantities when two rows for the same raw key share that signature. A divergent
        // collision is routed to its own review entry instead (never merged, never dropped).
        const identitySignature = (preview: ImportPreviewRow, source: NonNullable<ImportPreviewRow["source"]>): string => {
          if (preview.candidate?.uid) return `uid:${preview.candidate.uid}`;
          if (preview.retailCatalogMatch) {
            return `catalog:${preview.retailCatalogMatch.brand}|${preview.retailCatalogMatch.productName}|${preview.retailCatalogMatch.barcode}`;
          }
          // No matched identity at all - fall back to the same brand/name/sku/barcode fields the
          // suggestion itself is built from, so two rows with materially different suggestions (e.g.
          // different brand) are treated as different identities even without a corpus match. DEFECT 1
          // (padded-GTIN equivalence law): a GTIN-shaped barcode is compared by its CANONICAL form so
          // 086699866707 (UPC-A) and 0086699866707 (zero-padded EAN-13) share one signature; non-GTIN
          // codes (part numbers) fall through untouched - their leading zeros carry meaning.
          const sigBarcode = canonicalGtin(source.barcode) ?? source.barcode;
          return `raw:${source.brand}|${source.partNumber}|${sigBarcode}|${source.name}`;
        };
        // DEFECT 1 (padded-GTIN equivalence law): the aggregation MAP key must collapse zero-padded GTIN
        // encodings of one product onto a single entry. Key on the CANONICAL GTIN when the code is
        // GTIN-shaped; otherwise fall back to the raw string (a part number is NEVER canonicalized away).
        // The raw code is still preserved verbatim on the row/alias/product records below.
        const aggKeyFor = (rawCode: string): string => canonicalGtin(rawCode) ?? rawCode;
        const aggregated = new Map<string, AggregatedRow>();
        for (const preview of rows) {
          if (preview.status === "reject" || !preview.source) {
            summary.rejected += 1;
            continue;
          }
          const source = preview.source;
          const rawCode = source.barcode || source.partNumber || source.name;
          if (!rawCode) {
            summary.rejected += 1;
            continue;
          }
          const aggKey = aggKeyFor(rawCode);
          const suggestion = {
            name: preview.retailCatalogMatch?.productName || preview.candidate?.name || source.expected.name || rawCode,
            brand: preview.retailCatalogMatch?.brand || preview.candidate?.brand || source.brand,
            category: preview.retailCatalogMatch?.category || source.category,
            specsShort: [source.model, source.size].filter(Boolean).join(" "),
            primarySku: source.partNumber,
            primaryBarcode: source.barcode,
          };
          const signature = identitySignature(preview, source);
          const existing = aggregated.get(aggKey);
          if (existing) {
            if (existing.identitySignature === signature) {
              // Genuinely the same resolved product - safe to sum (unchanged C5 behavior).
              existing.quantity += source.quantity;
              // A later row for the same code never downgrades an already-exact status to fuzzy/review;
              // an exact match on ANY row for this code is enough to treat the aggregate as exact.
              if (preview.status === "exact") existing.status = "exact";
              continue;
            }
            // Divergent identity collision: do NOT merge under the first identity and do NOT drop this
            // row's identity/quantity. Route BOTH the existing aggregate and this row to Needs Review
            // under distinct keys, each keeping its own quantity, with an honest conflict reason.
            const conflictReason = "This code maps to more than one product in the file; confirm which.";
            if (existing.reason !== conflictReason) {
              existing.status = "review";
              existing.reason = conflictReason;
              // Re-key both the map entry and the reviewCode passed to reopenNeedsReview onto a
              // signature-qualified value, so this aggregate (a) no longer collides in this map with a
              // future row sharing the same raw key but a third distinct identity, and (b) mints its OWN
              // review row below instead of colliding with the review keyed on the bare raw code.
              existing.reviewCode = `${rawCode} (${existing.identitySignature})`;
              aggregated.delete(aggKey);
              aggregated.set(`${aggKey} ${existing.identitySignature}`, existing);
            }
            aggregated.set(`${aggKey} ${signature}`, {
              code: rawCode,
              reviewCode: `${rawCode} (${signature})`,
              status: "review",
              reason: conflictReason,
              quantity: source.quantity,
              suggestion,
              identitySignature: signature,
            });
            continue;
          }
          aggregated.set(aggKey, { code: rawCode, reviewCode: rawCode, status: preview.status, reason: preview.reason, quantity: source.quantity, suggestion, identitySignature: signature });
        }

        get().snapshotCount("Before universal import");
        for (const row of aggregated.values()) {
          const reviewId = get().reopenNeedsReview(row.reviewCode, row.reason, {
            importQuantity: row.quantity,
            suggestion: row.suggestion,
          });
          if (!reviewId) {
            summary.rejected += 1;
            continue;
          }
          if (row.status !== "exact") {
            summary.queuedForReview += 1;
            continue;
          }
          get().resolveUnknown(reviewId, "create_new", {
            origin: "human",
            applyToCount: true,
            newProduct: {
              name: row.suggestion.name,
              brand: row.suggestion.brand,
              category: row.suggestion.category,
              specsShort: row.suggestion.specsShort,
              primarySku: row.suggestion.primarySku,
              primaryBarcode: row.suggestion.primaryBarcode || row.code,
            },
          });
          if (get().needsReviewQueue.find((review) => review.id === reviewId)?.status === "resolved") {
            summary.applied += 1;
          } else {
            summary.queuedForReview += 1;
          }
        }
        get().snapshotCount("After universal import");
        return summary;
      },

      markWrong: async (productId, opts) => {
        const state = get();
        const product = state.products.find((p) => p.businessId === state.businessId && p.id === productId);
        const counts = state.finalCounts.filter((c) => c.businessId === state.businessId && c.productId === productId);
        // Codes that resolved to this product this session (scan feed is the reliable source; the count's
        // aliasesSeen is a fallback). These approved aliases are the ones to deactivate.
        const seenCodes = Array.from(
          new Set([
            ...state.scanFeed.filter((e) => e.businessId === state.businessId && e.matchedProductId === productId).map((e) => e.cleanCode),
            ...counts.flatMap((count) => count.aliasesSeen),
          ]),
        );
        const retainedFeedCodes = Array.from(
          new Set(state.scanFeed.filter((event) => event.businessId === state.businessId && event.matchedProductId === productId).map((event) => event.cleanCode)),
        );
        // 1. Deactivate the APPROVED aliases that mapped the scanned code(s) to this (wrong) product.
        const deactivate = state.aliases.filter(
          (a) => a.businessId === state.businessId && a.productId === productId && a.approved && (seenCodes.length === 0 || seenCodes.includes(a.cleanCode)),
        );
        if (deactivate.length > 0) {
          const ids = new Set(deactivate.map((a) => a.id));
          const queued: PendingSyncItem[] = [];
          const updatedAliases = state.aliases.map((a) => {
            if (!ids.has(a.id)) return a;
            const key = buildIdempotencyKey(state.businessId, state.sessionId, `${a.id}:markwrong:${idFactory()}`, "RESOLVE_ALIAS");
            const u: Alias = { ...a, approved: false, updatedAt: now(), syncStatus: "pending", idempotencyKey: key };
            queued.push(makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "Alias", entityId: a.id, operation: "RESOLVE_ALIAS", payload: u, idempotencyKey: key, scanEventId: null }));
            emitAudit({ entityType: "Alias", entityId: a.id, action: "wrong_alias_removed", metadata: { productId, cleanCode: a.cleanCode, reason: opts?.reason ?? "marked_wrong" } });
            return u;
          });
          set((s) => ({ aliases: updatedAliases, pendingSyncQueue: [...s.pendingSyncQueue, ...queued] }));
        }
        // 1b. Un-verify the wrong product so the DETERMINISTIC resolver can no longer match it by its
        // identifier fields (matchProductByIdentifiers only trusts verified === true). Without this, the
        // next scan of the same barcode would re-match this wrong product and re-count it - bypassing the
        // firewall entirely. The product row is kept (status unchanged) for audit/repair, just untrusted.
        if (product && product.verified) {
          const key = buildIdempotencyKey(state.businessId, state.sessionId, `${product.id}:markwrong:unverify`, "SAVE_PRODUCT");
          const unverified: Product = { ...product, verified: false, updatedAt: now(), updatedBy: "human" };
          set((s) => ({
            products: s.products.map((p) => (p.businessId === state.businessId && p.id === productId ? unverified : p)),
            pendingSyncQueue: [
              ...s.pendingSyncQueue,
              makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "Product", entityId: productId, operation: "SAVE_PRODUCT", payload: unverified, idempotencyKey: key, scanEventId: null }),
            ],
          }));
          emitAudit({ entityType: "Product", entityId: productId, action: "product_unverified", metadata: { reason: opts?.reason ?? "marked_wrong" } });
        }
        // 2. Reset related feed rows to needs_review (scan history preserved; no longer "known").
        set((s) => ({
          scanFeed: s.scanFeed.map((e) =>
            e.businessId === state.businessId && e.matchedProductId === productId && (seenCodes.length === 0 || seenCodes.includes(e.cleanCode))
              ? { ...e, status: "needs_review" as const, resolverStatus: "needs_review" as const, matchedProductId: null }
              : e,
          ),
        }));
        // 3. Transfer the wrong product's physical quantity to a SAFE "Unidentified item" provisional
        //    keyed by the representative scanned code, then reopen review. Total physical quantity is
        //    INVARIANT across any identity correction (North-star #2): the items are still on the
        //    shelf; only their identity was wrong.
        const code = seenCodes[0] || product?.primaryBarcode || "";
        if (counts.length > 0) {
          const wrongQty = counts.reduce((total, count) => total + count.quantity, 0);
          // (a) Remove the wrong count row FIRST. ensureProvisionalCount's idempotency guard
          //     (scanStore.ts:2952) short-circuits when any CURRENTLY-COUNTED product carries this
          //     code in its identifier fields - the wrong product still does (step 1b un-verifies but
          //     does not blank primaryBarcode). Its `counted` set is built from finalCounts, so removing
          //     the row here is what lets the mint below proceed.
          set((s) => ({ finalCounts: s.finalCounts.filter((c) => c.businessId !== state.businessId || c.productId !== productId) }));
          // F-03 FIX: sync the removal (mirrors deleteProductsInternal's "SYNC THE REPOINT" balanced-pair
          // fix, reviewed defect 2026-07-22, scanStore.ts ~6809) - without this the backend keeps the
          // wrong product's InventoryCount doc forever, so a fresh cloud reload / second-device load
          // would restore its quantity even as the corrected identity below also counts it (2 becomes 4).
          // FRESH per-transfer key (never the original counting key) so the applied-key dedupe cannot
          // reject this as an idempotency_conflict.
          for (const count of counts) {
            if (count.quantity <= 0) continue;
            const outKey = buildIdempotencyKey(state.businessId, count.sessionId, `${count.id}:markwrong-transfer-out`, "INCREMENT_COUNT");
            const outPayload: IncrementPayload = {
              businessId: state.businessId,
              sessionId: count.sessionId,
              productId,
              scanEventId: `${count.id}:markwrong-transfer`,
              quantityDelta: -count.quantity,
              idempotencyKey: outKey,
            };
            enqueueAndSync([
              makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: count.sessionId, entityType: "InventoryCount", entityId: count.id, operation: "INCREMENT_COUNT", payload: outPayload, idempotencyKey: outKey, scanEventId: null }),
            ]);
          }
          if (code && wrongQty > 0) {
            const transferProvisionals = new Map<string, Product>();
            // A count may retain alias metadata for rows already trimmed from the feed. Only a retained
            // feed row gets its own provisional; otherwise ensureProvisionalCount would manufacture an
            // extra physical scan before the residual logic can account for the trimmed quantity.
            const transferCodes = retainedFeedCodes.length > 0
              ? retainedFeedCodes
              : Array.from(new Set(counts.flatMap((count) => count.aliasesSeen.length > 0 ? count.aliasesSeen : [code])));
            for (const transferCode of transferCodes) {
            // (b) Mint + count the Unidentified provisional off the first reopened feed row (step 2
            //     already reset the wrong product's rows to matchedProductId: null / needs_review, which
            //     is exactly the shape ensureProvisionalCount's feed lookup matches). Task 2's D1 repair
            //     makes this mint enqueue SAVE_PRODUCT + SAVE_SCAN_EVENT + INCREMENT_COUNT too.
            //     TASK 9 FIX (provisional-wrong inflation): the mint target id comes from
            //     ensureProvisionalCount's own return, NEVER re-derived via an unordered
            //     products.find on primaryBarcode. When the marked-wrong product is ITSELF a
            //     provisional, the old find matched it (its primaryBarcode is never blanked) and the
            //     repoint loop re-counted the same physical scans on the OLD row while the mint had
            //     already counted one event on the NEW row - inflating the total. The id-keyed lookup
            //     below is deterministic; excluding productId is defense in depth so the repoint can
            //     never target the product being corrected away from.
            const mintedId = get().ensureProvisionalCount(
              transferCode,
              `Marked wrong - re-identify. Previous match "${product?.name ?? ""}" removed.`,
              // F-03: this repoints an EXISTING reopened feed row that may already be synced under the
              // wrong identity - see ensureProvisionalCount's freshTransferKeys comment for why the
              // inherited key must not be reused.
              {
                freshTransferKeys: true,
                // With no retained feed row, the per-session residual loop below owns the full
                // physical quantity. Mint only the safe identity here so no synthetic +1 is added
                // before that exact residual is reconstructed.
                countIfFeedMissing: retainedFeedCodes.length > 0,
              },
            );
            const provRow = get().products.find(
              (p) => p.businessId === state.businessId && p.id === mintedId && p.id !== productId && p.provisional === true && p.status !== "archived",
            );
            if (provRow) {
              transferProvisionals.set(transferCode, provRow);
              // (c) Repoint every REMAINING reopened feed event for this code onto the provisional and
              //     apply each through the ledger (incrementInventoryCount dedupes by event id), stamping
              //     the same-fact quantityDelta: 1 on the row. The transferred quantity is carried by
              //     REAL events - the ledger replay reproduces it exactly (North-star #2).
              const pending = get().scanFeed.filter(
                (e) => e.businessId === state.businessId && e.cleanCode === transferCode && e.matchedProductId === null && e.status === "needs_review",
              );
              for (const ev2 of pending) {
                const stNow = get();
                const cur = stNow.finalCounts.find((c) => c.productId === provRow.id);
                if (cur?.scanEventIds.includes(ev2.id)) continue;
                const repointedEvent: ScanEvent = { ...ev2, matchedProductId: provRow.id, status: "known", quantityDelta: 1 };
                const r = incrementInventoryCount(stNow.finalCounts, repointedEvent, idFactory);
                repointedEvent.quantityAfterScan = r.count.quantity;
                set((s2) => ({
                  finalCounts: r.counts,
                  scanFeed: s2.scanFeed.map((e) =>
                    e.id === ev2.id
                      ? { ...e, matchedProductId: provRow.id, status: "known" as const, quantityDelta: 1, quantityAfterScan: r.count.quantity }
                      : e,
                  ),
                }));
                // F-03 FIX: sync this repointed event. FRESH transfer keys (never ev2's original
                // SAVE_SCAN_EVENT/INCREMENT_COUNT keys, which were stamped against the OLD (wrong)
                // product's Firestore applied-key marker and would be rejected as idempotency_conflict
                // on replay against the new productId) - same reasoning as ensureProvisionalCount's
                // freshTransferKeys path above.
                const saveKey = buildIdempotencyKey(state.businessId, ev2.sessionId, `${ev2.id}:markwrong-transfer:${provRow.id}`, "SAVE_SCAN_EVENT");
                const incKey = buildIdempotencyKey(state.businessId, ev2.sessionId, `${ev2.id}:markwrong-transfer:${provRow.id}`, "INCREMENT_COUNT");
                const repointedIncPayload: IncrementPayload = {
                  businessId: state.businessId,
                  sessionId: ev2.sessionId,
                  productId: provRow.id,
                  scanEventId: ev2.id,
                  quantityDelta: 1,
                  idempotencyKey: incKey,
                };
                enqueueAndSync([
                  makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: ev2.sessionId, entityType: "ScanEvent", entityId: ev2.id, operation: "SAVE_SCAN_EVENT", payload: repointedEvent, idempotencyKey: saveKey, scanEventId: ev2.id }),
                  makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: ev2.sessionId, entityType: "InventoryCount", entityId: r.count.id, operation: "INCREMENT_COUNT", payload: repointedIncPayload, idempotencyKey: incKey, scanEventId: ev2.id }),
                ]);
              }
            }
            }
            // (d) Feed-trim safety net: account for retained rows across ALL reopened codes before
            //     minting any synthetic remainder. A wrong identity may have multiple real barcodes;
            //     those codes must retain distinct provisional identities rather than becoming a
            //     representative-code residual.
            const transferProductIds = new Set([...transferProvisionals.values()].map((provisional) => provisional.id));
            const transferredEvents = new Map(
              get().scanFeed
                .filter((event) => event.businessId === state.businessId && event.matchedProductId !== null && transferProductIds.has(event.matchedProductId))
                .map((event) => [event.id, event.quantityDelta] as const),
            );
            for (const count of counts) {
              const represented = count.scanEventIds.reduce(
                (total, eventId) => total + (transferredEvents.get(eventId) ?? 0),
                0,
              );
              const missing = count.quantity - represented;
              if (missing <= 0) continue;
              const residualCode = count.aliasesSeen.find((alias) => transferProvisionals.has(alias)) ?? code;
              const residualProvisional = transferProvisionals.get(residualCode);
              if (!residualProvisional) continue;
              const residualId = idFactory();
              const residualEvent: ScanEvent = {
                id: residualId,
                businessId: state.businessId,
                sessionId: count.sessionId,
                rawCode: residualCode,
                cleanCode: residualCode,
                normalizedCandidates: [],
                matchedProductId: residualProvisional.id,
                matchType: "unknown",
                status: "known",
                resolverStatus: "needs_review",
                codeType: detectCodeType(residualCode),
                reason: "markWrong residual repoint (feed trimmed by persist).",
                quantityDelta: missing,
                quantityAfterScan: 0,
                createdAt: now(),
                source: "scan",
                notes: "markWrong residual repoint (feed trimmed by persist).",
                syncStatus: "pending",
                syncError: null,
                idempotencyKey: buildIdempotencyKey(state.businessId, count.sessionId, residualId, "INCREMENT_COUNT"),
              };
              const rr = incrementInventoryCount(get().finalCounts, residualEvent, idFactory);
              residualEvent.quantityAfterScan = rr.count.quantity;
              set((s2) => ({ scanFeed: [residualEvent, ...s2.scanFeed], finalCounts: rr.counts }));
              const residualInc: IncrementPayload = {
                businessId: state.businessId, sessionId: count.sessionId, productId: residualProvisional.id,
                scanEventId: residualId, quantityDelta: missing, idempotencyKey: residualEvent.idempotencyKey,
              };
              enqueueAndSync([
                makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: count.sessionId, entityType: "ScanEvent", entityId: residualId, operation: "SAVE_SCAN_EVENT", payload: residualEvent, idempotencyKey: buildIdempotencyKey(state.businessId, count.sessionId, residualId, "SAVE_SCAN_EVENT"), scanEventId: residualId }),
                makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: count.sessionId, entityType: "InventoryCount", entityId: rr.count.id, operation: "INCREMENT_COUNT", payload: residualInc, idempotencyKey: residualEvent.idempotencyKey, scanEventId: residualId }),
              ]);
            }
          }
          emitAudit({ entityType: "InventoryCount", entityId: counts[0].id, action: "count_transferred", metadata: { productId, quantity: wrongQty, toCode: code, reason: "marked_wrong" } });
        }
        // 4. Reopen Needs Review for the representative scanned code.
        const reviewId = code
          ? get().reopenNeedsReview(code, `Marked wrong by owner. Previous match ${product?.name ? `"${product.name}"` : ""} removed - re-identify the product.`)
          : null;
        if (reviewId) {
          emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "needs_review_reopened", metadata: { code, fromProduct: productId } });
          // 5. Correction recheck through the decode pipeline (cost-guarded; never auto-saves or counts).
          await get().correctionRecheck(reviewId, { reason: opts?.reason });
        }
        // 6. Catalog revocation round (design §2.3): report the wrong identity to the shared master
        // catalog so other shops stop replaying it. Best-effort and NON-BLOCKING - mirrors how
        // correctionRecheck above is a trailing side-effect, not a dependency: markWrong's local
        // correction (count transfer, alias deactivation) already succeeded regardless of whether
        // this call lands, times out, the user has no session, or the server is unreachable. Never
        // awaited into the return path; every failure mode is swallowed here on purpose (matches the
        // project's "never block scanning/correction on the backend" rule for the sync queue).
        if (code) {
          void (async () => {
            try {
              const user = await getSession();
              if (!user) return;
              const idToken = await user.getIdToken();
              await fetch("/api/catalog-dispute", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  idToken,
                  normalizedBarcode: code,
                  businessId: state.businessId,
                  reason: opts?.reason ?? "marked_wrong",
                }),
              });
            } catch {
              // best-effort; local correction already succeeded regardless of this call
            }
          })();
        }
        return reviewId;
      },

  };
}
