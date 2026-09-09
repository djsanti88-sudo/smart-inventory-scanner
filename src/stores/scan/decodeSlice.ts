import type {
  AiLookupLog,
  AiLookupResult,
  DecodeDecision,
  PendingSyncItem,
  Product,
  ScanEvent,
  UnknownCodeReview,
} from "@/types";
import { cleanScanCode } from "@/scanning/clean/scanCleaner";
import { detectCodeType } from "@/products/match/codeTypeDetector";
import { isLikelyMisreadGtin } from "@/products/barcodes/misread";
import { clampDecodeBudgetMs } from "@/decoding/decodeBudget";
import { fetchWithBackoff } from "@/shared/net/fetchWithBackoff";
import { resolveScanToProductTiered } from "@/products/match/aliasMatcher";
import { incrementInventoryCount } from "@/inventory/ledger";
import { buildIdempotencyKey } from "@/inventory/idempotency";
import { versionReviewDecision } from "@/review/reviewDecisionVersion";
import { getSession } from "@/authentication/auth";
import { postTelemetry } from "@/shared/telemetry/telemetry";
import {
  evaluateAiGate,
  recordFailure,
  recordSuccess,
  type AiGateReason,
  type BreakerState,
} from "@/decoding/limits/circuitBreaker";
import { sanitizeForAiLookup } from "@/shared/privacy/sanitizer";
import { sanitizeCustomerReason, MISS_REASON_TEXT } from "@/decoding/decodeFallback";
import { isUsableProductName, cleanProductName } from "@/decoding/decode";
import { getIdentityConfidenceBand } from "@/decoding/identityConfidenceBand";
import type { CatalogEntry, CatalogHit } from "@/products/catalog/catalogTypes";
import { applyAiCandidate } from "@/products/catalog/localCatalogProvider";
import { planAutoVerify } from "@/products/catalog/catalogAutoVerify";
import { shopReverseUpcConflict, type UpcRecord } from "@/products/catalog/candidateUpcSet";
import { isTireContext, hasRequiredTireSpecs } from "@/decoding/tireSpecs";
import { extractTireFields } from "@/products/tires/extractTireFields";
import { lookupTirePrefix } from "@/products/tires/tirePrefixLookup";
import { deriveBrandPrefixHints, decodeBarcodeStructure } from "@/decoding/barcodeAnatomy";
import { prefixFloorName, type PrefixFloorResult } from "@/products/catalog/prefixFloor";
import { fetchPrefixFloorEnrichment, isBareUnidentifiedLabel, brandIsOnlyFloorGuess, isFloorGuessOnlyLabel } from "@/products/catalog/prefixFloorEnrich";
import { detectScanContextConflict, detectOffCategoryAdvisory, detectIdentityContextConflict, conflictReason } from "@/decoding/scanContextFirewall";
import { findIdentityMerge } from "@/products/catalog/identityMerge";
import { enrichProductIdentity } from "@/products/catalog/enrichProductIdentity";
import { toMasterCandidates } from "@/products/catalog/masterCandidates";
import { canAutoCount } from "@/stores/scanGates";
import { buildAliasesForCodes, buildOrphanTransferSyncOps } from "@/stores/scan/aliasBuilders";
import { enrichInFlight, provisionalPlaceholderName } from "@/stores/scan/placeholders";
import { enqueueDecode } from "@/stores/scan/decodePacer";
import {
  applyGodGateOverride,
  autoSuggestApplyOk,
  carriedProvisionalBarcode,
  evaluateAutoDecode,
  honestReasonForBadge,
  isPlatformOwnerForGateBypass,
  scrubSuggestedBarcode,
  tireAutoCountOk,
  trustedExactCanonicalId,
} from "@/stores/scan/decodeGates";
import { makeQueueItem } from "@/stores/scan/queueItem";
import { transferOrphanCount, DailyCapReachedError, DecodeAbortedError } from "@/stores/scanStore";
import type { ScanState, ScanStoreDeps } from "@/stores/scanStore";

export function createDecodeSlice(ctx: {
  set: (partial: Partial<ScanState> | ((s: ScanState) => Partial<ScanState>)) => void;
  get: () => ScanState;
  deps: ScanStoreDeps;
  idFactory: () => string;
  now: () => string;
  emitAudit: (e: { entityType: string; entityId: string; action: string; metadata?: Record<string, unknown> }) => void;
  enqueueAndSync: (items: PendingSyncItem[]) => void;
  buildReviewDecisionWrite: (review: UnknownCodeReview, decisionAt: string) => { review: UnknownCodeReview; item: PendingSyncItem };
  persistReviewDecision: (reviewId: string, decisionAt?: string, allowOpen?: boolean) => void;
  cloudBackend: boolean;
  trustedExactProbes: Map<string, UnknownCodeReview>;
  trustedExactProbeIdsByCode: Map<string, string>;
  trustedExactProbeReviewIds: Set<string>;
  trustedExactConfigGapReviewIds: Set<string>;
  getTrustedExactProbeGeneration: () => number;
}): Pick<ScanState,
  "setAiStatus" | "setEmergencyStop" | "refreshAiStatus" | "cloudCatalogResolve" |
  "liveDecode" | "runLiveDecodeOnce" | "enrichPrefixFloorLabel" | "markFeedRowVerified" |
  "applyDecodeFallback" | "backgroundVerifyDeep" | "correctionRecheck"
> {
  const {
    set, get, deps, idFactory, now, emitAudit, enqueueAndSync, buildReviewDecisionWrite, persistReviewDecision, cloudBackend,
    trustedExactProbes, trustedExactProbeIdsByCode, trustedExactProbeReviewIds, trustedExactConfigGapReviewIds,
    getTrustedExactProbeGeneration,
  } = ctx;

    // Live decode is tenant-scoped. Mock/E2E mode remains token-free.
    const aiRequestAuth = async (businessId: string): Promise<{ idToken?: string; businessId?: string }> => {
      if (!cloudBackend) return {};
      const user = await getSession();
      if (!user || typeof user.getIdToken !== "function") return {};
      return { idToken: await user.getIdToken(), businessId };
    };

    // The provisional product and scan event are written immediately so counting survives a slow decode.
    // Once a decode enriches either record, persist that newer state too or a refresh would restore the
    // placeholder rather than the identity the scanner just displayed.
    const syncDecodedState = (reviewId: string) => {
      if (!cloudBackend) return;
      const state = get();
      let review = state.needsReviewQueue.find((item) => item.id === reviewId);
      if (!review || !state.businessContextReady || !state.sessionId) return;
      // CLASS FIX (Codex final verdict finding 2, 2026-08-04): a repeat scan of the SAME unknown code
      // while its first scan's decode is still in flight reuses the still-open review (scanStore.ts:
      // 2902-2912) and mints its own SIBLING ScanEvent that shares this review's (sessionId, cleanCode).
      // The local settle further below (the scanFeed.map matching e.cleanCode === review.cleanCode)
      // updates EVERY such row, so persistence must sync ALL of them, not just the first `.find()` hit -
      // otherwise a sibling's decoded status never reaches the backend, and a reload/rehydrate (e.g. the
      // session timeline reading fresh ScanEvents via getScanEventsBySession) resurrects its stale
      // "decoding" badge even though the local count was always correct.
      const reviewSessionId = review.sessionId;
      const reviewCleanCode = review.cleanCode;
      const events = state.scanFeed.filter(
        (item) => item.sessionId === reviewSessionId && item.cleanCode === reviewCleanCode,
      );
      const items: PendingSyncItem[] = [];
      if (review.status === "resolved" || review.status === "ignored") {
        const write = buildReviewDecisionWrite(review, review.decisionUpdatedAt ?? review.resolvedAt ?? now());
        review = write.review;
        set((current) => ({
          needsReviewQueue: current.needsReviewQueue.map((item) => item.id === reviewId ? write.review : item),
        }));
        if (!state.pendingSyncQueue.some((item) => item.idempotencyKey === write.item.idempotencyKey)) {
          items.push(write.item);
        }
      }
      const syncedProductIds = new Set<string>();
      for (const event of events) {
        const product = state.products.find((item) => item.id === event.matchedProductId);
        if (!product) continue;
        // One product save per distinct matched product (normally all sibling events share the same
        // provisional/decoded product) - never one duplicate SAVE_PRODUCT per sibling event.
        if (!syncedProductIds.has(product.id)) {
          syncedProductIds.add(product.id);
          const productVersion = JSON.stringify([product.name, product.brand, product.primaryBarcode]);
          items.push(
            makeQueueItem({
              idFactory, now, businessId: state.businessId, sessionId: event.sessionId,
              entityType: "Product", entityId: product.id, operation: "SAVE_PRODUCT", payload: product,
              idempotencyKey: buildIdempotencyKey(state.businessId, event.sessionId, `${product.id}:decode:${productVersion}`, "SAVE_PRODUCT"), scanEventId: null,
              syncLane: "independent_product",
            }),
          );
        }
        const version = JSON.stringify([event.status, event.decodeStatus, event.reason, product.name, product.brand, product.primaryBarcode]);
        items.push(
          makeQueueItem({
            idFactory, now, businessId: state.businessId, sessionId: event.sessionId,
            entityType: "ScanEvent", entityId: event.id, operation: "SAVE_SCAN_EVENT", payload: event,
            idempotencyKey: buildIdempotencyKey(state.businessId, event.sessionId, `${event.id}:decode:${version}`, "SAVE_SCAN_EVENT"), scanEventId: event.id,
          }),
        );
      }
      if (items.length === 0) return;
      enqueueAndSync(items);
    };

    /**
     * Commit the authenticated trusted-exact result as one local state transition. This path deliberately
     * does not create aliases or write the shared catalog: the opaque server identity is only a coalescing
     * key for exact corpus rows, while every physical scan remains represented by its original event.
     */
    const settleTrustedExactIdentity = (
      reviewId: string,
      canonicalId: string,
      result: Partial<AiLookupResult>,
      reason: string,
    ): boolean => {
      const state = get();
      const review = state.needsReviewQueue.find((item) => item.id === reviewId) ?? trustedExactProbes.get(reviewId);
      if (!review || (review.status !== "open" && review.status !== "suggested")) return false;
      if (review.businessId !== state.businessId || review.sessionId !== state.sessionId) {
        trustedExactProbes.delete(reviewId);
        trustedExactProbeIdsByCode.delete(review.cleanCode);
        trustedExactProbeReviewIds.delete(reviewId);
        return false;
      }
      const transientProbe = trustedExactProbes.has(reviewId);

      const matchingEvent = state.scanFeed.find(
        (event) => event.sessionId === review.sessionId && event.cleanCode === review.cleanCode,
      );
      const provisionalId = review.provisionalProductId ?? matchingEvent?.matchedProductId ?? null;
      if (!provisionalId) return false;
      const provisional = state.products.find((product) => product.id === provisionalId);
      if (!provisional) return false;

      const existingCanonical = state.products.find(
        (product) => product.status !== "archived" && product.trustedExactCanonicalId === canonicalId,
      );
      const target = existingCanonical ?? provisional;
      const targetId = target.id;
      const settledAt = now();
      const settledProduct: Product = {
        ...target,
        name: result.productName?.trim() || target.name,
        brand: result.brand?.trim() || target.brand,
        category: result.category?.trim() || target.category,
        specsShort: result.specsShort?.trim() || target.specsShort,
        specsFull: result.specsFull?.trim() || target.specsFull,
        primarySku: result.primarySku?.trim() || target.primarySku,
        primaryBarcode: target.primaryBarcode || result.primaryBarcode?.trim() || review.cleanCode,
        gtin: result.gtin?.trim() || target.gtin,
        upc: result.upc?.trim() || target.upc,
        ean: result.ean?.trim() || target.ean,
        aliases: target.aliases ?? [],
        source: "catalog",
        confidence: 1,
        verified: true,
        provisional: false,
        provenanceTier: "corpus_verified",
        trustedExactCanonicalId: canonicalId,
        updatedAt: settledAt,
        updatedBy: "system:trusted_exact",
      };
      const archivedProvisional: Product | null = provisionalId !== targetId
        ? { ...provisional, status: "archived", updatedAt: settledAt, updatedBy: "system:trusted_exact" }
        : null;

      const isOwnEvent = (event: ScanEvent) =>
        event.sessionId === review.sessionId
        && (event.cleanCode === review.cleanCode || event.matchedProductId === provisionalId);
      const settledEvents = state.scanFeed.map((event): ScanEvent =>
        isOwnEvent(event)
          ? {
              ...event,
              matchedProductId: targetId,
              matchType: "primary_barcode",
              status: "known",
              resolverStatus: "known",
              reason,
              decodeNote: undefined,
              decodeStatus: "verified",
              provenance: "app_verified",
              suggestion: undefined,
              syncStatus: "pending",
            }
          : event,
      );
      const settledReview = versionReviewDecision({
        ...review,
        suggestedProductName: settledProduct.name,
        suggestedBrand: settledProduct.brand,
        suggestedCategory: settledProduct.category,
        suggestedSpecsShort: settledProduct.specsShort,
        suggestedSpecsFull: settledProduct.specsFull,
        suggestedPrimarySku: settledProduct.primarySku,
        suggestedPrimaryBarcode: settledProduct.primaryBarcode,
        suggestedGtin: settledProduct.gtin,
        suggestedUpc: settledProduct.upc,
        suggestedEan: settledProduct.ean,
        suggestedAliases: [],
        sourceUrls: [],
        verifiedFacts: [],
        guesses: [],
        reason,
        decodeNote: undefined,
        providerName: "trusted-exact-corpus",
        confidence: 1,
        hasSuggestion: false,
        decodeStatus: "verified",
        evidenceStrength: "fetched_source",
        exactCodeEvidenceVerifiedByApp: true,
        crossCheckDecision: "single_provider",
        suggestedLinkProductId: undefined,
        status: "resolved",
        resolvedAt: settledAt,
        resolvedBy: "system:trusted_exact",
        resolutionAction: "trusted_exact",
        syncStatus: "pending",
        idempotencyKey: review.idempotencyKey,
      }, settledAt);

      let finalCounts = state.finalCounts;
      const transferOps = provisionalId !== targetId
        ? buildOrphanTransferSyncOps({
            finalCountsBeforeTransfer: state.finalCounts,
            scanFeedBeforeTransfer: state.scanFeed.filter(isOwnEvent),
            oid: provisionalId,
            targetId,
            businessId: state.businessId,
            idFactory,
            now,
          })
        : [];
      if (provisionalId !== targetId) {
        finalCounts = transferOrphanCount(finalCounts, provisionalId, targetId, settledAt);
      }

      set((current) => ({
        products: current.products.map((product) => {
          if (product.id === targetId) return settledProduct;
          if (archivedProvisional && product.id === archivedProvisional.id) return archivedProvisional;
          return product;
        }),
        finalCounts,
        scanFeed: settledEvents,
        needsReviewQueue: transientProbe
          ? current.needsReviewQueue
          : current.needsReviewQueue.map((item) => item.id === reviewId ? settledReview : item),
      }));
      if (transientProbe) {
        trustedExactProbes.delete(reviewId);
        trustedExactProbeIdsByCode.delete(review.cleanCode);
      }

      const version = `${review.id}:${canonicalId}`;
      const settledEventOps = settledEvents
        .filter(isOwnEvent)
        .map((event) => {
          const key = buildIdempotencyKey(state.businessId, event.sessionId, `${event.id}:trusted-exact:${canonicalId}`, "SAVE_SCAN_EVENT");
          return makeQueueItem({
            idFactory, now, businessId: state.businessId, sessionId: event.sessionId,
            entityType: "ScanEvent", entityId: event.id, operation: "SAVE_SCAN_EVENT", payload: event,
            idempotencyKey: key, scanEventId: event.id,
          });
        });
      const productKey = buildIdempotencyKey(state.businessId, review.sessionId, `${targetId}:trusted-exact:${version}`, "SAVE_PRODUCT");
      const persistOps: PendingSyncItem[] = [
        ...transferOps,
        makeQueueItem({
          idFactory, now, businessId: state.businessId, sessionId: review.sessionId,
          entityType: "Product", entityId: targetId, operation: "SAVE_PRODUCT", payload: settledProduct,
          idempotencyKey: productKey, scanEventId: null,
        }),
      ];
      if (archivedProvisional) {
        const archiveKey = buildIdempotencyKey(state.businessId, review.sessionId, `${archivedProvisional.id}:trusted-exact-archive:${canonicalId}`, "SAVE_PRODUCT");
        persistOps.push(makeQueueItem({
          idFactory, now, businessId: state.businessId, sessionId: review.sessionId,
          entityType: "Product", entityId: archivedProvisional.id, operation: "SAVE_PRODUCT", payload: archivedProvisional,
          idempotencyKey: archiveKey, scanEventId: null,
        }));
      }
      if (!transientProbe) {
        persistOps.push(makeQueueItem({
          idFactory, now, businessId: state.businessId, sessionId: review.sessionId,
          entityType: "UnknownCodeReview", entityId: review.id, operation: "SAVE_UNKNOWN_SCAN", payload: settledReview,
          idempotencyKey: settledReview.idempotencyKey, scanEventId: matchingEvent?.id ?? null,
        }));
      }
      persistOps.push(...settledEventOps);
      enqueueAndSync(persistOps);
      return true;
    };

    const materializeTrustedExactMiss = (reviewId: string, reason: string): UnknownCodeReview | null => {
      const probe = trustedExactProbes.get(reviewId);
      if (!probe) return get().needsReviewQueue.find((item) => item.id === reviewId) ?? null;
      const review: UnknownCodeReview = {
        ...probe,
        reason,
        decodeNote: undefined,
        decodeStatus: "needs_review",
      };
      trustedExactProbes.delete(reviewId);
      trustedExactProbeIdsByCode.delete(review.cleanCode);
      set((state) => ({
        needsReviewQueue: state.needsReviewQueue.some((item) => item.id === review.id)
          ? state.needsReviewQueue
          : [...state.needsReviewQueue, review],
        scanFeed: state.scanFeed.map((event) =>
          event.sessionId === review.sessionId && event.cleanCode === review.cleanCode && event.decodeStatus === "decoding"
            ? { ...event, decodeStatus: "needs_review" as const, reason, decodeNote: undefined }
            : event,
        ),
      }));
      enqueueAndSync([makeQueueItem({
        idFactory, now, businessId: review.businessId, sessionId: review.sessionId,
        entityType: "UnknownCodeReview", entityId: review.id, operation: "SAVE_UNKNOWN_SCAN", payload: review,
        idempotencyKey: review.idempotencyKey, scanEventId: null,
      })]);
      emitAudit({ entityType: "UnknownCodeReview", entityId: review.id, action: "unknown_review_created", metadata: { code: review.cleanCode } });
      return review;
    };

  return {
      setAiStatus: (partial) => set((s) => ({ aiStatus: { ...s.aiStatus, ...partial } })),

      setEmergencyStop: (on) => set((s) => ({ aiStatus: { ...s.aiStatus, emergencyStop: on } })),

      refreshAiStatus: async () => {
        // Ask the server which keys/flags are configured (no secrets are returned).
        try {
          const res = await fetch("/api/ai-lookup", { method: "GET" });
          if (!res.ok) {
            // Silent-failure fix: a failed refresh must never be indistinguishable from a confirmed
            // "kill switch off" - mark the status unknown/stale rather than leaving a false "off".
            set((s) => ({ aiStatus: { ...s.aiStatus, killSwitchStatusUnknown: true } }));
            return;
          }
          const d = await res.json();
          set((s) => {
            const keyConfigured = Boolean(d.openaiConfigured);
            return {
              aiStatus: {
                ...s.aiStatus,
                liveEnabled: Boolean(d.liveEnabled),
                autoDecodeOnScan: Boolean(d.autoDecodeOnScan),
                openaiConfigured: Boolean(d.openaiConfigured),
                dailyLimit: typeof d.dailyLimit === "number" ? d.dailyLimit : s.aiStatus.dailyLimit,
                missingKeys: Array.isArray(d.missingKeys) ? d.missingKeys : s.aiStatus.missingKeys,
                // The server reports the real free-first decode order.
                decodePath: Array.isArray(d.decodePath) ? d.decodePath : s.aiStatus.decodePath,
                // Spec 2 (M1): server-authoritative, same as every other flag in this block - a stale
                // client value must never mask a live server kill switch, and an omitted field (older/
                // mocked GET response) correctly defaults to false (not on).
                killSwitchOn: Boolean(d.killSwitchOn),
                // A successful refresh always confirms fresh truth - clear any prior unknown/stale flag.
                killSwitchStatusUnknown: false,
                gptDecode:
                  d.gptDecode && typeof d.gptDecode === "object"
                    ? {
                        spentTodayUsd: Number(d.gptDecode.spentTodayUsd) || 0,
                        capUsd: Number(d.gptDecode.capUsd) || 0,
                        callsToday: Number(d.gptDecode.callsToday) || 0,
                        enabled: Boolean(d.gptDecode.enabled),
                      }
                    : s.aiStatus.gptDecode,
              },
              // Live AI config is SERVER-AUTHORITATIVE so a stale persisted client value can't disable lookup
              // or pin an old daily cap. When the server confirms a provider key, force lookup ON (always-on)
              // and adopt the server daily cap (AI_LOOKUP_DAILY_LIMIT).
              settings: {
                ...s.settings,
                aiLookupEnabled: keyConfigured ? true : s.settings.aiLookupEnabled,
                dailyLookupLimit: typeof d.dailyLimit === "number" ? d.dailyLimit : s.settings.dailyLookupLimit,
              },
            };
          });
        } catch {
          // Leave existing status; auto-decode simply won't fire without confirmed keys. But do not
          // leave killSwitchOn silently reading as a confirmed false "off" - a transient network
          // failure must surface as unknown/stale, not as reassurance that the kill switch is off.
          set((s) => ({ aiStatus: { ...s.aiStatus, killSwitchStatusUnknown: true } }));
        }
      },

      cloudCatalogResolve: async (reviewId, codes) => {
        if (!deps.lookupGlobalCatalog) return;
        let entry: CatalogEntry | null = null;
        try {
          entry = await deps.lookupGlobalCatalog(codes);
        } catch {
          // Cloud lookup failure must never break the scanner. Fall through to AI.
        }
        // Re-read review after the async round-trip: the user may have already resolved it.
        const review = get().needsReviewQueue.find((r) => r.id === reviewId);
        if (!review || review.status !== "open") return;

        // Phase 5b Task 4 (AC4/GC1/GC9): before applying a master-catalog hit, check whether the
        // master identity DISAGREES with a tenant product this account already has resolvable for
        // this code. toMasterCandidates only ever emits a non-empty candidate when a tenant
        // candidate existed first (GC1 hard invariant) - see masterCandidates.ts. Agreement or no
        // tenant candidate falls through to existing behavior, byte-identical.
        if (entry && entry.masterId) {
          const cleanedForCandidates = { rawCode: review.rawCode, cleanCode: review.cleanCode, normalizedCandidates: review.normalizedCandidates };
          const master = get();
          const masterCandidates = toMasterCandidates(
            { masterId: entry.masterId, name: entry.name, brand: entry.brand, masterProvenanceTier: entry.masterProvenanceTier },
            master.products,
            master.aliases,
            cleanedForCandidates,
            master.businessId,
          );
          const loneMasterCandidate = masterCandidates.length > 0 && masterCandidates.every((c) => c.productId.startsWith("master:"));
          if (loneMasterCandidate) {
            // HARD INVARIANT (GC1/review F3): toMasterCandidates guarantees this only happens when a
            // tenant candidate already resolved for this code (it never emits a lone "master:"
            // candidate for a code with zero tenant candidates). Dev-assert the invariant holds;
            // never throw in prod (a violated assumption here must never crash a scan).
            if (process.env.NODE_ENV !== "production") {
              const tenantOnlyCheck = resolveScanToProductTiered(cleanedForCandidates, { products: master.products, aliases: master.aliases, masterCandidates: [] }, master.businessId);
              if (!tenantOnlyCheck.productId) {
                throw new Error("toMasterCandidates invariant violated: lone master: candidate with no tenant-origin candidate");
              }
            }
            const tiered = resolveScanToProductTiered(cleanedForCandidates, { products: master.products, aliases: master.aliases, masterCandidates }, master.businessId);
            if (tiered.matchType === "conflict") {
              const conflictReasonText = "Cross-tier conflict: master catalog identity disagrees with this account's product";
              set((st) => ({
                needsReviewQueue: st.needsReviewQueue.map((r) => (r.id === reviewId ? { ...r, reason: conflictReasonText } : r)),
                // Match by cleanCode + not-yet-resolved (same guard shape as markFeedRowVerified above) -
                // the row here is the scan's own provisional placeholder (status "known" against that
                // placeholder, per TOP-LEVEL LAW), never a real approved-alias match: the review is still
                // open, so this code has no trusted resolution yet.
                scanFeed: st.scanFeed.map((e) =>
                  e.cleanCode === review.cleanCode && e.status !== "resolved"
                    ? { ...e, decodeStatus: "needs_review" as const, reason: conflictReasonText }
                    : e,
                ),
              }));
              // Identity-only outcome (GC9/TOP-LEVEL LAW): the row already appeared and counted
              // synchronously before this async resolve ran. Skip the enrichment apply below entirely
              // - never overwrite a disagreeing tenant identity with the master's.
              return;
            }
          }
        }

        const scanContext = get().settings.scanContext ?? "any";
        if (entry && entry.verificationStatus === "verified") {
          // Build a CatalogHit for the Phase-8C identity-context firewall check.
          const hit: CatalogHit = {
            source: "verified_catalog",
            name: entry.name,
            brand: entry.brand ?? "",
            category: entry.category ?? "",
            size: entry.size ?? "",
            imageUrl: entry.imageUrl ?? "",
            productUrl: entry.sourceUrls?.[0] ?? "",
            confidence: entry.confidence ?? 0.9,
            verified: true,
          };
          const hasConflict = detectIdentityContextConflict(scanContext, hit);
          if (!hasConflict) {
            // Cache into in-memory catalog so repeat scans are instant (no second cloud round-trip).
            set((s) => ({ catalog: [...s.catalog, entry!] }));
            get().recordFeedback("found_from_catalog", { code: review.cleanCode });
            get().resolveUnknown(reviewId, "create_new", {
              applyToCount: true,
              origin: "catalog",
              newProduct: {
                name: entry.name,
                brand: entry.brand,
                category: entry.category,
                imageUrl: entry.imageUrl,
                productUrl: entry.sourceUrls?.[0],
                primaryBarcode: review.cleanCode,
                source: "catalog",
              },
            });
            // BUG FIX (verified-shows-Unidentified): only stamp the feed badge "Verified match" when
            // resolveUnknown ACTUALLY resolved this review. resolveUnknown can silently no-op and leave
            // the review "open" - a fuzzy identity-merge suggest_link (two different products sharing a
            // name/brand), or a dedup conflict (matchedIds.size > 1) - in which case the row's REAL
            // product/name never changed (still the provisional placeholder) and forcing the badge to
            // "verified" here would lie about the row's status (the exact owner-reported bug: "Verified
            // match" + "Unidentified item" on the same row). Only mark verified once the review is
            // actually "resolved".
            if (get().needsReviewQueue.find((r) => r.id === reviewId)?.status === "resolved") {
              get().markFeedRowVerified(review.cleanCode, "Matched from global catalog - no AI used.");
            }
            return;
          }
          // Firewall conflict: fall through to AI below (same as a miss).
        }
        // Cloud miss, pending/unverified, or firewall conflict -> fall back to AI if the gate allows.
        const state = get();
        const s = state.settings;
        const nowMs = Date.now();
        const today = now().slice(0, 10);
        const dailyCount = s.lastResetDate === today ? s.dailyLookupCount : 0;
        const autoGate = evaluateAutoDecode({
          aiEnabled: s.aiLookupEnabled,
          status: state.aiStatus,
          online: state.online,
          dailyCount,
          dailyLimit: s.dailyLookupLimit,
          breaker: state.breaker,
          now: nowMs,
          platformOwner: isPlatformOwnerForGateBypass(state.userId),
        });
        // A3 (owner-ratified 2026-07-15): same misread gate as processScan's direct dispatch - a
        // bad-check-digit code cannot decode via any GTIN rung even after a cloud-catalog miss.
        if (autoGate.allowed && !isLikelyMisreadGtin(review.cleanCode)) void get().liveDecode(reviewId);
      },

      // Thin wrapper: enqueue the real work on the bounded decode queue (module-level, MAX_CONCURRENT_DECODES
      // = 2) so a burst of unknown scans never fires unlimited concurrent /api/ai-lookup calls. Resolves once
      // the queued task actually runs and completes. Counting/persistence never waits on this - see the
      // queue doc comment above `decodeCorroborated`.
      liveDecode: (reviewId, options) => enqueueDecode(
        reviewId,
        () => get().runLiveDecodeOnce(reviewId, options),
        options?.deterministicOnly === true,
      ),

      runLiveDecodeOnce: async (reviewId, options) => {
        const state = get();
        const deterministicOnly = options?.deterministicOnly === true;
        const invalidationGeneration = options?.invalidationGeneration;
        const wasInvalidated = () =>
          invalidationGeneration !== undefined && invalidationGeneration !== getTrustedExactProbeGeneration();
        if (wasInvalidated()) return;
        const review = state.needsReviewQueue.find((r) => r.id === reviewId)
          ?? (deterministicOnly ? trustedExactProbes.get(reviewId) : undefined);
        if (!review || review.status !== "open") return;

        const s = state.settings;
        const nowIso = now();
        const today = nowIso.slice(0, 10);
        const nowMs = new Date(nowIso).getTime();
        const dailyCount = s.lastResetDate === today ? s.dailyLookupCount : 0;

        const mkLog = (
          status: AiLookupLog["status"],
          providerName: string,
          confidence: number,
          breakerState: BreakerState,
        ): AiLookupLog => ({
          id: idFactory(),
          businessId: state.businessId,
          rawCode: review.rawCode,
          cleanCode: review.cleanCode,
          providerName,
          status,
          confidence,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          estimatedCost: 0,
          cacheHit: false,
          circuitBreakerState: breakerState.state,
          createdAt: nowIso,
        });

        // GOD CLIENT (owner-approved 2026-08-07): this is the SAME cap/breaker re-check evaluateAutoDecode
        // already bypassed at enqueue time (see its doc comment), run again here as defense-in-depth
        // before the actual fetch fires (state can drift between enqueue and dequeue). Without also
        // bypassing it here, the owner's decode would still be silently dropped to Needs Review with a
        // "Daily AI lookup cap reached"/"circuit breaker" reason even though evaluateAutoDecode allowed
        // it - defeating the whole point of the client bypass. See `applyGodGateOverride` for exactly
        // what is/isn't bypassed.
        const gate = applyGodGateOverride(
          evaluateAiGate({
            enabled: s.aiLookupEnabled,
            online: state.online,
            dailyCount,
            dailyLimit: s.dailyLookupLimit,
            breaker: state.breaker,
            now: nowMs,
          }),
          isPlatformOwnerForGateBypass(state.userId),
        );
        if (!gate.allowed && (!deterministicOnly || !state.online)) {
          // Fix-wave 2026-08-04: distinguish WHY this gate blocked instead of collapsing "disabled"
          // and "circuit_open" into the same "blocked_cap" label as a real daily-cap block - an
          // engineer reading aiLookupLogs needs to tell "the owner turned AI off" apart from "the
          // circuit breaker tripped" apart from "the daily spend cap is spent".
          const blockStatusByReason: Record<AiGateReason, AiLookupLog["status"]> = {
            ok: "success",
            disabled: "blocked_disabled",
            offline: "blocked_offline",
            daily_cap: "blocked_cap",
            circuit_open: "blocked_circuit",
          };
          const blockStatus: AiLookupLog["status"] = blockStatusByReason[gate.reason];
          // OWNER RULE follow-up (2026-08-05): a non-deterministic call blocked at THIS gate (e.g. the
          // trusted-exact continuation handing off into the ordinary decode path while the daily cap is
          // genuinely spent) must resolve the row honestly instead of leaving it stuck at decodeStatus
          // "decoding" forever - this gate returns before any fetch, so nothing downstream ever touches
          // the row again otherwise. A deterministic probe never flips decodeStatus to "decoding" in the
          // first place, so it stays exempt here (its own caller already routes the honest miss reason).
          // The scanFeed row may already be "needs_review" rather than "decoding" at this point (the
          // continuation's own flip-to-decoding write above is guarded to never touch an unrelated
          // already-resolved row for a repeat scan of the same code - see that guard's comment), so this
          // matches the same decoding/needs_review/suggested set as the decode-settle write below
          // (~line 3900) rather than "decoding" alone, or the honest cap reason would silently lose to a
          // stale pre-block reason already sitting on the row.
          const gateReasonText: Record<AiGateReason, string> = {
            ok: "",
            disabled: "AI lookup is off. Turn it on in Settings to auto-decode.",
            offline: "Offline. Saved locally; AI was not called.",
            daily_cap: "Daily AI lookup cap reached. Routed to Needs Review.",
            circuit_open: "AI circuit breaker is open after repeated failures. Routed to Needs Review.",
          };
          const blockedReason = gateReasonText[gate.reason];
          set((st) => ({
            aiLookupLogs: [mkLog(blockStatus, "decode", 0, gate.breaker), ...st.aiLookupLogs],
            breaker: gate.breaker,
            settings: { ...st.settings, dailyLookupCount: dailyCount, lastResetDate: today },
            needsReviewQueue: deterministicOnly
              ? st.needsReviewQueue
              : st.needsReviewQueue.map((item) =>
                  item.id === reviewId
                    ? { ...item, decodeStatus: "needs_review" as const, reason: blockedReason, decodeNote: undefined }
                    : item,
                ),
            scanFeed: deterministicOnly
              ? st.scanFeed
              : st.scanFeed.map((event) =>
                  event.sessionId === review.sessionId
                    && event.cleanCode === review.cleanCode
                    && (event.decodeStatus === "decoding" || event.decodeStatus === "needs_review" || event.decodeStatus === "suggested")
                    ? { ...event, decodeStatus: "needs_review" as const, reason: blockedReason, decodeNote: undefined }
                    : event,
                ),
          }));
          return;
        }

        // Fix-wave 2026-08-04 (BLOCKER): mirror route.ts's bareNumericCode carve-out here, client-side.
        // The phone sanitizer masks bare 10-digit runs (sanitizer.ts's PHONE pattern), so a scanned
        // UPC/EAN-shaped bare code was being sent to the server as the literal string
        // "[redacted-phone]" instead of real digits. The server has its own carve-out (route.ts's
        // bareNumericCode), but it only recovers real digits from body.cleanCode/body.rawCode - once
        // the client had already masked them, the server never saw anything to recover. A bare
        // separator-free 8-14 digit run is a lookup code, not free text; everything else (formatted
        // phone numbers, letters, extra words) still gets sanitized exactly as before. The
        // deterministicOnly branch already sends the untouched review.rawCode/review.cleanCode (the
        // trusted-exact corpus probe never reaches a third-party AI provider - see route.ts's
        // deterministicOnly early return before any provider code), so it is unaffected here.
        const exactCodeForBareCheck = cleanScanCode(review.cleanCode || review.rawCode || "").cleanCode;
        const bareNumericCode = /^\d{8,14}$/.test(exactCodeForBareCheck) ? exactCodeForBareCheck : null;
        const rawCodeSanitized = deterministicOnly
          ? review.rawCode
          : (bareNumericCode ?? sanitizeForAiLookup(review.rawCode).clean);
        const cleanCodeSanitized = deterministicOnly
          ? review.cleanCode
          : (bareNumericCode ?? sanitizeForAiLookup(review.cleanCode).clean);
        const codeType = detectCodeType(review.cleanCode);
        // Phase 8B: app-derived prompt hints (advisory only - the Phase 8 firewall stays the hard gate).
        const scanContext = s.scanContext ?? "any";
        const candidatePrefix = decodeBarcodeStructure(review.cleanCode, codeType).candidateCompanyPrefix;
        const learnedHint = candidatePrefix
          ? deriveBrandPrefixHints(get().products, get().aliases).find((h) => h.prefix === candidatePrefix)
          : undefined;
        // Non-authoritative brand-FAMILY suggestion from the validated prefix hint table (corporate
        // siblings that share a GS1 company prefix). The learned (human-approved) hint is listed FIRST -
        // it is the trusted/promoted layer; the family is only a suggestion and never overrides the firewall.
        const familyMatch = lookupTirePrefix(review.cleanCode);
        const familyHint = familyMatch
          ? `GS1 prefix ${familyMatch.prefix} is associated (non-authoritative hint) with the tire brand family: ${familyMatch.brands.map((b) => b.brand).slice(0, 8).join(", ")}`
          : undefined;
        const brandPrefixHint =
          [
            learnedHint
              ? `candidate prefix ${learnedHint.prefix} has previously been human-approved for brand "${learnedHint.brand}" in this business`
              : undefined,
            familyHint,
          ]
            .filter(Boolean)
            .join(". ") || undefined;

        try {
          // AM-1(a) (owner-reported 36-70s browser blocks): the decode fetch had no client-side
          // timeout at all - a slow/hung server response could block the scan row (and the browser
          // connection) indefinitely. Timeout margin gives the server-side decode deadline
          // (DECODE_LADDER_TOTAL_MS, see pipeline.ts) room to finish and reply honestly before the
          // client gives up; the abort is a client-local giveup only - the server keeps computing and
          // caches its answer for the next scan, so nothing is lost.
          // AM-9: clamp a possibly-stale persisted decodeBudgetMs (e.g. an old 13000 default) into the
          // real [5000, 8000] server-enforced range before using it for anything client-side.
          const clampedBudgetMs = clampDecodeBudgetMs(s.decodeBudgetMs);
          const abortController = new AbortController();
          const abortTimer = setTimeout(() => abortController.abort(), clampedBudgetMs + 7000);
          // D4-follow-up: live-auth mode requires idToken + businessId on every POST
          // (route.ts:294-324) or this 401s "unauthenticated"; mock mode resolves {} and both call
          // legs are unaffected. aiRequestAuth is resolved inline on each leg below.
          const decodeOnce = async () => {
            let res: Response;
            try {
              // P4 (#28): fetchWithBackoff replaces the old inline capped-at-30s/single-retry-no-
              // jitter block. It honors Retry-After IN FULL (up to its own safety ceiling, not the
              // old 30s cap) and applies full jitter on the exponential fallback so a burst of 429s
              // does not retry in a synchronized wave. onRetryDecision reads the (cloned) 429 body to
              // veto a retry outright on daily_cap/account_daily_cap - those never clear by waiting,
              // exactly as before. maxAttempts: 2 preserves the existing single-retry cost/latency
              // budget; the ORIGINAL (unread) response is returned when exhausted/vetoed so the
              // reasonCode handling below is unchanged.
              res = await fetchWithBackoff(
                "/api/ai-lookup",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  signal: abortController.signal,
                  body: JSON.stringify({
                    ...(await aiRequestAuth(state.businessId)),
                    mode: "decode",
                    deterministicOnly,
                    rawCode: rawCodeSanitized,
                    cleanCode: cleanCodeSanitized,
                    codeType,
                    confidenceThreshold: 0.8,
                    allowImageSuggestions: s.allowImageSuggestions,
                    budgetMs: clampedBudgetMs,
                    scanContext,
                    brandPrefixHint,
                    autoCountNonPublicWithEvidence: s.autoCountNonPublicWithEvidence ?? true,
                  }),
                },
                {
                  maxAttempts: 2,
                  onRetryDecision: async (cloned) => {
                    const body = await cloned.json().catch(() => ({}) as { reasonCode?: string });
                    return { retry: body?.reasonCode !== "account_daily_cap" && body?.reasonCode !== "daily_cap" };
                  },
                },
              );
            } catch (fetchErr) {
              // An abort is NEVER a retry case (there is nowhere to retry TO - the decode keeps
              // running server-side and the client just gave up waiting). Every other fetch-level
              // failure (network down, DNS, etc.) falls through to the existing generic catch below.
              if (fetchErr instanceof Error && fetchErr.name === "AbortError") {
                throw new DecodeAbortedError();
              }
              throw fetchErr;
            }
            // 429 has two distinct causes that must NOT be treated the same:
            //  - daily_cap: the server-side daily AI spend cap is reached. There is no automatic
            //    decode-on-cap-reset queue anywhere in the app, so retrying now is pointless (it will
            //    just 429 again) - fail fast with an honest reason instead of burning a wait.
            //  - anything else: a self-inflicted rate limit (costs $0) that fetchWithBackoff already
            //    retried (with full Retry-After honor + jitter) before returning this final response.
            if (res.status === 429) {
              const body = await res.json().catch(() => ({}) as { reasonCode?: string; floor?: PrefixFloorResult });
              // P2: thread the server's $0 prefix floor into the error so the cap-blocked row is named
              // "<Brand> / product unconfirmed" from the GS1 company prefix, not a bare "Unidentified item".
              // F4: the per-account cap (route.ts:311/331) is a distinct 429 the client must ALSO honor -
              // it is not a self-inflicted rate limit, so it must NOT retry. Route it to Needs Review with
              // its own honest account-scoped copy (accountScoped=true drives the message below).
              if (body?.reasonCode === "account_daily_cap") throw new DailyCapReachedError(undefined, body?.floor, true);
              if (body?.reasonCode === "daily_cap") throw new DailyCapReachedError(undefined, body?.floor);
              throw new Error(`decode failed 429 after retries`);
            }
            if (!res.ok) throw new Error(`decode failed ${res.status}`);
            return res.json();
          };
          // Owner cost rule: NO client retry. The old "retry once on a miss" doubled both the wait (up
          // to ~70s, which dropped the browser connection -> "Failed to fetch") and the token spend. One
          // call only; a miss is shown fast with its honest reason and is briefly miss-cached server-side
          // so an immediate re-scan does not re-pay.
          let data: Awaited<ReturnType<typeof decodeOnce>>;
          try {
            data = await decodeOnce();
          } finally {
            clearTimeout(abortTimer);
          }
          // A clear-session/cache/sign-out/tenant-switch action is authoritative. The network request
          // may still complete, but a response from the previous generation must become a pure no-op
          // before any product, review, count, audit, or sync mutation can run.
          if (wasInvalidated()) return;
          // BUG #14 (QA hardening 2026-07-16): CLIENT-SIDE defense in depth. The server already
          // sanitizes reasonText/decision.reason (pipeline.ts) before responding, but this store must
          // not trust that unconditionally - sanitize both here too, ONCE, right at the response
          // boundary, so every downstream read (needsReviewQueue[].reason, scanFeed[].reason, the
          // honestReasonForBadge composition below) is already clean. Honest hand-written prose (no
          // vendor/service/model tokens) passes through unchanged; only a raw/internal string is
          // replaced with an honest fixed fallback - never empty, never the raw value.
          if (data.decision) {
            data = { ...data, decision: { ...data.decision, reason: sanitizeCustomerReason(data.decision.reason ?? "", { status: data.decision.status }) } };
          }
          if (typeof data.reasonText === "string") {
            data = { ...data, reasonText: sanitizeCustomerReason(data.reasonText, { status: data.decision?.status }) };
          }
          const decision = data.decision;
          const results: AiLookupResult[] = data.results ?? [];
          const best = results[0] ?? null;
          // TASK T3 fix (2026-08-06, audit-9 finding B): remember a config-gap probe outcome so the
          // eventual continuation settle (below) can name the real cause instead of the generic
          // all-miss bucket. Only the deterministicOnly probe leg ever sees this reasonCode.
          if (deterministicOnly && data.reasonCode === "trusted_exact_not_available") {
            trustedExactConfigGapReviewIds.add(reviewId);
          }
          const canonicalId = trustedExactCanonicalId(data);
          if (canonicalId && best) {
            settleTrustedExactIdentity(
              reviewId,
              canonicalId,
              best,
              decision?.reason || "Authenticated trusted exact corpus match.",
            );
            return;
          }
          // AUDIT-6 FINDING 5 fix (2026-08-06, call-count only): a deterministic-only probe can ALSO
          // return a genuinely verified, exact-code-evidenced corpus hit that does not qualify for the
          // boss canonical-id settle above (e.g. a "global_corpus" trusted-exact hit, which deliberately
          // omits trustedExactCanonicalProductId - see the server tire knowledge provider's
          // resolveTrustedExactBarcodeDecision). Treating that as a miss and firing the owner-ratified
          // miss-continuation below would just re-fetch and re-verify the SAME identity a second time -
          // the live-observed "~2 POST /api/ai-lookup for one settled corpus scan" defect. Reuse this
          // response instead of discarding it: skip the miss/continuation branch entirely so the review
          // falls through into the ordinary decode-write path below (unchanged, shared with every
          // non-deterministic decode), producing the identical result the second call would have.
          //
          // SECURITY NARROWING: this must NEVER become a laundering path for an incomplete/spoofed
          // BOSS-scope response (the exact self-claim class scanStore.trustedExact.test.ts's "rejects
          // self-claimed or incomplete trusted responses" guards - a response that claims the boss
          // envelope via either corroborationPath or trustedExact.path but fails the strict canonical-id/
          // digest/schema checks above). Only a response that never claims the boss scope in the first
          // place (the plain non-boss "global_corpus" shape) is eligible here; anything claiming boss
          // scope without a valid canonicalId falls through unchanged to the existing miss/continuation
          // handling below, exactly as before this fix.
          const claimsBossScope =
            decision?.corroborationPath === "boss_trusted_exact_barcode"
            || data.trustedExact?.path === "boss_trusted_exact_barcode";
          const alreadySettledByProbe =
            deterministicOnly
            && !canonicalId
            && !claimsBossScope
            && decision?.status === "verified"
            && decision?.exactCodeEvidenceVerifiedByApp === true
            && Boolean(best);
          if (deterministicOnly && !alreadySettledByProbe) {
            const current = get();
            const currentSettings = current.settings;
            const currentNow = new Date(now()).getTime();
            // OWNER RULE (2026-08-05): a trusted-exact miss is never a dead end. The code continues into
            // the ordinary decode path in every environment unless its own gate blocks it.
            // dailyCount is intentionally forced to 0 so paid-decode cap math stays server-side while the
            // free corpus/cache rungs still run. GTIN shape and misread-likelihood never suppress the handoff.
            const continuationGate = evaluateAutoDecode({
              aiEnabled: currentSettings.aiLookupEnabled,
              status: current.aiStatus,
              online: current.online,
              dailyCount: 0,
              dailyLimit: currentSettings.dailyLookupLimit,
              breaker: current.breaker,
              now: currentNow,
              platformOwner: isPlatformOwnerForGateBypass(current.userId),
            });
            if (continuationGate.allowed) {
              const persisted = materializeTrustedExactMiss(reviewId, decision?.reason || "No trusted exact match was found.");
              if (persisted) {
                set((state) => ({
                  needsReviewQueue: state.needsReviewQueue.map((item) =>
                    item.id === persisted.id
                      ? { ...item, decodeStatus: "decoding" as const }
                      : item,
                  ),
                  // Guard by decodeStatus === "decoding" (matches the sibling patterns at
                  // materializeTrustedExactMiss above and the decode-settle write below): sessionId+
                  // cleanCode alone can match a DIFFERENT, already-resolved scanFeed row for a repeat
                  // scan of the same code in this session (e.g. an earlier occurrence already
                  // "verified") - without the guard this would wrongly revert that unrelated row back
                  // to "decoding".
                  scanFeed: state.scanFeed.map((event) =>
                    event.sessionId === persisted.sessionId
                      && event.cleanCode === persisted.cleanCode
                      && event.decodeStatus === "decoding"
                      ? { ...event, decodeStatus: "decoding" as const }
                      : event,
                  ),
                }));
                void get().liveDecode(persisted.id, { invalidationGeneration });
              } else {
                // Hardening: materializeTrustedExactMiss found neither the in-flight probe nor a
                // needsReviewQueue entry for this id (e.g. the session/cache was cleared mid-flight).
                // There is nothing left to continue into decode for - resolve honestly instead of
                // silently doing nothing and leaving a stale row behind.
                const fallbackReason = decision?.reason || "No trusted exact match was found.";
                set((state) => ({
                  needsReviewQueue: state.needsReviewQueue.map((item) =>
                    item.id === reviewId
                      ? { ...item, decodeStatus: "needs_review" as const, reason: fallbackReason, decodeNote: undefined }
                      : item,
                  ),
                  scanFeed: state.scanFeed.map((event) =>
                    event.sessionId === review.sessionId
                      && event.cleanCode === review.cleanCode
                      && event.decodeStatus === "decoding"
                      ? { ...event, decodeStatus: "needs_review" as const, reason: fallbackReason, decodeNote: undefined }
                      : event,
                  ),
                }));
              }
              return;
            }
            const missReasonBase = decision?.reason || "No trusted exact match was found.";
            const missReason = `${missReasonBase} Decode did not continue: ${continuationGate.reason}`;
            if (trustedExactProbes.has(reviewId)) {
              materializeTrustedExactMiss(reviewId, missReason);
              return;
            }
            set((current) => ({
              scanFeed: current.scanFeed.map((event) =>
                event.sessionId === review.sessionId
                  && event.cleanCode === review.cleanCode
                  && event.decodeStatus === "decoding"
                  ? { ...event, decodeStatus: "needs_review" as const, reason: missReason, decodeNote: undefined }
                  : event,
              ),
              needsReviewQueue: current.needsReviewQueue.map((item) =>
                item.id === reviewId
                  ? { ...item, decodeStatus: "needs_review" as const, reason: missReason, decodeNote: undefined }
                  : item,
              ),
            }));
            return;
          }
          if (alreadySettledByProbe) {
            // Move the transient probe into the real needsReviewQueue (same mechanic already proven by
            // materializeTrustedExactMiss) so the shared decode-write code below - which looks the
            // review up by id - has a row to update. Its placeholder reason/decodeStatus are
            // immediately overwritten by the real decision a few lines down; this call is purely the
            // carrier that makes the review addressable, never a second network request.
            const persisted = materializeTrustedExactMiss(reviewId, decision?.reason || "Verified from the trusted corpus.");
            if (!persisted) return; // hardening: nothing left to attach the verified identity to (rare race)
          }
          // TASK T3 fix (2026-08-06, audit-9 finding B): if the trusted-exact probe for THIS review
          // reported reasonCode trusted_exact_not_available (the server allowlist is not configured /
          // does not include this business) and the decode path we then continued into settles on the
          // generic all-miss bucket (MISS_REASON_TEXT.product_not_found), that generic text is
          // dishonest - it is indistinguishable from a code that genuinely does not exist anywhere.
          // Compose the specific, customer-safe, denylist-clean reason instead. A genuine
          // trusted_exact_miss (checked and missed) or any other miss reason (rate limit, cap,
          // timeout, missing keys) is untouched - only this exact collapse is corrected. The set entry
          // is consumed here (delete on read) so a later, unrelated re-decode of the same review id
          // never inherits a stale config-gap marker.
          const wasConfigGapProbe = trustedExactConfigGapReviewIds.has(reviewId);
          if (wasConfigGapProbe) trustedExactConfigGapReviewIds.delete(reviewId);
          const finalDecisionReason =
            wasConfigGapProbe && decision?.reason === MISS_REASON_TEXT.product_not_found
              ? "Trusted exact lookup is not enabled for this business, and no match was found in the databases. Saved to Needs Review."
              : (decision?.reason ?? "");
          // Phase 10: for a tire scan, parse the messy decode into structured columns (size -> specs,
          // brand, part number, clean description). Display/storage only - it does NOT touch the firewall
          // or the tireAutoCountOk (size + model) auto-count gate below (those read the ORIGINAL `best`).
          const tireFields = best && s.scanContext === "tire" && isTireContext(best) ? extractTireFields(best) : null;
          const providerNamesArr = (data.providerNames as string[]) ?? [];
          const providerName = providerNamesArr.join("+") || "mock";
          // P5 Task 5 (honest provenance badges): derive the honest provenance signal for the feed
          // row's badge from the SAME DecodeDecision already in scope here (the primary live-decode
          // write site). App-verified exact-code evidence wins first (it is the strongest, real
          // signal); otherwise a bare self-report is labeled by which provider produced it. Display
          // only - never gates counting/auto-count (that stays in scanGates.ts's canAutoCount).
          const decodeProvenance: ScanEvent["provenance"] = decision?.exactCodeEvidenceVerifiedByApp
            ? "app_verified"
            : decision?.corroborationPath === "gpt_self_report"
              ? "ai_self_report"
              : undefined;
          const decodeProviderSummaries = results.map((r, i) => ({
            provider: providerNamesArr[i] ?? "?",
            productName: r.productName,
            sources: (r.sourceUrls ?? []).length,
          }));

          // Phase 1: shop-catalog reverse-UPC guard (client-safe, our OWN catalog/products, full UPCs).
          // platformOwner heads-up when the proposed product already exists under a DIFFERENT code.
          const shopRecords: UpcRecord[] = [
            ...get().catalog.map((c) => ({ name: c.name, brand: c.brand, barcode: c.barcode, normalizedBarcode: c.normalizedBarcode })),
            ...get().products.map((p) => ({ name: p.name, brand: p.brand, model: p.specsShort, primarySku: p.primarySku, primaryBarcode: p.primaryBarcode, upc: p.upc, ean: p.ean, gtin: p.gtin, aliases: p.aliases })),
          ];
          const shopRev = best
            ? shopReverseUpcConflict({ brand: best.brand, name: best.productName, model: best.primarySku }, review.cleanCode, shopRecords)
            : { conflict: false, knownUpcs: [] as string[] };
          const reverseUpcConflictNote = shopRev.conflict ? `Already in your catalog under: ${shopRev.knownUpcs.slice(0, 3).join(", ")}` : "";

          // Surface why the one paid decode was skipped without leaking the reason into verification.
          const gptSkipEntry = Array.isArray(data.providerStatuses)
            ? (data.providerStatuses as Array<{ provider?: string; status?: string; errorCode?: string }>).find(
                (p) => p?.provider === "gpt-5.4-mini" && p?.status === "skipped",
              )
            : undefined;
          const gptSkipNote = gptSkipEntry?.errorCode ? `gpt-5.4-mini skipped: ${gptSkipEntry.errorCode}` : "";
          const decodeNoteUpdate = gptSkipNote || undefined;

          const suggestedPartNumberForGate = tireFields?.partNumber ?? best?.primarySku;
          const suggestionFields = {
                suggestedProductName: tireFields?.description || (best?.productName ?? ""),
                suggestedBrand: tireFields?.brand ?? best?.brand ?? "",
                suggestedCategory: best?.category ?? "",
                suggestedSpecsShort: tireFields?.size ?? best?.specsShort ?? "",
                suggestedSpecsFull: best?.specsFull ?? "",
                suggestedPrimarySku: tireFields?.partNumber ?? best?.primarySku ?? "",
                suggestedPrimaryBarcode: scrubSuggestedBarcode(best?.primaryBarcode, suggestedPartNumberForGate),
                suggestedGtin: scrubSuggestedBarcode(best?.gtin, suggestedPartNumberForGate),
                suggestedUpc: scrubSuggestedBarcode(best?.upc, suggestedPartNumberForGate),
                suggestedEan: scrubSuggestedBarcode(best?.ean, suggestedPartNumberForGate),
                suggestedImageUrl: s.allowImageSuggestions ? (best?.imageUrl ?? "") : "",
                suggestedProductUrl: best?.productUrl ?? "",
                suggestedAliases: best?.aliases ?? [],
                hasSuggestion: true,
              };

          set((st) => ({
            needsReviewQueue: st.needsReviewQueue.map((r) =>
              r.id === reviewId
                ? {
                    ...r,
                    ...suggestionFields,
                    sourceUrls: best?.sourceUrls ?? [],
                    verifiedFacts: best?.verifiedFacts ?? [],
                    guesses: best?.guesses ?? [],
                    reason: finalDecisionReason,
                    providerName,
                    confidence: decision?.confidence ?? 0,
                    decodeStatus: decision?.status ?? "needs_review",
                    evidenceStrength: decision?.evidenceStrength ?? "none",
                    exactCodeEvidenceVerifiedByApp: Boolean(decision?.exactCodeEvidenceVerifiedByApp),
                    crossCheckDecision: decision?.crossCheck?.decision ?? "",
                    decodeProviderSummaries,
                    prefixHint: (data.debug?.prefixHint as string) || "",
                    prefixConflictReason: (data.debug?.firewallReason as string) || "",
                    reverseUpcConflictNote,
                    decodeNote: decodeNoteUpdate ?? r.decodeNote,
                  }
                : r,
            ),
            // Update the originating scan-feed row(s) from "Decoding..." / provisional "suggested" (the row
            // may already have been counted synchronously by ensureProvisionalCount) to the REAL fast-decode
            // outcome (needs_review / suggested / conflict). Never downgrade a row already flipped to
            // "verified" by the auto-verify pass.
            //
            // BUG FIX (verified-shows-Unidentified, burst report): a provider's raw decision.status
            // "verified" is NEVER written to the feed badge here. "Verified match" must mean the APP's own
            // auto-count gate (below) actually resolved this scan to a real product - a raw "verified"
            // decision can still fail to auto-count (weak/no evidence, context conflict, tireOk false) or
            // resolveUnknown can still no-op (fuzzy identity-merge suggest_link, dedup conflict), in which
            // case the row must keep showing its honest pending state, not a "Verified match" lie over the
            // unresolved "Unidentified item" placeholder. Only `markFeedRowVerified` - now called ONLY
            // after resolveUnknown actually resolves the review - is allowed to write "verified" here.
            scanFeed: st.scanFeed.map((e) => {
              if (
                e.cleanCode !== review.cleanCode ||
                !(e.decodeStatus === "decoding" || e.decodeStatus === "needs_review" || e.decodeStatus === "suggested")
              ) {
                return e;
              }
              const displayedBadge = (decision?.status === "verified"
                ? "suggested"
                : (decision?.status ?? "needs_review")) as ScanEvent["decodeStatus"];
              return {
                ...e,
                decodeStatus: displayedBadge,
                // P5 Task 5: honest provenance signal for the badge (display only). A raw "verified"
                // decision is displayed as "suggested" above (displayedBadge), so app_verified here
                // would be misleading on THIS provisional row - only attach it when the badge is
                // actually settled to "suggested" so DecodeStatusBadge's app_verified branch (which
                // only fires for status "verified") never mismatches this row's shown status.
                provenance: displayedBadge === "suggested" ? decodeProvenance : undefined,
                // BADGE/REASON INVARIANT: never write a "Verified...No AI lookup needed" reason under a
                // non-verified badge (see honestReasonForBadge above - the owner-caught contradiction).
                reason: honestReasonForBadge(finalDecisionReason, decision?.status, displayedBadge) || e.reason,
                // Stale-note fix: decodeNote was set once at scan time to the
                // in-flight "Decoding with AI..." note and never refreshed - platformOwner saw that note
                // forever on every settled row. The decode has now settled, so replace the in-flight note
                // with the honest post-decode transparency note (the skipped-paid note when present),
                // or clear it. Never leave "Decoding with AI..." on a row that is no longer decoding.
                decodeNote: decodeNoteUpdate || undefined,
              };
            }),
            aiLookupLogs: [mkLog("success", providerName, decision?.confidence ?? 0, recordSuccess()), ...st.aiLookupLogs],
            breaker: recordSuccess(),
            aiStatus: { ...st.aiStatus, lastAttemptAt: nowIso, lastProvider: providerName, lastFailureReason: "" },
            settings: { ...st.settings, dailyLookupCount: dailyCount + 1, lastResetDate: today },
          }));

          // CONFIDENCE-BASED AUTO-VERIFY (no extra network calls - scores the evidence the decode
          // already returned). Strong, evidence-backed matches auto-save to the verified catalog and
          // count with NO owner approval. Weak/conflicting/unsafe/AI-only-no-evidence -> Needs Review.
          const cleanName = cleanProductName(best?.productName ?? "");
          const avSettings = {
            autoCatalogLearningEnabled: s.autoCatalogLearningEnabled ?? true,
            autoVerifyConfidenceThreshold: s.autoVerifyConfidenceThreshold ?? 80,
            trustedSourceAutoVerifyEnabled: s.trustedSourceAutoVerifyEnabled ?? true,
            aiOnlyAutoVerifyAllowed: s.aiOnlyAutoVerifyAllowed ?? false,
            allowNonPublicAutoCount: s.autoCountNonPublicWithEvidence ?? true,
          };
          const plan = planAutoVerify({
            code: review.cleanCode,
            codeType,
            decision: {
              status: decision?.status ?? "needs_review",
              evidenceStrength: decision?.evidenceStrength ?? "none",
              exactCodeEvidenceVerifiedByApp: Boolean(decision?.exactCodeEvidenceVerifiedByApp),
              crossCheck: decision?.crossCheck ?? {
                decision: "weak", confidence: 0, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [],
              },
            },
            best,
            catalog: get().catalog,
            settings: avSettings,
          });

          const newProduct = {
            name: tireFields?.description || cleanName,
            brand: tireFields?.brand ?? best?.brand ?? "",
            category: best?.category ?? "",
            specsShort: tireFields?.size ?? best?.specsShort ?? "",
            specsFull: best?.specsFull ?? "",
            primarySku: tireFields?.partNumber ?? best?.primarySku ?? "",
            primaryBarcode: best?.primaryBarcode || review.cleanCode,
            gtin: best?.gtin ?? "",
            upc: best?.upc ?? "",
            ean: best?.ean ?? "",
            imageUrl: s.allowImageSuggestions ? (best?.imageUrl ?? "") : "",
            productUrl: best?.productUrl ?? "",
          };

          const autoAddOn = s.autoAddDecodedProducts ?? true; // master gate: false = manual review for all
          // Phase 7 EVIDENCE GATE: auto-count ONLY on the app's independent exact-code verification +
          // confidence >= 0.8 + (for tires) a countable identity (size + model, matching the route's
          // verify gate). The model's self-reported confidence alone is never enough (that is what
          // auto-counted wrong products). Anything short -> Needs Review.
          const tireOk = tireAutoCountOk(best);
          // Phase 8 FIREWALL: exact-code evidence is necessary but NOT sufficient. If the decoded product
          // contradicts the business scan context (tire) or a learned brand-prefix hint, block auto-count.
          // Task 9 (owner-ratified 2026-07-14, decode-anything): strong APP-VERIFIED exact-code evidence
          // clears the tire category hard-block - a tire shop can really stock hot sauce. Weak/unverified
          // single-source identities (the go-upc-poison / coconut-oil class) still hard-block.
          const exactCodeVerifiedByApp =
            decision?.exactCodeEvidenceVerifiedByApp === true && decision?.status === "verified";
          const firewallParams = {
            scanContext: s.scanContext ?? "any",
            code: review.cleanCode,
            codeType,
            result: best,
            brandPrefixHints: deriveBrandPrefixHints(get().products, get().aliases),
            exactCodeVerifiedByApp,
          };
          const contextConflict = detectScanContextConflict(firewallParams);
          // True exactly when the category conflict was CLEARED by verification -> the row still counts but
          // is tagged "Off-category item" so the operator sees it is not a tire.
          const offCategory = detectOffCategoryAdvisory(firewallParams);
          // PHASE-7 EVIDENCE GATE + GPT decode trust tier + T20/code-1225 public-barcode firewall, now in
          // one pure function (src/stores/scanGates.ts) shared with backgroundVerifyDeep so the two paths
          // cannot drift. tireOk + contextConflict are computed here (they need store services) and passed in.
          const evidenceGatePassed = canAutoCount({
            codeType,
            decision,
            productName: best?.productName ?? "",
            productNameUsable: isUsableProductName(best?.productName ?? ""),
            tireOk,
            contextConflict,
          }).allowed;
          // MULTI-VARIANT GATE (Group C, owner mandate 2026-07-21): a listing naming several
          // distinct speed ratings for one size (e.g. "93V, 93W, 93H") describes MULTIPLE product
          // variants, not one confident identity - it must NEVER auto-apply/auto-count as a clean
          // verified match, regardless of how strong the evidence/confidence otherwise looks.
          const multiVariantIdentity = enrichProductIdentity({ payload: { name: best?.productName ?? "" } }).multiVariant;
          if (autoAddOn && evidenceGatePassed && !multiVariantIdentity && (plan.status === "auto_verify" || plan.status === "auto_count")) {
            // Origin decides the catalog write: exact app-confirmed evidence -> VERIFIED global catalog
            // entry; a trusted-but-non-exact AI product -> still counted + aliased, PENDING catalog
            // entry ("ai"); learning off -> count only, no catalog write ("auto_count").
            // OPTION 3: a NON-public code (vendor/SKU/FNSKU) NEVER writes the global cross-shop catalog
            // ("auto_verify") - those codes are seller-specific. It still counts + makes a SHOP-local approved
            // alias via origin "ai". Only a public UPC/EAN/GTIN keeps the verified global-catalog write.
            const isPublicCode = (["upc_a", "ean_13", "gtin_14"] as string[]).includes(codeType);
            const origin =
              plan.status === "auto_count" ? "auto_count" : (plan.verifiedBy && isPublicCode) ? "auto_verify" : "ai";
            get().recordFeedback(plan.verifiedBy === "trusted_source" ? "trusted_source_match" : "found_from_ai", { code: review.cleanCode });
            if (origin === "auto_verify") {
              get().recordFeedback("auto_verified_catalog_entry", { code: review.cleanCode, meta: { score: plan.score, tier: plan.sourceTier } });
            }
            get().resolveUnknown(reviewId, "create_new", {
              applyToCount: true,
              origin,
              autoVerify:
                origin === "auto_verify"
                  ? {
                      score: plan.score,
                      verifiedBy: plan.verifiedBy ?? "evidence_score",
                      sourceTier: plan.sourceTier,
                      reason: plan.reason,
                      evidenceSummary: plan.evidenceSummary,
                      sourceUrls: best?.sourceUrls ?? [],
                    }
                  : undefined,
              newProduct,
            });
            // TASK 3: the scan was counted synchronously, so its feed row is already "known" (which
            // resolveUnknown's resolved-row remap skips). Flip that row's badge to "verified" so the feed
            // shows the auto-verified decode instead of the stale "suggested" placeholder badge.
            //
            // BUG FIX (verified-shows-Unidentified, burst report): resolveUnknown can silently no-op and
            // leave the review "open" instead of "resolved" - most commonly the identity-merge fuzzy
            // suggest_link path (two different products/codes with a very similar name+brand, e.g. the
            // SAME tire model in different sizes scanned back-to-back) or a dedup conflict
            // (matchedIds.size > 1). In either case the row's product/name is UNCHANGED (still the
            // provisional "Unidentified item" placeholder) and the review is left open for a human
            // decision - forcing the badge to "verified" here would show "Verified match" over an
            // unresolved placeholder name, exactly the owner-reported burst bug. Only mark the row
            // verified when resolveUnknown actually resolved it.
            if (get().needsReviewQueue.find((r) => r.id === reviewId)?.status === "resolved") {
              // P5 Task 5: this branch only runs after the Phase-7 evidence gate (evidenceGatePassed /
              // canAutoCount) passed, i.e. the app itself verified the exact-code evidence - honest
              // "app_verified" provenance for the badge.
              get().markFeedRowVerified(review.cleanCode, decision?.reason ?? "", "app_verified");
            } else {
              // FIX (rung self-poisoning audit, owner-approved): resolveUnknown's create_new branch
              // already stamps "resolved" on every ACTUAL resolution. The only ways a review is still
              // open/suggested here are the two DELIBERATE human-required early-returns: the fuzzy
              // identity-merge suggest_link path (stamps suggestedLinkProductId + returns, keeping the
              // review open on purpose) and the multi-match dedup-conflict path (pushes this reviewId onto
              // lastAliasConflicts + returns, keeping it open on purpose). Force-stamping "resolved" here
              // used to fire in BOTH of those cases - the only cases where the row is still open - hiding
              // a row that MUST stay visible behind a fabricated "auto create_new" audit trail even though
              // nothing was actually created. Only stamp when NEITHER deliberate-hold signal fired for
              // this exact review.
              const stillOpen = get().needsReviewQueue.find((r) => r.id === reviewId);
              const heldForSuggestLink = Boolean(stillOpen?.suggestedLinkProductId);
              const heldForConflict = (get().lastAliasConflicts ?? []).some((c) => c.reviewId === reviewId);
              if (stillOpen && (stillOpen.status === "open" || stillOpen.status === "suggested") && !heldForSuggestLink && !heldForConflict) {
                set((st) => ({
                  needsReviewQueue: st.needsReviewQueue.map((r) =>
                    r.id === reviewId
                      ? { ...r, status: "resolved" as const, resolvedAt: now(), resolvedBy: "auto", resolutionAction: "create_new" as const }
                      : r,
                  ),
                }));
              }
            }
            persistReviewDecision(reviewId);
            // Task 9: an app-verified off-category decode counts, but flag the row so the feed shows the
            // "Off-category item" tag (the product is not a tire, even though it cleared the firewall).
            if (offCategory) {
              set((st) => ({
                scanFeed: st.scanFeed.map((e) =>
                  e.cleanCode === review.cleanCode ? { ...e, offCategory: true } : e,
                ),
              }));
            }
          } else {
            // DECODE-EVERYTHING provisional count: EVERY scan that reached decode gets counted, even if
            // the AI returned a weak/empty product or no product at all. Owner rule: scan 10 = count 10.
            // The provisional product has verified:false, provisional:true, no approved alias, and the
            // review STAYS OPEN for human confirmation. NOTHING blocks provisional counting — not even a
            // brand/context conflict (the prefix firewall is a suggestion, not a blocker for counting).
            {
              const code = review.cleanCode;
              const hasUsableName = isUsableProductName(best?.productName ?? "");
              // PREFIX FLOOR (Plan C Task 3): no usable AI name - before falling back to the bare
              // "Unidentified item" placeholder, check whether the GS1 company prefix maps to a known
              // brand. If so, state the brand with confidence and flag the product unconfirmed instead
              // of an empty row. Never fabricates a specific product; never verified.
              const floor = hasUsableName ? null : prefixFloorName(code, codeType);
              const provName = hasUsableName
                ? (cleanName || code)
                : floor
                  ? floor.name
                  : `Unidentified item (barcode ${code})`;
              const cur = get();
              // DEDUP: reuse a still-counted product whose identifier matches this code (orphaned-count rule),
              // so re-scans increment the SAME provisional row instead of duplicating. Never fuzzy.
              const countedIds = new Set(cur.finalCounts.map((c) => c.productId));
              let provId = cur.products.find(
                (p) =>
                  countedIds.has(p.id) &&
                  p.status !== "archived" &&
                  [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].map((c) => (c ?? "").trim()).includes(code),
              )?.id;
              // BUG FIX (scan-order merge asymmetry, live-proven: barcode-then-PN left 2 rows while
              // PN-then-barcode correctly merged into 1): `provId` above is almost always already this
              // SCAN'S OWN placeholder - ensureProvisionalCount mints it synchronously at scan time
              // (before decode ever runs), keyed on the literal scanned code. So an exact-code dedup miss
              // against any OTHER product never happens here; every decode that reaches this branch (never
              // "verified" - e.g. every corpus PN hit, which is a "suggested" decision by design) instead
              // needs to check whether the DECODED identity (not the raw scanned code) matches an existing,
              // already-verified product from an earlier scan of a DIFFERENT code for the SAME physical
              // item (the barcode-first case: a distributor-prefixed PN's own canonical part number was
              // never going to equal the scanned string). resolveUnknown's create_new path already runs
              // findIdentityMerge for exactly this reason; this fast "decode-everything" branch never did.
              // Reuse the SAME size-aware identity-merge primitive here - auto_link (canonical GTIN/barcode
              // equality, tire size agreeing) merges deterministically into the existing product (its own
              // fields are trusted and never overwritten by this weaker suggestion); anything fuzzier
              // (suggest_link) is left alone (never guessed), matching resolveUnknown's own trust rule.
              let mergeOrphanId: string | null = null;
              let mergeTargetId: string | null = null;
              if (best) {
                const mergeCandidates = cur.products.filter(
                  (p) => p.status !== "archived" && p.provisional !== true && p.id !== provId,
                );
                // NOTE: deliberately OMITS primaryBarcode - canonicalOf (identityMerge.ts) reads it, and a
                // carried/decoded barcode must never become a merge key here (probe-B footgun); only the
                // decoded identity fields below are trusted for matching.
                const merge = findIdentityMerge(mergeCandidates, {
                  gtin: best.gtin ?? null,
                  upc: best.upc ?? null,
                  ean: best.ean ?? null,
                  brand: best.brand ?? null,
                  name: best.productName ?? null,
                  specsShort: best.specsShort ?? null,
                  specsFull: best.specsFull ?? null,
                });
                if (merge.kind === "auto_link" && countedIds.has(merge.productId) && merge.productId !== provId) {
                  mergeTargetId = merge.productId;
                  mergeOrphanId = provId ?? null; // this scan's own placeholder (if any) gets merged away
                  provId = merge.productId;
                  emitAudit({ entityType: "Product", entityId: merge.productId, action: "identity_merge_auto_link", metadata: { code } });
                }
              }
              if (mergeTargetId) {
                // BUG FIX (scan-order merge asymmetry): reuse the EXISTING verified product discovered
                // above. Its fields are already correct and trusted - only add this code as a new alias
                // (via the SAME buildAliasesForCodes helper resolveUnknown's own multi-code aliasing uses)
                // so a future scan of the same code resolves deterministically. Never overwrite the
                // existing product's name/brand/specs from this weaker (suggested-tier) decode.
                const targetProduct = cur.products.find((p) => p.id === mergeTargetId);
                if (targetProduct) {
                  const built = buildAliasesForCodes({
                    product: targetProduct,
                    codes: [code],
                    existingAliases: cur.aliases,
                    businessId: cur.businessId,
                    sessionId: cur.sessionId,
                    idFactory,
                    now,
                    source: "ai_openai",
                    createdBy: "ai",
                  });
                  if (built.aliases.length > 0) {
                    set((st) => ({
                      aliases: [...st.aliases, ...built.aliases],
                      pendingSyncQueue: [...st.pendingSyncQueue, ...built.queued],
                    }));
                  }
                }
                // If this scan already had its OWN provisional placeholder (minted synchronously by
                // ensureProvisionalCount before this decode landed), transfer its retained count onto the
                // merge target and remove the now-redundant placeholder row - the SAME orphan-transfer
                // pattern resolveUnknown uses (never lose a count, never leave two rows for one identity).
                if (mergeOrphanId && mergeOrphanId !== mergeTargetId) {
                  const oid = mergeOrphanId;
                  const targetId = mergeTargetId;
                  // F-03: sync the repoint (mirrors deleteProductsInternal's balanced-pair fix) - a
                  // local-only transfer leaves the backend holding the orphan's count forever.
                  const transferOps = buildOrphanTransferSyncOps({
                    finalCountsBeforeTransfer: get().finalCounts,
                    scanFeedBeforeTransfer: get().scanFeed,
                    oid,
                    targetId,
                    businessId: cur.businessId,
                    idFactory,
                    now,
                  });
                  set((st) => ({
                    products: st.products.filter((p) => p.id !== oid),
                    finalCounts: transferOrphanCount(st.finalCounts, oid, targetId, now()),
                    scanFeed: st.scanFeed.map((e) =>
                      e.matchedProductId === oid ? { ...e, matchedProductId: targetId } : e,
                    ),
                  }));
                  if (transferOps.length > 0) enqueueAndSync(transferOps);
                }
              } else if (!provId) {
                provId = `prod-${idFactory()}`;
                // PN-BARCODE-CARRY: mint time - the scanned code itself is the only barcode so far
                // (current primaryBarcode is empty, i.e. "" as far as carriedProvisionalBarcode is
                // concerned), so a decode-provided barcode may carry through subject to the trust gate.
                const mintedBarcode =
                  carriedProvisionalBarcode({
                    currentPrimaryBarcode: "",
                    scannedCleanCode: code,
                    scannedCodeType: codeType,
                    candidateBarcode: best?.primaryBarcode,
                    partNumber: best?.primarySku,
                  }) || code;
                // FALKEN FIX (owner-reported live bug, 2026-07-20): this is the DECODE-EVERYTHING
                // provisional mint - the exact path a single fresh scan with a name-only decode
                // payload (no separate brand/category/specsShort/specsFull) takes. Previously every
                // structured column defaulted straight to "" with no fallback, leaving Brand/Model/
                // Category/Specs/Size permanently blank even though they are cleanly parseable from
                // the decoded name. Route through the shared helper: the payload's own field always
                // wins; a still-empty field falls back to a deterministic name parse, never a guess.
                const mintEnriched = enrichProductIdentity({
                  payload: { name: provName, brand: best?.brand, category: best?.category, specsShort: best?.specsShort, specsFull: best?.specsFull },
                });
                const provProduct: Product = {
                  id: provId, businessId: cur.businessId, name: provName, brand: mintEnriched.brand || (floor?.brand ?? ""),
                  category: mintEnriched.category, specsShort: mintEnriched.specsShort, specsFull: mintEnriched.specsFull,
                  primarySku: best?.primarySku ?? "", primaryBarcode: mintedBarcode, gtin: best?.gtin ?? "", upc: best?.upc ?? "",
                  ean: best?.ean ?? "", vendorCodes: [], aliases: [], imageUrl: s.allowImageSuggestions ? (best?.imageUrl ?? "") : "",
                  productUrl: best?.productUrl ?? "", location: "", notes: "", status: "active", source: "ai_openai",
                  confidence: decision?.confidence ?? 0, verified: false, provisional: true, provenanceTier: "provisional", createdAt: now(), createdBy: "ai", updatedAt: now(), updatedBy: "ai",
                  ...(mintEnriched.structuredModel ? { structuredModel: mintEnriched.structuredModel, structuredBy: "deterministic" as const } : {}),
                };
                set((st) => ({ products: [...st.products, provProduct] }));
                emitAudit({ entityType: "Product", entityId: provId, action: "product_created", metadata: { code, origin: "ai_suggested_provisional" } });
              } else if (hasUsableName) {
                // TASK 3 ENRICH: the scan was already counted synchronously (ensureProvisionalCount) as an
                // "Unidentified item" placeholder. Upgrade that SAME row in place with the decoded identity
                // (name / brand / specs) - NEVER re-count (its feed row is already "known"). It stays
                // provisional + unverified; the review stays open for human confirmation.
                const enrichId = provId;
                set((st) => ({
                  products: st.products.map((p) => {
                    if (p.id !== enrichId) return p;
                    // FALKEN FIX (owner-reported live bug, 2026-07-20): same gap as the mint branch
                    // above - a name-only decode payload used to leave brand/category/specsShort/
                    // specsFull permanently blank on the upgraded row. Fill-if-empty via the shared
                    // helper: a field the row already carries a value for is preserved untouched.
                    //
                    // PREFIX-FLOOR BRAND LOCK FIX (owner-reported live bug, 2026-07-21, 310-row review:
                    // rows 049000242201/049000245462 showed a real tire's decoded name next to Brand
                    // "Coca-Cola" - 049000 is Coca-Cola's GS1 prefix): p.brand at this point may be
                    // NOTHING MORE than the statistical prefix-floor guess ensureProvisionalCount wrote
                    // synchronously BEFORE this decode ever ran (p.name is still exactly the floor's own
                    // placeholder text). That guess is not "another source" that fill-if-empty must
                    // protect - it must yield to whatever THIS decode determines (its own brand, or a
                    // name-parsed brand, or genuinely empty), never silently lock in the wrong brand next
                    // to a now-correct decoded name. A brand set by any OTHER means (a prior real decode,
                    // a human edit) still wins untouched, since p.name would no longer equal the floor text.
                    //
                    // CLASS FIX (2026-08-04, cocacola-bug-report.md): this used to be the ONLY of three
                    // vulnerable call sites carrying this guard - moved into enrichProductIdentity itself
                    // (via existingBrandIsFloorGuess) so the other two call sites (resolveUnknown's
                    // reuse/orphan-upgrade branches) can share the exact same protection.
                    const enrichIdentity = enrichProductIdentity({
                      payload: { name: provName, brand: best?.brand, category: best?.category, specsShort: best?.specsShort, specsFull: best?.specsFull },
                      existing: { name: p.name, brand: p.brand, category: p.category, specsShort: p.specsShort, specsFull: p.specsFull },
                      existingBrandIsFloorGuess: brandIsOnlyFloorGuess(p.name, code),
                    });
                    return {
                          ...p,
                          name: provName,
                          brand: enrichIdentity.brand,
                          category: enrichIdentity.category,
                          specsShort: enrichIdentity.specsShort,
                          specsFull: enrichIdentity.specsFull,
                          ...(!p.structuredModel && enrichIdentity.structuredModel ? { structuredModel: enrichIdentity.structuredModel } : {}),
                          primarySku: p.primarySku || (best?.primarySku ?? ""),
                          // PN-BARCODE-CARRY: upgrade the placeholder primaryBarcode (empty, or the
                          // scanned PN itself) to the decode's corpus barcode - never a real scanned
                          // GTIN (carriedProvisionalBarcode returns "" in that case, keeping p.primaryBarcode).
                          primaryBarcode:
                            carriedProvisionalBarcode({
                              currentPrimaryBarcode: p.primaryBarcode,
                              scannedCleanCode: code,
                              scannedCodeType: codeType,
                              candidateBarcode: best?.primaryBarcode,
                              partNumber: best?.primarySku ?? p.primarySku,
                            }) || p.primaryBarcode,
                          gtin: p.gtin || (best?.gtin ?? ""),
                          upc: p.upc || (best?.upc ?? ""),
                          ean: p.ean || (best?.ean ?? ""),
                          imageUrl: s.allowImageSuggestions ? (best?.imageUrl ?? p.imageUrl) : p.imageUrl,
                          productUrl: best?.productUrl || p.productUrl,
                          confidence: decision?.confidence ?? p.confidence,
                          updatedAt: now(),
                          updatedBy: "ai",
                    };
                  }),
                }));
              }
              // Count it on the EXISTING scan event for this code (idempotent by event id), and surface the
              // provisional product + qty on that feed row while keeping the "Suggested" badge.
              const ev = get().scanFeed.find((e) => e.cleanCode === code && e.status !== "known");
              if (ev) {
                const countEvent: ScanEvent = { ...ev, matchedProductId: provId!, status: "known", quantityDelta: 1 };
                const { counts, count } = incrementInventoryCount(get().finalCounts, countEvent, idFactory);
                set((st) => ({
                  finalCounts: counts,
                  // Clear lastSyncError so provisionally counted items don't show a stale error banner.
                  lastSyncError: null,
                  scanFeed: st.scanFeed.map((e) =>
                    e.id === ev.id
                      ? { ...e, matchedProductId: provId!, status: "known", quantityAfterScan: count.quantity, decodeStatus: hasUsableName ? "suggested" : "needs_review", syncStatus: "synced" as const }
                      : e,
                  ),
                }));
              } else {
                // Already counted synchronously at scan time: just refresh the decode badge on the known
                // provisional row (no re-count). Never downgrade a row already flipped to "verified".
                const badge: ScanEvent["decodeStatus"] = hasUsableName ? "suggested" : "needs_review";
                set((st) => ({
                  scanFeed: st.scanFeed.map((e) =>
                    e.cleanCode === code && e.status === "known" && e.decodeStatus !== "verified" && e.matchedProductId === provId
                      ? { ...e, decodeStatus: badge }
                      : e,
                  ),
                }));
              }
              // F5 bundle-surgery: no usable AI name and the client-safe (SEED/LEARNED) lookup found no
              // brand - worth an async check for a DERIVED-tier hit. The row already appeared + counted
              // above either way (TOP-LEVEL LAW unaffected).
              if (!hasUsableName && !floor && provId) get().enrichPrefixFloorLabel(code, provId);
            }
            // STABLE-ID FIX: the decode-everything block just above minted/reused this code's provisional
            // placeholder. Look its id up fresh (it is scoped inside the block above) so resolveUnknown can
            // re-link by id after a customer reload, instead of by reconstructed name.
            const provIdForReview = get().products.find(
              (p) => p.provisional === true && p.status !== "archived" && p.primaryBarcode === review.cleanCode,
            )?.id;
            // Needs Review: keep it in the queue, show the score + why; write a PENDING catalog
            // candidate when the name is usable so the catalog still accumulates knowledge.
            get().recordFeedback("catalog_candidate_blocked", { code: review.cleanCode, meta: { score: plan.score } });
            if (isUsableProductName(best?.productName ?? "")) {
              set({
                catalog: applyAiCandidate(
                  get().catalog,
                  {
                    barcode: review.cleanCode,
                    normalizedBarcode: review.cleanCode,
                    barcodeType: codeType,
                    name: cleanName,
                    brand: best?.brand ?? "",
                    category: best?.category ?? "",
                    sourceUrls: best?.sourceUrls ?? [],
                    evidenceScore: plan.score,
                    blockingReasons: plan.blockingReasons,
                  },
                  nowIso,
                ),
              });
            }
            // Prefer the server's HONEST reason (rate-limited / timed-out / not-found-after-search /
            // fallback) over the generic gate text, so the row never lies about why it needs review.
            // TASK T3 fix (2026-08-06, audit-9 finding B): this decode-everything settle site has its
            // OWN reason write (reviewReason below), independent of the earlier one - it must not fall
            // back to the raw generic reasonText and silently undo the config-gap override computed
            // above (finalDecisionReason). Same rule: only substitute when this review's probe really
            // was the config-gap outcome AND the raw text is exactly the generic all-miss bucket.
            const honest =
              wasConfigGapProbe && data.reasonText === MISS_REASON_TEXT.product_not_found
                ? finalDecisionReason
                : typeof data.reasonText === "string" ? data.reasonText : "";
            // Phase 8: a category/brand conflict gives the safe, product-facing reason (highest priority).
            // Phase 7: a usable tire decode blocked only for missing specs gets a precise reason.
            const tireIncomplete = isUsableProductName(best?.productName ?? "") && isTireContext(best) && !hasRequiredTireSpecs(best);
            const reviewReason = contextConflict
              ? conflictReason(contextConflict)
              : tireIncomplete
                ? "Tire decode missing size / load index / speed rating - confirm full specs before counting (incomplete_specs)."
                : honest || plan.blockingReasons[0] || plan.reason || "Needs review";
            set((st) => ({
              // Phase 9: a category-context conflict drives the dismissible scan-page warning banner.
              lastCategoryWarning:
                contextConflict === "category_context_conflict"
                  ? { code: review.cleanCode, productName: best?.productName ?? "this product", reason: contextConflict }
                  : st.lastCategoryWarning,
              needsReviewQueue: st.needsReviewQueue.map((r) =>
                r.id === reviewId
                  ? {
                      ...r,
                      autoVerifyScore: plan.score,
                      blockingReasons: plan.blockingReasons,
                      reason: reviewReason,
                      provisionalProductId: r.provisionalProductId ?? provIdForReview ?? null,
                    }
                  : r,
              ),
              // Never leave a "Verified AI Decode + Unknown" feed row: if the decode said "verified" but
              // did NOT auto-save, rewrite the feed badge to needs_review. Conflict/suggested keep their
              // (already accurate) decode status.
              scanFeed:
                decision?.status === "verified"
                  ? st.scanFeed.map((e) =>
                      e.cleanCode === review.cleanCode && e.status !== "known" && e.status !== "resolved"
                        ? { ...e, decodeStatus: "needs_review", reason: reviewReason }
                        : e,
                    )
                  : st.scanFeed,
            }));

            // AUTO-SUGGEST-APPLY (owner order 2026-07-10): this decode did NOT clear the full auto-count
            // gate above, but it may still be high-trust enough to skip Needs Review entirely. The
            // identity was ALREADY applied onto the provisional row in place a few lines up (the
            // hasUsableName enrich branch runs regardless of this gate) - the only thing left is to close
            // the review instead of leaving it open, when confidence >= 0.8 OR this is an app-verified
            // exact app-verified decode (status "verified" + exactCodeEvidenceVerifiedByApp true).
            // TRUST RULES: no alias is created here, the product stays provisional:true/verified:false,
            // and the feed badge stays "suggested" (never "verified") - markFeedRowVerified is not called.
            // MULTI-VARIANT GATE (Group C): a listing naming several distinct speed ratings for one
            // size describes multiple product variants, not one confident identity - never let it
            // skip Needs Review via auto-suggest-apply, regardless of confidence/evidence.
            const multiVariantIdentity = enrichProductIdentity({ payload: { name: best?.productName ?? "" } }).multiVariant;
            const autoSuggestApplied =
              !multiVariantIdentity &&
              autoSuggestApplyOk({
                autoAddOn,
                contextConflict,
                productName: best?.productName ?? "",
                confidence: decision?.confidence ?? 0,
                status: decision?.status,
                exactCodeEvidenceVerifiedByApp: Boolean(decision?.exactCodeEvidenceVerifiedByApp),
              });
            if (autoSuggestApplied) {
              set((st) => ({
                needsReviewQueue: st.needsReviewQueue.map((r) =>
                  r.id === reviewId
                    ? { ...r, status: "resolved" as const, resolvedAt: now(), resolvedBy: "auto", resolutionAction: "create_new" as const, syncStatus: "synced" as const }
                    : r,
                ),
              }));
              persistReviewDecision(reviewId);
            }

            // Tasks 5+6: CLIENT-ORCHESTRATED BACKGROUND VERIFY. The fast hot path (mode:"decode") did
            // NOT auto-count this scan (the else branch ran -> not verified-and-clean). For a TIRE scan
            // that is still open, fire ONE background `mode:"decode-deep"` request WITH scanContext
            // "tire" - that is what makes the route page-fetch + app-verify the exact UPC and lets
            // decideDecode return "verified" (proven live: Hankook 715459332915). On success it routes
            // through the SAME verified-decode handling below to count + learn the alias.
            //
            // Never fire when the fast pass was a firewall context CONFLICT (a poisoned/off-domain
            // identity in tire context): re-fetching would just re-confirm the poison and the firewall
            // would block the count anyway, so we keep it in human review instead of spending a fetch.
            // The tire trigger reads BOTH the scan context (tire) and the decoded identity, so a clearly
            // non-tire decode in tire context does not escalate. Also skip when this decode was just
            // auto-suggest-applied above: the review is already closed, so a deep re-check would find
            // status !== "open" and no-op anyway (idempotency guard) - skip the wasted network call.
            const tireScan =
              (s.scanContext ?? "any") === "tire" && (isTireContext(best) || lookupTirePrefix(review.cleanCode) !== null);
            const fastWasVerified = decision?.status === "verified";
            if (tireScan && !fastWasVerified && !contextConflict && !autoSuggestApplied) {
              // Fire-and-forget: it must NEVER block the scan UI or throw into this flow. The action
              // self-guards on the review still being open (idempotent against a late/duplicate response).
              void get().backgroundVerifyDeep(reviewId);
            }

            // Task 9b (owner-ratified 2026-07-14): a suggestion-bearing decode NO LONGER sits in Needs
            // Review. The scan already counted (count-decouple, above); the suggestion concerns only the
            // NAME, so it moves onto the counted feed row as a PENDING inline suggestion (approve/decline
            // controls) and the review record is PARKED at status "suggested" (kept for the audit trail +
            // the batch-approve surface; dropped from the open queue/badge). APPROVED SEAM: only a decision
            // that is honestly "suggested", with a usable name, no firewall conflict, not auto-suggest-
            // applied, and NOT a tire scan awaiting the background deep-verify escalation just fired above
            // (that proven owner-loved path keeps its open review until it completes; backgroundVerifyDeep
            // performs the same conversion itself when it finishes WITHOUT verifying). Conflicts, empty
            // decodes, and blocked-verified decodes still create/keep open reviews (unchanged).
            // autoAddOn gate: with autoAddDecodedProducts OFF the owner asked for EVERY decode to go to
            // manual review (documented master switch) - suggestions then keep landing in the open queue.
            // BEST-GUESS DISPLAY (owner decision 2026-08-19): the inline suggestion is no longer limited
            // to an honestly-"suggested" decision. A WEAKER "needs_review" decision that still produced a
            // usable name carries that best guess on the counted row too, banded and correctable, instead
            // of showing the operator nothing. Every trust exclusion above is unchanged - only the
            // status clause widened, and nothing here creates an alias or marks anything verified.
            // FLOOR-GUESS EXCLUSION (F5): the prefix-floor naming aid ("<Brand> / product unconfirmed")
            // passes isUsableProductName and carries a brand, but it names NO product - it is a GS1
            // prefix statistic, not a candidate identity. Putting a one-tap Approve on it would teach an
            // approved alias for a product nobody ever identified, which is exactly the trust line the
            // best-guess decision kept strict. Such a row keeps the honest floor text with Edit/Identify.
            const suggestionInline =
              autoAddOn &&
              !autoSuggestApplied &&
              !multiVariantIdentity &&
              (decision?.status === "suggested" || decision?.status === "needs_review") &&
              isUsableProductName(best?.productName ?? "") &&
              !isFloorGuessOnlyLabel(suggestionFields.suggestedProductName) &&
              !contextConflict &&
              !(tireScan && !fastWasVerified);
            if (suggestionInline) {
              const pendingSuggestion = {
                productName: suggestionFields.suggestedProductName,
                brand: suggestionFields.suggestedBrand,
                confidence: decision?.confidence ?? 0,
                band: getIdentityConfidenceBand(decision),
                status: "pending" as const,
              };
              set((st) => ({
                needsReviewQueue: st.needsReviewQueue.map((r) =>
                  r.id === reviewId && r.status === "open" ? { ...r, status: "suggested" as const } : r,
                ),
                scanFeed: st.scanFeed.map((e) =>
                  e.cleanCode === review.cleanCode && e.decodeStatus !== "verified" && !e.suggestion
                    ? { ...e, suggestion: pendingSuggestion }
                    : e,
                ),
              }));
            }
            syncDecodedState(reviewId);
          }
        } catch (e) {
          if (wasInvalidated()) return;
          if (deterministicOnly && trustedExactProbes.has(reviewId)) {
            materializeTrustedExactMiss(
              reviewId,
              "Trusted exact lookup was unavailable. Saved locally and counted as unverified; retry to identify when back online.",
            );
            return;
          }
          const nextBreaker = recordFailure(gate.breaker, nowMs);
          // Emit only on the closed/half-open -> open transition. This best-effort request must not
          // participate in the scan/decode control flow or report a raw scan/provider error.
          if (gate.breaker.state !== "open" && nextBreaker.state === "open") {
            void postTelemetry("breaker_open", "decode_failure_threshold_reached");
          }
          // Task 2: a daily_cap 429 gets its own honest, non-retry-promising copy - there is no
          // automatic decode-on-cap-reset queue, so telling the user to just wait would be false.
          // Every other failure (network / self-inflicted rate limit / provider error) keeps the
          // existing generic copy unchanged.
          const failReason =
            e instanceof DailyCapReachedError
              ? e.accountScoped
                ? "Your account's daily AI lookup cap is reached. This scan is saved and counted as unverified. Retry after the cap resets."
                : "Daily AI lookup cap reached. This scan is saved and counted as unverified. Retry after the cap resets."
              : e instanceof DecodeAbortedError
                ? "Decode is taking longer than expected - it keeps working in the background; check Needs Review shortly"
                : // DEFECT 2 (untrusted string leak): NEVER surface the raw browser/provider error
                  // ("Failed to fetch", DNS errors, etc.) in the user-facing Reason column. Map every
                  // network/provider failure to honest human copy; the technical detail stays only in
                  // the debug-only aiLookupLogs error entry written below (mkLog), never on the row.
                  "Live decode failed (network / rate-limit / provider error). Saved locally and counted as unverified; retry to identify when back online.";
          // DECODE-EVERYTHING (owner): a FAILED decode (timeout / 429 rate-limit / provider error / AI down)
          // must NOT leave the scan blank. We still COUNT it as an UNVERIFIED, reviewable provisional row with
          // a SAFE label and the scanned code - never a fabricated product identity, never an approved alias,
          // never a verified product. The review STAYS OPEN so a retry can identify it.
          const code = review.cleanCode;
          // PREFIX FLOOR (Plan C Task 3): a failed decode must not leave a bare "Unidentified item"
          // when the GS1 prefix maps to a known brand - see prefixFloorName. Label text comes from the
          // shared provisionalPlaceholderName helper (same one ensureProvisionalCount uses) so this
          // mint can never drift from what resolveUnknown's reload-resilient fallback expects to match.
          // P2 (Task 8): on a daily_cap block the SERVER already resolved the floor and threaded it through
          // the 429 body; prefer that authoritative floor when present (falls back to the identical local
          // recompute for every other failure). The honest cap reason text (failReason) is unchanged.
          const capFloor = e instanceof DailyCapReachedError ? e.floor : undefined;
          const floor = capFloor ?? prefixFloorName(code, codeType);
          const fbName = capFloor?.name ?? provisionalPlaceholderName(code);
          const cur = get();
          const countedIds = new Set(cur.finalCounts.map((c) => c.productId));
          let provId = cur.products.find(
            (p) =>
              countedIds.has(p.id) &&
              p.status !== "archived" &&
              [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].map((c) => (c ?? "").trim()).includes(code),
          )?.id;
          if (!provId) {
            provId = `prod-${idFactory()}`;
            const provProduct: Product = {
              id: provId, businessId: cur.businessId, name: fbName, brand: floor?.brand ?? "", category: "", specsShort: "",
              specsFull: "", primarySku: "", primaryBarcode: code, gtin: "", upc: "", ean: "", vendorCodes: [],
              aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "ai_openai",
              confidence: 0, verified: false, provisional: true, provenanceTier: "provisional", createdAt: now(), createdBy: "ai", updatedAt: now(), updatedBy: "ai",
            };
            set((st) => ({ products: [...st.products, provProduct] }));
          } else if (floor) {
            // F5 bundle-surgery: the row was pre-counted at scan time by ensureProvisionalCount, whose
            // CLIENT-SAFE (SEED/LEARNED) lookup may have missed a DERIVED-tier brand the server knows
            // (capFloor from the 429 body, or a local hit). If the existing row still carries the bare
            // "Unidentified item" fallback for this code, upgrade it in place with the floor's
            // brand-confident naming aid - exactly what the pre-split synchronous path produced. Never
            // clobbers a real decoded/human name (bare-label guard), never verified, never a re-count.
            const targetId = provId;
            set((st) => ({
              products: st.products.map((p) =>
                p.id === targetId && p.provisional === true && p.verified !== true && isBareUnidentifiedLabel(p.name, code)
                  ? { ...p, name: floor.name, brand: floor.brand, updatedAt: now(), updatedBy: "ai" }
                  : p,
              ),
            }));
          }
          const evF = get().scanFeed.find((ev) => ev.cleanCode === code && ev.status !== "known");
          let countsF = get().finalCounts;
          let qtyF = 0;
          if (evF) {
            const r = incrementInventoryCount(countsF, { ...evF, matchedProductId: provId, status: "known", quantityDelta: 1 }, idFactory);
            countsF = r.counts;
            qtyF = r.count.quantity;
          }
          set((st) => ({
            finalCounts: countsF,
            needsReviewQueue: st.needsReviewQueue.map((r) =>
              r.id === reviewId
                ? {
                    ...r,
                    decodeStatus: "needs_review",
                    reason: failReason,
                    // F5 bundle-surgery: a bare "Unidentified item" suggestion (stamped at scan time by
                    // the client-safe SEED/LEARNED lookup) upgrades to the floor's brand-confident name
                    // (fbName carries the server-authoritative capFloor when present) - exactly what the
                    // pre-split synchronous path produced. A REAL suggestion is never overwritten.
                    suggestedProductName:
                      r.suggestedProductName && !isBareUnidentifiedLabel(r.suggestedProductName, code)
                        ? r.suggestedProductName
                        : fbName,
                    // STABLE-ID FIX: capture the placeholder id (freshly minted above, or reused if one
                    // already existed) so resolveUnknown can re-link by id after a customer reload.
                    provisionalProductId: r.provisionalProductId ?? provId ?? null,
                  }
                : r,
            ),
            scanFeed: st.scanFeed.map((ev) =>
              evF && ev.id === evF.id
                ? { ...ev, matchedProductId: provId!, status: "known", quantityAfterScan: qtyF, decodeStatus: "suggested", reason: failReason }
                : ev.cleanCode === code && ev.decodeStatus === "decoding"
                  ? { ...ev, decodeStatus: "needs_review", reason: failReason }
                  : ev,
            ),
            aiLookupLogs: [mkLog("error", "decode", 0, nextBreaker), ...st.aiLookupLogs],
            breaker: nextBreaker,
            aiStatus: { ...st.aiStatus, lastAttemptAt: nowIso, lastFailureReason: failReason },
            settings: { ...st.settings, dailyLookupCount: dailyCount, lastResetDate: today },
          }));
          // F5 bundle-surgery: only worth enriching when neither the server-authoritative cap floor nor
          // the client-safe (SEED/LEARNED) lookup found a brand - capFloor already used the FULL index.
          if (!capFloor && !floor && provId) get().enrichPrefixFloorLabel(code, provId);
        }
      },

      enrichPrefixFloorLabel: (code, productId) => {
        // Fire-and-forget: never awaited by any caller, never blocks/delays the row that already
        // appeared + counted synchronously. Deferred a tick so any SYNCHRONOUS same-call resolution
        // (catalog-first hit, deterministic alias, a decode landing in the same stack) renames the row
        // first and the pre-fetch bare-label check below skips the network call entirely - the fetch
        // only fires for a row that genuinely settled as a bare "Unidentified item".
        setTimeout(() => {
          if (!get().online) return; // offline: no fetch, label silently stays (retry is not needed - naming aid only)
          if (enrichInFlight.has(productId)) return; // one enrichment round-trip per row, never a duplicate fetch
          const before = get().products.find((p) => p.id === productId);
          if (!before || !isBareUnidentifiedLabel(before.name, code)) return; // already identified: no fetch
          enrichInFlight.add(productId);
          void fetchPrefixFloorEnrichment(code).finally(() => enrichInFlight.delete(productId)).then((floor) => {
            if (!floor) return; // offline / no derived-tier hit / non-barcode-shaped code: silent no-op
            const prod = get().products.find((p) => p.id === productId);
            // Re-check after the round-trip too: only upgrade if the row STILL carries the exact bare
            // fallback label for this code - a decode may have landed (real name), or a human may have
            // edited it, while the fetch was in flight. Never clobber anything but the bare placeholder.
            if (!prod || !isBareUnidentifiedLabel(prod.name, code)) return;
            set((s) => ({
              products: s.products.map((p) =>
                p.id === productId ? { ...p, name: floor.name, brand: floor.brand } : p,
              ),
            }));
          });
        }, 0);
      },

      markFeedRowVerified: (cleanCode, reason, provenance) => {
        set((s) => ({
          scanFeed: s.scanFeed.map((e) =>
            e.cleanCode === cleanCode && e.status !== "resolved" && e.decodeStatus !== "verified"
              ? {
                  ...e,
                  decodeStatus: "verified" as ScanEvent["decodeStatus"],
                  reason: reason || e.reason,
                  // Stale-note fix: the row just settled to verified - drop
                  // any leftover in-flight "Decoding with AI..." note (see the main settle block above).
                  decodeNote: undefined,
                  // P5 Task 5: additive, optional. Only set when the caller passed one (see the
                  // interface comment) - display only, never gates counting/auto-count.
                  provenance,
                }
              : e,
          ),
        }));
      },

      applyDecodeFallback: (reviewId, reason) => {
        const review = get().needsReviewQueue.find((r) => r.id === reviewId);
        if (!review || review.status !== "open") return;
        get().ensureProvisionalCount(review.cleanCode, reason);
      },

      backgroundVerifyDeep: async (reviewId) => {
        const state = get();
        const review = state.needsReviewQueue.find((r) => r.id === reviewId);
        // IDEMPOTENCY GUARD: only an OPEN review is ever acted on. The fast-path resolveUnknown (or an
        // earlier deep response) flips the review to "resolved" the instant it counts, so a late or
        // duplicate deep response that re-enters here finds status !== "open" and returns - it can never
        // double-count or duplicate the alias. This reuses the SAME open-status gate liveDecode relies on.
        if (!review || review.status !== "open") return;

        const s = state.settings;
        const nowIso = now();
        const today = nowIso.slice(0, 10);
        const nowMs = new Date(nowIso).getTime();
        const dailyCount = s.lastResetDate === today ? s.dailyLookupCount : 0;

        // Reuse the EXACT auto-decode gate (online + AI on + configured + not stopped + under cap +
        // breaker closed). No new gating is invented; a blocked state simply leaves the review open.
        // GOD CLIENT (owner-approved 2026-08-07): background deep-verify follow-up must not silently
        // re-block the platform owner either - see `applyGodGateOverride`.
        const gate = applyGodGateOverride(
          evaluateAiGate({
            enabled: s.aiLookupEnabled,
            online: state.online,
            dailyCount,
            dailyLimit: s.dailyLookupLimit,
            breaker: state.breaker,
            now: nowMs,
          }),
          isPlatformOwnerForGateBypass(state.userId),
        );
        if (!gate.allowed) return;

        const rawCodeSanitized = sanitizeForAiLookup(review.rawCode).clean;
        const cleanCodeSanitized = sanitizeForAiLookup(review.cleanCode).clean;
        const codeType = detectCodeType(review.cleanCode);

        let data: {
          decision?: DecodeDecision;
          results?: AiLookupResult[];
        };
        try {
          // D4-follow-up: live-auth mode requires idToken + businessId on every POST (route.ts:294-324)
          // or this 401s "unauthenticated" - mock mode resolves {} and is unaffected.
          // P4 (#28): shared backoff helper - background enrichment only, still silently gives up
          // (`if (!res.ok) return;` below) on a final 429, unchanged; this only adds honest-Retry-
          // After/jittered resilience before that give-up point.
          const res = await fetchWithBackoff("/api/ai-lookup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...(await aiRequestAuth(state.businessId)),
              mode: "decode-deep",
              // MANDATORY: without scanContext "tire" the route's page-fetch verify gate cannot fire,
              // so the exact UPC is never app-verified and decideDecode can never return "verified"
              // (proven live). This is the whole point of the background pass.
              scanContext: "tire",
              rawCode: rawCodeSanitized,
              cleanCode: cleanCodeSanitized,
              codeType,
              confidenceThreshold: 0.85,
              allowImageSuggestions: s.allowImageSuggestions,
            }),
          });
          if (!res.ok) return; // never throw into the scan flow; leave the review open for the human
          data = await res.json();
        } catch {
          // Network/provider failure on the BACKGROUND pass must be silent: the row is already shown as
          // suggested/needs_review and the human can still resolve it. Never surface a scary error here.
          return;
        }

        // COST METERING: a successful deep fetch is a REAL provider call, so it must count against the
        // daily cap exactly like liveDecode does (same field, same +1, same set/persist pattern). Only a
        // real provider call reaches here - a non-OK response or a thrown fetch returned above, uncounted.
        set((st) => ({
          settings: { ...st.settings, dailyLookupCount: dailyCount + 1, lastResetDate: today },
        }));

        const decision = data.decision;
        const results: AiLookupResult[] = data.results ?? [];
        const best = results[0] ?? null;

        // Re-read the review: it may have been resolved (fast path / a concurrent deep response) while we
        // awaited the fetch. Only an OPEN review is upgraded - the idempotency backstop.
        const fresh = get().needsReviewQueue.find((r) => r.id === reviewId);
        if (!fresh || fresh.status !== "open") return;

        // NON-VERIFIED deep result: NEVER counts. If it carries a fuller product than the fast pass, refresh
        // the review's suggestion so the human sees better data; otherwise leave it untouched. No gate weakened.
        if (decision?.status !== "verified") {
          if (best && isUsableProductName(best.productName ?? "")) {
            const tireFields = best && s.scanContext === "tire" && isTireContext(best) ? extractTireFields(best) : null;
            set((st) => ({
              needsReviewQueue: st.needsReviewQueue.map((r) =>
                r.id === reviewId && r.status === "open"
                  ? {
                      ...r,
                      suggestedProductName: tireFields?.description || best.productName || r.suggestedProductName,
                      suggestedBrand: tireFields?.brand ?? best.brand ?? r.suggestedBrand,
                      suggestedCategory: best.category ?? r.suggestedCategory,
                      suggestedSpecsShort: tireFields?.size ?? best.specsShort ?? r.suggestedSpecsShort,
                      suggestedSpecsFull: best.specsFull ?? r.suggestedSpecsFull,
                      suggestedPrimarySku: tireFields?.partNumber ?? best.primarySku ?? r.suggestedPrimarySku,
                      suggestedImageUrl: s.allowImageSuggestions ? (best.imageUrl ?? r.suggestedImageUrl) : r.suggestedImageUrl,
                      suggestedProductUrl: best.productUrl ?? r.suggestedProductUrl,
                      sourceUrls: best.sourceUrls ?? r.sourceUrls,
                      hasSuggestion: true,
                    }
                  : r,
              ),
            }));
          }
          // Task 9b (owner-ratified 2026-07-14 addition): the deep pass has now COMPLETED without
          // verifying - the identity is still only a suggestion, and suggestions never sit in Needs
          // Review. Convert this review to the same PENDING inline-suggestion state the fast path
          // uses (status "suggested" + approve/decline controls on the counted feed row). Guarded on
          // the review still being open (idempotent against duplicate/late deep responses) and on a
          // usable suggested identity; a deep result that returned a NEW identity is re-checked
          // against the context firewall first (the fast identity was already cleared before this
          // escalation ever fired - see the backgroundVerifyDeep trigger in runLiveDecodeOnce).
          const freshAfter = get().needsReviewQueue.find((r) => r.id === reviewId);
          // Same autoAddOn master-switch gate as the fast path: with autoAddDecodedProducts OFF the
          // owner asked for every decode to sit in manual review, so no inline conversion happens.
          // MULTI-VARIANT GATE (Group C): same rule as the fast path - never convert a multi-variant
          // listing into a pending inline suggestion, regardless of confidence/evidence.
          const deepMultiVariant = enrichProductIdentity({ payload: { name: freshAfter?.suggestedProductName ?? "" } }).multiVariant;
          if (
            (s.autoAddDecodedProducts ?? true) &&
            freshAfter &&
            freshAfter.status === "open" &&
            freshAfter.hasSuggestion &&
            isUsableProductName(freshAfter.suggestedProductName) &&
            !deepMultiVariant
          ) {
            const deepConflict =
              best && isUsableProductName(best.productName ?? "")
                ? detectScanContextConflict({
                    scanContext: s.scanContext ?? "any",
                    code: review.cleanCode,
                    codeType,
                    result: best,
                    brandPrefixHints: deriveBrandPrefixHints(get().products, get().aliases),
                    exactCodeVerifiedByApp: false,
                  })
                : null; // no new deep identity: the fast pass already cleared the firewall before escalating
            if (!deepConflict) {
              const pendingSuggestion = {
                productName: freshAfter.suggestedProductName,
                brand: freshAfter.suggestedBrand,
                confidence: freshAfter.confidence,
                band: getIdentityConfidenceBand(decision),
                status: "pending" as const,
              };
              set((st) => ({
                needsReviewQueue: st.needsReviewQueue.map((r) =>
                  r.id === reviewId && r.status === "open" ? { ...r, status: "suggested" as const } : r,
                ),
                scanFeed: st.scanFeed.map((e) =>
                  e.cleanCode === review.cleanCode && e.decodeStatus !== "verified" && !e.suggestion
                    ? { ...e, suggestion: pendingSuggestion }
                    : e,
                ),
              }));
            }
          }
          return;
        }

        // VERIFIED deep result: route through the SAME auto-count gate + verified-decode handling as
        // liveDecode (Task 6 alignment). This must reuse resolveUnknown so the count + alias-learn +
        // idempotency keys are identical to the fast path - we never re-implement counting here.
        const cleanName = cleanProductName(best?.productName ?? "");
        const tireFields = best && s.scanContext === "tire" && isTireContext(best) ? extractTireFields(best) : null;
        const avSettings = {
          autoCatalogLearningEnabled: s.autoCatalogLearningEnabled ?? true,
          autoVerifyConfidenceThreshold: s.autoVerifyConfidenceThreshold ?? 80,
          trustedSourceAutoVerifyEnabled: s.trustedSourceAutoVerifyEnabled ?? true,
          aiOnlyAutoVerifyAllowed: s.aiOnlyAutoVerifyAllowed ?? false,
          allowNonPublicAutoCount: s.autoCountNonPublicWithEvidence ?? true,
        };
        const plan = planAutoVerify({
          code: review.cleanCode,
          codeType,
          decision: {
            status: decision.status,
            evidenceStrength: decision.evidenceStrength ?? "none",
            exactCodeEvidenceVerifiedByApp: Boolean(decision.exactCodeEvidenceVerifiedByApp),
            crossCheck: decision.crossCheck ?? {
              decision: "weak", confidence: 0, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [],
            },
          },
          best,
          catalog: get().catalog,
          settings: avSettings,
        });

        const newProduct = {
          name: tireFields?.description || cleanName,
          brand: tireFields?.brand ?? best?.brand ?? "",
          category: best?.category ?? "",
          specsShort: tireFields?.size ?? best?.specsShort ?? "",
          specsFull: best?.specsFull ?? "",
          primarySku: tireFields?.partNumber ?? best?.primarySku ?? "",
          primaryBarcode: best?.primaryBarcode || review.cleanCode,
          gtin: best?.gtin ?? "",
          upc: best?.upc ?? "",
          ean: best?.ean ?? "",
          imageUrl: s.allowImageSuggestions ? (best?.imageUrl ?? "") : "",
          productUrl: best?.productUrl ?? "",
        };

        const autoAddOn = s.autoAddDecodedProducts ?? true; // master gate (unchanged): false -> manual review
        // SAME Phase 7 evidence gate + Phase 8 firewall as liveDecode. A non-verified result never reaches
        // here, and a firewall/brand-prefix conflict (poison in tire context) still blocks the count.
        const tireOk = tireAutoCountOk(best);
        // Task 9 (owner-ratified 2026-07-14, decode-anything): app-verified exact-code evidence clears the
        // tire category hard-block; weak/unverified identities still hard-block (poison guard intact).
        const exactCodeVerifiedByApp =
          decision?.exactCodeEvidenceVerifiedByApp === true && decision?.status === "verified";
        const firewallParams = {
          scanContext: s.scanContext ?? "any",
          code: review.cleanCode,
          codeType,
          result: best,
          brandPrefixHints: deriveBrandPrefixHints(get().products, get().aliases),
          exactCodeVerifiedByApp,
        };
        const contextConflict = detectScanContextConflict(firewallParams);
        const offCategory = detectOffCategoryAdvisory(firewallParams);
        // SAME pure evidence gate as liveDecode (src/stores/scanGates.ts): Phase-7 corroboration + GPT
        // trust tier + T20/code-1225 public-barcode firewall, kept in sync so the two decode paths can
        // never drift apart again. tireOk + contextConflict are computed here and passed in.
        const evidenceGatePassed = canAutoCount({
          codeType,
          decision,
          productName: best?.productName ?? "",
          productNameUsable: isUsableProductName(best?.productName ?? ""),
          tireOk,
          contextConflict,
        }).allowed;

        if (autoAddOn && evidenceGatePassed && (plan.status === "auto_verify" || plan.status === "auto_count")) {
          // OPTION 3: non-public codes never write the global catalog ("auto_verify") - shop-local "ai" only.
          const isPublicCode = (["upc_a", "ean_13", "gtin_14"] as string[]).includes(codeType);
          const origin = plan.status === "auto_count" ? "auto_count" : (plan.verifiedBy && isPublicCode) ? "auto_verify" : "ai";
          get().recordFeedback(plan.verifiedBy === "trusted_source" ? "trusted_source_match" : "found_from_ai", { code: review.cleanCode });
          if (origin === "auto_verify") {
            get().recordFeedback("auto_verified_catalog_entry", { code: review.cleanCode, meta: { score: plan.score, tier: plan.sourceTier } });
          }
          get().resolveUnknown(reviewId, "create_new", {
            applyToCount: true,
            origin,
            autoVerify:
              origin === "auto_verify"
                ? {
                    score: plan.score,
                    verifiedBy: plan.verifiedBy ?? "evidence_score",
                    sourceTier: plan.sourceTier,
                    reason: plan.reason,
                    evidenceSummary: plan.evidenceSummary,
                    sourceUrls: best?.sourceUrls ?? [],
                  }
                : undefined,
            newProduct,
          });
          // Flip the scan-feed badge to verified AFTER resolveUnknown, and ONLY when it actually resolved
          // the review (status "resolved"). The row may be "known" (counted synchronously) - markFeedRowVerified
          // flips it regardless of that, as long as it is not already resolved. BUG FIX (verified-shows-
          // Unidentified): resolveUnknown can silently no-op (fuzzy identity-merge suggest_link, or a dedup
          // conflict) and leave the review "open" with the placeholder product untouched - marking the row
          // "verified" in that case would show "Verified match" over the unresolved placeholder name.
          if (get().needsReviewQueue.find((r) => r.id === reviewId)?.status === "resolved") {
            get().markFeedRowVerified(review.cleanCode, decision.reason ?? "");
          } else {
            // FIX (rung self-poisoning audit, owner-approved): resolveUnknown's create_new branch
            // already stamps "resolved" on every ACTUAL resolution. The only ways a review is still
            // open/suggested here are the two DELIBERATE human-required early-returns: the fuzzy
            // identity-merge suggest_link path (stamps suggestedLinkProductId + returns, keeping the
            // review open on purpose) and the multi-match dedup-conflict path (pushes this reviewId onto
            // lastAliasConflicts + returns, keeping it open on purpose). Only stamp when NEITHER
            // deliberate-hold signal fired for this exact review - status metadata only, never
            // scanFeed/finalCounts.
            const stillOpen = get().needsReviewQueue.find((r) => r.id === reviewId);
            const heldForSuggestLink = Boolean(stillOpen?.suggestedLinkProductId);
            const heldForConflict = (get().lastAliasConflicts ?? []).some((c) => c.reviewId === reviewId);
            if (stillOpen && (stillOpen.status === "open" || stillOpen.status === "suggested") && !heldForSuggestLink && !heldForConflict) {
              set((st) => ({
                needsReviewQueue: st.needsReviewQueue.map((r) =>
                  r.id === reviewId
                    ? { ...r, status: "resolved" as const, resolvedAt: now(), resolvedBy: "auto", resolutionAction: "create_new" as const }
                    : r,
                ),
              }));
            }
          }
          // Task 9: tag an app-verified off-category decode so the feed shows "Off-category item".
          if (offCategory) {
            set((st) => ({
              scanFeed: st.scanFeed.map((e) =>
                e.cleanCode === review.cleanCode ? { ...e, offCategory: true } : e,
              ),
            }));
          }
        } else if (contextConflict) {
          // FALSE-AUTO-COUNT BACKSTOP: a "verified" deep decode that contradicts the tire context (poison)
          // must NOT count. Keep it open with the safe conflict reason; the human relinks. Never weaken.
          set((st) => ({
            lastCategoryWarning:
              contextConflict === "category_context_conflict"
                ? { code: review.cleanCode, productName: best?.productName ?? "this product", reason: contextConflict }
                : st.lastCategoryWarning,
            needsReviewQueue: st.needsReviewQueue.map((r) =>
              r.id === reviewId && r.status === "open" ? { ...r, reason: conflictReason(contextConflict) } : r,
            ),
          }));
        } else {
          // AUTO-SUGGEST-APPLY (owner order 2026-07-10, kept in sync with the same gate in liveDecode):
          // a verified deep decode that missed the full auto-count gate above (e.g. tireOk failed) can
          // still skip Needs Review as a SUGGESTION when confidence >= 0.8, OR this is an app-verified
          // exact app-verified decode. Apply the identity onto the existing provisional row in
          // PLACE - product stays provisional:true/verified:false - and close the review. TRUST RULES:
          // no alias created, markFeedRowVerified never called, feed badge stays "suggested".
          const autoSuggestApplied = autoSuggestApplyOk({
            autoAddOn,
            contextConflict,
            productName: best?.productName ?? "",
            confidence: decision.confidence ?? 0,
            status: decision.status,
            exactCodeEvidenceVerifiedByApp: Boolean(decision.exactCodeEvidenceVerifiedByApp),
          });
          if (autoSuggestApplied) {
            const ownProvId =
              review.provisionalProductId ??
              get().products.find((p) => p.provisional === true && p.status !== "archived" && p.primaryBarcode === review.cleanCode)?.id;
            // BUG FIX (scan-order merge asymmetry, same class as the fast-path decode-everything branch):
            // before enriching THIS scan's own placeholder in place, check whether the decoded identity
            // already matches a DIFFERENT, already-verified product (e.g. an earlier scan of this same
            // physical item's barcode). Reuse the SAME size-aware findIdentityMerge primitive; auto_link
            // only (never the fuzzy suggest_link - that stays a human decision, unchanged).
            const countedIds = new Set(get().finalCounts.map((c) => c.productId));
            let mergeTargetId: string | null = null;
            if (best) {
              const mergeCandidates = get().products.filter(
                (p) => p.status !== "archived" && p.provisional !== true && p.id !== ownProvId,
              );
              // NOTE: deliberately OMITS primaryBarcode - canonicalOf (identityMerge.ts) reads it, and a
              // carried/decoded barcode must never become a merge key here (probe-B footgun); only the
              // decoded identity fields below are trusted for matching.
              const merge = findIdentityMerge(mergeCandidates, {
                gtin: best.gtin ?? null,
                upc: best.upc ?? null,
                ean: best.ean ?? null,
                brand: best.brand ?? null,
                name: best.productName ?? null,
                specsShort: best.specsShort ?? null,
                specsFull: best.specsFull ?? null,
              });
              if (merge.kind === "auto_link" && countedIds.has(merge.productId) && merge.productId !== ownProvId) {
                mergeTargetId = merge.productId;
                emitAudit({ entityType: "Product", entityId: merge.productId, action: "identity_merge_auto_link", metadata: { code: review.cleanCode } });
              }
            }
            if (mergeTargetId) {
              const targetProduct = get().products.find((p) => p.id === mergeTargetId);
              if (targetProduct) {
                const built = buildAliasesForCodes({
                  product: targetProduct,
                  codes: [review.cleanCode],
                  existingAliases: get().aliases,
                  businessId: state.businessId,
                  sessionId: state.sessionId,
                  idFactory,
                  now,
                  source: "ai_openai",
                  createdBy: "ai",
                });
                if (built.aliases.length > 0) {
                  set((st) => ({
                    aliases: [...st.aliases, ...built.aliases],
                    pendingSyncQueue: [...st.pendingSyncQueue, ...built.queued],
                  }));
                }
              }
              if (ownProvId && ownProvId !== mergeTargetId) {
                const oid = ownProvId;
                const targetId = mergeTargetId;
                // F-03: sync the repoint (mirrors deleteProductsInternal's balanced-pair fix) - a
                // local-only transfer leaves the backend holding the orphan's count forever.
                const transferOps = buildOrphanTransferSyncOps({
                  finalCountsBeforeTransfer: get().finalCounts,
                  scanFeedBeforeTransfer: get().scanFeed,
                  oid,
                  targetId,
                  businessId: state.businessId,
                  idFactory,
                  now,
                });
                set((st) => {
                  const finalCounts = transferOrphanCount(st.finalCounts, oid, targetId, now());
                  return {
                    products: st.products.filter((p) => p.id !== oid),
                    finalCounts,
                    scanFeed: st.scanFeed.map((e) =>
                      e.matchedProductId === oid
                        ? { ...e, matchedProductId: targetId, decodeStatus: e.decodeStatus !== "verified" ? ("suggested" as const) : e.decodeStatus }
                        : e,
                    ),
                    needsReviewQueue: st.needsReviewQueue.map((r) =>
                      r.id === reviewId
                        ? { ...r, status: "resolved" as const, resolvedAt: now(), resolvedBy: "auto", resolutionAction: "create_new" as const, syncStatus: "synced" as const }
                        : r,
                    ),
                  };
                });
                if (transferOps.length > 0) enqueueAndSync(transferOps);
              } else {
                set((st) => ({
                  needsReviewQueue: st.needsReviewQueue.map((r) =>
                    r.id === reviewId
                      ? { ...r, status: "resolved" as const, resolvedAt: now(), resolvedBy: "auto", resolutionAction: "create_new" as const, syncStatus: "synced" as const }
                      : r,
                  ),
                }));
              }
            } else if (ownProvId) {
              const provId = ownProvId;
              set((st) => ({
                products: st.products.map((p) =>
                  p.id === provId
                    ? {
                        ...p,
                        name: tireFields?.description || cleanName || p.name,
                        brand: tireFields?.brand ?? best?.brand ?? p.brand,
                        category: best?.category ?? p.category,
                        specsShort: tireFields?.size ?? best?.specsShort ?? p.specsShort,
                        specsFull: best?.specsFull ?? p.specsFull,
                        primarySku: p.primarySku || (tireFields?.partNumber ?? best?.primarySku ?? ""),
                        gtin: p.gtin || (best?.gtin ?? ""),
                        upc: p.upc || (best?.upc ?? ""),
                        ean: p.ean || (best?.ean ?? ""),
                        imageUrl: s.allowImageSuggestions ? (best?.imageUrl ?? p.imageUrl) : p.imageUrl,
                        productUrl: best?.productUrl || p.productUrl,
                        confidence: decision.confidence ?? p.confidence,
                        updatedAt: now(),
                        updatedBy: "ai",
                      }
                    : p,
                ),
                needsReviewQueue: st.needsReviewQueue.map((r) =>
                  r.id === reviewId
                    ? { ...r, status: "resolved" as const, resolvedAt: now(), resolvedBy: "auto", resolutionAction: "create_new" as const, syncStatus: "synced" as const }
                    : r,
                ),
                scanFeed: st.scanFeed.map((e) =>
                  e.cleanCode === review.cleanCode && e.decodeStatus !== "verified" ? { ...e, decodeStatus: "suggested" as const } : e,
                ),
              }));
            }
          }
          // else: verified-but-gate-blocked-for-another-reason (e.g. autoAdd off, incomplete specs, or no
          // usable name/confidence < 0.8 and not app-verified-exact). The fast pass already left an
          // accurate review row; we leave it for the human (never count a blocked result).
        }
        persistReviewDecision(reviewId);
      },

      correctionRecheck: async (reviewId, opts) => {
        const review = get().needsReviewQueue.find((r) => r.id === reviewId);
        if (!review || review.status !== "open") return;
        // Cost guard: one Pro recheck per marked-wrong code unless the user explicitly retries.
        if (review.correctionRecheckStatus && review.correctionRecheckStatus !== "requested" && !opts?.retry) return;
        const ai = get().aiStatus;
        const patch = (extra: Partial<UnknownCodeReview>) =>
          set((s) => ({ needsReviewQueue: s.needsReviewQueue.map((r) => (r.id === reviewId ? { ...r, ...extra } : r)) }));

        emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "correction_recheck_requested", metadata: { code: review.cleanCode, reason: opts?.reason ?? "" } });

        // Decode unavailable: do NOT fail the correction. Mark unavailable and keep it in Needs Review.
        // The recheck runs the same free-first/GPT decode pipeline as a normal scan, so a missing paid
        // key is not a blocker for free knowledge. The
        // only conditions that stop it running at all are the server kill switch and the server-side
        // live-AI disable - the same two server flags the normal decode path honors. Key NAMES only.
        if (ai.killSwitchOn || !ai.liveEnabled) {
          const reason = ai.killSwitchOn ? "kill_switch" : "live_ai_disabled";
          patch({
            correctionRecheckStatus: "unavailable",
            correctionRecheckedAt: now(),
            ...(ai.missingKeys.length > 0 ? { correctionRecheckMissingKeys: [...ai.missingKeys] } : {}),
          });
          emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "correction_recheck_completed", metadata: { code: review.cleanCode, status: "unavailable", reason } });
          return;
        }

        patch({ correctionRecheckStatus: "requested", correctionRecheckedAt: now() });
        try {
          // D4-follow-up: live-auth mode requires idToken + businessId on every POST (route.ts:294-324)
          // or this 401s "unauthenticated" - mock mode resolves {} and is unaffected.
          // P4 (#28): shared backoff helper - a human-triggered single action, not a storm contributor,
          // but gets the same honest-Retry-After/jitter resilience for consistency.
          const res = await fetchWithBackoff("/api/ai-lookup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...(await aiRequestAuth(get().businessId)),
              mode: "decode", rawCode: review.rawCode, cleanCode: review.cleanCode, codeType: detectCodeType(review.cleanCode), confidenceThreshold: 0.85,
            }),
          });
          const data = await res.json();
          const decision = data.decision;
          const results: AiLookupResult[] = data.results ?? [];
          const best = results[0] ?? null;
          const status: "verified_correction" | "insufficient_evidence" | "conflict" =
            decision?.status === "verified" ? "verified_correction" : decision?.status === "conflict" ? "conflict" : "insufficient_evidence";

          if (status === "verified_correction" && best) {
            // Recommendation is a SUGGESTION only - the human still approves it via Needs Review (no auto-save/count).
            patch({
              correctionRecheckStatus: status, correctionRecheckedAt: now(),
              suggestedProductName: best.productName, suggestedBrand: best.brand, suggestedCategory: best.category,
              suggestedSpecsShort: best.specsShort, suggestedPrimarySku: best.primarySku,
              suggestedPrimaryBarcode: scrubSuggestedBarcode(best.primaryBarcode, best.primarySku),
              suggestedGtin: scrubSuggestedBarcode(best.gtin, best.primarySku),
              suggestedUpc: scrubSuggestedBarcode(best.upc, best.primarySku),
              suggestedEan: scrubSuggestedBarcode(best.ean, best.primarySku),
              suggestedAliases: best.aliases ?? [],
              sourceUrls: best.sourceUrls ?? [], verifiedFacts: best.verifiedFacts ?? [], guesses: best.guesses ?? [],
              hasSuggestion: true, decodeStatus: "verified", confidence: decision?.confidence ?? best.confidence ?? 0,
              evidenceStrength: decision?.evidenceStrength ?? "none", exactCodeEvidenceVerifiedByApp: Boolean(decision?.exactCodeEvidenceVerifiedByApp),
              crossCheckDecision: decision?.crossCheck?.decision ?? "",
              reason: "Correction recheck: verified correction suggested. Approve to save (still requires your confirmation).",
            });
          } else {
            // insufficient_evidence | conflict -> keep in Needs Review, safe message, NO trusted suggestion.
            patch({
              correctionRecheckStatus: status, correctionRecheckedAt: now(),
              decodeStatus: status === "conflict" ? "conflict" : "needs_review",
              reason: status === "conflict"
                ? "Correction recheck: sources conflict on identity. Kept in Needs Review - resolve manually."
                : "Correction recheck: insufficient evidence to auto-correct. Kept in Needs Review.",
            });
          }
          emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "correction_recheck_completed", metadata: { code: review.cleanCode, status } });
        } catch {
          patch({ correctionRecheckStatus: "unavailable", correctionRecheckedAt: now() });
          emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "correction_recheck_completed", metadata: { code: review.cleanCode, status: "error" } });
        }
      },
  };
}
