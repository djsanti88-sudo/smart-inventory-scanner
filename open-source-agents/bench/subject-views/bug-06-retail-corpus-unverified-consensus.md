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
