import type {
  PendingSyncItem,
  Product,
  ResolverResult,
  ScanEvent,
  SyncOperation,
  UnknownCodeReview,
} from "@/types";
import type { IncrementPayload } from "@/sync-database/mock/mockDb";
import { cleanScanCode } from "@/scanning/clean/scanCleaner";
import { detectCodeType } from "@/products/match/codeTypeDetector";
import { resolveScan } from "@/products/match/resolver";
import { isLikelyMisreadGtin } from "@/products/barcodes/misread";
import { incrementInventoryCount } from "@/inventory/ledger";
import { buildIdempotencyKey } from "@/inventory/idempotency";
import { isUsableProductName } from "@/decoding/decode";
import { getIdentityConfidenceBand } from "@/decoding/identityConfidenceBand";
import { decideLookup, observeScan } from "@/products/catalog/localCatalogProvider";
import { prefixFloorName } from "@/products/catalog/prefixFloor";
import { detectIdentityContextConflict, conflictReason } from "@/decoding/scanContextFirewall";
import { provisionalPlaceholderName } from "@/stores/scan/placeholders";
import { evaluateAutoDecode, isPlatformOwnerForGateBypass } from "@/stores/scan/decodeGates";
import { trustedExactProbeCandidate, RECENT_LOCATIONS_CAP } from "@/stores/scanStore";
import { makeQueueItem, stampScanEventLocation } from "@/stores/scan/queueItem";
import type { ScanState, ScanStoreDeps } from "@/stores/scanStore";

export function createScanSlice(ctx: {
  set: (partial: Partial<ScanState> | ((s: ScanState) => Partial<ScanState>)) => void;
  get: () => ScanState;
  deps: ScanStoreDeps;
  idFactory: () => string;
  now: () => string;
  emitAudit: (e: { entityType: string; entityId: string; action: string; metadata?: Record<string, unknown> }) => void;
  enqueueAndSync: (items: PendingSyncItem[]) => void;
  sanitizeLiveScanStateShape: () => string[];
  trustedExactProbeEnabled: boolean;
  trustedExactProbes: Map<string, UnknownCodeReview>;
  trustedExactProbeIdsByCode: Map<string, string>;
  trustedExactProbeReviewIds: Set<string>;
  getTrustedExactProbeGeneration: () => number;
}): Pick<ScanState,
  "setLocation" | "processScan" | "ensureProvisionalCount"
> {
  const {
    set, get, deps, idFactory, now, emitAudit, enqueueAndSync, sanitizeLiveScanStateShape,
    trustedExactProbeEnabled, trustedExactProbes, trustedExactProbeIdsByCode, trustedExactProbeReviewIds,
    getTrustedExactProbeGeneration,
  } = ctx;

  // P6 C2: set-once stamp of this business's first EVER counted scan (any path). Called AFTER the
  // count has already been applied at each call site (never before - TOP-LEVEL LAW: counting is never
  // gated on this). Idempotent: a no-op once firstScanAt is already set, so re-scans/re-entries never
  // overwrite the original timestamp. Local Zustand-persisted state only (MOCK-BACKEND rule, review
  // F5) - live-auth mode mirroring this to the business doc is deferred, not built here.
  const markFirstScanIfNeeded = () => {
    if (get().firstScanAt != null) return;
    set({ firstScanAt: now() });
  };

  return {
      setLocation: (location) => {
        const trimmed = location.trim();
        if (!trimmed) return;
        set((s) => {
          const withoutDup = s.recentLocations.filter((l) => l !== trimmed);
          const next = [...withoutDup, trimmed];
          return {
            location: trimmed,
            recentLocations: next.length > RECENT_LOCATIONS_CAP ? next.slice(next.length - RECENT_LOCATIONS_CAP) : next,
          };
        });
      },

      processScan: (rawInput) => {
        // LAYER C / OUTER SAFETY NET (third-review hardening, 2026-08-16; widened FOURTH-review,
        // 2026-08-16): LAYER A (persist merge) and LAYER B (sanitizeLiveScanStateShape, just below)
        // close every KNOWN wrong-shape variant found so far. But a reviewer has now found this class
        // of bug FOUR times - the only way to guarantee the TOP-LEVEL LAW against a still-unknown
        // variant is to make processScan itself structurally incapable of letting a throw escape
        // without first committing a safe row. FINDING 1 (independent Codex clean-room review,
        // 2026-08-16): the try used to start AFTER session initialization (ensureAutoSession, which
        // calls getOrCreateDeviceId -> raw localStorage.getItem/setItem) - a throw there (Safari private
        // mode, blocked cookies, full quota) escaped processScan entirely with no Layer C log, no
        // fallback row, no count. The try now starts at the very top of this action so NOTHING in its
        // synchronous body - including session init - sits outside the safety net. `cleanedCaught` and
        // `scanEventIdCaught` are hoisted `let`s (assigned inside the try, never re-declared) purely so
        // the catch can still identify which physical scan needs recovering.
        let cleanedCaught: ReturnType<typeof cleanScanCode> | undefined;
        let scanEventIdCaught: string | undefined;
        try {
        // TOP-LEVEL LAW / Phase 3 defect F1: a scanned code must ALWAYS appear on the feed and count,
        // even when the current session is locked (owner PIN) or completed (Finish). Those guards
        // decide the session's own frozen/read-only status; they must never make a physical scan
        // vanish. So instead of dropping the scan, ROTATE to a fresh active session and count it
        // there - reusing the exact mechanism ensureAutoSession/mount already use for a stale/absent
        // session - leaving the locked/completed session and its counts untouched and auditable.
        // Callers (the scan page) also call ensureAutoSession before every scan batch; this is the
        // hard backstop for any path (including the internal resolveUnknown -> processScan re-apply
        // call) that does not.
        if (!get().sessionId || !get().currentSession || get().currentSession?.locked || get().currentSession?.status === "completed") {
          get().ensureAutoSession();
        }
        const scanLocation = get().location;
        const scanDeviceId = get().deviceId;
        const cleaned = cleanScanCode(rawInput);
        cleanedCaught = cleaned;
        if (!cleaned.cleanCode) return null;

        // LAYER B (persist-corruption defect, 2026-08-13): defense in depth alongside LAYER A's persist
        // `merge` sanitizer above. `ensureProvisionalCount`'s ordering already enforces the TOP-LEVEL
        // LAW that every scan appears + counts - but that guarantee only holds if nothing BEFORE (or
        // called FROM) it can throw. `products`/`aliases` are filtered/mapped/found across the resolver,
        // the alias matcher, AND ensureProvisionalCount itself (all reading live store state via get()),
        // so a wrong-shape value reaching this far - from any future path, not just the persist boundary
        // LAYER A already closes - would throw somewhere in that chain and silently drop the scan.
        // Sanitize the STORE STATE itself (not just a local copy) so every subsequent get() in this
        // call, including nested action calls like ensureProvisionalCount, sees well-shaped data too.
        // Loudly logged, never silently swallowed.
        const stateShapeIssues = sanitizeLiveScanStateShape();
        if (stateShapeIssues.length > 0) {
          console.error(
            `[scanStore] processScan: store state had wrong-shape field(s) (${stateShapeIssues.join(", ")}); ` +
              `reset to [] so this scan still appears and counts (TOP-LEVEL LAW).`,
          );
        }
        const { products, aliases, businessId, sessionId } = get();
        // Deterministic resolver only. AI is never consulted here. Known requires verified/approved.
        // Wrapped: any unexpected throw inside resolution degrades this scan to "unidentified" (still
        // appears + counts via the needs_review path below) instead of propagating out of processScan
        // and silently dropping the row.
        let resolution: ResolverResult;
        try {
          resolution = resolveScan(cleaned, products, aliases, businessId);
        } catch (err) {
          console.error(
            `[scanStore] resolveScan threw for code '${cleaned.cleanCode}'; degrading to unidentified ` +
              `so the scan still appears and counts (TOP-LEVEL LAW).`,
            err,
          );
          resolution = {
            rawCode: cleaned.rawCode,
            cleanCode: cleaned.cleanCode,
            normalizedCandidates: cleaned.normalizedCandidates,
            codeType: "messy",
            resolverStatus: "needs_review",
            matchType: "unknown",
            productId: null,
            confidence: 0,
            reason: "Internal error while resolving this code; it was routed to Needs Review as unidentified.",
          };
        }
        const scanEventId = idFactory();
        scanEventIdCaught = scanEventId;
        const createdAt = now();
        const keyFor = (op: SyncOperation) =>
          buildIdempotencyKey(businessId, sessionId, scanEventId, op);

        const isKnown = resolution.resolverStatus === "known" && !!resolution.productId;
        // Phase 8C SIDE-DOOR FIREWALL: a deterministic "known" match (approved alias or verified product)
        // can still carry a POISONED identity - e.g. a verified product whose primaryBarcode is a tire UPC
        // that a public source mislabels as a rivet kit. The original firewall only ran inside the AI
        // decode path, so such a match would auto-count with NO AI and NO firewall. Re-check the matched
        // product's domain against the scan context; on conflict it must NOT count -> route to Needs Review.
        const matchedProduct = resolution.productId
          ? products.find((p) => p.id === resolution.productId)
          : undefined;
        const knownConflict = isKnown
          ? detectIdentityContextConflict(get().settings.scanContext ?? "any", matchedProduct)
          : null;
        const countable = isKnown && !knownConflict;
        // PHASE 2 re-scan dedup: the deterministic resolver only returns "known" for an APPROVED alias /
        // VERIFIED product. A weak AI suggestion is counted as a PROVISIONAL product (verified:false, NO
        // approved alias), which the resolver intentionally misses - so a re-scan would re-decode / duplicate.
        // Bridge it deterministically: if a STILL-COUNTED, UNVERIFIED product carries this exact code as an
        // identifier, count THAT product (exact identifier match only, never fuzzy, no AI). A human approval
        // later flips it verified + approved, after which the resolver matches it as a normal Known.
        let provMatchId: string | null = null;
        if (!countable && !knownConflict) {
          const countedIds = new Set(get().finalCounts.map((c) => c.productId));
          const ids = [cleaned.cleanCode, ...(cleaned.normalizedCandidates ?? [])];
          provMatchId =
            products.find(
              (p) =>
                countedIds.has(p.id) &&
                p.status !== "archived" &&
                p.provisional === true &&
                [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].map((c) => (c ?? "").trim()).some((c) => !!c && ids.includes(c)),
            )?.id ?? null;
        }
        const pendingTrustedExactReview = provMatchId
          ? get().needsReviewQueue.find(
              (review) =>
                trustedExactProbeReviewIds.has(review.id)
                && review.provisionalProductId === provMatchId
                && review.sessionId === sessionId
                && review.cleanCode === cleaned.cleanCode
                && review.status === "open"
                && review.decodeStatus === "decoding",
            ) ?? [...trustedExactProbes.values()].find(
              (probe) =>
                probe.provisionalProductId === provMatchId
                && probe.sessionId === sessionId
                && probe.cleanCode === cleaned.cleanCode,
            )
          : undefined;
        const effectiveProductId = resolution.productId ?? provMatchId;
        const effectiveCountable = countable || !!provMatchId;
        if (knownConflict === "category_context_conflict") {
          // Phase 9: surface the non-blocking category warning banner (the scan still routes to review).
          set({ lastCategoryWarning: { code: cleaned.cleanCode, productName: matchedProduct?.name ?? "this product", reason: knownConflict } });
        }

        const event: ScanEvent = stampScanEventLocation(
          {
            id: scanEventId,
            businessId,
            sessionId,
            rawCode: cleaned.rawCode,
            cleanCode: cleaned.cleanCode,
            normalizedCandidates: cleaned.normalizedCandidates,
            matchedProductId: effectiveProductId,
            matchType: resolution.matchType,
            status: effectiveCountable ? "known" : resolution.resolverStatus === "conflict" ? "conflict" : "needs_review",
            resolverStatus: resolution.resolverStatus,
            codeType: resolution.codeType,
            reason: pendingTrustedExactReview?.reason
              ?? (provMatchId ? "Counted (suggested - awaiting your confirmation)." : resolution.reason),
            decodeStatus: pendingTrustedExactReview ? "decoding" : provMatchId ? "suggested" : undefined,
            quantityDelta: effectiveCountable ? 1 : 0,
            quantityAfterScan: 0,
            createdAt,
            source: "scan",
            notes: resolution.reason,
            syncStatus: "pending",
            idempotencyKey: keyFor("INCREMENT_COUNT"),
            syncError: null,
          },
          scanLocation,
          scanDeviceId,
        );

        // BEST GUESS ON EVERY SCAN OF THE CODE (owner decision 2026-08-19): a repeat scan of a code whose
        // best guess is already on screen carries the SAME pending suggestion (and its confirm controls)
        // onto this new row, instead of a bare row with no identity. Display only - the decode that
        // produced it settled long ago, so this costs nothing and re-decodes nothing.
        // Never on a deterministically KNOWN row: that identity is settled, a guess would only muddy it.
        const awaitingReview = isKnown
          ? undefined
          : get().needsReviewQueue.find(
              (r) =>
                r.cleanCode === cleaned.cleanCode &&
                (r.status === "open" || r.status === "suggested") &&
                isUsableProductName(r.suggestedProductName),
            );
        if (awaitingReview) {
          event.suggestion = {
            productName: awaitingReview.suggestedProductName,
            brand: awaitingReview.suggestedBrand,
            confidence: awaitingReview.confidence,
            // No status passed: a review still awaiting a human is by definition not a verified identity.
            band: getIdentityConfidenceBand({
              confidence: awaitingReview.confidence,
              evidenceStrength: awaitingReview.evidenceStrength,
              exactCodeEvidenceVerifiedByApp: awaitingReview.exactCodeEvidenceVerifiedByApp,
            }),
            status: "pending",
          };
        }

        if (effectiveCountable && effectiveProductId) {
          // Deterministic increment in local state FIRST (instant UI, no server round-trip).
          const { counts, count } = incrementInventoryCount(get().finalCounts, event, idFactory);
          event.quantityAfterScan = count.quantity;

          set((s) => ({
            scanFeed: [event, ...s.scanFeed],
            finalCounts: counts.map((c) =>
              c.productId === event.matchedProductId && c.sessionId === event.sessionId
                ? { ...c, location: scanLocation }
                : c,
            ),
          }));
          // P6 C2: written AFTER the count above is applied - never before (TOP-LEVEL LAW).
          markFirstScanIfNeeded();

          const incPayload: IncrementPayload = {
            businessId,
            sessionId,
            productId: effectiveProductId,
            scanEventId,
            quantityDelta: 1,
            idempotencyKey: keyFor("INCREMENT_COUNT"),
          };
          enqueueAndSync([
            makeQueueItem({
              idFactory,
              now,
              businessId,
              sessionId,
              entityType: "ScanEvent",
              entityId: scanEventId,
              operation: "SAVE_SCAN_EVENT",
              payload: event,
              idempotencyKey: keyFor("SAVE_SCAN_EVENT"),
              scanEventId,
            }),
            makeQueueItem({
              idFactory,
              now,
              businessId,
              sessionId,
              entityType: "InventoryCount",
              entityId: count.id,
              operation: "INCREMENT_COUNT",
              payload: incPayload,
              idempotencyKey: keyFor("INCREMENT_COUNT"),
              scanEventId,
            }),
          ]);
          return event;
        }

        if (isKnown && knownConflict && resolution.productId) {
          // SIDE-DOOR FIREWALL block: the matched product contradicts the tire scan context (a poisoned
          // identity reached via the deterministic path). Do NOT count. Surface it for human relink,
          // carrying the suspect product so the owner sees what it WOULD have been. No AI is run here -
          // re-decoding would just return the same poisoned public source.
          const conflictText = conflictReason(knownConflict);
          event.decodeStatus = "needs_review";
          event.reason = conflictText;
          event.notes = conflictText;
          set((s) => ({ scanFeed: [event, ...s.scanFeed] }));
          const alreadyOpen = get().needsReviewQueue.find(
            (r) => r.cleanCode === cleaned.cleanCode && r.status === "open",
          );
          if (!alreadyOpen) {
            const review: UnknownCodeReview = {
              id: idFactory(),
              businessId,
              sessionId,
              rawCode: cleaned.rawCode,
              cleanCode: cleaned.cleanCode,
              normalizedCandidates: cleaned.normalizedCandidates,
              suggestedProductName: matchedProduct?.name ?? "",
              suggestedBrand: matchedProduct?.brand ?? "",
              suggestedCategory: matchedProduct?.category ?? "",
              suggestedSpecsShort: matchedProduct?.specsShort ?? "",
              suggestedSpecsFull: matchedProduct?.specsFull ?? "",
              suggestedPrimarySku: matchedProduct?.primarySku ?? "",
              suggestedPrimaryBarcode: matchedProduct?.primaryBarcode ?? "",
              suggestedGtin: matchedProduct?.gtin ?? "",
              suggestedUpc: matchedProduct?.upc ?? "",
              suggestedEan: matchedProduct?.ean ?? "",
              suggestedImageUrl: "",
              suggestedProductUrl: "",
              suggestedAliases: [],
              sourceUrls: [],
              verifiedFacts: [],
              guesses: [],
              reason: conflictText,
              providerName: "",
              confidence: 0,
              hasSuggestion: !!matchedProduct,
              decodeStatus: "needs_review",
              evidenceStrength: "none",
              exactCodeEvidenceVerifiedByApp: false,
              crossCheckDecision: "",
              status: "open",
              createdAt,
              resolvedAt: null,
              resolvedBy: null,
              resolutionAction: null,
              syncStatus: "pending",
              idempotencyKey: keyFor("SAVE_UNKNOWN_SCAN"),
            };
            set((s) => ({ needsReviewQueue: [...s.needsReviewQueue, review] }));
            enqueueAndSync([
              makeQueueItem({
                idFactory,
                now,
                businessId,
                sessionId,
                entityType: "UnknownCodeReview",
                entityId: review.id,
                operation: "SAVE_UNKNOWN_SCAN",
                payload: review,
                idempotencyKey: keyFor("SAVE_UNKNOWN_SCAN"),
                scanEventId,
              }),
            ]);
            emitAudit({
              entityType: "UnknownCodeReview",
              entityId: review.id,
              action: "context_conflict_blocked",
              metadata: { code: cleaned.cleanCode, productId: resolution.productId, kind: knownConflict },
            });
          }
          // OWNER RULE "scan N = count N": even a known-but-context-conflicted scan must COUNT (the physical
          // item is on the shelf). Count it provisionally against a SAFE "Unidentified item" placeholder -
          // never against the suspect/poisoned matched product - and keep the review open so a human confirms
          // the real identity. ensureProvisionalCount is idempotent PER CODE (mints the placeholder once and
          // counts it once) - it never counts a REPEAT physical scan of the same conflicted code (F-02,
          // TOP-LAW). Detect a repeat the same way the provMatchId bridge does for non-conflict provisionals
          // (2208-2222): if a safe placeholder for this code is ALREADY counted, mint a FRESH counting event
          // (this scan's own scanEventId + idempotency keys) directly against that placeholder - never
          // against the poisoned resolution.productId - so N repeated conflict scans produce N counts.
          const conflictCandidates = [cleaned.cleanCode, ...(cleaned.normalizedCandidates ?? [])];
          const conflictCountedIds = new Set(get().finalCounts.map((c) => c.productId));
          const repeatPlaceholderId =
            get().products.find(
              (p) =>
                conflictCountedIds.has(p.id) &&
                p.status !== "archived" &&
                p.provisional === true &&
                [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku]
                  .map((c) => (c ?? "").trim())
                  .some((c) => !!c && conflictCandidates.includes(c)),
            )?.id ?? null;
          if (repeatPlaceholderId) {
            const repeatEvent: ScanEvent = {
              ...event,
              matchedProductId: repeatPlaceholderId,
              status: "known",
              quantityDelta: 1,
              decodeStatus: "suggested",
            };
            const { counts, count } = incrementInventoryCount(get().finalCounts, repeatEvent, idFactory);
            repeatEvent.quantityAfterScan = count.quantity;
            set((s) => ({
              scanFeed: s.scanFeed.map((e) => (e.id === repeatEvent.id ? repeatEvent : e)),
              finalCounts: counts.map((c) =>
                c.productId === repeatEvent.matchedProductId && c.sessionId === repeatEvent.sessionId
                  ? { ...c, location: scanLocation }
                  : c,
              ),
            }));
            // P6 C2: written AFTER the count above is applied - never before (TOP-LEVEL LAW).
            markFirstScanIfNeeded();
            const repeatIncPayload: IncrementPayload = {
              businessId,
              sessionId,
              productId: repeatPlaceholderId,
              scanEventId,
              quantityDelta: 1,
              idempotencyKey: keyFor("INCREMENT_COUNT"),
            };
            enqueueAndSync([
              makeQueueItem({
                idFactory,
                now,
                businessId,
                sessionId,
                entityType: "ScanEvent",
                entityId: scanEventId,
                operation: "SAVE_SCAN_EVENT",
                payload: repeatEvent,
                idempotencyKey: keyFor("SAVE_SCAN_EVENT"),
                scanEventId,
              }),
              makeQueueItem({
                idFactory,
                now,
                businessId,
                sessionId,
                entityType: "InventoryCount",
                entityId: count.id,
                operation: "INCREMENT_COUNT",
                payload: repeatIncPayload,
                idempotencyKey: keyFor("INCREMENT_COUNT"),
                scanEventId,
              }),
            ]);
            get().recordFeedback("conflict_detected", { code: cleaned.cleanCode });
            return repeatEvent;
          }
          get().ensureProvisionalCount(cleaned.cleanCode, conflictText);
          // STABLE-ID FIX: the placeholder now exists (minted just above); stamp its id onto this review
          // (new or pre-existing open one) so resolveUnknown can re-link by id after a customer reload
          // instead of by reconstructed name (see provisionalProductId doc comment in types.ts).
          const conflictPlaceholder = get().products.find(
            (p) => p.provisional === true && p.status !== "archived" && p.primaryBarcode === cleaned.cleanCode,
          );
          if (conflictPlaceholder) {
            set((s) => ({
              needsReviewQueue: s.needsReviewQueue.map((r) =>
                r.cleanCode === cleaned.cleanCode && r.status === "open" && !r.provisionalProductId
                  ? { ...r, provisionalProductId: conflictPlaceholder.id }
                  : r,
              ),
            }));
          }
          get().recordFeedback("conflict_detected", { code: cleaned.cleanCode });
          return event;
        }

        // Unknown or conflict. AGGRESSIVE AUTO DECODE: if AI is on and a key is configured, run the
        // live decode pipeline automatically instead of dropping straight to passive Needs Review.
        const settings = get().settings;
        const today = createdAt.slice(0, 10);
        const dailyCount = settings.lastResetDate === today ? settings.dailyLookupCount : 0;
        let autoGate = evaluateAutoDecode({
          aiEnabled: settings.aiLookupEnabled,
          status: get().aiStatus,
          online: get().online,
          dailyCount,
          dailyLimit: settings.dailyLookupLimit,
          breaker: get().breaker,
          now: new Date(createdAt).getTime(),
          platformOwner: isPlatformOwnerForGateBypass(get().userId),
        });
        // A3 (owner-ratified 2026-07-15, narrowed by AM-2): a code whose GS1 check digit fails can
        // never decode correctly because every downstream identity lookup keys off the code - dispatching the
        // decode here only burns time and cap budget chasing a doomed lookup. Skip auto-decode
        // entirely; the row stays a normal, aliasable needs_review row (never "decoding") with the
        // additive misread reason already set by the resolver. Overriding here (rather than after
        // row creation) keeps decodeStatus honest from the very first render - never "decoding" then
        // silently reverted. A valid unknown GTIN is never affected by this check.
        // QA HARDENING FIX #6 (live-proven): captured once and reused below at the catalog-first seam -
        // a misread code must never mint a fabricated identity there either (see that call site).
        const misread = isLikelyMisreadGtin(cleaned.cleanCode);
        if (misread) {
          autoGate = { allowed: false, reason: "Scan misread - decode was not attempted." };
        }
        const deterministicCandidate = trustedExactProbeCandidate(cleaned.cleanCode);
        const deterministicLookupEligible = trustedExactProbeEnabled
          && get().online
          && deterministicCandidate;
        const lookupPending = autoGate.allowed || deterministicLookupEligible;

        const existingOpen = get().needsReviewQueue.find(
          (r) => r.cleanCode === cleaned.cleanCode && r.status === "open",
        );

        // Customer-safe split: the feed REASON is the deterministic resolver explanation only (product-
        // facing, no AI/provider/Settings mechanics). The auto-decode "why" (e.g. lookup not configured)
        // goes to decodeNote, which LiveScanFeed shows ONLY to platformOwner. The internal gate reason
        // text is unchanged (still used for aiLookupLogs/diagnostics).
        event.decodeStatus = existingOpen?.decodeStatus ?? (lookupPending ? "decoding" : "needs_review");
        event.reason = existingOpen?.reason ?? resolution.reason;
        event.decodeNote = existingOpen?.decodeNote ?? autoGate.reason;

        set((s) => ({ scanFeed: [event, ...s.scanFeed] }));

        // OWNER RULE "scan N = count N": count EVERY unresolved scan immediately, synchronously, before any
        // network work. The AI/catalog lookup below only ENRICHES this provisional row (name/verified); it
        // can never again decide whether the scan counts. ensureProvisionalCount is idempotent, so the later
        // decode handlers (which filter on status !== "known") find nothing to re-count.
        get().ensureProvisionalCount(cleaned.cleanCode, resolution.reason);

        if (deterministicLookupEligible) {
          // Repeats share the in-flight probe, while each physical scan has already received its own
          // synchronous feed/count event above.
          if (trustedExactProbeIdsByCode.has(cleaned.cleanCode)) return event;
          const mintedPlaceholder = get().products.find(
            (p) => p.provisional === true && p.status !== "archived" && p.primaryBarcode === cleaned.cleanCode,
          );
          const probe: UnknownCodeReview = {
            id: idFactory(), businessId, sessionId, rawCode: cleaned.rawCode, cleanCode: cleaned.cleanCode,
            normalizedCandidates: cleaned.normalizedCandidates,
            suggestedProductName: "", suggestedBrand: "", suggestedCategory: "", suggestedSpecsShort: "", suggestedSpecsFull: "",
            suggestedPrimarySku: "", suggestedPrimaryBarcode: "", suggestedGtin: "", suggestedUpc: "", suggestedEan: "",
            suggestedImageUrl: "", suggestedProductUrl: "", suggestedAliases: [], sourceUrls: [], verifiedFacts: [], guesses: [],
            reason: resolution.reason, decodeNote: autoGate.reason, providerName: "", confidence: 0, hasSuggestion: false,
            decodeStatus: "decoding", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheckDecision: "",
            status: "open", createdAt, resolvedAt: null, resolvedBy: null, resolutionAction: null, syncStatus: "pending",
            idempotencyKey: keyFor("SAVE_UNKNOWN_SCAN"), provisionalProductId: mintedPlaceholder?.id ?? null,
            suggestedLinkProductId: resolution.nearMatchSuggestion?.productId,
          };
          trustedExactProbes.set(probe.id, probe);
          trustedExactProbeIdsByCode.set(probe.cleanCode, probe.id);
          trustedExactProbeReviewIds.add(probe.id);
          void get().liveDecode(probe.id, {
            deterministicOnly: true,
            invalidationGeneration: getTrustedExactProbeGeneration(),
          }).then(
            () => trustedExactProbeReviewIds.delete(probe.id),
            () => trustedExactProbeReviewIds.delete(probe.id),
          );
          return event;
        }

        if (!existingOpen) {
          // STABLE-ID FIX: ensureProvisionalCount just ran synchronously above, so this code's placeholder
          // product (if one was minted) already exists in state. Capture its id now so resolveUnknown can
          // re-link this review to it by id later, even after a customer reload strips the placeholder's
          // `provisional` flag and identifier fields (see provisionalProductId doc comment in types.ts).
          const mintedPlaceholder = get().products.find(
            (p) => p.provisional === true && p.status !== "archived" && p.primaryBarcode === cleaned.cleanCode,
          );
          const review: UnknownCodeReview = {
            id: idFactory(),
            businessId,
            sessionId,
            rawCode: cleaned.rawCode,
            cleanCode: cleaned.cleanCode,
            normalizedCandidates: cleaned.normalizedCandidates,
            suggestedProductName: "",
            suggestedBrand: "",
            suggestedCategory: "",
            suggestedSpecsShort: "",
            suggestedSpecsFull: "",
            suggestedPrimarySku: "",
            suggestedPrimaryBarcode: "",
            suggestedGtin: "",
            suggestedUpc: "",
            suggestedEan: "",
            suggestedImageUrl: "",
            suggestedProductUrl: "",
            suggestedAliases: [],
            sourceUrls: [],
            verifiedFacts: [],
            guesses: [],
            reason: resolution.reason,
            decodeNote: autoGate.reason,
            providerName: resolution.resolverStatus === "conflict" ? "conflict" : "",
            confidence: 0,
            hasSuggestion: false,
            decodeStatus: lookupPending ? "decoding" : "needs_review",
            evidenceStrength: "none",
            exactCodeEvidenceVerifiedByApp: false,
            crossCheckDecision: "",
            status: "open",
            createdAt,
            resolvedAt: null,
            resolvedBy: null,
            resolutionAction: null,
            syncStatus: "pending",
            idempotencyKey: keyFor("SAVE_UNKNOWN_SCAN"),
            provisionalProductId: mintedPlaceholder?.id ?? null,
            // QA Task 8 (owner-approved 2026-07-15): review-only "Did you mean <X>?" near-match SKU
            // suggestion from the deterministic resolver (distance<=1, single candidate only - see
            // resolver.ts findNearMatchSuggestion). Reuses the EXACT same one-tap "Link to <product>"
            // UI/path as the identity-merge suggest_link (NeedsReviewTable's suggestedLinkProductId),
            // which already routes exclusively through the human-approved link_existing action. This
            // NEVER auto-counts and NEVER auto-aliases - resolverStatus/decodeStatus above are
            // untouched (still a normal needs_review row awaiting a human).
            suggestedLinkProductId: resolution.nearMatchSuggestion?.productId,
          };
          set((s) => ({ needsReviewQueue: [...s.needsReviewQueue, review] }));
          enqueueAndSync([
            makeQueueItem({
              idFactory,
              now,
              businessId,
              sessionId,
              entityType: "UnknownCodeReview",
              entityId: review.id,
              operation: "SAVE_UNKNOWN_SCAN",
              payload: review,
              idempotencyKey: keyFor("SAVE_UNKNOWN_SCAN"),
              scanEventId,
            }),
          ]);
          emitAudit({ entityType: "UnknownCodeReview", entityId: review.id, action: "unknown_review_created", metadata: { code: cleaned.cleanCode } });

          if (resolution.resolverStatus === "conflict") {
            get().recordFeedback("conflict_detected", { code: cleaned.cleanCode });
          }

          // Every trusted-exact candidate gets the isolated deterministic-only request first. A valid
          // GTIN miss may later enter the unchanged ordinary queue; non-GTIN, misread, and gate-blocked
          // misses remain counted/reviewable without provider egress.
          // CATALOG-FIRST (offline-first, saves AI tokens): private shop override -> verified shared
          // catalog. A verified hit resolves + counts with NO AI, even with no key / offline. AI only
          // runs on a miss or a weak/conflicting catalog hit.
          // QA HARDENING FIX #6 (live-proven, 2026-07-16): a misread (bad-check-digit) GTIN must NEVER
          // attach a fabricated identity here either. `codeSet.has(entry.normalizedBarcode)` in
          // localCatalogProvider.ts has no check-digit awareness, so a bad code that happens to
          // string-match a seeded catalog entry's normalizedBarcode (e.g. a coincidental zero-pad
          // collision) would otherwise mint a named product via resolveUnknown("create_new",
          // {origin:"catalog"}) - the exact bug that attached "Healthyholics" to an invalid UPC. Skip
          // computing `decision` entirely when misread (cleaner than gating the `if` below): this also
          // avoids polluting the catalog's timesScanned/observeScan bookkeeping with a bad-code hit.
          // The row already fell through to needs_review with the honest misread reason set above.
          const codes = [cleaned.cleanCode, ...cleaned.normalizedCandidates];
          const decision = misread
            ? { source: "none" as const, hit: null, shouldResolveWithoutAi: false, shouldTryAi: true }
            : decideLookup(get().catalog, get().shopOverrides, codes, businessId);
          // Phase 8C: a verified-catalog / shop-override hit is also a NON-AI auto-count path - apply the
          // same context firewall. A clearly non-tire hit in tire context must not shortcut-count; let it
          // fall through to the AI decode path (where the firewall + human review handle it).
          const catalogConflict = decision.hit
            ? detectIdentityContextConflict(get().settings.scanContext ?? "any", decision.hit)
            : null;
          if (decision.shouldResolveWithoutAi && decision.hit && !catalogConflict) {
            const fromOverride = decision.source === "shop_override";
            get().recordFeedback(fromOverride ? "found_from_override" : "found_from_catalog", {
              code: cleaned.cleanCode,
            });
            if (decision.source === "verified_catalog") {
              set({ catalog: observeScan(get().catalog, codes, now()) });
            }
            get().markFeedRowVerified(
              cleaned.cleanCode,
              `Matched from ${fromOverride ? "shop override" : "verified catalog"} - no AI used.`,
            );
            get().resolveUnknown(review.id, "create_new", {
              applyToCount: true,
              origin: "catalog",
              newProduct: {
                name: decision.hit.name,
                brand: decision.hit.brand,
                category: decision.hit.category,
                imageUrl: decision.hit.imageUrl,
                productUrl: decision.hit.productUrl,
                primaryBarcode: cleaned.cleanCode,
                source: "catalog",
              },
            });
            return event;
          }

          // Fall back to live AI decode (subject to the existing gate). A human still approves anything
          // not auto-accepted. AI is never called for a known/approved scan or a verified catalog hit.
          // Option 1 wiring: if the cloud dep is present and we're online, try the global catalog first;
          // cloudCatalogResolve falls through to AI internally on a miss / firewall conflict.
          if (deps.lookupGlobalCatalog && get().online) {
            // FIX 5: swallow a rejection here (e.g. a dev-assert throw from the GC1 hard invariant)
            // so it never becomes an unhandled promise rejection - siblings already do this (line ~1138).
            void get().cloudCatalogResolve(review.id, codes).catch(() => {});
          } else if (autoGate.allowed) {
            void get().liveDecode(review.id);
          } else {
            // AI decode SKIPPED. Only fire the provisional fallback when decode was INTENDED but blocked
            // by a TRANSIENT cause (circuit breaker, rate-limit, offline, cap). When AI is explicitly
            // disabled or keys are missing, the scan goes to Needs Review without a provisional count
            // (the user chose not to decode — do not fabricate a product).
            const s = get();
            const aiIntended = s.settings.aiLookupEnabled && s.aiStatus.openaiConfigured;
            if (aiIntended) {
              get().applyDecodeFallback(
                review.id,
                `${autoGate.reason ?? "AI decode unavailable."} Counted as unverified; retry to identify.`.trim(),
              );
            }
          }
        }
        return event;
        } catch (outerErr) {
          // LAYER C catch: log loudly (never silently swallowed) and guarantee the row still appears
          // and counts. ensureProvisionalCount is idempotent - if a scanFeed row for this code was
          // already committed by an earlier branch before the throw, it repoints THAT row instead of
          // minting a duplicate; if none exists yet, it mints both the safe placeholder product and a
          // synthetic backing scanFeed row so the physical scan is never lost.
          //
          // FINDING 1 continued: `cleanedCaught` may still be unset (the throw happened before it was
          // ever assigned, e.g. inside ensureAutoSession/getOrCreateDeviceId before the fail-soft fix,
          // or some still-unknown FIFTH variant). cleanScanCode is pure and cheap - recompute it here,
          // defensively, so this recovery path still has a code to recover even in that case.
          let recoveredCleanCode: string;
          try {
            recoveredCleanCode = cleanedCaught ? cleanedCaught.cleanCode : cleanScanCode(rawInput).cleanCode;
          } catch (cleanErr) {
            console.error(
              `[scanStore] processScan: even recomputing the clean code failed for raw input; the scan ` +
                `cannot be recovered. This is the true last resort.`,
              cleanErr,
            );
            recoveredCleanCode = "";
          }
          console.error(
            `[scanStore] processScan: unexpected error while processing code '${recoveredCleanCode}'; ` +
              `routing to Needs Review as unidentified so the scan still appears and counts (TOP-LEVEL LAW).`,
            outerErr,
          );
          if (!recoveredCleanCode) {
            return get().scanFeed[0] ?? null;
          }
          try {
            get().ensureProvisionalCount(
              recoveredCleanCode,
              "Internal error while processing this scan; it was routed to Needs Review as unidentified.",
              // FINDING 2 FIX: pass THIS scan's own event id so ensureProvisionalCount's idempotent
              // shortcut cannot be fooled by an unrelated/stale existing count for the same code - see
              // its doc comment. Only meaningful when scanEventId was actually minted before the throw.
              scanEventIdCaught ? { verifyEventId: scanEventIdCaught } : undefined,
            );
          } catch (fallbackErr) {
            // True last resort: even the safe fallback path itself threw. Still never rethrow out of
            // processScan (that would be the original silent-drop defect all over again) - log and
            // return whatever the feed already shows for this code, if anything.
            console.error(
              `[scanStore] processScan: fallback ensureProvisionalCount ALSO threw for code ` +
                `'${recoveredCleanCode}'; the scan may not have counted. This is the true last resort.`,
              fallbackErr,
            );
          }
          // FINDING 3 (recovery must prove itself, not just claim success): assert a committed feed row
          // AND ledger application actually exist for THIS scan before calling the recovery successful.
          // A caller (or a human reading the log) must be able to tell "recovered" apart from "lost" -
          // returning an older same-code row as if it were proof of success is exactly how the original
          // loss stayed invisible.
          const recoveredState = get();
          const ownRecoveredRow = scanEventIdCaught
            ? recoveredState.scanFeed.find((e) => e.id === scanEventIdCaught)
            : recoveredState.scanFeed.find((e) => e.cleanCode === recoveredCleanCode);
          const ledgerHasOwnEvent =
            !!ownRecoveredRow &&
            recoveredState.finalCounts.some(
              (c) => c.productId === ownRecoveredRow!.matchedProductId && Array.isArray(c.scanEventIds) && c.scanEventIds.includes(ownRecoveredRow!.id),
            );
          if (!ownRecoveredRow || !ledgerHasOwnEvent) {
            console.error(
              `[scanStore] processScan: LAYER C RECOVERY FAILED for code '${recoveredCleanCode}' ` +
                `(scanEventId=${scanEventIdCaught ?? "unminted"}) - no feed row and/or ledger entry for THIS ` +
                `scan exists after the fallback ran. This scan may not have counted. Do not treat the ` +
                `return value of this call as proof of success.`,
            );
          }
          return ownRecoveredRow ?? recoveredState.scanFeed.find((e) => e.cleanCode === recoveredCleanCode) ?? null;
        }
      },
      ensureProvisionalCount: (code, reason, opts) => {
        const st0 = get();
        const freshTransferKeys = opts?.freshTransferKeys === true;
        const countIfFeedMissing = opts?.countIfFeedMissing !== false;
        // IDEMPOTENT: if this code is already counted (any path), do nothing - never double count.
        const counted = new Set(st0.finalCounts.map((c) => c.productId));
        const existing = st0.products.find(
          (p) =>
            counted.has(p.id) &&
            p.status !== "archived" &&
            [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].map((c) => (c ?? "").trim()).includes(code),
        );
        if (existing) {
          if (!opts?.verifyEventId) return existing.id;
          // FINDING 2 FIX (Codex clean-room review, 2026-08-16): do not trust "a count already exists
          // for this code" as proof THIS physical scan's own event was ever applied - the caller (the
          // Layer C recovery fallback) only reaches this opt-in path after an unexpected throw, and the
          // existing ledger row may be exactly the stale/corrupted record that caused it. Verify the
          // event id is actually present before treating this as a genuine idempotent no-op.
          const ledgerRow = st0.finalCounts.find(
            (c) => c.productId === existing.id && c.sessionId === st0.sessionId,
          );
          const alreadyLanded =
            Array.isArray(ledgerRow?.scanEventIds) && ledgerRow.scanEventIds.includes(opts.verifyEventId);
          if (alreadyLanded) return existing.id;
          // Not landed: force-count THIS scan against the SAME existing product now - never mint a
          // duplicate product row for a code that already has one, and never silently drop the scan
          // just because an (unrelated or stale) count for the same code happened to already exist.
          const forceReason = reason || "Recovered count (existing ledger entry for this code did not include this scan).";
          const forcedEvent: ScanEvent = {
            id: opts.verifyEventId,
            businessId: st0.businessId,
            sessionId: st0.sessionId,
            rawCode: code,
            cleanCode: code,
            normalizedCandidates: [],
            matchedProductId: existing.id,
            matchType: "unknown",
            status: "known",
            resolverStatus: "needs_review",
            codeType: detectCodeType(code),
            reason: forceReason,
            quantityDelta: 1,
            quantityAfterScan: 0,
            createdAt: now(),
            source: "scan",
            notes: forceReason,
            syncStatus: "pending",
            syncError: null,
            idempotencyKey: buildIdempotencyKey(st0.businessId, st0.sessionId, opts.verifyEventId, "INCREMENT_COUNT"),
          };
          const forced = incrementInventoryCount(st0.finalCounts, forcedEvent, idFactory);
          forcedEvent.quantityAfterScan = forced.count.quantity;
          set((st) => ({
            finalCounts: forced.counts,
            scanFeed: st.scanFeed.some((e) => e.id === forcedEvent.id)
              ? st.scanFeed.map((e) =>
                  e.id === forcedEvent.id
                    ? { ...e, matchedProductId: existing.id, status: "known" as const, quantityAfterScan: forcedEvent.quantityAfterScan, quantityDelta: 1 }
                    : e,
                )
              : [forcedEvent, ...st.scanFeed],
          }));
          // P6 C2: written AFTER the count above is applied - never before (TOP-LEVEL LAW).
          markFirstScanIfNeeded();
          const forcedIncPayload: IncrementPayload = {
            businessId: st0.businessId,
            sessionId: st0.sessionId,
            productId: existing.id,
            scanEventId: forcedEvent.id,
            quantityDelta: 1,
            idempotencyKey: forcedEvent.idempotencyKey,
          };
          enqueueAndSync([
            makeQueueItem({
              idFactory, now, businessId: st0.businessId, sessionId: st0.sessionId,
              entityType: "ScanEvent", entityId: forcedEvent.id, operation: "SAVE_SCAN_EVENT",
              payload: forcedEvent,
              idempotencyKey: buildIdempotencyKey(st0.businessId, st0.sessionId, forcedEvent.id, "SAVE_SCAN_EVENT"),
              scanEventId: forcedEvent.id,
            }),
            makeQueueItem({
              idFactory, now, businessId: st0.businessId, sessionId: st0.sessionId,
              entityType: "InventoryCount", entityId: forced.count.id, operation: "INCREMENT_COUNT",
              payload: forcedIncPayload,
              idempotencyKey: forcedEvent.idempotencyKey,
              scanEventId: forcedEvent.id,
            }),
          ]);
          return existing.id;
        }
        // Code-type aware label: a SAFE "Unidentified item" + the scanned code. NEVER fabricate manufacturer
        // anatomy here (no decode response). PREFIX FLOOR (Plan C Task 3): unless the GS1 prefix maps to a
        // known brand, in which case the row states the brand with confidence and flags the product
        // unconfirmed - see prefixFloorName. Label text comes from the shared provisionalPlaceholderName
        // helper so resolveUnknown's reload-resilient provOrphanId fallback can reconstruct the identical
        // name purely from the code, even after the customer persist split strips this row's identity fields.
        const ct = detectCodeType(code);
        const floor = prefixFloorName(code, ct);
        const fbName = provisionalPlaceholderName(code);
        const provId = `prod-${idFactory()}`;
        const provProduct: Product = {
          id: provId, businessId: st0.businessId, name: fbName, brand: floor?.brand ?? "", category: "", specsShort: "",
          specsFull: "", primarySku: "", primaryBarcode: code, gtin: "", upc: "", ean: "", vendorCodes: [],
          aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "ai_openai",
          confidence: 0, verified: false, provisional: true, provenanceTier: "provisional", createdAt: now(), createdBy: "ai", updatedAt: now(), updatedBy: "ai",
        };
        const ev = st0.scanFeed.find((e) => e.cleanCode === code && e.status !== "known");
        let counts = st0.finalCounts;
        let qty = 0;
        let countId: string | null = null;
        // LAW FIX: no matching scanFeed row exists for this code (e.g. a persist-trimmed feed, or a
        // review whose backing event was otherwise lost) is NOT a reason to silently count nothing -
        // this function still mints the provisional product below, and a scan that already went to
        // Needs Review must still count once it is resolved. Mint a SYNTHETIC BACKING EVENT (same
        // precedent as markWrong's feed-trim safety net, scanStore.ts ~5622) so replayLedgerCounts can
        // reproduce the quantity from feed events alone - never a naked quantity bump.
        const countedEvent = ev
          ? { ...ev, matchedProductId: provId, status: "known" as const, quantityDelta: 1 }
          : countIfFeedMissing
            ? ({
              id: idFactory(),
              businessId: st0.businessId,
              sessionId: st0.sessionId,
              rawCode: code,
              cleanCode: code,
              normalizedCandidates: [],
              matchedProductId: provId,
              matchType: "unknown",
              status: "known" as const,
              resolverStatus: "needs_review",
              codeType: ct,
              reason: reason || "Recovered count (scan record was missing)",
              quantityDelta: 1,
              quantityAfterScan: 0,
              createdAt: now(),
              source: "scan",
              notes: reason || "Recovered count (scan record was missing)",
              syncStatus: "pending",
              syncError: null,
              idempotencyKey: "",
            } as ScanEvent)
            : null;
        if (!ev && countedEvent) {
          countedEvent.idempotencyKey = buildIdempotencyKey(st0.businessId, st0.sessionId, countedEvent.id, "INCREMENT_COUNT");
        } else if (freshTransferKeys && countedEvent && ev) {
          // F-03: markWrong/orphan-transfer callers repoint an EXISTING feed row that may already have
          // been synced under its PREVIOUS (wrong) identity. Reusing its inherited idempotencyKey here
          // would resend the SAME key against a DIFFERENT productId - Firestore's applied-key dedupe
          // stores the ORIGINAL marker (targetId = old productId) and rejects the mismatched replay as
          // idempotency_conflict (retryable:false), so the correction never reaches the backend. Mint a
          // FRESH transfer key (never the original counting key) so this repoint is a genuinely new,
          // never-before-applied write.
          countedEvent.idempotencyKey = buildIdempotencyKey(st0.businessId, ev.sessionId, `${ev.id}:transfer:${provId}`, "INCREMENT_COUNT");
        }
        if (countedEvent) {
          const r = incrementInventoryCount(counts, countedEvent, idFactory);
          counts = r.counts.map((c) =>
            c.productId === countedEvent.matchedProductId && c.sessionId === countedEvent.sessionId
              ? { ...c, location: countedEvent.location }
              : c,
          );
          qty = r.count.quantity;
          countId = r.count.id;
          countedEvent.quantityAfterScan = qty;
        }
        set((st) => ({
          products: [...st.products, provProduct],
          finalCounts: counts,
          needsReviewQueue: st.needsReviewQueue.map((r) =>
            r.cleanCode === code && r.status === "open"
              ? {
                  ...r,
                  decodeStatus: "needs_review",
                  reason: r.reason || reason,
                  suggestedProductName: r.suggestedProductName || fbName,
                  // STABLE-ID FIX: this placeholder (provId, minted just above) belongs to THIS review's
                  // code. Stamp its id so resolveUnknown can re-link by id after a customer reload, instead
                  // of by reconstructed name (see provisionalProductId doc comment in types.ts). Only set
                  // when not already stamped (idempotent; never clobber a value set earlier).
                  provisionalProductId: r.provisionalProductId ?? provId,
                }
              : r,
          ),
          scanFeed: ev
            ? st.scanFeed.map((e) =>
                e.id === ev.id
                  ? {
                      ...e,
                      matchedProductId: provId,
                      status: "known",
                      quantityAfterScan: qty,
                      // Preserve an IN-FLIGHT "Decoding..." badge (a live decode is actually running) so the
                      // documented "Decoding -> Verified / Suggested / Conflict / Needs review" UI stays visible;
                      // only stamp "suggested" when there is no decode in flight.
                      decodeStatus: e.decodeStatus === "decoding" ? "decoding" : "suggested",
                      // D1 FIX: the stored feed event and the counted delta are the SAME FACT - the row a
                      // provisional count was applied from must carry the delta it contributed (North-star #2:
                      // sum(feed deltas) === quantity). And the fake optimistic "synced" stamp is GONE: the
                      // row's syncStatus is derived from pendingSyncQueue membership (see the reconcile at
                      // scanStore.ts:907-922) and only reads "synced" after a real sync ack.
                      quantityDelta: 1,
                      reason: e.reason || reason,
                    }
                  : e,
              )
            // No matching feed row: prepend the synthetic backing event so the feed still carries the
            // exact fact that was counted (North-star #2: sum(feed deltas) === quantity), same
            // precedent as markWrong's residual-repoint synthetic event.
            : countedEvent
              ? [countedEvent, ...st.scanFeed]
              : st.scanFeed,
        }));
        // P6 C2: written AFTER the count above is applied - never before (TOP-LEVEL LAW) - and only
        // when this call actually counted something (countedEvent), never on a no-op/idempotent re-entry.
        if (countedEvent) markFirstScanIfNeeded();
        // D1 FIX: a provisional count is real inventory. Enqueue its ledger writes through the SAME sync
        // queue mechanism every counted scan uses. SAVE_SCAN_EVENT + INCREMENT_COUNT mirror the countable
        // branch's two ops (scanStore.ts:1397-1422); SAVE_PRODUCT for the freshly minted provisional is a
        // NEW op on the scan path (precedent: resolveUnknown's SAVE_PRODUCT enqueue, :3912-3930). The
        // INCREMENT_COUNT key is the event's own key minted in processScan - reused verbatim, never
        // regenerated (Idempotent Sync Rules).
        if (countedEvent && countId) {
          const bId = st0.businessId;
          const sId = countedEvent.sessionId;
          const incPayload: IncrementPayload = {
            businessId: bId, sessionId: sId, productId: provId, scanEventId: countedEvent.id,
            quantityDelta: 1, idempotencyKey: countedEvent.idempotencyKey,
          };
          // F-03: the SAVE_SCAN_EVENT key normally reconstructs deterministically from the event's own id
          // (safe on the FIRST-ever sync of that id). A freshTransferKeys repoint reuses an id that may
          // ALREADY be synced under the previous identity, so it needs the SAME `:transfer:${provId}`
          // suffix as the INCREMENT_COUNT key above (never the bare id) or Firestore's applied-key dedupe
          // rejects the corrected payload as idempotency_conflict.
          const saveScanEventKey = freshTransferKeys
            ? buildIdempotencyKey(bId, sId, `${countedEvent.id}:transfer:${provId}`, "SAVE_SCAN_EVENT")
            : buildIdempotencyKey(bId, sId, countedEvent.id, "SAVE_SCAN_EVENT");
          enqueueAndSync([
            // Task 1b fix (same recipe as correctProduct, commit 024c849): a bare
            // `businessId:sessionId:provId:SAVE_PRODUCT` key collides with resolveUnknown's later
            // orphan-merge SAVE_PRODUCT for this SAME id (it reuses provOrphanId - scanStore.ts ~4791),
            // which would otherwise be swallowed as "alreadyApplied" and the resolved identity would
            // never reach the backend. Suffix `:provisional` so the first (placeholder) write and any
            // later distinct write to this id mint different keys; the key is still minted once here and
            // reused verbatim on every retry of THIS item, so retry dedupe is unaffected.
            makeQueueItem({
              idFactory,
              now,
              businessId: bId,
              sessionId: sId,
              entityType: "Product",
              entityId: provId,
              operation: "SAVE_PRODUCT",
              payload: provProduct,
              idempotencyKey: buildIdempotencyKey(bId, sId, `${provId}:provisional`, "SAVE_PRODUCT"),
              scanEventId: null,
              syncLane: freshTransferKeys ? undefined : "independent_product",
            }),
            makeQueueItem({ idFactory, now, businessId: bId, sessionId: sId, entityType: "ScanEvent", entityId: countedEvent.id, operation: "SAVE_SCAN_EVENT", payload: countedEvent, idempotencyKey: saveScanEventKey, scanEventId: countedEvent.id }),
            makeQueueItem({ idFactory, now, businessId: bId, sessionId: sId, entityType: "InventoryCount", entityId: countId, operation: "INCREMENT_COUNT", payload: incPayload, idempotencyKey: countedEvent.idempotencyKey, scanEventId: countedEvent.id }),
          ]);
        } else if (!countedEvent) {
          const bId = st0.businessId;
          const sId = st0.sessionId;
          enqueueAndSync([
            makeQueueItem({
              idFactory,
              now,
              businessId: bId,
              sessionId: sId,
              entityType: "Product",
              entityId: provId,
              operation: "SAVE_PRODUCT",
              payload: provProduct,
              idempotencyKey: buildIdempotencyKey(bId, sId, `${provId}:provisional`, "SAVE_PRODUCT"),
              scanEventId: null,
            }),
          ]);
        }
        // F5 bundle-surgery: the row already appeared + counted above (TOP-LEVEL LAW unaffected). Only
        // worth an enrichment fetch when the client-safe (SEED/LEARNED) lookup found nothing - a
        // DERIVED-tier hit is still possible server-side.
        if (!floor) get().enrichPrefixFloorLabel(code, provId);
        return provId;
      },
  };
}
