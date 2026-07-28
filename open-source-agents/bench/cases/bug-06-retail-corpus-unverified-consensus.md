# Case: bug-06-retail-corpus-unverified-consensus
## Task prompt (what the subject model sees)
Review the following code for real defects. This is part of a server-side barcode decode pipeline: for an unknown scanned code it consults a free local retail-product database (millions of rows, occasionally has a wrong row), then may fall through to paid AI providers (Go-UPC, Fetch V2, GPT) that can self-report a "verified" identity for the same code.
## Input code
```ts
// src/server/decode/pipeline.ts

const computeDecode = async (): Promise<DecodePayload> => {
  // RETAIL PRODUCT KNOWLEDGE INDEX (4M+ Open Food Facts products): exact barcode hit resolves
  // the product WITHOUT AI. Tries local SQLite first, then Turso remote DB. retailLookupStatus
  // is surfaced in the decode debug payload below (both the hit-return here and the AI-path
  // fallback) so a broken Turso connection ("turso_error") is distinguishable from a genuine
  // corpus miss ("turso_miss") instead of both silently falling through to paid AI decode.
  let retailLookupStatus: string | undefined;
  let retailHit: { productName: string; brand: string } | null = null;
  if (!e2eMode()) {
    const { lookupRetailBarcodeAsync, getLastRetailLookupStatus } = await import("@/server/retail-knowledge/retailKnowledgeIndex");
    retailHit = await lookupRetailBarcodeAsync(code);
    retailLookupStatus = getLastRetailLookupStatus();
    // The 4M-row Open Food Facts retail DB (Turso) is a FREE structured source. Its data is mostly right
    // but has some WRONG rows (glycine UPC 0737870166917 -> "Coconut oil"), so it is NO LONGER trusted
    // ALONE (that produced wrong Verified identities - the old Fix 5). Instead it is passed into the
    // resolver below as ONE consensus VOTE (the retailDb dep): a wrong OFF row is OUTVOTED by UPCitemdb +
    // grounding, while its millions of correct rows give FREE, instant (~50-160ms) coverage - so most
    // food/retail codes auto-count with no AI and no Firecrawl.
  }

  // PLAN D (grounding-first fast resolver) MOVED (Task 7, ORDER v3): it used to run HERE, before the
  // decode ladder. Under the owner-ratified cost order (retail peek -> FREE rungs -> Plan D -> cap gate
  // -> paid ladder) Plan D's internal Firecrawl legs must not run before the $0 UPCitemdb/OFF rungs, so
  // its execution now happens further down, AFTER the free ladder run completes. Only these forward
  // declarations stay up here (they are read by the response assembly below). See "PLAN D EXECUTION".
  const isPublicBarcode = codeType === "upc_a" || codeType === "ean_13" || codeType === "gtin_14";
  let planDStash: DecodePayload | null = null;
  let planDProviderStatusForStash: ProviderStatus | null = null;
  let planDAiCalled = false;

  // ===== DECODE LADDER (spec v6): Go-UPC -> Fetch V2 -> GPT-5.5 =====================================
  // ... free ladder run + escalation logic omitted (unchanged) ...

  // (Later, after the free/paid ladder has run and produced `ladderRun`:)
  const win = ladderRun.outcome?.payload as LadderPayload | undefined;

  // receiptState: only a GPT rung that genuinely ran + came back empty earns a permanent receipt.
  receiptState = gptLadderResult ? classifyReceipt(gptLadderResult) : { eligible: false };

  // Assemble the response. A settled rung supplies its payload verbatim; an all-miss ladder falls back
  // to the stashed Plan D floor/suggestion (TASK T8b) so the user experience for a genuinely
  // unfindable code is unchanged; a Plan D stash always records its own attempt in providerStatuses so
  // debug shows both what Plan D found AND what the ladder did with it.
  if (win) {
    // win.decision.status may be "verified" here, sourced from whichever paid rung settled
    // (goupc / fetchv2 / gpt). retailHit (looked up above) is available in this closure but is only
    // consumed as one vote inside the earlier consensus resolver - it is not consulted again here.
    return { kind: "computed", payload: { ...win }, cached: false };
  }
  // ... unresolved/fallback path omitted ...
};
```
## GROUND TRUTH (never shown to subject)
- Defect: Two compounding gaps. (1) `retailHit` is looked up unconditionally (`if (!e2eMode())`, with no check that `code` is actually barcode-shaped, e.g. EAN-8/UPC/GTIN), so it also fires for codes the retail DB was never meant to key on. (2) Even when `retailHit` disagrees with whatever a paid provider later self-reports as "verified" (`win.decision.status === "verified"`), nothing cross-checks the two: `retailHit` is only ever folded in as one vote inside the earlier consensus resolver, but a paid rung's own "verified" claim is returned as-is at the end with no contradiction check against the retail corpus row already sitting in the closure. In production this let an EAN-8 code whose retail-corpus row said "Saumon fume Ecossais tranche main" (salmon) get returned as a paid-provider "Verified" identity for a beer product, because the retail row that should have contradicted the paid claim was simply never consulted again.
- Fix commit: dcd9a8b fix(decode): retail corpus joins free rung 0 (incl. EAN-8) + paid-verified contradiction guard - stops corpus bypass and wrong-verified (live-proven salmon/beer bug)
- Key evidence: `if (!e2eMode()) { ... retailHit = await lookupRetailBarcodeAsync(code); ... }` has no GTIN/barcode-shape gate, and the final assembly `const win = ladderRun.outcome?.payload as LadderPayload | undefined; ... if (win) { return { kind: "computed", payload: { ...win }, cached: false }; }` returns a paid rung's "verified" decision unchanged with no comparison against `retailHit`, even though `retailHit` was already fetched earlier in the same function and is still in scope.
- Scoring: HIT if the subject identifies that a paid provider's self-reported "verified" status is never cross-checked against the retail-corpus row already looked up earlier in the function, so the two sources can silently disagree and the wrong (paid-provider) identity wins with no contradiction detection. PARTIAL if the subject notices `retailHit` is fetched but flags only the missing barcode-shape gate on the lookup itself (`if (!e2eMode())` with no GTIN check) without connecting it to the missing verified/retail contradiction check. Plausible-but-wrong findings: (1) claiming the destructuring `let retailLookupStatus: string | undefined;` / `let retailHit: ... | null = null;` pattern is unsafe or should be `const` (irrelevant, standard mutable-forward-declaration pattern used deliberately); (2) flagging that `e2eMode()` gating the retail lookup means tests never exercise this path (true but not the historical production bug — it's an intentional test-safety gate); (3) suggesting the comment about "glycine UPC -> Coconut oil" being a known wrong row means the whole retail index should be deleted (overly broad; the real fix keeps the retail index and adds a targeted contradiction guard instead).
