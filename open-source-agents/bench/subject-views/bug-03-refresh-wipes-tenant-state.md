# Case: bug-03-refresh-wipes-tenant-state
## Task prompt (what the subject model sees)
Review the following code for real defects. This is `setBusinessContext` in a Zustand store for a multi-tenant inventory app; it is called whenever the app resolves which signed-in business/user context should be active, including on every page mount/refresh, not just on an actual account switch.
## Input code
```ts
// src/stores/scanStore.ts
// Interface (unchanged in this version):
//   setBusinessContext: (businessId: string, userId: string) => void;

setBusinessContext: (businessId, userId) => {
  const needsLoad = cloudBackend && !!deps.loadBusinessData;
  // Isolation: settings/needsReviewQueue/scanFeed are NOT returned by loadBusinessData and
  // finalCounts linger when no session restores, so a context switch must REPLACE all four or
  // the previous tenant's rows bleed through (two users OR one user with two businesses).
  const cleared = emptyTenantState();
  set({
    businessId,
    userId,
    businessContextReady: true,
    businessDataLoaded: !needsLoad,
    lastSyncError: null,
    scanFeed: cleared.scanFeed,
    finalCounts: cleared.finalCounts,
    needsReviewQueue: cleared.needsReviewQueue,
    settings: cleared.settings,
    firstScanAt: cleared.firstScanAt,
    recentLocations: cleared.recentLocations,
  });
  const loader = deps.loadBusinessData;
  if (cloudBackend && loader) {
    // Load THIS business's products/aliases from Firestore (replace, never merge another tenant's
    // data), then drain anything queued. Failure is surfaced, not fatal to the local UI.
    void (async () => {
      try {
        const data = await loader(businessId, userId);
        // Reconstruct the active count session + its finalCounts (survive-refresh). Prefer the most
        // recent ACTIVE session; else the most recent overall. finalCounts are the persisted count
        // lines for that session, mapped back to store shape. No session -> keep current defaults.
        const byStartedAtDesc = (a: InventorySession, b: InventorySession) =>
          (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
        const sessions = [...data.sessions].sort(byStartedAtDesc);
        const restored = sessions.find((s) => s.status === "active") ?? sessions[0] ?? null;
        const next: Partial<ScanState> = { products: data.products, aliases: data.aliases };
        if (restored) {
          next.currentSession = restored;
          next.sessionId = restored.id;
          next.finalCounts = data.counts.filter((c) => c.sessionId === restored.id);
        }
        next.businessDataLoaded = true;
        set(next);
      } catch (e) {
        // Surface the error but mark loaded so the UI does not hang forever (sync still paused on error).
        set({ lastSyncError: e instanceof Error ? e.message : "Failed to load business data", businessDataLoaded: true });
      }
      get().syncPending();
    })();
  } else {
    get().syncPending(); // drain anything queued now that we have a real business context
  }
},

// Elsewhere in the same store:
rehydrateForUid: (uid: string) => {
  if (typeof window === "undefined" || !window.localStorage) return;
  // Re-point storage at this uid's key and rehydrate from it. NO legacy migration here:
  // adopting the pre-account blob is an explicit owner action (adoptLegacyLocalData), never an
  // automatic side effect of signing in (shared-browser inheritance hazard).
  if (!deps.persistName) return; // non-persisted test store: nothing to re-point
  const persistApi = (useScanStore as unknown as {
    persist?: { setOptions: (o: { name: string }) => void; rehydrate: () => Promise<void> | void };
  }).persist;
  if (persistApi) {
    persistApi.setOptions({ name: persistKeyForUid(uid) });
    void persistApi.rehydrate();
  }
},
```
```tsx
// src/components/BusinessContextGate.tsx (relevant effect body)
useEffect(() => {
  if (!cloud) return; // mock/local path: nothing to wire (context + data already "ready")
  let active = true;
  void (async () => {
    const user = await getSession();
    if (!active) return;
    if (!user) { setStatus("no-user"); return; }

    const selected = getSelectedBusinessId();
    const memberships = await listMemberships();
    if (!active) return;
    const membership = selected ? memberships.find((m) => m.businessId === selected) : undefined;
    if (!membership) { setStatus("no-business"); return; }

    const legacy = typeof window !== "undefined" && hasLegacyBlob(window.localStorage);
    const alreadyOwn =
      typeof window !== "undefined" && window.localStorage.getItem(persistKeyForUid(user.uid)) !== null;
    if (legacy && !alreadyOwn) {
      setPendingCtx({ businessId: membership.businessId, uid: user.uid });
      setStatus("adopt-choice");
      return;
    }

    useScanStore.getState().rehydrateForUid(user.uid);
    setBusinessContext(membership.businessId, user.uid);
    setStatus("ready");
  })();
  return () => { active = false; };
}, [cloud, setBusinessContext]);
```
