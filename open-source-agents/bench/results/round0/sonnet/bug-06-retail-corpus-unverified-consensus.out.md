# Review: bug-06-retail-corpus-unverified-consensus

## Defect 1 (High): The retail corpus hit is fetched but the shown code never verifies or cross-checks it before the final decode payload is returned — the "consensus vote" protection is asserted only in comments, not demonstrated in the returned code path

```ts
retailHit = await lookupRetailBarcodeAsync(code);
retailLookupStatus = getLastRetailLookupStatus();
// ... comment: "it is passed into the resolver below as ONE consensus VOTE (the retailDb dep):
// a wrong OFF row is OUTVOTED by UPCitemdb + grounding..."
...
if (win) {
  // win.decision.status may be "verified" here, sourced from whichever paid rung settled
  // (goupc / fetchv2 / gpt). retailHit (looked up above) is available in this closure but is only
  // consumed as one vote inside the earlier consensus resolver - it is not consulted again here.
  return { kind: "computed", payload: { ...win }, cached: false };
}
```

The function's own comment explicitly admits `retailHit` is "not consulted again here" once a paid rung (`goupc`/`fetchv2`/`gpt`) settles the ladder. So whatever "consensus resolver" the comments describe (an OFF row being "outvoted") is asserted to happen somewhere in the omitted "free ladder run + escalation logic," but the code that is actually shown — the part that decides what gets returned as the final `payload` — takes `win.decision.status` (a paid provider's **self-reported** status) at face value with no visible cross-check against `retailHit` at the point of return. If the omitted consensus step only ever compares retail against the *free* rungs (UPCitemdb/OFF-adjacent sources) and never re-validates against whichever *paid* rung ultimately won, then a paid provider that self-reports "verified" for a code the retail corpus already correctly identified differently (or vice versa: a paid provider hallucinating a wrong identity that the retail corpus would have contradicted) can settle the ladder and be returned as truth with zero cross-check in this function. That is precisely an "unverified consensus" — the consensus mechanism is named and claimed in comments but not exercised at the decision point this code snippet actually controls.

## Defect 2 (Medium): `retailLookupStatus` is computed but never checked before treating `retailHit` as valid input to anything

```ts
retailHit = await lookupRetailBarcodeAsync(code);
retailLookupStatus = getLastRetailLookupStatus();
```

The comment explains the whole point of `retailLookupStatus` is to distinguish "a broken Turso connection (`turso_error`)" from "a genuine corpus miss (`turso_miss`)" so they aren't both silently treated as `retailHit === null`. But nothing in the shown code branches on `retailLookupStatus` — it's assigned and, per the function's own admission, never read again in the part of the flow shown here (only "surfaced in the decode debug payload," which is a diagnostics concern, not a decision-making one). If the downstream consensus resolver (not shown) also fails to distinguish `turso_error` from `turso_miss` before folding `retailHit` into its vote, a transient connection failure would be indistinguishable from "corpus has no opinion" — silently weakening the consensus by one vote exactly when the corpus is unavailable, rather than treating a connection error as "retail abstains" or retrying, or flagging degraded coverage.

## Defect 3 (Low, structural risk visible in this excerpt): Retail lookup is skipped entirely in E2E mode with no compensating stub, which could mask a real integration bug in the consensus path from ever being exercised by tests

```ts
if (!e2eMode()) {
  ... retailHit = await lookupRetailBarcodeAsync(code); ...
}
```

Because this whole block is skipped under `e2eMode()`, `retailHit` stays `null` for every E2E test regardless of what the mock retail corpus "should" return for a given test code. Any defect in how `retailHit` participates in the (unseen) consensus resolver — including Defect 1's cross-check gap — is structurally untestable via the E2E suite, since E2E runs never populate `retailHit` at all. This isn't necessarily wrong (mocking network/DB dependencies in E2E is reasonable), but it does mean this exact code path's consensus behavior has no browser-level proof and relies entirely on unit tests of the (unshown) resolver function to catch regressions.

## Not a defect
- Treating the 4M-row Open Food Facts retail DB as one vote rather than an auto-trusted source is the right design intent, and the comment correctly identifies the prior "old Fix 5" failure mode (glycine mis-tagged as "Coconut oil") that motivated the change — the *intent* here is sound.
- Deferring Plan D's Firecrawl execution until after the free ladder (to preserve cost order: free rungs before paid) is a reasonable, well-justified reordering, not a bug.
- `receiptState = gptLadderResult ? classifyReceipt(gptLadderResult) : { eligible: false }` correctly gates the "permanent receipt" only on a rung that genuinely ran and came back empty, consistent with the comment.

## Recommendation
Make the retail-vs-paid-rung cross-check explicit and visible at the return point shown here: before returning `win` as `"computed"`, compare `win.decision.status`/identity against `retailHit` (when `retailLookupStatus` indicates a genuine hit, not an error/miss) and route to conflict/Needs-Review handling if they disagree, the same way the codebase's evidence-verification rules require for other provider disagreements. Also branch on `retailLookupStatus` distinctly from `retailHit === null` wherever the corpus vote is folded into the resolver, so a Turso outage cannot silently masquerade as "corpus has no data."
