"use client";

import { useScanStore } from "@/stores/scanStore";
import { useIsPlatformOwner } from "@/services/security/useAccessLevel";
import { DecodeStatusBadge, MatchBadge, StatusBadge, SyncBadge } from "@/components/badges";
import { prettifyBrand, prettifyProductName } from "@/services/format/productDisplay";

// Raw live scan feed: every scan event in order, newest first. Keeps the full audit trail. Raw/clean
// codes AND the internal match type are platformOwner-only; customers see the product name + part number
// and the scan status of each scan, never the code strings or how the code matched internally.
export function LiveScanFeed() {
  const scanFeed = useScanStore((s) => s.scanFeed);
  const getProduct = useScanStore((s) => s.getProduct);
  const needsReviewQueue = useScanStore((s) => s.needsReviewQueue);
  const approveSuggestion = useScanStore((s) => s.approveSuggestion);
  const declineSuggestion = useScanStore((s) => s.declineSuggestion);
  const isPlatform = useIsPlatformOwner();
  // The "Barcode" column shows the code the user JUST scanned (their own in-memory scan, never persisted
  // for customers and never the catalog/alias database) - visible to ALL roles. Raw code + Match remain
  // platformOwner-only. Customer columns: Time, Barcode, Brand, Product, SKU, Qty, Status, Reason, Sync = 9.
  const colSpan = isPlatform ? 11 : 9;

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <h2 id="scan-feed-heading" className="text-lg font-semibold text-zinc-900">What you just scanned</h2>
        <span className="text-sm text-zinc-600">{scanFeed.length} scans</span>
      </div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full border-collapse text-left text-base" aria-labelledby="scan-feed-heading">
          <thead className="sticky top-0 border-b border-zinc-200 bg-zinc-50 text-sm font-semibold text-zinc-700">
            <tr>
              <th scope="col" className="px-4 py-3">Time</th>
              {isPlatform && <th scope="col" className="px-4 py-3">Raw code</th>}
              <th scope="col" className="px-4 py-3">Barcode</th>
              {isPlatform && <th scope="col" className="px-4 py-3">Match</th>}
              <th scope="col" className="px-4 py-3">Brand</th>
              <th scope="col" className="px-4 py-3">Product</th>
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
              scanFeed.map((e) => {
                const product = getProduct(e.matchedProductId);
                // TASK 3 FIX (feed stuck on "Unidentified item"): ensureProvisionalCount ALWAYS mints a
                // provisional placeholder Product synchronously at scan time, before decode finishes, so
                // `product` is truthy even when there is no real identity yet. A naive `product ? undefined
                // : suggestion` check therefore skipped the suggestion lookup forever. Now the suggestion
                // lookup also runs when the matched product is still `provisional` (not yet a real,
                // human-confirmed identity), so the feed shows the best-known name as soon as decode has one.
                const suggestion = (!product || product.provisional)
                  ? needsReviewQueue.find((r) => r.cleanCode === e.cleanCode && r.suggestedProductName)
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
                    <td className="px-4 py-3" data-testid={`feed-product-${e.id}`}>
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
                          (suggested, {Math.round((inline.confidence ?? 0) * 100)}%)
                          <button
                            type="button"
                            tabIndex={-1}
                            onMouseDown={(me) => me.preventDefault()}
                            onClick={() => approveSuggestion(e.id)}
                            aria-label={`Approve ${inline.productName}`}
                            title={`Approve ${inline.productName}`}
                            data-testid={`approve-suggestion-${e.id}`}
                            className="inline-flex h-6 w-6 items-center justify-center rounded border border-emerald-300 bg-emerald-50 font-semibold text-emerald-700 hover:bg-emerald-100"
                          >
                            ✓
                          </button>
                          <button
                            type="button"
                            tabIndex={-1}
                            onMouseDown={(me) => me.preventDefault()}
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
                      {suggestionTag === "unconfirmed" ? (
                        <span className="ml-1 rounded px-1 text-xs text-zinc-600">unconfirmed</span>
                      ) : suggestionTag === "(suggested)" ? (
                        <span className="ml-1 text-xs text-amber-700">(suggested)</span>
                      ) : null}
                      {/* Task 9: an app-verified decode that counted despite being off the business scan
                          context (e.g. hot sauce in a tire shop) shows this advisory tag - it counted, but
                          the operator sees it is not a tire. */}
                      {e.offCategory ? (
                        <span className="ml-1 text-xs text-amber-700" data-testid={`feed-off-category-${e.id}`}>
                          Off-category item
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 font-mono text-sm" data-testid={`feed-part-number-${e.id}`}>
                      {displaySku}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{e.status === "known" ? e.quantityAfterScan : "-"}</td>
                    <td className="px-4 py-3">
                      {e.decodeStatus && e.decodeStatus !== "none" ? (
                        <DecodeStatusBadge status={e.decodeStatus} />
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
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
