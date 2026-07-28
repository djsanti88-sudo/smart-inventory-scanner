# Defects

1. **Resolving the same context again is treated as a tenant switch and destructively clears live state.** The gate calls `rehydrateForUid` and then immediately calls `setBusinessContext` on every mount. There is no check that `businessId` and `userId` are unchanged, so a normal refresh can erase `scanFeed`, `needsReviewQueue`, `settings`, `recentLocations`, and the current counts before loading. `loadBusinessData` does not return most of those fields, and it restores counts only when it finds a session, so the cleared data is not reconstructed. For example, refreshing a shop with open reviews and customized settings leaves both at defaults.

   The unawaited rehydration makes this nondeterministic: the clear can run before or after the persisted state finishes rehydrating, so persisted state can either be immediately wiped or arrive after context setup and overwrite it.

2. **Async business loads are not fenced to the context that started them.** If A starts loading, the user switches to B, and B finishes first, A can finish later and blindly `set` A's products, aliases, session, and counts while the store's `businessId` still says B. That is a concrete cross-tenant data leak. Each load needs a generation/context check (or cancellation) before committing results or calling sync.
