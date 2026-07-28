# Code Review: bug-06-retail-corpus-unverified-consensus

## Overview
Review of `computeDecode` in `src/server/decode/pipeline.ts`. The pipeline handles barcode resolution by checking a free local retail product index (4M+ rows from Open Food Facts) before escalating to paid AI providers (Go-UPC, Fetch V2, GPT-5.5).

---

## Defect 1: Unused `retailHit` Result Causing Full Escalation to Paid AI Rungs

### Concrete Failure Scenario
A user scans a standard food/retail barcode (e.g., UPC/EAN) present in the 4M-row local retail database. 

Line 18 executes:
```ts
retailHit = await lookupRetailBarcodeAsync(code);
retailLookupStatus = getLastRetailLookupStatus();
```
`retailHit` receives a valid product hit (`{ productName, brand }`). However, `retailHit` is NEVER passed to any consensus resolver, ladder rung, or payload builder in the rest of `computeDecode`. It remains an unread local variable.

As a result:
1. The pipeline ignores the free local retail database hit entirely.
2. Every scanned barcode escalates directly into the paid DECODE LADDER (Go-UPC, Fetch V2, GPT-5.5).
3. The system incurs unnecessary API fees and high latency (~1-3s vs ~50-160ms) for millions of known retail products.

### Root Cause
`retailHit` is queried on Line 18 but is never referenced or forwarded to `ladderRun` or any free resolution rung.

---

## Defect 2: Omission of `retailLookupStatus` from Winning Decode Response Payload

### Concrete Failure Scenario
When Turso experiences a database connection failure (`turso_error`), `getLastRetailLookupStatus()` returns `"turso_error"`. 

When a paid rung subsequently produces a winning decode (`win`), line 55 returns:
```ts
return { kind: "computed", payload: { ...win }, cached: false };
```
Because `retailLookupStatus` is omitted from the returned object, the debug/diagnostic payload loses the database error indicator. System monitoring cannot distinguish whether Turso failed (`turso_error`) or simply had no matching barcode (`turso_miss`).

### Root Cause
Line 55 returns `win` verbatim without embedding `retailLookupStatus` into the debug metadata of the response payload.
