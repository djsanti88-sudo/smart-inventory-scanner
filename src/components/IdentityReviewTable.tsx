"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Role = "owner" | "admin" | "counter" | "viewer";
type Bucket = "automatic" | "review" | "abstain" | "non_product" | "invalid";
type Candidate = { productId: string; rank: number; evidence: string[]; missingFields: string[]; contradictions: string[] };
export type IdentityReviewRow = { reviewId: string; rowId: string; scope?: { sourceSystem: string; vendorId: string; sourceSignature: string }; decision: { kind: string; candidates: Candidate[] } };
type Action = "confirm_candidate" | "reject" | "create_tenant_product" | "revoke_link";
const buckets: Array<{ key: Bucket; label: string }> = [{ key: "automatic", label: "Automatic" }, { key: "review", label: "Review" }, { key: "abstain", label: "Abstain" }, { key: "non_product", label: "Non-product" }, { key: "invalid", label: "Invalid" }];
const pageSize = 25;

function safeBucket(value: string): Bucket { return buckets.some((bucket) => bucket.key === value) ? value as Bucket : "review"; }
function topCandidate(row: IdentityReviewRow): Candidate | undefined { return [...row.decision.candidates].sort((left, right) => left.rank - right.rank || left.productId.localeCompare(right.productId))[0]; }
function bodyMessage(value: unknown, fallback: string): string { return value && typeof value === "object" && "error" in value && typeof (value as { error?: unknown }).error === "string" ? (value as { error: string }).error : fallback; }

export function IdentityReviewTable(props: { businessId: string; actorRole: Role; previewDecisions?: readonly IdentityReviewRow[] }) { return <IdentityReviewQueue key={props.businessId} {...props} />; }

function IdentityReviewQueue({ businessId, actorRole, previewDecisions = [] }: { businessId: string; actorRole: Role; previewDecisions?: readonly IdentityReviewRow[] }) {
  const [reviews, setReviews] = useState<IdentityReviewRow[]>([]), [status, setStatus] = useState("Loading identity reviews."), [error, setError] = useState(""), [page, setPage] = useState(0), [bucket, setBucket] = useState<Bucket>("review"), [pending, setPending] = useState<string | null>(null), [productName, setProductName] = useState<Record<string, string>>({});
  const generation = useRef(0), focusAfterResolve = useRef(false), actionArea = useRef<HTMLElement>(null);
  const canResolve = actorRole === "owner" || actorRole === "admin";
  useEffect(() => {
    const controller = new AbortController(), request = ++generation.current;
    void fetch(`/api/identity/reviews?businessId=${encodeURIComponent(businessId)}&page=1&pageSize=${pageSize}`, { signal: controller.signal }).then(async (response) => {
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(bodyMessage(body, "Unable to load identity reviews."));
      if (generation.current !== request) return;
      const loaded = body && typeof body === "object" && Array.isArray((body as { reviews?: unknown }).reviews) ? (body as { reviews: IdentityReviewRow[] }).reviews : [];
      setReviews(loaded); setStatus(loaded.length ? "Identity reviews loaded." : "No identity reviews need attention.");
    }).catch((reason: unknown) => { if (generation.current === request && !controller.signal.aborted) { const message = reason instanceof Error ? reason.message : "Unable to load identity reviews."; setError(message); setStatus("Identity reviews could not be loaded."); } });
    return () => controller.abort();
  }, [businessId]);
  const rows = useMemo(() => {
    const combined = new Map<string, IdentityReviewRow>();
    for (const row of previewDecisions) combined.set(row.rowId, row);
    for (const row of reviews) combined.set(row.rowId, row);
    return [...combined.values()];
  }, [previewDecisions, reviews]);
  const totals = useMemo(() => Object.fromEntries(buckets.map(({ key }) => [key, rows.filter((row) => safeBucket(row.decision.kind) === key).length])) as Record<Bucket, number>, [rows]);
  const matching = useMemo(() => rows.filter((row) => safeBucket(row.decision.kind) === bucket), [bucket, rows]);
  const pageCount = Math.max(1, Math.ceil(matching.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = matching.slice(currentPage * pageSize, currentPage * pageSize + pageSize);
  useEffect(() => { if (focusAfterResolve.current) { focusAfterResolve.current = false; actionArea.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(); } }, [visible, pending]);
  async function action(row: IdentityReviewRow, actionName: Action, targetProductId?: string) {
    if (pending || !canResolve) return;
    const name = productName[row.reviewId]?.trim();
    if (actionName === "create_tenant_product" && !name) { setError("Enter a tenant product name before creating it."); return; }
    setPending(row.reviewId); setError("");
    try {
      const response = await fetch("/api/identity/reviews", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `review:${row.reviewId}:${actionName}` }, body: JSON.stringify({ businessId, reviewId: row.reviewId, action: actionName, ...(targetProductId ? { targetProductId } : {}), ...(actionName === "create_tenant_product" ? { name } : {}) }) });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(bodyMessage(body, "Review action failed."));
      focusAfterResolve.current = true;
      setReviews((current) => current.filter((item) => item.reviewId !== row.reviewId));
      setStatus(actionName === "confirm_candidate" ? "Candidate confirmed." : actionName === "create_tenant_product" ? "Tenant product created." : actionName === "revoke_link" ? "Identity link revoked." : "Review rejected.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Review action failed."); }
    finally { setPending(null); }
  }
  return <section ref={actionArea} aria-label="Identity review queue"><p role="status" aria-live="polite" className="text-sm text-zinc-600">{status} Page {currentPage + 1} of {pageCount}.</p>{error && <p role="alert">{error}</p>}<div role="group" aria-label="Decision filters">{buckets.map(({ key, label }) => <button key={key} type="button" aria-pressed={bucket === key} onClick={() => { setBucket(key); setPage(0); }} className="min-h-11 px-3">{label} ({totals[key]})</button>)}</div><div className="overflow-x-auto"><table aria-label="Identity review queue" className="w-full text-left"><thead><tr><th scope="col">Import row</th><th scope="col">Candidate</th><th scope="col">Evidence and scope</th><th scope="col">Action</th></tr></thead><tbody>{visible.map((row) => { const candidate = topCandidate(row), busy = pending === row.reviewId; return <tr key={row.rowId} aria-busy={busy || undefined}><th scope="row">{row.rowId}</th><td>{candidate?.productId ?? "No candidate"}</td><td><ul>{candidate?.evidence.map((value) => <li key={`e:${value}`}>{value}</li>)}{candidate?.missingFields.map((value) => <li key={`m:${value}`}>Missing: {value}</li>)}{candidate?.contradictions.map((value) => <li key={`c:${value}`}>Contradiction: {value}</li>)}</ul>{row.scope && <small>{row.scope.sourceSystem} / {row.scope.vendorId} / {row.scope.sourceSignature}</small>}</td><td>{canResolve && <><button className="min-h-11 px-3" type="button" disabled={busy || !candidate} onClick={() => candidate && void action(row, "confirm_candidate", candidate.productId)}>Confirm {candidate?.productId ?? "candidate"}</button><button className="min-h-11 px-3" type="button" disabled={busy} onClick={() => void action(row, "reject")}>Reject</button><button className="min-h-11 px-3" type="button" disabled={busy || !candidate} onClick={() => candidate && void action(row, "revoke_link", candidate.productId)}>Revoke link</button><label>Tenant product name<input aria-label={`Tenant product name for ${row.rowId}`} value={productName[row.reviewId] ?? ""} disabled={busy} onChange={(event) => setProductName((current) => ({ ...current, [row.reviewId]: event.target.value }))} /></label><button className="min-h-11 px-3" type="button" disabled={busy} onClick={() => void action(row, "create_tenant_product")}>Create tenant product</button></>}</td></tr>; })}</tbody></table></div><nav aria-label="Identity review pagination"><button className="min-h-11 px-3" type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous page</button><button className="min-h-11 px-3" type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Next page</button></nav></section>;
}
