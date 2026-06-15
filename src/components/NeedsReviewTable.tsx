"use client";

import { useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import { useIsPlatformOwner } from "@/services/security/useAccessLevel";
import { StatusBadge, SyncBadge } from "@/components/badges";
import type { UnknownCodeReview } from "@/types";

// Shows the decode pipeline outcome. "Verified AI Decode" requires the app to have independently
// verified the exact code in strong evidence AND cross-checked providers - it is never the model's
// self-claim, and it still requires human approval to count (unless the owner opts into auto-accept).
function DecodeBadge({ review, isPlatform }: { review: UnknownCodeReview; isPlatform: boolean }) {
  // Customer-facing labels avoid "AI"/"providers"; platformOwner sees the technical wording.
  const status = review.decodeStatus ?? "none";
  if (status === "verified" && review.exactCodeEvidenceVerifiedByApp) {
    return (
      <span className="w-fit rounded bg-green-100 px-1.5 py-0.5 font-medium text-green-800" data-testid="decode-status">
        {isPlatform ? "Verified AI Decode (app-verified)" : "Verified match"}
      </span>
    );
  }
  if (status === "conflict") {
    return (
      <span className="w-fit rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-800" data-testid="decode-status">
        {isPlatform ? "Conflict - providers disagree" : "Conflict - needs review"}
      </span>
    );
  }
  return (
    <span className="w-fit rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800" data-testid="decode-status">
      {isPlatform ? "Suggested - not trusted" : "Suggested product"}
    </span>
  );
}

// Needs Review queue. Unknown / conflicting codes land here and are never silently counted.
// Human resolution permanently learns an alias (handled by the store), so the AI is never asked
// about that code again.
export function NeedsReviewTable() {
  const reviews = useScanStore((s) => s.needsReviewQueue);
  const isPlatform = useIsPlatformOwner();

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 px-4 py-2">
        <h2 className="text-sm font-semibold text-zinc-800">Needs Review</h2>
        <p className="text-xs text-zinc-500">
          Unknown, vendor-label, or conflicting codes. AI results here are SUGGESTIONS only and are
          never trusted until you approve them. Approving saves a permanent alias so future scans
          count automatically.
        </p>
      </div>
      <div className="overflow-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
            <tr>
              {isPlatform && <th className="px-3 py-2">Raw code</th>}
              {isPlatform && <th className="px-3 py-2">Clean code</th>}
              <th className="px-3 py-2">Reason</th>
              <th className="px-3 py-2">Suggested product</th>
              <th className="px-3 py-2">Confidence</th>
              {isPlatform && <th className="px-3 py-2">Provider</th>}
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Sync</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody data-testid="review-body">
            {reviews.length === 0 ? (
              <tr>
                <td colSpan={isPlatform ? 9 : 6} className="px-3 py-6 text-center text-zinc-400">
                  Nothing to review. Unknown codes will appear here.
                </td>
              </tr>
            ) : (
              reviews.map((r) => <ReviewRow key={r.id} review={r} isPlatform={isPlatform} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReviewRow({ review, isPlatform }: { review: UnknownCodeReview; isPlatform: boolean }) {
  const products = useScanStore((s) => s.products);
  const resolveUnknown = useScanStore((s) => s.resolveUnknown);
  const liveDecode = useScanStore((s) => s.liveDecode);
  const aiEnabled = useScanStore((s) => s.settings.aiLookupEnabled);
  const lastMismatchWarning = useScanStore((s) => s.lastMismatchWarning);
  const clearMismatchWarning = useScanStore((s) => s.clearMismatchWarning);
  // Show the human-mistake warning only on the row + product it was raised for.
  const warn = lastMismatchWarning && lastMismatchWarning.reviewId === review.id ? lastMismatchWarning : null;

  const [mode, setMode] = useState<"idle" | "create">("idle");
  const [linkId, setLinkId] = useState(products[0]?.id ?? "");
  const [applyToCount, setApplyToCount] = useState(true);
  const [np, setNp] = useState({ name: "", brand: "", category: "" });

  const resolved = review.status !== "open";

  return (
    <tr className="border-t border-zinc-100 align-top" data-testid={`review-row-${review.cleanCode}`}>
      {isPlatform && <td className="px-3 py-2 font-mono text-xs">{review.rawCode}</td>}
      {isPlatform && <td className="px-3 py-2 font-mono text-xs">{review.cleanCode}</td>}
      <td className="max-w-48 px-3 py-2 text-xs text-zinc-600" data-testid="review-reason">
        {review.reason || "Unknown code."}
        {typeof review.autoVerifyScore === "number" && (
          <span className="mt-1 block text-zinc-500" data-testid="review-score">
            Confidence: {review.autoVerifyScore}/100 (below auto-save threshold)
          </span>
        )}
        {review.blockingReasons && review.blockingReasons.length > 0 && (
          <ul className="mt-1 list-disc pl-4 text-zinc-500" data-testid="review-blocking">
            {review.blockingReasons.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        )}
      </td>
      <td className="max-w-56 px-3 py-2 text-xs">
        {review.hasSuggestion || review.sourceUrls.length > 0 ? (
          <div className="flex flex-col gap-1">
            <DecodeBadge review={review} isPlatform={isPlatform} />
            {isPlatform && review.evidenceStrength && review.evidenceStrength !== "none" && (
              <span className="text-zinc-500" data-testid="evidence-strength">
                Evidence: {review.evidenceStrength.replace(/_/g, " ")} - app-verified:{" "}
                {review.exactCodeEvidenceVerifiedByApp ? "yes" : "no"}
                {review.crossCheckDecision ? ` - cross-check: ${review.crossCheckDecision}` : ""}
              </span>
            )}
            <span className="font-medium text-zinc-800">
              {review.suggestedProductName
                ? `${review.suggestedProductName}${review.suggestedBrand ? ` - ${review.suggestedBrand}` : ""}`
                : "No product identified - check the sources below"}
            </span>
            {isPlatform && review.decodeProviderSummaries && review.decodeProviderSummaries.length > 0 && (
              <span className="text-zinc-500" data-testid="provider-results">
                {review.decodeProviderSummaries
                  .map((p) => `${p.provider}: ${p.productName || "no result"} (${p.sources} src)`)
                  .join(" | ")}
              </span>
            )}
            {review.verifiedFacts.length > 0 && (
              <span className="text-zinc-500">Facts: {review.verifiedFacts.join("; ")}</span>
            )}
            {review.guesses.length > 0 && (
              <span className="text-zinc-400">Guesses: {review.guesses.join("; ")}</span>
            )}
            {isPlatform && review.sourceUrls.length > 0 && (
              <span className="flex flex-wrap gap-1">
                {review.sourceUrls.map((u, i) => (
                  <a key={i} href={u} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
                    source {i + 1}
                  </a>
                ))}
              </span>
            )}
          </div>
        ) : (
          <span className="text-zinc-400">No suggestion</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs tabular-nums">
        {review.confidence > 0 ? `${Math.round(review.confidence * 100)}%` : "-"}
      </td>
      {isPlatform && <td className="px-3 py-2 text-xs">{review.providerName || "-"}</td>}
      <td className="px-3 py-2">
        <StatusBadge status={review.status === "open" ? "needs_review" : (review.status as "resolved" | "ignored")} />
      </td>
      <td className="px-3 py-2">
        <SyncBadge status={review.syncStatus} />
      </td>
      <td className="px-3 py-2">
        {warn && (
          <div className="mb-2 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800" data-testid="mismatch-warning">
            <p className="font-semibold">Possible wrong product</p>
            <p className="mt-0.5">{warn.verdict.message}</p>
            <div className="mt-1.5 flex gap-1">
              <button
                type="button"
                data-testid="mismatch-override"
                onClick={() => resolveUnknown(review.id, "link_existing", { productId: warn.productId, applyToCount, confirmedMismatch: true })}
                className="rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700"
              >
                Link anyway
              </button>
              <button type="button" data-testid="mismatch-cancel" onClick={() => clearMismatchWarning()} className="rounded border border-zinc-300 px-2 py-1">
                Cancel
              </button>
            </div>
          </div>
        )}
        {resolved ? (
          <span className="text-xs text-zinc-400">{review.resolutionAction ?? review.status}</span>
        ) : mode === "create" ? (
          <div className="flex w-64 flex-col gap-1" data-testid="create-form">
            <input
              aria-label="product name"
              value={np.name}
              onChange={(e) => setNp({ ...np, name: e.target.value })}
              placeholder="Product name"
              className="rounded border border-zinc-300 px-2 py-1 text-xs"
            />
            <div className="flex gap-1">
              <input
                aria-label="brand"
                value={np.brand}
                onChange={(e) => setNp({ ...np, brand: e.target.value })}
                placeholder="Brand"
                className="w-1/2 rounded border border-zinc-300 px-2 py-1 text-xs"
              />
              <input
                aria-label="category"
                value={np.category}
                onChange={(e) => setNp({ ...np, category: e.target.value })}
                placeholder="Category"
                className="w-1/2 rounded border border-zinc-300 px-2 py-1 text-xs"
              />
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                data-testid="create-save"
                onClick={() =>
                  resolveUnknown(review.id, "create_new", {
                    newProduct: { name: np.name || review.cleanCode, brand: np.brand, category: np.category },
                    applyToCount,
                  })
                }
                className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
              >
                Save product
              </button>
              <button
                type="button"
                onClick={() => setMode("idle")}
                className="rounded border border-zinc-300 px-2 py-1 text-xs"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            {review.hasSuggestion && review.suggestedProductName && (
              <button
                type="button"
                data-testid="approve-suggestion"
                onClick={() =>
                  resolveUnknown(review.id, "create_new", {
                    applyToCount,
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
                  })
                }
                title="Approve this AI suggestion and save it as a verified product + alias"
                className="rounded bg-amber-600 px-2 py-1 text-xs font-medium text-white hover:bg-amber-700"
              >
                Approve suggestion
              </button>
            )}
            <select
              aria-label="link to product"
              value={linkId}
              onChange={(e) => setLinkId(e.target.value)}
              className="max-w-40 rounded border border-zinc-300 px-1 py-1 text-xs"
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="link-existing"
              onClick={() => resolveUnknown(review.id, "link_existing", { productId: linkId, applyToCount })}
              className="rounded bg-green-600 px-2 py-1 text-xs font-medium text-white hover:bg-green-700"
            >
              Link
            </button>
            <button
              type="button"
              data-testid="open-create"
              onClick={() => {
                // Pre-fill from the AI suggestion (if any) so create-once is a quick edit.
                setNp({
                  name: review.suggestedProductName,
                  brand: review.suggestedBrand,
                  category: review.suggestedCategory,
                });
                setMode("create");
              }}
              className="rounded border border-zinc-300 px-2 py-1 text-xs"
            >
              Create new
            </button>
            <button
              type="button"
              data-testid="ignore-review"
              onClick={() => resolveUnknown(review.id, "ignore", {})}
              className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-500"
            >
              Ignore
            </button>
            {isPlatform && (
              <button
                type="button"
                data-testid="live-decode"
                onClick={() => void liveDecode(review.id)}
                title={
                  aiEnabled
                    ? "Run a live AI decode (cross-checked + app-verified evidence). Result is a suggestion you approve."
                    : "AI lookup is off (enable it in Settings)"
                }
                className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-500 disabled:opacity-40"
                disabled={!aiEnabled}
              >
                Live decode
              </button>
            )}
            <label className="flex items-center gap-1 text-xs text-zinc-500">
              <input type="checkbox" checked={applyToCount} onChange={(e) => setApplyToCount(e.target.checked)} />
              count it
            </label>
          </div>
        )}
      </td>
    </tr>
  );
}
