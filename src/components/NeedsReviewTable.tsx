"use client";

import { useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import { useIsPlatformOwner } from "@/services/security/useAccessLevel";
import { StatusBadge, SyncBadge } from "@/components/badges";
import { buildDiscoveredIdentifiers } from "@/services/discoveredIdentifiers";
import { prettifyProductName } from "@/services/format/productDisplay";
import { getIdentityConfidenceBand, identityBandWord } from "@/services/ai/identityConfidenceBand";
import type { UnknownCodeReview } from "@/types";

// Shows the decode pipeline outcome. Two visible states only: "Verified" (app-confirmed) and
// "Suggested" (everything else, including a provider conflict) - Plan C collapses the old
// "Conflict" wall state into "Suggested" since it is a non-blocking label, not a gate (Plan A
// already makes every scan count). "Verified match" requires the app to have independently
// verified the exact code in strong evidence AND cross-checked providers - it is never the
// model's self-claim, and it still requires human approval to count (unless the owner opts
// into auto-accept).
function DecodeBadge({ review, isPlatform }: { review: UnknownCodeReview; isPlatform: boolean }) {
  // Customer-facing labels avoid "AI"/"providers"; platformOwner sees the technical wording.
  const status = review.decodeStatus ?? "none";
  if (status === "verified" && review.exactCodeEvidenceVerifiedByApp) {
    return (
      <span className="w-fit rounded-md bg-green-100 px-1.5 py-0.5 text-sm font-medium text-green-800" data-testid="decode-status">
        {isPlatform ? "Verified match (app-confirmed)" : "Verified match"}
      </span>
    );
  }
  return (
    <span className="w-fit rounded-md bg-amber-100 px-1.5 py-0.5 text-sm font-medium text-amber-900" data-testid="decode-status">
      {isPlatform ? "Suggested - needs approval" : "Suggested product"}
    </span>
  );
}

// Needs Review queue. Unknown / conflicting codes land here and are never silently counted.
// Human resolution permanently learns an alias (handled by the store), so the AI is never asked
// about that code again.
export function NeedsReviewTable() {
  const allReviews = useScanStore((s) => s.needsReviewQueue);
  const isPlatform = useIsPlatformOwner();
  // Owner rule (2026-07-22, supersedes the resolved-but-unsynced carve-out of 2026-07-14): the
  // queue shows ONLY items still awaiting a human decision. A resolved item vanishes immediately -
  // the device already has everything and the cloud backup retries invisibly in the background
  // (pendingSyncQueue + the global sync indicator cover a stuck backup; a shop owner never needs
  // to see sync state here). "suggested" reviews also never belong here - they live on the feed
  // row's inline controls + the SuggestedApprovalPanel. "ignored" is likewise a made decision
  // (the human clicked Ignore), so it leaves the queue with the resolved ones.
  const reviews = allReviews.filter((r) => r.status === "open");

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 px-4 py-3">
        <h2 id="review-heading" className="text-lg font-semibold text-zinc-900">Suggested items (confirm if you like)</h2>
        <p className="text-sm text-zinc-700">
          {isPlatform
            ? "Unknown or lower-confidence codes. Results here are suggestions only, already counted, and confirming just makes future scans of that code deterministic. Once confirmed, the barcode is saved so future scans count automatically."
            : "These codes already count. Confirm the right product once if you like, and from then on scanning that code is automatic."}
        </p>
      </div>
      <div
        className="overflow-auto shadow-[inset_-8px_0_6px_-6px_rgba(0,0,0,0.08)]"
        tabIndex={0}
        role="region"
        aria-label="Suggested items table, scroll horizontally for more columns"
      >
        <table className="w-full border-collapse text-left text-base" aria-labelledby="review-heading">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-sm font-semibold text-zinc-700">
            <tr>
              {isPlatform && <th scope="col" className="px-4 py-3">Raw code</th>}
              {isPlatform && <th scope="col" className="px-4 py-3">Normalised barcode</th>}
              <th scope="col" className="px-4 py-3">Barcode</th>
              <th scope="col" className="px-4 py-3">Reason</th>
              <th scope="col" className="px-4 py-3">Suggested product</th>
              <th scope="col" className="px-4 py-3">Confidence</th>
              {isPlatform && <th scope="col" className="px-4 py-3">Provider</th>}
              <th scope="col" className="px-4 py-3">Status</th>
              <th scope="col" className="px-4 py-3">Sync</th>
              <th scope="col" className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody data-testid="review-body">
            {reviews.length === 0 ? (
              <tr>
                <td colSpan={isPlatform ? 10 : 7} className="px-4 py-6 text-center text-base text-zinc-600">
                  Nothing to review. Unrecognised codes will appear here for you to identify.
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
  const correctionRecheck = useScanStore((s) => s.correctionRecheck);
  const aiEnabled = useScanStore((s) => s.settings.aiLookupEnabled);
  const lastMismatchWarning = useScanStore((s) => s.lastMismatchWarning);
  const clearMismatchWarning = useScanStore((s) => s.clearMismatchWarning);
  // Show the human-mistake warning only on the row + product it was raised for.
  const warn = lastMismatchWarning && lastMismatchWarning.reviewId === review.id ? lastMismatchWarning : null;

  const [mode, setMode] = useState<"idle" | "create">("idle");
  const [linkId, setLinkId] = useState("");
  const [applyToCount, setApplyToCount] = useState(true);
  const [np, setNp] = useState({ name: "", brand: "", category: "" });

  // W2: discovered identifiers the human can approve as aliases. Default = all selected; the human
  // unchecks to exclude. Approval still requires an explicit click (never auto-saved).
  const discovered = buildDiscoveredIdentifiers(review);
  const [deselected, setDeselected] = useState<string[]>([]);
  const selectedCodes = discovered.map((d) => d.code).filter((c) => !deselected.includes(c));
  const toggleCode = (code: string, on: boolean) =>
    setDeselected((prev) => (on ? prev.filter((c) => c !== code) : Array.from(new Set([...prev, code]))));
  const aliasConflicts = useScanStore((s) => s.lastAliasConflicts);
  const myConflicts = (aliasConflicts ?? []).filter((c) => c.reviewId === review.id);
  // Phase 4 (C4, plan-review-mandated): a review carrying importQuantity came from a universal-import
  // row, not a scan. Its confirmation must be explicitly human-origin (so the poison guard / weak-guess
  // check never treats an import row as an AI suggestion), and it must NEVER expose live-decode or
  // correction-recheck - Phase 4 makes ZERO /api/ai-lookup calls, and those two actions POST the code to
  // that route. importQuantity !== undefined is the store's own import-origin marker (see types.ts).
  const isImportOrigin = review.importQuantity !== undefined;
  const importHumanOrigin = isImportOrigin ? { origin: "human" as const } : {};

  // Task 9b: a parked "suggested" review is still AWAITING the human (never styled/treated as
  // resolved). Defense in depth - the table filter above already excludes suggested reviews.
  const resolved = review.status !== "open" && review.status !== "suggested";

  // Identity-merge suggest_link (QA 2026-07-15 issue 3): when the decode fuzzily matches a product
  // ALREADY in the shop, resolveUnknown parks the candidate on suggestedLinkProductId and refuses to
  // mint a duplicate. Rendering that candidate as a one-tap "Link to <product>" is the only way the
  // operator can act on it - without it, "Approve suggestion" was a silent no-op on these rows.
  const suggestedLinkProduct = review.suggestedLinkProductId
    ? products.find((p) => p.id === review.suggestedLinkProductId && p.status !== "archived")
    : undefined;

  // P4: elderly-readable controls. One PRIMARY action per row (blue filled, >=44px, text-base); everything
  // else is a same-size outline so nothing scary competes with the primary. Approve is primary when there is
  // a suggestion to approve; otherwise Link (to an existing product) is the primary.
  const primaryIsApprove = !!(review.hasSuggestion && review.suggestedProductName);
  const btnBase = "inline-flex min-h-[44px] items-center rounded-lg px-4 text-base font-medium";
  const btnPrimary = `${btnBase} bg-blue-600 text-white hover:bg-blue-700`;
  const btnSecondary = `${btnBase} border border-zinc-300 text-zinc-700 hover:bg-zinc-50`;

  return (
    <tr className="border-t border-zinc-100 align-top hover:bg-zinc-50" data-testid={`review-row-${review.cleanCode}`}>
      {isPlatform && <td className="px-4 py-3 font-mono text-sm">{review.rawCode}</td>}
      {isPlatform && <td className="px-4 py-3 font-mono text-sm">{review.cleanCode}</td>}
      <td className="px-4 py-3 font-mono text-sm" data-testid="review-barcode">{review.cleanCode || review.rawCode || "-"}</td>
      <td className="max-w-48 px-4 py-3 text-sm text-zinc-700" data-testid="review-reason">
        {review.reason || "Unknown code."}
        {/* Task 9 copy fix: never show the "confidence too low" demotion next to a decode the app actually
            VERIFIED. The old demotion rendered a bogus "50/100" beside a real 90% app-verified decode (the
            hot-sauce incident). A verified decode is not "too low to save" - its confidence is honest. */}
        {typeof review.autoVerifyScore === "number" && review.decodeStatus !== "verified" && (
          <span className="mt-1 block text-zinc-600" data-testid="review-score">
            Confidence too low to save automatically ({review.autoVerifyScore}/100)
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
      <td className="max-w-56 px-4 py-3 text-sm">
        {review.hasSuggestion || (review.sourceUrls?.length ?? 0) > 0 ? (
          <div className="flex flex-col gap-1">
            <DecodeBadge review={review} isPlatform={isPlatform} />
            {isPlatform && review.evidenceStrength && review.evidenceStrength !== "none" && (
              <span className="text-zinc-600" data-testid="evidence-strength">
                Evidence: {({ url_only: "URL match", snippet: "Text snippet", grounding_chunk: "Grounded source", fetched_source: "Fetched page" } as Record<string, string>)[review.evidenceStrength] ?? review.evidenceStrength.replace(/_/g, " ")}{" "}
                ({review.exactCodeEvidenceVerifiedByApp ? "verified by app" : "not verified"})
                {review.crossCheckDecision ? ` - ${({ agree: "two sources agree", single_provider: "one source only", conflict: "sources disagree", weak: "low confidence" } as Record<string, string>)[review.crossCheckDecision] ?? review.crossCheckDecision}` : ""}
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
                  .map((p) => `${p.provider}: ${p.productName || "no result"} (${p.sources} source${p.sources === 1 ? "" : "s"})`)
                  .join(" | ")}
              </span>
            )}
            {isPlatform && review.prefixHint && (
              <span className="text-zinc-500" data-testid="prefix-hint">
                Barcode prefix: {review.prefixHint}
              </span>
            )}
            {isPlatform && review.prefixConflictReason && (
              <span className="w-fit rounded-md bg-amber-50 px-1.5 py-0.5 text-sm text-amber-900" data-testid="prefix-conflict">
                Brand check blocked: {review.prefixConflictReason}
              </span>
            )}
            {isPlatform && review.reverseUpcConflictNote && (
              <span className="w-fit rounded bg-amber-50 px-1.5 py-0.5 text-amber-800" data-testid="reverse-upc-conflict">
                {review.reverseUpcConflictNote}
              </span>
            )}
            {(review.verifiedFacts?.length ?? 0) > 0 && (
              <span className="text-zinc-500">Facts: {review.verifiedFacts!.join("; ")}</span>
            )}
            {(review.guesses?.length ?? 0) > 0 && (
              <span className="text-zinc-600">Guesses: {review.guesses!.join("; ")}</span>
            )}
            {isPlatform && (review.sourceUrls?.length ?? 0) > 0 && (
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
          <span className="text-zinc-600">No suggestion</span>
        )}
      </td>
      <td className="px-4 py-3 text-sm">
        {/* Owner decision 2026-08-19: the app's own band, never a raw provider percentage. */}
        {review.hasSuggestion
          ? identityBandWord(
              getIdentityConfidenceBand({
                confidence: review.confidence,
                evidenceStrength: review.evidenceStrength,
                exactCodeEvidenceVerifiedByApp: review.exactCodeEvidenceVerifiedByApp,
              }),
            )
          : "-"}
      </td>
      {isPlatform && <td className="px-4 py-3 text-sm">{review.providerName || "-"}</td>}
      <td className="px-4 py-3">
        {/* Task 9b: StatusBadge is "suggested"-aware, so the raw review status passes through
            without the old unsafe cast (which fed "suggested" into undefined map/label lookups). */}
        <StatusBadge status={review.status === "open" ? "needs_review" : review.status} />
      </td>
      <td className="px-4 py-3">
        <SyncBadge status={review.syncStatus} />
      </td>
      <td className="px-4 py-3">
        {warn && (
          <div className="mb-2 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800" data-testid="mismatch-warning">
            <p className="font-semibold">Possible wrong product</p>
            <p className="mt-0.5">{warn.verdict.message}</p>
            <div className="mt-1.5 flex gap-1">
              <button
                type="button"
                data-testid="mismatch-override"
                onClick={() => resolveUnknown(review.id, "link_existing", { productId: warn.productId, applyToCount, confirmedMismatch: true, ...importHumanOrigin })}
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
        {myConflicts.length > 0 && (
          <div data-testid="alias-conflict" className="mb-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
            <p className="font-semibold">Some identifiers already belong to another product</p>
            <p className="mt-0.5">
              {myConflicts.length} selected identifier(s) were not linked because they are already approved for a
              different product. They were not overwritten.
            </p>
          </div>
        )}
        {isPlatform && !resolved && discovered.length > 0 && (
          <div className="mb-2 rounded border border-zinc-200 bg-zinc-50 p-2" data-testid="discovered-identifiers">
            <p className="text-xs font-medium text-zinc-600">Extra barcodes found (check the ones to save for future scans)</p>
            <div className="mt-1 flex flex-col gap-0.5">
              {discovered.map((d) => (
                <label key={d.code} className="flex items-center gap-1 text-xs text-zinc-600">
                  <input
                    type="checkbox"
                    data-testid={`discovered-${d.code}`}
                    checked={selectedCodes.includes(d.code)}
                    onChange={(e) => toggleCode(d.code, e.target.checked)}
                  />
                  <span>
                    {d.label}: <span className="font-mono text-zinc-800">{d.code}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
        {resolved ? null : mode === "create" ? ( // resolved rows are filtered out above; branch kept as defense in depth

          <div className="flex w-64 flex-col gap-1.5" data-testid="create-form">
            <input
              aria-label="product name"
              value={np.name}
              onChange={(e) => setNp({ ...np, name: e.target.value })}
              placeholder="Product name"
              className="min-h-[44px] rounded-lg border border-zinc-300 px-3 text-base"
            />
            <div className="flex gap-1.5">
              <input
                aria-label="brand"
                value={np.brand}
                onChange={(e) => setNp({ ...np, brand: e.target.value })}
                placeholder="Brand"
                className="min-h-[44px] w-1/2 rounded-lg border border-zinc-300 px-3 text-base"
              />
              <input
                aria-label="category"
                value={np.category}
                onChange={(e) => setNp({ ...np, category: e.target.value })}
                placeholder="Category"
                className="min-h-[44px] w-1/2 rounded-lg border border-zinc-300 px-3 text-base"
              />
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                data-testid="create-save"
                onClick={() =>
                  resolveUnknown(review.id, "create_new", {
                    ...importHumanOrigin,
                    newProduct: { name: np.name || review.cleanCode, brand: np.brand, category: np.category },
                    applyToCount,
                    selectedAliasCodes: selectedCodes,
                  })
                }
                className={btnPrimary}
              >
                Save product
              </button>
              <button
                type="button"
                onClick={() => setMode("idle")}
                className={btnSecondary}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            {suggestedLinkProduct && (
              <span className="w-full text-sm text-zinc-600" data-testid="suggest-link-note">
                This looks like a product already in your list: {prettifyProductName(suggestedLinkProduct.name)}.
                Link it so it is not duplicated.
              </span>
            )}
            {suggestedLinkProduct && (
              <button
                type="button"
                data-testid="link-suggested"
                onClick={() =>
                  resolveUnknown(review.id, "link_existing", {
                    productId: suggestedLinkProduct.id,
                    applyToCount,
                    selectedAliasCodes: selectedCodes,
                  })
                }
                title="Connect this code to the matching product already in your list"
                className={btnPrimary}
              >
                Link to {prettifyProductName(suggestedLinkProduct.name)}
              </button>
            )}
            {!suggestedLinkProduct && review.hasSuggestion && review.suggestedProductName && (
              <button
                type="button"
                data-testid="approve-suggestion"
                onClick={() =>
                  resolveUnknown(review.id, "create_new", {
                    ...importHumanOrigin,
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
                    selectedAliasCodes: selectedCodes,
                  })
                }
                title="Approve this AI suggestion and save it as a verified product + alias"
                className={btnPrimary}
              >
                Approve suggestion
              </button>
            )}
            <select
              aria-label="link to product"
              value={linkId}
              onChange={(e) => setLinkId(e.target.value)}
              className="min-h-[44px] max-w-48 rounded-lg border border-zinc-300 px-2 text-base"
            >
              <option value="" disabled>
                Select a product...
              </option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {prettifyProductName(p.name)}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="link-existing"
              disabled={!linkId}
              onClick={() => resolveUnknown(review.id, "link_existing", { productId: linkId, applyToCount, selectedAliasCodes: selectedCodes, ...importHumanOrigin })}
              className={primaryIsApprove ? btnSecondary : btnPrimary}
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
              className={btnSecondary}
            >
              Create new
            </button>
            <button
              type="button"
              data-testid="ignore-review"
              onClick={() => resolveUnknown(review.id, "ignore", {})}
              className={btnSecondary}
            >
              Ignore
            </button>
            {/* C4: an import-origin review NEVER shows live-decode or correction-recheck - both POST the
                code to /api/ai-lookup, and Phase 4 makes ZERO such calls. Human link/confirm only. */}
            {isPlatform && !isImportOrigin && (
              <button
                type="button"
                data-testid="live-decode"
                onClick={() => void liveDecode(review.id)}
                title={
                  aiEnabled
                    ? "Look up this barcode with AI. The result is a suggestion you approve."
                    : "AI lookup is off (enable it in Settings)"
                }
                className={`${btnSecondary} disabled:opacity-40`}
                disabled={!aiEnabled}
              >
                Look up with AI
              </button>
            )}
            {isPlatform && !isImportOrigin && (
              <button
                type="button"
                data-testid="stronger-redecode"
                onClick={() => void correctionRecheck(review.id, { retry: true })}
                title="Try again with a more thorough lookup. The result is a suggestion you approve."
                className={`${btnBase} border border-purple-300 bg-purple-50 text-purple-700 hover:bg-purple-100 disabled:opacity-40`}
                disabled={!aiEnabled}
              >
                Deep lookup
              </button>
            )}
            <label className="flex items-center gap-1.5 text-base text-zinc-700">
              <input type="checkbox" className="h-5 w-5 rounded" checked={applyToCount} onChange={(e) => setApplyToCount(e.target.checked)} />
              Add to count
            </label>
          </div>
        )}
      </td>
    </tr>
  );
}
