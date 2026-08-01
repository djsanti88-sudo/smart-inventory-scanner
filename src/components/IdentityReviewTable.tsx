"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Role = "owner" | "admin" | "counter" | "viewer";
type Bucket = "automatic" | "review" | "abstain" | "non_product" | "invalid";
type Candidate = { productId: string; rank: number; evidence: string[]; missingFields: string[]; contradictions: string[] };
type CurrentApprovedLink = { sourceSystem: string; sourceSignature: string; vendorId: string; identifierType: string; namespace: string; normalizedValue: string; targetProductId: string; version: number; predecessorFingerprint: string; predecessorSource: "configured" | "durable" };
export type IdentityReviewRow = { reviewId: string; rowId: string; scope?: { sourceSystem: string; vendorId: string; sourceSignature: string }; currentApprovedLink?: { targetProductId: string; version: number }; decision: { kind: string; candidates: Candidate[] } };
type Action = "confirm_candidate" | "reject" | "create_tenant_product" | "revoke_link";
const buckets: Array<{ key: Bucket; label: string }> = [{ key: "automatic", label: "Automatic" }, { key: "review", label: "Review" }, { key: "abstain", label: "Abstain" }, { key: "non_product", label: "Non-product" }, { key: "invalid", label: "Invalid" }];
const pageSize = 25;

function safeBucket(value: string): Bucket { return buckets.some((bucket) => bucket.key === value) ? value as Bucket : "review"; }
function topCandidate(row: IdentityReviewRow): Candidate | undefined { return [...row.decision.candidates].sort((left, right) => left.rank - right.rank || left.productId.localeCompare(right.productId))[0]; }
function bodyMessage(value: unknown, fallback: string): string { return value && typeof value === "object" && "error" in value && typeof (value as { error?: unknown }).error === "string" ? (value as { error: string }).error : fallback; }
function linkKey(link: CurrentApprovedLink): string { return link.predecessorFingerprint; }

export function IdentityReviewTable(props: { businessId: string; actorRole: Role; previewDecisions?: readonly IdentityReviewRow[] }) { return <IdentityReviewQueue key={props.businessId} {...props} />; }

function IdentityReviewQueue({ businessId, actorRole, previewDecisions = [] }: { businessId: string; actorRole: Role; previewDecisions?: readonly IdentityReviewRow[] }) {
  const [reviews, setReviews] = useState<IdentityReviewRow[]>([]), [links, setLinks] = useState<CurrentApprovedLink[]>([]), [status, setStatus] = useState("Loading identity reviews."), [error, setError] = useState(""), [page, setPage] = useState(0), [linkTotal, setLinkTotal] = useState(0), [bucket, setBucket] = useState<Bucket>("review"), [pending, setPending] = useState<string | null>(null), [productName, setProductName] = useState<Record<string, string>>({}), [selected, setSelected] = useState<Record<string, string>>({}), [serverTotal, setServerTotal] = useState(0), [serverTotals, setServerTotals] = useState<Record<Bucket, number>>({ automatic: 0, review: 0, abstain: 0, non_product: 0, invalid: 0 }), [reload, setReload] = useState(0), [focusTarget, setFocusTarget] = useState<"review" | "link" | null>(null);
  const generation = useRef(0), initialLoadComplete = useRef(false), statusRef = useRef<HTMLParagraphElement>(null), sectionRef = useRef<HTMLElement>(null);
  const canResolve = actorRole === "owner" || actorRole === "admin";
  useEffect(() => {
    const controller = new AbortController(), request = ++generation.current;
    void fetch(`/api/identity/reviews?businessId=${encodeURIComponent(businessId)}&bucket=${encodeURIComponent(bucket)}&page=${page + 1}&linkPage=${page + 1}&pageSize=${pageSize}`, { signal: controller.signal }).then(async (response) => {
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(bodyMessage(body, "Unable to load identity reviews."));
      if (generation.current !== request) return;
      const loaded = body && typeof body === "object" && Array.isArray((body as { reviews?: unknown }).reviews) ? (body as { reviews: IdentityReviewRow[] }).reviews : [];
      const loadedLinks = body && typeof body === "object" && Array.isArray((body as { currentApprovedLinks?: unknown }).currentApprovedLinks) ? (body as { currentApprovedLinks: CurrentApprovedLink[] }).currentApprovedLinks : [];
      setReviews(loaded); setLinks(loadedLinks); setServerTotal(typeof (body as { total?: unknown })?.total === "number" ? (body as { total: number }).total : loaded.length); setLinkTotal(typeof (body as { linkTotal?: unknown })?.linkTotal === "number" ? (body as { linkTotal: number }).linkTotal : loadedLinks.length); const totals = (body as { bucketTotals?: unknown })?.bucketTotals; if (totals && typeof totals === "object") setServerTotals(Object.fromEntries(buckets.map(({ key }) => [key, typeof (totals as Record<string, unknown>)[key] === "number" ? (totals as Record<string, number>)[key] : 0])) as Record<Bucket, number>); if (!initialLoadComplete.current) { initialLoadComplete.current = true; setStatus(loaded.length || loadedLinks.length ? "Identity reviews loaded." : "No identity reviews or approved links are available."); }
    }).catch((reason: unknown) => { if (generation.current === request && !controller.signal.aborted) { const message = reason instanceof Error ? reason.message : "Unable to load identity reviews."; setError(message); setStatus("Identity reviews could not be loaded."); } });
    return () => controller.abort();
  }, [businessId, bucket, page, reload]);
  void previewDecisions;
  const matching = useMemo(() => reviews.filter((row) => safeBucket(row.decision.kind) === bucket), [bucket, reviews]);
  const pageCount = Math.max(1, Math.ceil(serverTotal / pageSize), Math.ceil(linkTotal / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  useEffect(() => {
    if (!focusTarget || pending) return;
    const selector = focusTarget === "link" ? "[data-link-action]" : "[data-review-action]";
    const next = [...(sectionRef.current?.querySelectorAll<HTMLButtonElement>(selector) ?? [])].find((button) => !button.disabled);
    if (next) { next.focus(); queueMicrotask(() => setFocusTarget(null)); return; }
    if ((focusTarget === "link" && links.length === 0) || (focusTarget === "review" && matching.length === 0)) { statusRef.current?.focus(); queueMicrotask(() => setFocusTarget(null)); }
  }, [focusTarget, links, matching, pending]);
  async function action(row: IdentityReviewRow, actionName: Exclude<Action, "revoke_link">, targetProductId?: string) {
    if (pending || !canResolve) return;
    const name = productName[row.reviewId]?.trim();
    if (actionName === "create_tenant_product" && !name) { setError("Enter a tenant product name before creating it."); return; }
    setPending(`review:${row.reviewId}`); setError("");
    try {
      const response = await fetch("/api/identity/reviews", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `review:${row.reviewId}:${actionName}` }, body: JSON.stringify({ businessId, reviewId: row.reviewId, action: actionName, ...(targetProductId ? { targetProductId } : {}), ...(actionName === "create_tenant_product" ? { name } : {}) }) });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(bodyMessage(body, "Review action failed."));
      setFocusTarget("review");
      setReviews((current) => current.filter((item) => item.reviewId !== row.reviewId)); setReload((current) => current + 1);
      setStatus(actionName === "confirm_candidate" ? "Candidate confirmed." : actionName === "create_tenant_product" ? "Tenant product created." : "Review rejected.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Review action failed."); }
    finally { setPending(null); }
  }
  async function revokeLink(link: CurrentApprovedLink) {
    const key = `link:${linkKey(link)}`;
    if (pending || !canResolve) return;
    setPending(key); setError("");
    try {
      const response = await fetch("/api/identity/reviews", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `link:${link.predecessorFingerprint}:revoke` }, body: JSON.stringify({ businessId, action: "revoke_link", link }) });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(bodyMessage(body, "Approved identity link could not be revoked."));
      setFocusTarget("link");
      setLinks((current) => current.filter((item) => linkKey(item) !== linkKey(link))); setReload((current) => current + 1);
      setStatus("Identity link revoked.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Approved identity link could not be revoked."); }
    finally { setPending(null); }
  }
  return <section ref={sectionRef} aria-label="Identity review queue"><p ref={statusRef} role="status" aria-live="polite" tabIndex={-1} className="text-sm text-zinc-600">{pending ? "Submitting identity review action." : status} Page {currentPage + 1} of {pageCount}.</p>{error && <p role="alert">{error}</p>}<div role="group" aria-label="Decision filters">{buckets.map(({ key, label }) => <button key={key} type="button" aria-pressed={bucket === key} onClick={() => { initialLoadComplete.current = false; setStatus("Loading identity reviews."); setBucket(key); setPage(0); }} className="min-h-11 px-3">{label} ({serverTotals[key]})</button>)}</div><div className="overflow-x-auto"><table aria-label="Identity review queue" className="w-full text-left"><thead><tr><th scope="col">Import row</th><th scope="col">Candidate</th><th scope="col">Evidence and scope</th><th scope="col">Action</th></tr></thead><tbody>{matching.map((row) => { const defaultCandidate = topCandidate(row), candidate = row.decision.candidates.find((item) => item.productId === (selected[row.reviewId] ?? defaultCandidate?.productId)) ?? defaultCandidate, busy = pending === `review:${row.reviewId}`, actionable = row.decision.kind === "review"; return <tr key={row.rowId} aria-busy={busy || undefined}><th scope="row">{row.rowId}</th><td><fieldset><legend className="sr-only">Candidate for {row.rowId}</legend>{row.decision.candidates.map((item) => <label key={item.productId} className="inline-flex min-h-11 items-center gap-2"><input className="min-h-11 min-w-11" type="radio" name={`candidate:${row.reviewId}`} checked={candidate?.productId === item.productId} disabled={busy} onChange={() => setSelected((current) => ({ ...current, [row.reviewId]: item.productId }))} />{item.productId}</label>)}</fieldset></td><td><ul>{candidate?.evidence.map((value) => <li key={`e:${value}`}>{value}</li>)}{candidate?.missingFields.map((value) => <li key={`m:${value}`}>Missing: {value}</li>)}{candidate?.contradictions.map((value) => <li key={`c:${value}`}>Contradiction: {value}</li>)}</ul>{row.scope && <small>{row.scope.sourceSystem} / {row.scope.vendorId} / {row.scope.sourceSignature}</small>}</td><td>{canResolve && actionable && <><button data-review-action className="min-h-11 px-3" type="button" disabled={busy || !candidate} onClick={() => candidate && void action(row, "confirm_candidate", candidate.productId)}>Confirm {candidate?.productId ?? "candidate"}</button><button data-review-action className="min-h-11 px-3" type="button" disabled={busy} onClick={() => void action(row, "reject")}>Reject</button><label className="inline-flex min-h-11 items-center gap-2">Tenant product name<input className="min-h-11" aria-label={`Tenant product name for ${row.rowId}`} value={productName[row.reviewId] ?? ""} disabled={busy} onChange={(event) => setProductName((current) => ({ ...current, [row.reviewId]: event.target.value }))} /></label><button data-review-action className="min-h-11 px-3" type="button" disabled={busy} onClick={() => void action(row, "create_tenant_product")}>Create tenant product</button></>}</td></tr>; })}</tbody></table></div><section aria-label="Current approved identity links" className="mt-6"><h2>Current approved links</h2><div className="overflow-x-auto"><table aria-label="Current approved links" className="w-full text-left"><thead><tr><th scope="col">Identifier</th><th scope="col">Source</th><th scope="col">Vendor</th><th scope="col">Target</th><th scope="col">Version</th>{canResolve && <th scope="col">Action</th>}</tr></thead><tbody>{links.map((link) => { const busy = pending === `link:${linkKey(link)}`; return <tr key={linkKey(link)} aria-busy={busy || undefined}><td>{link.identifierType}: {link.normalizedValue}</td><td>{link.sourceSystem} / {link.sourceSignature}</td><td>{link.vendorId}</td><td>{link.targetProductId}</td><td>{link.version}</td>{canResolve && <td><button data-link-action className="min-h-11 px-3" type="button" disabled={busy} onClick={() => void revokeLink(link)}>Revoke approved link {link.normalizedValue}</button></td>}</tr>; })}</tbody></table></div></section><nav aria-label="Identity review pagination"><button className="min-h-11 px-3" type="button" disabled={currentPage === 0} onClick={() => { initialLoadComplete.current = false; setStatus("Loading identity reviews."); setPage(currentPage - 1); }}>Previous page</button><button className="min-h-11 px-3" type="button" disabled={currentPage + 1 >= pageCount} onClick={() => { initialLoadComplete.current = false; setStatus("Loading identity reviews."); setPage(currentPage + 1); }}>Next page</button></nav></section>;
}
