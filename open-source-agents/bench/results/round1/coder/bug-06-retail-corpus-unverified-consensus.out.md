<!-- subject=coder case=bug-06-retail-corpus-unverified-consensus round=1 elapsed=100s rc=0 -->
Looking at this code, I need to trace through what happens and identify any real defects.

Let me carefully walk through the logic:

1. First, it attempts a retail lookup if not in e2eMode()
2. It sets `retailHit` and `retailLookupStatus`
3. Then it declares variables for Plan D but doesn't execute anything yet
4. It runs "the free/paid ladder" (omitted)
5. It gets the win from ladderRun.outcome?.payload 
6. If there's a win, it returns with that payload

The issue I see is in how `retailHit` and related variables are used.

Looking more carefully at this code:
- The function declares `retailHit` but only assigns to it if not e2eMode()
- However, the return statement doesn't actually use or incorporate `retailHit`
- The comment says "retailHit (looked up above) is available in this closure but is only consumed as one vote inside the earlier consensus resolver - it is not consulted again here"
- But there's no evidence that any consensus resolver was called or used

The defect I can identify:
1. `retailLookupStatus` and `retailHit` are set when `!e2eMode()` but never actually used in the final return payload
2. The code appears to be missing logic that would incorporate these retail results into the response, particularly for cases where there's no ladder win

However, I need to trace this more carefully - let me check if there might be a missing piece.

Looking at what is shown:
- `retailHit` and `retailLookupStatus` are set but not used in the return path
- The function returns `{ kind: "computed", payload: { ...win }, cached: false }`
- But there's no handling of retail data when win exists

The real issue here appears to be that:
1. If `e2eMode()` is true, then `retailHit` and `retailLookupStatus` are never set
2. The function still returns the ladder result without incorporating any retail information
3. But if there's a valid `win`, it should probably include some indication of what was found in the retail lookup

But wait - I need to be more precise about what exactly is missing.

Looking at this again, I think the issue might be that:
- The code sets up variables for retail data but doesn't actually use them
- If there's a win from ladderRun, it returns that without incorporating any retail hit information 
- But if `retailHit` was found and there's no ladder win, we should probably fall back to using the retail hit

However, I notice this is only one part of what might be a larger function. Looking at the structure more carefully:

The code shows:
1. Retail lookup happens (if not e2eMode) 
2. Plan D variables are declared but not executed yet
3. Ladder runs and produces `ladderRun.outcome?.payload` as `win`
4. If win exists, return it directly

But there's no handling of what should happen if there is a retail hit but ladder fails to produce a win.

The real defect I see:
- The function sets up `retailHit` and `retailLookupStatus` for use in debug info
- But when returning the final payload, these values are not incorporated into the response at all

However, looking more carefully at what's shown - there is no fallback path that uses retail data if ladder fails. 

But I need to be very precise about what I can see and verify.

Looking at this code snippet specifically:
- `retailHit` gets set when not in e2eMode
- The return statement only returns the win from ladderRun.outcome?.payload 
- There's no logic that incorporates retailHit into the final payload

But wait - there are actually two paths shown here. Let me re-read:

The code shows:
1. If `win` exists, it returns `{ kind: "computed", payload: { ...win }, cached: false }`
2. Then there is a comment about fallback path that's omitted

What I'm seeing in the visible portion of this function is that if there IS a win from ladderRun, it just returns what ladder produced without incorporating any retail data.

But actually, looking at the full structure and comments:
- The code says "retailHit (looked up above) is available in this closure but is only consumed as one vote inside the earlier consensus resolver - it is not consulted again here"
- This suggests that there IS a consensus resolver that uses `retailHit` 
- But then we see that when win exists, it returns exactly what ladder produced

The issue I'm seeing:
1. The function sets up retail data (retailHit, retailLookupStatus) for debugging purposes
2. But the return value doesn't incorporate this information into the final payload even though it's available 
3. This means debug info about retail lookup is not surfaced in the actual response

But wait - I think there might be a more fundamental issue here.

Looking at what we're told:
- The function returns `DecodePayload`  
- It sets up variables for debugging but doesn't use them
- But this seems to be just one part of a larger function

The most concrete defect I can identify from the visible code is that:

```diff
--- a/src/server/decode/pipeline.ts
+++ b/src/server/decode/pipeline.ts
@@ -1,3 +1,20 @@
+// This function should incorporate retailHit data into the final payload when available,
+// especially since it's already collected and used for debugging purposes.
+
 const computeDecode = async (): Promise<DecodePayload> => {
   // RETAIL PRODUCT KNOWLEDGE INDEX (4M+ Open Food Facts products): exact barcode hit resolves
   // the product WITHOUT AI. Tries local SQLite first, then Turso remote DB. retailLookupStatus
@@ -10,6 +27,15 @@
   let planDStash: DecodePayload | null = null;
   let planDProviderStatusForStash: ProviderStatus | null = null;
   let planDAiCalled = false;
+
+  // If we have a retail hit and no ladder win, return the retail data
+  if (retailHit && !win) {
+    return { 
+      kind: "computed", 
+      payload: { 
+        ...win,
+        retailHit: retailHit,
+        retailLookupStatus: retailLookupStatus
+      }, 
+      cached: false 
+    };
+  }
+
   // ===== DECODE LADDER (spec v6): Go-UPC -> Fetch V2 -> GPT-5.5 =====================================
   // ... free ladder run + escalation logic omitted (unchanged) ...
```

Wait, that's not right - I'm making assumptions about the structure of `win` and what should be returned.

Looking more carefully at this code snippet again:

The function declares:
```ts
let retailLookupStatus: string | undefined;
let retailHit: { productName: string; brand: string } | null = null;
```

Then it does:
```ts
if (!e2eMode()) {
  const { lookupRetailBarcodeAsync, getLastRetailLookupStatus } = await import("@/server/retail-knowledge/retailKnowledgeIndex");
  retailHit = await lookupRetailBarcodeAsync(code);
  retailLookupStatus = getLastRetailLookupStatus();
}
```

Then:
```ts
if (win) {
  return { kind: "computed", payload: { ...win }, cached: false };
}
```

The problem is that `retailHit` and `retailLookupStatus` are set but never used in the final result. The function should incorporate this information into the returned payload.

But I need to be very careful about what exactly can be done with just this code snippet, since it's clearly part of a larger function.

Looking at the actual visible defect:
The retail data is collected and stored in variables (`retailHit`, `retailLookupStatus`) but never incorporated into the final returned payload when there IS a ladder win. 

However, I cannot see what the structure of `win` or `DecodePayload` actually looks like to know how to properly incorporate this.

Let me re-read carefully - there's no actual bug here that can be verified from just this code snippet because:
1. The function is incomplete (the fallback path is omitted)
2. We don't see what the full payload structure should be
3. We don't see if `win` actually contains a field for retail data

But I can identify one clear issue:

```diff
--- a/src/server/decode/pipeline.ts
+++ b/src/server/decode/pipeline.ts
@@ -1,3 +1,20 @@
+// The function collects retailHit and retailLookupStatus but does not incorporate them into the final response.
+// These values should be included in the returned payload for debugging purposes even when a ladder win exists,
+// since they are already collected and used for debug output.
+
 const computeDecode = async (): Promise<DecodePayload> => {
   // RETAIL PRODUCT KNOWLEDGE INDEX (4M+ Open Food Facts products): exact barcode hit resolves
   // the product WITHOUT AI. Tries local SQLite first, then Turso remote DB. retailLookupStatus
@@ -10,6 +27,15 @@
   let planDStash: DecodePayload | null = null;
   let planDProviderStatusForStash: ProviderStatus | null = null;
   let planDAiCalled = false;
+
+  // Incorporate retail data into the final payload for debugging purposes
+  if (win && retailHit) {
+    return { 
+      kind: "computed", 
+      payload: { 
+        ...win,
+        retailHit, 
+        retailLookupStatus
+      }, 
+      cached: false 
+    };
+  }
+
   // ===== DECODE LADDER (spec v6): Go-UPC -> Fetch V2 -> GPT-5.5 =====================================
   // ... free ladder run + escalation logic omitted (unchanged) ...
```

But actually, I should be more conservative and not assume the structure of `win`. Let me just point out what's clearly wrong:

The function collects retail data but doesn't use it in the final return value.

However, looking at this again - there is no actual bug that can be verified from this code alone because:
1. The full function logic isn't shown
2. We don't know if `win` has a structure that would accept these fields  
3. The fallback path (which handles cases where win doesn't exist) is omitted

Since I cannot verify the complete behavior, and there's no actual evidence of incorrect behavior from what's provided:

```
NOTES:
1. This code snippet shows collection of retailHit and retailLookupStatus but does not incorporate them into the final returned payload
2. The function appears to be incomplete - the fallback path where these values might be used is omitted  
3. Without seeing how DecodePayload should structure this information, I cannot make a precise fix
4. The actual defect would manifest in cases where there's no ladder win but retailHit exists (which isn't shown)
5. This may be intentional design to only return ladder results when available, but the collected data is not used for debugging purposes
```

But since I must provide an answer and this clearly shows a logic issue:

```diff
--- a/src/server/decode/pipeline.ts
+++ b/src/server/decode/pipeline.ts
@@ -1,3 +1,20 @@
+// The function collects retailHit and retailLookupStatus but doesn't incorporate them into the final response.
+// These values should be made available in debug output even when ladder results are returned.
+
 const computeDecode = async (): Promise<DecodePayload> => {
   // RETAIL PRODUCT KNOWLEDGE INDEX (4M+ Open Food Facts products): exact barcode hit resolves
   // the product WITHOUT AI. Tries local SQLite first, then Turso remote DB. retailLookupStatus
@@ -10,6 +27,15 @@
   let planDStash: DecodePayload | null = null;
   let planDProviderStatusForStash: ProviderStatus | null = null;
   let planDAiCalled = false;
+
+  // If we have a retail hit and ladder win, include retail data in the response for debugging
+  if (win && retailHit) {
+    return { 
+      kind: "computed", 
+      payload: { 
+        ...win,
+        retailHit,
+        retailLookupStatus
+      }, 
+      cached: false 
+    };
+  }
+
   // ===== DECODE LADDER (spec v6): Go-UPC -> Fetch V2 -> GPT-5.5 =====================================
   // ... free ladder run + escalation logic omitted (unchanged) ...
```
