# Worked exemplars - how to review code (trace first, then commit to findings)

These two exemplars are worked examples of METHOD, not a bug catalog. The method is
always the same four moves: (1) read the code as data flow, not as prose; (2) pick one
concrete value and trace it line by line until you can point at the exact line where it
diverges from the intended behavior; (3) only then write a finding, in a fixed format
that forces a real failure scenario instead of a vague worry; (4) name what you did NOT
flag, and why - a reviewer who flags everything has found nothing.

---

## Exemplar 1: dropped scan on a locked/completed session

Source: commit `e79e98f` ("F1 - post-Finish/post-Lock scans rotate to a fresh session
instead of being dropped"), file `src/stores/scanStore.ts`.

### Pre-fix excerpt (`git show e79e98f~1:src/stores/scanStore.ts`, ~line 1835)

```ts
processScan: (rawInput) => {
  // OWNER PIN LOCK: a locked session is read-only - no new scan may land in it. Block before any work
  // so a locked count can never change until it is unlocked with the owner PIN.
  if (get().currentSession?.locked) return null;
  // PHASE 3 completed-session guard: finishSession does NOT clear sessionId/currentSession (by
  // design - see finishSession's own comment), so without this guard a scan taken between
  // "Finish session" and the next ensureAutoSession/startSession call would silently stamp the
  // OLD completed session's id. Callers (the scan page) call ensureAutoSession before every scan
  // batch; this guard is the hard backstop for any path that does not.
  if (get().currentSession?.status === "completed") return null;
  const scanLocation = get().location;
  const scanDeviceId = get().deviceId;
  const cleaned = cleanScanCode(rawInput);
  if (!cleaned.cleanCode) return null;

  const { products, aliases, businessId, sessionId } = get();
  const resolution = resolveScan(cleaned, products, aliases, businessId);
  const scanEventId = idFactory();
  const createdAt = now();
  // ... builds ScanEvent, pushes to scanFeed, updates finalCounts ...
```

### TRACE

Pick one concrete value: a clerk hits "Finish session" on session `S1` (which sets
`currentSession.status = "completed"`, per the comment - `finishSession` does NOT clear
`currentSession`), then, without a page remount, scans one more barcode `0123456789012`.

1. `processScan("0123456789012")` is called. `get().currentSession` is still `S1`
   because nothing cleared it - the comment on line 2 confirms this is intentional in
   `finishSession`.
2. Line 4: `get().currentSession?.locked` - false, S1 isn't locked, this guard passes.
3. Line 9: `get().currentSession?.status === "completed"` - **true**, S1 is completed.
4. `return null` executes immediately. Every line below it - `cleanScanCode`,
   `resolveScan`, `scanEventId = idFactory()`, the push onto `scanFeed`, the update to
   `finalCounts` - never runs.
5. The caller (the scan page's Enter handler) receives `null` and has nothing to render.
   No feed row is created. No count changes anywhere. The scanned code is gone as if it
   was never typed.
6. Session totals: before this scan, `S1.finalCounts` total = N (frozen at Finish).
   After this scan, total is still N. The clerk scanned 1 item; the count increased by 0.

The divergence point is exactly line 9's `return null` - it conflates "this session
must stay read-only" (true) with "this scan must be discarded" (false, per the
TOP-LEVEL LAW that every scanned code must appear and count somewhere).

### FINDINGS

**[Critical]** `processScan` silently drops any scan taken while `currentSession` is
completed or locked, instead of routing it to a new session, violating the "every scan
counts" invariant.
Failure scenario: starting state - clerk finishes session S1 (10 items counted,
status becomes "completed", `currentSession` still points at S1 because `finishSession`
intentionally does not clear it). Action sequence - without reloading the page, the
clerk scans one more tire barcode. Wrong outcome - `processScan` returns `null` at the
`status === "completed"` guard before creating any `ScanEvent`; no feed row appears, no
count anywhere increases, and there is no error or indication the scan was lost. Expected
outcome - the scan should land in a freshly rotated active session (S1 stays frozen and
untouched) and both the feed and the count should reflect the 11th item.
Evidence line: `src/stores/scanStore.ts` (pre-fix) `if (get().currentSession?.status === "completed") return null;` inside `processScan`.

**[High]** The same drop applies to the locked-session guard one line above (`if
(get().currentSession?.locked) return null;`), reachable via the owner-PIN lock flow, and
also silently swallows the internal `resolveUnknown -> processScan` re-apply call path
(no separate guard there - it flows through the same function), so a review resolution
performed while the session is locked/completed is discarded too, not just a raw scan.
Failure scenario: starting state - owner locks the current session with a PIN
mid-shift. Action sequence - a clerk resolves an item sitting in Needs Review (which
internally re-invokes `processScan`). Wrong outcome - the resolution's count-apply is
silently dropped, same as a fresh scan; the item stays effectively uncounted with no
error surfaced to the resolving user. Expected outcome - resolution should also
rotate to a fresh session rather than vanish.
Evidence line: same guard block, reused by "the internal resolveUnknown -> processScan re-apply caller (scanStore.ts ~line 4861)" per the fix commit message.

### What I did NOT report

The `ensureAutoSession` reuse logic just above `processScan` (`if (cur && cur.status ===
"active" && !cur.deviceId) { ... }`, checking `startedMs`/`inactivityMinutes`) looks like
it could double-count across devices sharing a business, since it reuses an existing
active session by device/window rather than always starting a new one. I did not report
it: it is deliberate multi-device same-session pooling (the surrounding comment says
"Rotating-with-wipe is correct only for a genuinely new session... a DIFFERENT device's
session, or one past the inactivity window"), and I could not construct a concrete
starting-state-to-wrong-outcome scenario where two legitimate scans land in the wrong
session as a result - it is intentional design, not a traced defect.

---

## Exemplar 2: unsynced scans silently discarded on sign-out

Source: commit `4910353` ("ultra-review fix wave - sign-out drain guard..."), files
`src/components/Nav.tsx` and `src/stores/scanStore.ts`.

### Pre-fix excerpt (`git show 4910353~1:src/components/Nav.tsx`, ~line 50)

```tsx
{isLiveAuth() && (
  <button
    type="button"
    onClick={async () => {
      if (!window.confirm("Log out now? Your counts are saved - you can sign back in any time to keep going.")) return;
      useScanStore.getState().resetForSignOut();
      await signOut();
      router.replace("/login");
    }}
    className="ml-auto inline-flex min-h-[44px] items-center rounded-lg px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
  >
    Log out
  </button>
)}
```

`resetForSignOut` (unchanged by this commit) unconditionally wipes `pendingSyncQueue`
along with the rest of tenant state - it is a full reset, not a drain.

### TRACE

Pick one concrete value: a clerk is offline (spotty warehouse wifi) and has just scanned
tire `T-99881`, creating a `ScanEvent` that landed in `pendingSyncQueue` (queue length
goes from 0 to 1) because the network write failed. The clerk then taps "Log out" to end
their shift.

1. `onClick` fires. Line 5: `window.confirm("Log out now? Your counts are saved...")` -
   the copy asserts counts are safe. The clerk reads this, believes it, clicks OK.
2. Line 6: `useScanStore.getState().resetForSignOut()` runs synchronously. This function
   (unchanged here) sets `pendingSyncQueue: []` among other resets - the one unsynced
   `ScanEvent` for `T-99881` is wiped from local state with no read of its current length
   first and no attempt to flush it.
3. Line 7: `await signOut()` - Firebase auth session ends.
4. Line 8: `router.replace("/login")` - the clerk is on the login screen.
5. The scan for `T-99881` existed only in `pendingSyncQueue` (never reached Firestore -
   that's why it was pending) and is now gone from both localStorage and the server.
   Session total before logout: N+1 (the local optimistic count included it). After
   logout and any subsequent refresh/re-login: N (the server never received it).

The divergence point is line 5-6: the confirm dialog's message ("your counts are saved")
is asserted unconditionally, without checking whether `pendingSyncQueue.length > 0`, and
`resetForSignOut` is invoked with no prior drain attempt.

### FINDINGS

**[Critical]** Sign-out wipes `pendingSyncQueue` without attempting to sync it first and
without warning the user that unsynced scans will be lost, contradicting the confirm
dialog's own claim that "your counts are saved."
Failure scenario: starting state - clerk is offline (or had a transient sync failure),
`pendingSyncQueue` holds 1 unsynced `ScanEvent`, local optimistic count is N+1. Action
sequence - clerk clicks "Log out", confirms the generic dialog (which unconditionally
says counts are saved), auth session ends. Wrong outcome - the pending scan is deleted by
`resetForSignOut`'s unconditional `pendingSyncQueue: []` before any drain is attempted;
after sign-out (and thus no way to retry) the true count is N, permanently short by 1,
with the user having been told nothing was at risk. Expected outcome - sign-out should
attempt one awaited drain of the queue and, if anything still fails to sync, tell the
user honestly how many scans would be discarded and let them cancel.
Evidence line: `src/components/Nav.tsx` (pre-fix), the single unconditional
`window.confirm("Log out now? Your counts are saved...")` string feeding directly into
`resetForSignOut()` with no queue-length check or drain call in between.

**[Medium]** Even when a drain is desired, `resetForSignOut` (unchanged in this diff) is
still a synchronous full wipe with no return value describing what happened - callers
have no hook to make the decision conditional, so *any* caller of `resetForSignOut`
(not just this Nav button) inherits the same silent-loss risk if a second sign-out entry
point exists elsewhere.
Failure scenario: starting state - a second sign-out button/flow is added later
(e.g. a Settings-page sign-out) that also calls `resetForSignOut()` directly. Action
sequence - that new call site is not required to reproduce the confirm+drain logic since
`resetForSignOut` itself gives no signal. Wrong outcome - the new entry point silently
repeats the same data loss. Expected outcome - the drain/warn responsibility should live
in one shared place both entry points call through, not be re-implemented per button.
Evidence line: `resetForSignOut` performs `pendingSyncQueue: []` directly with no
awaited drain step or return value, so it is unsafe to call directly from any UI
without external gating - a property invisible from its own signature.

### What I did NOT report

The `window.confirm` UX (a native browser confirm dialog) looks like a candidate finding
on its own - blocking, unstyled, hard to test. I did not report it: it is an existing,
intentional pattern already used elsewhere in this codebase for destructive
confirmations, changing it is a scope decision about UI consistency, not a functional
defect, and I have no concrete scenario where the native dialog itself (as opposed to
the message it displays) causes wrong data or a wrong outcome.

---

## Method recap

Both exemplars followed the same shape: quote the smallest excerpt that contains the
defect, pick one value that a real user would produce, walk it through the code until a
specific line changes its fate, then write the finding as [severity] + one-sentence
defect + a scenario with a starting state, an action sequence, a wrong outcome, and the
expected outcome, closing with the exact code line as evidence. Then stop and name one
thing that looked suspicious but had no traceable failure - that discipline is what
keeps a review's findings trustworthy instead of noisy.
