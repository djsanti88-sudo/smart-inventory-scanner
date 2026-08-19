"use client";

import { useEffect, useMemo, useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import { useIsPlatformOwner } from "@/services/security/useAccessLevel";
import { DecodeStatusBadge, MatchBadge, StatusBadge, SyncBadge } from "@/components/badges";
import { prettifyBrand, prettifyProductName } from "@/services/format/productDisplay";
import { getIdentityConfidenceBand, identityBandLabel } from "@/services/ai/identityConfidenceBand";
import { matchTireSize } from "@/services/tire/tireSizeNormalizer";
import { canonicalTireSize } from "@/services/catalog/tireListingNormalizer";
import type { Product, UnknownCodeReview } from "@/types";

// Size column: same structured-size source FinalCountTable already uses (product.specsShort via
// matchTireSize), falling back to a deterministic parse of the row's own display name when the
// linked product has no parseable structured size yet (e.g. still-provisional rows). Never guesses;
// "-" when neither source yields a confident size.
function resolvedFeedSize(product: Product | undefined, displayName: string): string {
  const fromProduct = product ? matchTireSize(product.specsShort)?.canonical.split(" ")[0] : undefined;
  if (fromProduct) return fromProduct;
  return canonicalTireSize(displayName) || "-";
}

// DEFECT #29/#37 residual (live-reproduced 2026-08-05/06, canelo round 2): after the Map-lookup fix
// above, a fresh-device restore of a 4,500-event business STILL froze the renderer ~30s because this
// table synchronously mounted EVERY scanFeed row into the DOM. WINDOWING (display-only, sanctioned
// contingency - no new dependency): render only the most recent FEED_RENDER_WINDOW rows, plus a
// summary row stating exactly how many earlier scans are hidden, with a "Show more" control that grows
// the window by FEED_RENDER_CHUNK per click. TOP-LEVEL LAW is untouched - every scan still COUNTS; the
// header's "N scans" total and all store totals are computed over the FULL scanFeed, never the window.
export const FEED_RENDER_WINDOW = 150;
export const FEED_RENDER_CHUNK = 300;

// SCANNER SAFETY (non-negotiable, shared by every row control): pointer-only targets - tabIndex -1 so
// they are never in the tab/Enter path, and onMouseDown preventDefault so clicking one never moves
// focus off #scanner-input. A scanner Enter burst can never trigger them.
const rowButtonProps = {
  type: "button" as const,
  tabIndex: -1,
  onMouseDown: (me: React.MouseEvent) => me.preventDefault(),
};

// Reassign is PRODUCT-scoped (markWrong moves EVERY counted unit of the product and deactivates every
// approved alias mapped to it), so a single stray click on a dense feed can move a whole session's count
// for that product. It is therefore a TWO-TAP control: the first tap only arms a confirm that STATES the
// blast radius ("Move 3 units?"), the second fires it. The armed state disarms itself on Escape, on a
// click anywhere else, and after this timeout, so it can never sit armed waiting for an accidental tap.
const REASSIGN_CONFIRM_MS = 5000;

/** Prefill value for the confirm sheet: a best guess only. A placeholder label ("Unidentified item
 *  (barcode ...)") is not an identity - prefilling it would make the operator delete it first. */
function bestGuessPrefill(name: string | undefined): string {
  return name && !name.startsWith("Unidentified item") ? name : "";
}

/** Bring the scanner back after a manual form interaction (the only place focus intentionally moves). */
function refocusScanner() {
  document.getElementById("scanner-input")?.focus();
}

/**
 * The row's identity sheet. Two DISTINCT operations, never merged: "confirm" hands a human-typed
 * identity to confirmRowIdentity (tenant approved alias), "edit" hands product fields to correctProduct
 * (metadata only, alias untouched). Deliberately minimal - name + brand - and never autofocused, so
 * rendering it can not steal the scanner's focus.
 */
function RowIdentitySheet({
  eventId,
  mode,
  initialName,
  initialBrand,
  onSave,
  onClose,
}: {
  eventId: string;
  mode: "confirm" | "edit";
  initialName: string;
  initialBrand: string;
  onSave: (fields: { name: string; brand: string }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [brand, setBrand] = useState(initialBrand);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1" data-testid={`identity-sheet-${eventId}`}>
      <input
        aria-label="product name"
        data-testid={`identity-name-${eventId}`}
        value={name}
        onChange={(ev) => setName(ev.target.value)}
        placeholder="Product name"
        className="min-h-[36px] rounded border border-zinc-300 px-2 text-sm"
      />
      <input
        aria-label="brand"
        data-testid={`identity-brand-${eventId}`}
        value={brand}
        onChange={(ev) => setBrand(ev.target.value)}
        placeholder="Brand"
        className="min-h-[36px] w-28 rounded border border-zinc-300 px-2 text-sm"
      />
      <button
        type="button"
        data-testid={`identity-save-${eventId}`}
        onClick={() => {
          onSave({ name: name.trim(), brand: brand.trim() });
          onClose();
          refocusScanner();
        }}
        className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
      >
        {mode === "confirm" ? "Confirm identity" : "Save details"}
      </button>
      <button
        type="button"
        data-testid={`identity-cancel-${eventId}`}
        onClick={() => {
          onClose();
          refocusScanner();
        }}
        className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
      >
        Cancel
      </button>
    </div>
  );
}

// Raw live scan feed: every scan event in order, newest first. Keeps the full audit trail. Raw/clean
// codes AND the internal match type are platformOwner-only; customers see the product name + part number
// and the scan status of each scan, never the code strings or how the code matched internally.
export function LiveScanFeed() {
  const scanFeed = useScanStore((s) => s.scanFeed);
  const products = useScanStore((s) => s.products);
  const needsReviewQueue = useScanStore((s) => s.needsReviewQueue);
  const approveSuggestion = useScanStore((s) => s.approveSuggestion);
  const declineSuggestion = useScanStore((s) => s.declineSuggestion);
  const confirmRowIdentity = useScanStore((s) => s.confirmRowIdentity);
  const correctProduct = useScanStore((s) => s.correctProduct);
  const markWrong = useScanStore((s) => s.markWrong);
  const finalCounts = useScanStore((s) => s.finalCounts);
  const isPlatform = useIsPlatformOwner();
  const [renderWindow, setRenderWindow] = useState(FEED_RENDER_WINDOW);
  // At most one row sheet is open at a time (identity confirm, or product metadata edit).
  const [sheet, setSheet] = useState<{ eventId: string; mode: "confirm" | "edit" } | null>(null);
  // At most one Reassign is armed at a time (the row's event id).
  const [armedReassign, setArmedReassign] = useState<string | null>(null);

  // Disarm on Escape, on a click anywhere else, or after REASSIGN_CONFIRM_MS. The confirm button itself
  // stops its own mousedown from reaching this listener, so tapping it confirms instead of disarming.
  useEffect(() => {
    if (!armedReassign) return;
    const disarm = () => setArmedReassign(null);
    const onKeyDown = (ke: KeyboardEvent) => {
      if (ke.key === "Escape") disarm();
    };
    const timer = window.setTimeout(disarm, REASSIGN_CONFIRM_MS);
    document.addEventListener("mousedown", disarm);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", disarm);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [armedReassign]);

  // PERF FIX (defect #37, live-reproduced 2026-08-05/06): the store's getProduct(id) does a linear
  // `products.find()`. Calling it once per rendered scanFeed row made this O(scanFeed.length *
  // products.length) - with thousands of scans and thousands of products, that quadratic blowup froze
  // the renderer for 30+ seconds on a fresh device's first load. Build the id -> product index ONCE per
  // `products` change (single pass, O(M)) and do O(1) Map lookups per row instead (O(N) total).
  const productsById = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of products) m.set(p.id, p);
    return m;
  }, [products]);
  // Same fix for the per-row `needsReviewQueue.find(...)` lookup: index by cleanCode ONCE (first
  // matching review per code wins, same semantics as the original .find()), instead of re-scanning the
  // whole review queue for every feed row.
  const reviewByCleanCode = useMemo(() => {
    const m = new Map<string, UnknownCodeReview>();
    for (const r of needsReviewQueue) {
      if (r.suggestedProductName && !m.has(r.cleanCode)) m.set(r.cleanCode, r);
    }
    return m;
  }, [needsReviewQueue]);
  // The "Barcode" column shows the code the user JUST scanned (their own in-memory scan, never persisted
  // for customers and never the catalog/alias database) - visible to ALL roles. Raw code + Match remain
  // platformOwner-only. Customer columns: Time, Barcode, Brand, Product, Size, SKU, Qty, Status, Reason,
  // Sync = 10.
  const colSpan = isPlatform ? 12 : 10;
  // Display-only window: scanFeed is already newest-first, so slicing from the front keeps the newest
  // rows visible exactly as before. Clamp against the current feed length so a shrunken feed (e.g.
  // "Clear session") never leaves a stale negative hidden count.
  // Counted quantity per product, built once per finalCounts change (same O(1)-per-row shape as the
  // productsById index above). It is what Reassign's confirm copy names, and what decides whether the
  // control renders at all - a product with nothing counted has no quantity to move.
  const countedQtyByProduct = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of finalCounts) m.set(c.productId, (m.get(c.productId) ?? 0) + c.quantity);
    return m;
  }, [finalCounts]);
  const visibleFeed = useMemo(() => scanFeed.slice(0, renderWindow), [scanFeed, renderWindow]);
  const hiddenCount = Math.max(0, scanFeed.length - visibleFeed.length);

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <h2 id="scan-feed-heading" className="text-lg font-semibold text-zinc-900">What you just scanned</h2>
        <span className="text-sm text-zinc-600">{scanFeed.length} scans</span>
      </div>
      <div
        className="max-h-72 overflow-auto shadow-[inset_-8px_0_6px_-6px_rgba(0,0,0,0.08)]"
        tabIndex={0}
        role="region"
        aria-label="What you just scanned table, scroll horizontally for more columns"
      >
        <table className="w-full border-collapse text-left text-base" aria-labelledby="scan-feed-heading">
          <thead className="sticky top-0 border-b border-zinc-200 bg-zinc-50 text-sm font-semibold text-zinc-700">
            <tr>
              <th scope="col" className="px-4 py-3">Time</th>
              {isPlatform && <th scope="col" className="px-4 py-3">Raw code</th>}
              <th scope="col" className="px-4 py-3">Barcode</th>
              {isPlatform && <th scope="col" className="px-4 py-3">Match</th>}
              <th scope="col" className="px-4 py-3">Brand</th>
              <th scope="col" className="px-4 py-3">Product</th>
              <th scope="col" className="px-4 py-3">Size</th>
              <th scope="col" className="px-4 py-3">{isPlatform ? "SKU" : "Part number"}</th>
              <th scope="col" className="px-4 py-3">Qty on hand</th>
              <th scope="col" className="px-4 py-3">Status</th>
              <th scope="col" className="px-4 py-3">Reason</th>
              <th scope="col" className="px-4 py-3">Sync</th>
            </tr>
          </thead>
          <tbody data-testid="scan-feed-body">
            {scanFeed.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="px-4 py-6 text-center text-base text-zinc-600">
                  No scans yet. Scan a barcode above to start counting.
                </td>
              </tr>
            ) : (
              <>
              {visibleFeed.map((e) => {
                const product = e.matchedProductId ? productsById.get(e.matchedProductId) : undefined;
                // TASK 3 FIX (feed stuck on "Unidentified item"): ensureProvisionalCount ALWAYS mints a
                // provisional placeholder Product synchronously at scan time, before decode finishes, so
                // `product` is truthy even when there is no real identity yet. A naive `product ? undefined
                // : suggestion` check therefore skipped the suggestion lookup forever. Now the suggestion
                // lookup also runs when the matched product is still `provisional` (not yet a real,
                // human-confirmed identity), so the feed shows the best-known name as soon as decode has one.
                const suggestion = (!product || product.provisional)
                  ? reviewByCleanCode.get(e.cleanCode)
                  : undefined;
                // Display priority: a real (non-provisional) product name wins outright. Otherwise prefer the
                // decoded suggestion's name over the safe-but-uninformative provisional placeholder name, and
                // fall back to the placeholder, then "-", if no suggestion exists yet.
                const displayName = prettifyProductName(
                  (product && !product.provisional ? product.name : undefined) ??
                    suggestion?.suggestedProductName ??
                    product?.name ??
                    "-",
                );
                const displaySku =
                  (product && !product.provisional ? product.primarySku : undefined) ||
                  suggestion?.suggestedPrimarySku ||
                  product?.primarySku ||
                  "-";
                // Task 9b (owner-ratified 2026-07-14): the row's OWN inline suggestion (pending ->
                // "(suggested, NN%)" + pointer-only approve/decline controls) takes precedence over the
                // legacy review-derived tag so a row never shows two suggestion tags at once.
                const inline = e.suggestion;
                // Trust rule: an unconfirmed identity must stay visually distinct from a Verified match.
                // confidence >= 0.8 -> neutral gray "unconfirmed"; confidence < 0.8 -> amber "(suggested)".
                // Never render a suggestion with no tag at all.
                const suggestionTag = inline
                  ? null
                  : suggestion
                    ? suggestion.confidence >= 0.8
                      ? "unconfirmed"
                      : "(suggested)"
                    : null;
                // ROW STATE -> CONTROLS (owner decision 2026-08-19). Three distinct operations, never one
                // umbrella "edit": a verified row offers metadata Edit only (no Approve - it is already
                // trusted); a row carrying a pending guess offers Approve / Edit (confirm the identity) /
                // Not this product; a row with no identity offers Identify. Reassign (the count-transfer
                // path) stays its own control on any counted row.
                const pendingInline = inline?.status === "pending";
                // A row has a candidate when it carries the pending inline guess OR a review-derived
                // suggestion (the latter is shown when the inline guess was deliberately withheld: context
                // conflict, tire deep-verify pending, auto-add off). Either way the operator is editing a
                // name, not identifying from nothing; Approve stays inline-only so a deliberate hold is
                // never bypassed from the feed.
                const hasCandidate = pendingInline || bestGuessPrefill(suggestion?.suggestedProductName) !== "";
                const verifiedRow = e.decodeStatus === "verified" || Boolean(product?.verified);
                const canEditMetadata = verifiedRow && Boolean(product);
                const reassignQty = product ? (countedQtyByProduct.get(product.id) ?? 0) : 0;
                const canReassign = Boolean(product) && e.status === "known" && reassignQty > 0;
                // Same display priority as the name: real product brand wins, then the decode
                // suggestion's brand, then whatever the provisional placeholder carries.
                const displayBrand = prettifyBrand(
                  (product && !product.provisional ? product.structuredBrand || product.brand : undefined) ||
                    suggestion?.suggestedBrand ||
                    product?.brand ||
                    "",
                );
                return (
                  <tr key={e.id} className="animate-[row-appear_200ms_ease-out] border-t border-zinc-100 hover:bg-zinc-50">
                    <td className="px-4 py-3 text-sm text-zinc-600">
                      {e.createdAt ? new Date(e.createdAt).toLocaleTimeString() : "-"}
                    </td>
                    {isPlatform && <td className="px-4 py-3 font-mono text-sm">{e.rawCode}</td>}
                    <td className="px-4 py-3 font-mono text-sm" data-testid={`feed-barcode-${e.id}`}>{e.cleanCode || "-"}</td>
                    {isPlatform && (
                      <td className="px-4 py-3">
                        <MatchBadge type={e.matchType} />
                      </td>
                    )}
                    <td className="px-4 py-3" data-testid={`feed-brand-${e.id}`}>{displayBrand || "-"}</td>
                    <td className="px-4 py-3">
                      {/* The identity text (name + its honest tags) stays in its own node, so the row
                          controls beside it are never part of what the row "says" the product is. */}
                      <span data-testid={`feed-product-${e.id}`}>
                        {displayName}
                        {/* Task 9b: pending inline suggestion - honest confidence + pointer-only
                            approve/decline. SCANNER SAFETY (non-negotiable): tabIndex={-1} and
                            onMouseDown preventDefault so focus NEVER leaves #scanner-input; a scanner
                            Enter burst can never trigger these controls. */}
                        {inline && inline.status === "pending" ? (
                          <span
                            className="ml-1 inline-flex items-center gap-1 whitespace-nowrap align-middle text-xs text-amber-700"
                            data-testid={`feed-suggestion-${e.id}`}
                          >
                            {/* Owner decision 2026-08-19: an app-derived band, never a raw provider
                                percentage. The raw confidence stays on the event for audit. */}
                            ({identityBandLabel(inline.band ?? getIdentityConfidenceBand({ confidence: inline.confidence }))})
                            <button
                              {...rowButtonProps}
                              onClick={() => approveSuggestion(e.id)}
                              aria-label={`Approve ${inline.productName}`}
                              title={`Approve ${inline.productName}`}
                              data-testid={`approve-suggestion-${e.id}`}
                              className="inline-flex h-6 w-6 items-center justify-center rounded border border-emerald-300 bg-emerald-50 font-semibold text-emerald-700 hover:bg-emerald-100"
                            >
                              ✓
                            </button>
                            <button
                              {...rowButtonProps}
                              onClick={() => declineSuggestion(e.id)}
                              aria-label="Not this product"
                              title="Not this product"
                              data-testid={`decline-suggestion-${e.id}`}
                              className="inline-flex h-6 w-6 items-center justify-center rounded border border-red-300 bg-red-50 font-semibold text-red-700 hover:bg-red-100"
                            >
                              ✕
                            </button>
                          </span>
                        ) : null}
                        {/* COSMETIC FIX (2026-08-04, cocacola-bug-report.md): adjacent {text}{element} JSX
                            renders with no whitespace text node between them - the ml-1 margin alone (4px)
                            reads as a concatenated word ("Delinte D7unconfirmed") in a screenshot. Add a
                            literal space, matching the codebase's own {" "} convention elsewhere. */}
                        {suggestionTag === "unconfirmed" ? (
                          <>
                            {" "}
                            <span className="ml-1 rounded px-1 text-xs text-zinc-600">unconfirmed</span>
                          </>
                        ) : suggestionTag === "(suggested)" ? (
                          <>
                            {" "}
                            <span className="ml-1 text-xs text-amber-700">(suggested)</span>
                          </>
                        ) : null}
                        {/* Task 9: an app-verified decode that counted despite being off the business scan
                            context (e.g. hot sauce in a tire shop) shows this advisory tag - it counted, but
                            the operator sees it is not a tire. */}
                        {e.offCategory ? (
                          <span className="ml-1 text-xs text-amber-700" data-testid={`feed-off-category-${e.id}`}>
                            Off-category item
                          </span>
                        ) : null}
                      </span>
                      <span className="ml-2 inline-flex items-center gap-1 align-middle text-xs" data-testid={`row-actions-${e.id}`}>
                        {canEditMetadata ? (
                          <button
                            {...rowButtonProps}
                            onClick={() => setSheet({ eventId: e.id, mode: "edit" })}
                            aria-label={`Edit ${displayName}`}
                            data-testid={`edit-product-${e.id}`}
                            className="rounded border border-zinc-300 px-1.5 py-0.5 text-zinc-700 hover:bg-zinc-100"
                          >
                            Edit
                          </button>
                        ) : !verifiedRow ? (
                          <button
                            {...rowButtonProps}
                            onClick={() => setSheet({ eventId: e.id, mode: "confirm" })}
                            aria-label={hasCandidate ? `Edit ${inline?.productName ?? suggestion?.suggestedProductName}` : "Identify this item"}
                            data-testid={hasCandidate ? `edit-identity-${e.id}` : `identify-row-${e.id}`}
                            className="rounded border border-zinc-300 px-1.5 py-0.5 text-zinc-700 hover:bg-zinc-100"
                          >
                            {hasCandidate ? "Edit" : "Identify"}
                          </button>
                        ) : null}
                        {canReassign && product ? (
                          armedReassign === e.id ? (
                            <button
                              {...rowButtonProps}
                              // stopPropagation so this tap does not reach the document-level disarm
                              // listener before its own click lands. preventDefault (from rowButtonProps)
                              // still holds, so the scanner keeps focus.
                              onMouseDown={(me) => {
                                me.preventDefault();
                                me.stopPropagation();
                              }}
                              onClick={() => {
                                setArmedReassign(null);
                                void markWrong(product.id, { reason: "reassigned from the scan feed" });
                              }}
                              aria-label={`Confirm reassign: move ${reassignQty} counted ${reassignQty === 1 ? "unit" : "units"} of ${displayName}`}
                              title="Every counted unit of this product moves to a new unidentified row"
                              data-testid={`reassign-confirm-${e.id}`}
                              className="rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 font-medium text-amber-800 hover:bg-amber-100"
                            >
                              Move {reassignQty} {reassignQty === 1 ? "unit" : "units"}?
                            </button>
                          ) : (
                            <button
                              {...rowButtonProps}
                              onMouseDown={(me) => {
                                me.preventDefault();
                                me.stopPropagation();
                              }}
                              onClick={() => setArmedReassign(e.id)}
                              aria-label="Reassign to a different product"
                              title="This is a different product - move the count"
                              data-testid={`reassign-${e.id}`}
                              className="rounded border border-zinc-300 px-1.5 py-0.5 text-zinc-700 hover:bg-zinc-100"
                            >
                              Reassign
                            </button>
                          )
                        ) : null}
                      </span>
                      {sheet?.eventId === e.id ? (
                        <RowIdentitySheet
                          eventId={e.id}
                          mode={sheet.mode}
                          initialName={
                            sheet.mode === "edit"
                              ? (product?.name ?? "")
                              : bestGuessPrefill(inline?.productName ?? suggestion?.suggestedProductName)
                          }
                          initialBrand={sheet.mode === "edit" ? (product?.brand ?? "") : (inline?.brand ?? suggestion?.suggestedBrand ?? "")}
                          onSave={(fields) =>
                            sheet.mode === "edit" && product
                              ? correctProduct(product.id, { name: fields.name, brand: fields.brand })
                              : confirmRowIdentity(e.id, { name: fields.name, brand: fields.brand })
                          }
                          onClose={() => setSheet(null)}
                        />
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-sm" data-testid={`feed-size-${e.id}`}>
                      {resolvedFeedSize(product, displayName)}
                    </td>
                    <td className="px-4 py-3 font-mono text-sm" data-testid={`feed-part-number-${e.id}`}>
                      {displaySku}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{e.status === "known" ? e.quantityAfterScan : "-"}</td>
                    <td className="px-4 py-3">
                      {e.decodeStatus && e.decodeStatus !== "none" ? (
                        <DecodeStatusBadge status={e.decodeStatus} provenance={e.provenance} />
                      ) : (
                        <StatusBadge status={e.status} />
                      )}
                    </td>
                    {/* STALE-NOTE FIX (goupc-cap-rootcause item 3): decodeNote is now cleared/refreshed by
                        the store on every settle, so it should never read the in-flight note once the row
                        is done decoding. This guard is a defensive backstop against any future settle path
                        that forgets to clear it - the in-flight note is only ever honest while the row is
                        still "decoding". */}
                    {(() => {
                      const showDecodeNote =
                        isPlatform && Boolean(e.decodeNote) && (e.decodeStatus === "decoding" || e.decodeNote !== "Decoding with AI...");
                      return (
                        <td
                          className="max-w-56 px-4 py-3 text-sm text-zinc-600"
                          title={showDecodeNote ? `${e.reason}: ${e.decodeNote}` : e.reason}
                        >
                          {e.reason}
                          {showDecodeNote ? <span className="text-zinc-500">: {e.decodeNote}</span> : null}
                        </td>
                      );
                    })()}
                    <td className="px-4 py-3">
                      <SyncBadge status={e.syncStatus} />
                    </td>
                  </tr>
                );
              })}
              {hiddenCount > 0 && (
                <tr className="border-t border-zinc-100 bg-zinc-50">
                  <td colSpan={colSpan} className="px-4 py-3 text-center text-sm text-zinc-600" data-testid="feed-hidden-summary">
                    + {hiddenCount} earlier {hiddenCount === 1 ? "scan" : "scans"} counted
                    <button
                      type="button"
                      tabIndex={-1}
                      onMouseDown={(me) => me.preventDefault()}
                      onClick={() => setRenderWindow((w) => w + FEED_RENDER_CHUNK)}
                      data-testid="feed-show-more"
                      className="ml-2 rounded border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100"
                    >
                      Show more
                    </button>
                  </td>
                </tr>
              )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
