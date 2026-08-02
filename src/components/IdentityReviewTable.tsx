"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Role = "owner" | "admin" | "counter" | "viewer";
type Bucket = "automatic" | "review" | "abstain" | "non_product" | "invalid";
type CandidateDisplay = { label: string; category: string; attributes: Partial<Record<"size" | "season" | "loadIndex" | "speedRating" | "sidewall", string>> };
type Candidate = { productId: string; rank: number; evidence: string[]; missingFields: string[]; contradictions: string[]; display?: CandidateDisplay };
type CurrentApprovedLink = { sourceSystem: string; sourceSignature: string; vendorId: string; identifierType: string; namespace: string; normalizedValue: string; targetProductId: string; version: number; predecessorFingerprint: string; predecessorSource: "configured" | "durable" };
export type IdentityReviewRow = { reviewId: string; rowId: string; scope?: { sourceSystem: string; vendorId: string; sourceSignature: string }; currentApprovedLink?: { targetProductId: string; version: number }; decision: { kind: string; candidates: Candidate[] } };
type Action = "confirm_candidate" | "reject" | "create_tenant_product" | "revoke_link";
const buckets: Array<{ key: Bucket; label: string }> = [{ key: "automatic", label: "Automatic" }, { key: "review", label: "Review" }, { key: "abstain", label: "Abstain" }, { key: "non_product", label: "Non-product" }, { key: "invalid", label: "Invalid" }];
const pageSize = 25;
const displayAttributeKeys = ["size", "season", "loadIndex", "speedRating", "sidewall"] as const;

function safeBucket(value: string): Bucket { return buckets.some((bucket) => bucket.key === value) ? value as Bucket : "review"; }
function topCandidate(row: IdentityReviewRow): Candidate | undefined { return [...row.decision.candidates].sort((left, right) => left.rank - right.rank || left.productId.localeCompare(right.productId))[0]; }
function bodyMessage(value: unknown, fallback: string): string { return value && typeof value === "object" && "error" in value && typeof (value as { error?: unknown }).error === "string" ? (value as { error: string }).error : fallback; }
function linkKey(link: CurrentApprovedLink): string { return link.predecessorFingerprint; }

export function IdentityReviewTable(props: { businessId: string; actorRole: Role; previewDecisions?: readonly IdentityReviewRow[] }) { return <IdentityReviewQueue key={props.businessId} {...props} />; }

function IdentityReviewQueue({ businessId, actorRole, previewDecisions = [] }: { businessId: string; actorRole: Role; previewDecisions?: readonly IdentityReviewRow[] }) {
  const [reviews, setReviews] = useState<IdentityReviewRow[]>([]), [links, setLinks] = useState<CurrentApprovedLink[]>([]), [status, setStatus] = useState("Loading identity reviews."), [error, setError] = useState(""), [bucket, setBucket] = useState<Bucket>("review"), [pending, setPending] = useState<string | null>(null), [productName, setProductName] = useState<Record<string, string>>({}), [selected, setSelected] = useState<Record<string, string>>({}), [serverTotals, setServerTotals] = useState<Record<Bucket, number>>({ automatic: 0, review: 0, abstain: 0, non_product: 0, invalid: 0 }), [reload, setReload] = useState(0), [navigationRequest, setNavigationRequest] = useState(0), [focusTarget, setFocusTarget] = useState<"review" | "link" | null>(null), [reviewAfter, setReviewAfter] = useState<Array<string | null>>([null]), [linkAfter, setLinkAfter] = useState<Array<string | null>>([null]), [nextReviewCursor, setNextReviewCursor] = useState<string | null>(null), [nextLinkCursor, setNextLinkCursor] = useState<string | null>(null), [navigationPending, setNavigationPending] = useState(false);
  const generation = useRef(0), initialLoadComplete = useRef(false), navigationInFlight = useRef(false), committedHeads = useRef<{ review: string | null; link: string | null }>({ review: null, link: null }), requestHeads = useRef<{ review: string | null; link: string | null }>({ review: null, link: null }), navigationAttempt = useRef<{ surface: "review" | "link"; history: Array<string | null>; review: string | null; link: string | null } | null>(null), statusRef = useRef<HTMLParagraphElement>(null), sectionRef = useRef<HTMLElement>(null);
  const canResolve = actorRole === "owner" || actorRole === "admin";
  const reviewHead = reviewAfter[reviewAfter.length - 1] ?? null, linkHead = linkAfter[linkAfter.length - 1] ?? null;
  useEffect(() => { committedHeads.current = { review: reviewHead, link: linkHead }; }, [reviewHead, linkHead]);
  useEffect(() => {
    const controller = new AbortController(), request = ++generation.current;
    const requested = { ...requestHeads.current };
    const query = new URLSearchParams({ businessId, bucket, pageSize: String(pageSize) });
    if (requested.review) query.set("afterReview", requested.review);
    if (requested.link) query.set("afterLink", requested.link);
    void fetch(`/api/identity/reviews?${query.toString()}`, { signal: controller.signal }).then(async (response) => {
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(bodyMessage(body, "Unable to load identity reviews."));
      if (generation.current !== request) return;
      const loaded = body && typeof body === "object" && Array.isArray((body as { reviews?: unknown }).reviews) ? (body as { reviews: IdentityReviewRow[] }).reviews : [];
      const loadedLinks = body && typeof body === "object" && Array.isArray((body as { currentApprovedLinks?: unknown }).currentApprovedLinks) ? (body as { currentApprovedLinks: CurrentApprovedLink[] }).currentApprovedLinks : [];
      const attempt = navigationAttempt.current;
      if (attempt && attempt.review === requested.review && attempt.link === requested.link) {
        if (attempt.surface === "review") setReviewAfter(attempt.history); else setLinkAfter(attempt.history);
        navigationAttempt.current = null;
      }
      setReviews(loaded); setLinks(loadedLinks); setError(""); setNextReviewCursor(typeof (body as { nextReviewCursor?: unknown })?.nextReviewCursor === "string" ? (body as { nextReviewCursor: string }).nextReviewCursor : null); setNextLinkCursor(typeof (body as { nextLinkCursor?: unknown })?.nextLinkCursor === "string" ? (body as { nextLinkCursor: string }).nextLinkCursor : null); const totals = (body as { bucketTotals?: unknown })?.bucketTotals; if (totals && typeof totals === "object") setServerTotals(Object.fromEntries(buckets.map(({ key }) => [key, typeof (totals as Record<string, unknown>)[key] === "number" ? (totals as Record<string, number>)[key] : 0])) as Record<Bucket, number>); if (!initialLoadComplete.current) { initialLoadComplete.current = true; setStatus(loaded.length || loadedLinks.length ? "Identity reviews loaded." : "No identity reviews or approved links are available."); } navigationInFlight.current = false; setNavigationPending(false);
    }).catch((reason: unknown) => { if (generation.current === request && !controller.signal.aborted) { const message = reason instanceof Error ? reason.message : "Unable to load identity reviews."; setError(message); setStatus("Identity reviews could not be loaded."); requestHeads.current = { ...committedHeads.current }; const attempt = navigationAttempt.current; if (attempt && attempt.review === requested.review && attempt.link === requested.link) navigationAttempt.current = null; navigationInFlight.current = false; setNavigationPending(false); } });
    return () => controller.abort();
  }, [businessId, bucket, reload, navigationRequest]);
  void previewDecisions;
  const matching = useMemo(() => reviews.filter((row) => safeBucket(row.decision.kind) === bucket), [bucket, reviews]);
  useEffect(() => {
    if (!focusTarget || pending) return;
    const selector = focusTarget === "link" ? "[data-link-action]" : "[data-review-action]";
    const next = [...(sectionRef.current?.querySelectorAll<HTMLButtonElement>(selector) ?? [])].find((button) => !button.disabled);
    if (next) { next.focus(); queueMicrotask(() => setFocusTarget(null)); return; }
    if ((focusTarget === "link" && links.length === 0) || (focusTarget === "review" && matching.length === 0)) { statusRef.current?.focus(); queueMicrotask(() => setFocusTarget(null)); }
  }, [focusTarget, links, matching, pending]);
  async function action(row: IdentityReviewRow, actionName: Exclude<Action, "revoke_link">, targetProductId?: string) {
    if (pending || navigationInFlight.current || !canResolve) return;
    const name = productName[row.reviewId]?.trim();
    if (actionName === "create_tenant_product" && !name) { setError("Enter a tenant product name before creating it."); return; }
    setPending(`review:${row.reviewId}`); setError("");
    try {
      const response = await fetch("/api/identity/reviews", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `review:${row.reviewId}:${actionName}` }, body: JSON.stringify({ businessId, reviewId: row.reviewId, action: actionName, ...(targetProductId ? { targetProductId } : {}), ...(actionName === "create_tenant_product" ? { name } : {}) }) });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(bodyMessage(body, "Review action failed."));
      setFocusTarget("review");
      setReviews((current) => current.filter((item) => item.reviewId !== row.reviewId)); requestHeads.current = { ...committedHeads.current }; setReload((current) => current + 1);
      setStatus(actionName === "confirm_candidate" ? "Candidate confirmed." : actionName === "create_tenant_product" ? "Tenant product created." : "Review rejected.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Review action failed."); }
    finally { setPending(null); }
  }
  async function revokeLink(link: CurrentApprovedLink) {
    const key = `link:${linkKey(link)}`;
    if (pending || navigationInFlight.current || !canResolve) return;
    setPending(key); setError("");
    try {
      const response = await fetch("/api/identity/reviews", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `link:${link.predecessorFingerprint}:revoke` }, body: JSON.stringify({ businessId, action: "revoke_link", link }) });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(bodyMessage(body, "Approved identity link could not be revoked."));
      setFocusTarget("link");
      setLinks((current) => current.filter((item) => linkKey(item) !== linkKey(link))); requestHeads.current = { ...committedHeads.current }; setReload((current) => current + 1);
      setStatus("Identity link revoked.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Approved identity link could not be revoked."); }
    finally { setPending(null); }
  }
  const navigate = (surface: "review" | "link", direction: "next" | "previous") => {
    if (navigationInFlight.current || pending) return;
    const history = surface === "review" ? reviewAfter : linkAfter;
    const nextCursor = surface === "review" ? nextReviewCursor : nextLinkCursor;
    if ((direction === "previous" && history.length === 1) || (direction === "next" && !nextCursor)) return;
    const nextHistory = direction === "previous" ? history.slice(0, -1) : [...history, nextCursor!];
    const requested = { review: surface === "review" ? nextHistory[nextHistory.length - 1] ?? null : reviewHead, link: surface === "link" ? nextHistory[nextHistory.length - 1] ?? null : linkHead };
    navigationAttempt.current = { surface, history: nextHistory, ...requested }; requestHeads.current = requested;
    navigationInFlight.current = true; setNavigationPending(true); initialLoadComplete.current = false; setError(""); setStatus("Loading identity reviews."); setNavigationRequest((current) => current + 1);
  };
  return <section ref={sectionRef} aria-label="Identity review queue"><p ref={statusRef} role="status" aria-live="polite" tabIndex={-1} className="text-sm text-zinc-600">{pending ? "Submitting identity review action." : status} Review page {reviewAfter.length}. Link page {linkAfter.length}.</p>{error && <p role="alert">{error}</p>}<div role="group" aria-label="Decision filters">{buckets.map(({ key, label }) => <button key={key} type="button" aria-pressed={bucket === key} onClick={() => { if (key === bucket) return; navigationAttempt.current = null; requestHeads.current = { review: null, link: linkHead }; navigationInFlight.current = true; setNavigationPending(true); initialLoadComplete.current = false; setError(""); setStatus("Loading identity reviews."); setBucket(key); setReviewAfter([null]); setNextReviewCursor(null); }} className="min-h-11 px-3">{label} ({serverTotals[key]})</button>)}</div><div className="overflow-x-auto"><table aria-label="Identity review queue" className="w-full text-left"><thead><tr><th scope="col">Import row</th><th scope="col">Candidate</th><th scope="col">Evidence and scope</th><th scope="col">Action</th></tr></thead><tbody>{matching.map((row) => { const defaultCandidate = topCandidate(row), candidate = row.decision.candidates.find((item) => item.productId === (selected[row.reviewId] ?? defaultCandidate?.productId)) ?? defaultCandidate, busy = pending === `review:${row.reviewId}`, actionable = row.decision.kind === "review"; return <tr key={row.rowId} aria-busy={busy || undefined}><th scope="row">{row.rowId}</th><td><fieldset><legend className="sr-only">Candidate for {row.rowId}</legend>{row.decision.candidates.map((item) => <label key={item.productId} className="inline-flex min-h-11 items-center gap-2"><input className="min-h-11 min-w-11" type="radio" name={`candidate:${row.reviewId}`} checked={candidate?.productId === item.productId} disabled={busy} onChange={() => setSelected((current) => ({ ...current, [row.reviewId]: item.productId }))} /><span><strong>{item.display?.label ?? item.productId}</strong>{item.display && <><span>{item.display.category}</span>{displayAttributeKeys.flatMap((key) => item.display?.attributes[key] ? [<span key={key}>{key}: {item.display.attributes[key]}</span>] : [])}<small>{item.productId}</small></>}</span></label>)}</fieldset></td><td><ul>{candidate?.evidence.map((value) => <li key={`e:${value}`}>{value}</li>)}{candidate?.missingFields.map((value) => <li key={`m:${value}`}>Missing: {value}</li>)}{candidate?.contradictions.map((value) => <li key={`c:${value}`}>Contradiction: {value}</li>)}</ul>{row.scope && <small>{row.scope.sourceSystem} / {row.scope.vendorId} / {row.scope.sourceSignature}</small>}</td><td>{canResolve && actionable && <><button data-review-action className="min-h-11 px-3" type="button" disabled={busy || navigationPending || !candidate} onClick={() => candidate && void action(row, "confirm_candidate", candidate.productId)}>Confirm {candidate?.productId ?? "candidate"}</button><button data-review-action className="min-h-11 px-3" type="button" disabled={busy || navigationPending} onClick={() => void action(row, "reject")}>Reject</button><label className="inline-flex min-h-11 items-center gap-2">Tenant product name<input className="min-h-11" aria-label={`Tenant product name for ${row.rowId}`} value={productName[row.reviewId] ?? ""} disabled={busy || navigationPending} onChange={(event) => setProductName((current) => ({ ...current, [row.reviewId]: event.target.value }))} /></label><button data-review-action className="min-h-11 px-3" type="button" disabled={busy || navigationPending} onClick={() => void action(row, "create_tenant_product")}>Create tenant product</button></>}</td></tr>; })}</tbody></table></div><section aria-label="Current approved identity links" className="mt-6"><h2>Current approved links</h2><div className="overflow-x-auto"><table aria-label="Current approved links" className="w-full text-left"><thead><tr><th scope="col">Identifier</th><th scope="col">Source</th><th scope="col">Vendor</th><th scope="col">Target</th><th scope="col">Version</th>{canResolve && <th scope="col">Action</th>}</tr></thead><tbody>{links.map((link) => { const busy = pending === `link:${linkKey(link)}`; return <tr key={linkKey(link)} aria-busy={busy || undefined}><td>{link.identifierType}: {link.normalizedValue}</td><td>{link.sourceSystem} / {link.sourceSignature}</td><td>{link.vendorId}</td><td>{link.targetProductId}</td><td>{link.version}</td>{canResolve && <td><button data-link-action className="min-h-11 px-3" type="button" disabled={busy || navigationPending} onClick={() => void revokeLink(link)}>Revoke approved link {link.normalizedValue}</button></td>}</tr>; })}</tbody></table></div></section><nav aria-label="Review pagination"><button className="min-h-11 px-3" type="button" disabled={!!pending || navigationPending || reviewAfter.length === 1} onClick={() => navigate("review", "previous")}>Previous review page</button><button className="min-h-11 px-3" type="button" disabled={!!pending || navigationPending || !nextReviewCursor} onClick={() => navigate("review", "next")}>Next reviews</button></nav><nav aria-label="Approved links pagination"><button className="min-h-11 px-3" type="button" disabled={!!pending || navigationPending || linkAfter.length === 1} onClick={() => navigate("link", "previous")}>Previous approved links page</button><button className="min-h-11 px-3" type="button" disabled={!!pending || navigationPending || !nextLinkCursor} onClick={() => navigate("link", "next")}>Next approved links</button></nav></section>;
}
