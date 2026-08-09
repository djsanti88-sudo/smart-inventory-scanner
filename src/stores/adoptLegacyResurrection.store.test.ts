import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useScanStore } from "@/stores/scanStore";
import { getMockDb } from "@/services/mockDb";

// F-4 (resurrection leak, 2026-08-09): adoptLegacyLocalData copies the legacy "sis-scan-v1" blob
// into the signed-in user's per-uid key, then deletes "sis-scan-v1" - but that delete goes through
// scanPersistNamespace's migrateLegacyBlobOnce(Async), which writes straight to the RAW backing
// store(s), bypassing scanStore's own coalesced-write wrapper entirely. If a scan happened moments
// before the adopt click (still batched/pending - the wrapper collapses ~6 writes/scan into at most
// one write per tick), that pending write's target key/value are untouched by the raw delete and can
// still flush AFTER it, RE-CREATING "sis-scan-v1" with stale data. On a shared device the next sign-in
// would then see the adopt banner offering that resurrected (and by then already-adopted, orphaned)
// inventory - a cross-account disclosure. The fix: adoptLegacyLocalData now also cancels any pending
// wrapper write for the legacy key immediately after the copy-then-clear lands.

const SEEDED_CODE = "6419440485331"; // seed Nokian tire barcode (known match, same as persistBrick.test.ts)
const RACING_CODE = "999888777666"; // an arbitrary second scan; TOP-LEVEL LAW means it counts regardless

describe("adoptLegacyLocalData does not let a still-pending coalesced write resurrect the deleted legacy key", () => {
  beforeEach(() => {
    getMockDb().reset();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("cancels a pending write for sis-scan-v1 queued right before adopt runs, so the legacy key stays gone after the copy-then-clear", async () => {
    // Isolation note: adoptLegacyLocalData's LAST step is `get().rehydrateForUid(uid)`, whose own
    // persist.rehydrate() call triggers onRehydrateStorage -> setHasHydrated -> another set() - which
    // would ALSO happen to clobber the wrapper's single pending-write slot (any setItem call replaces
    // pendingName/pendingValue outright, regardless of key). That incidental clobber would mask the
    // bug under test (a case where NOTHING else touches the wrapper between the raw delete and the
    // stale flush). Stub it to a no-op via setState (read through get() by adoptLegacyLocalData, so
    // this override takes effect) to isolate exactly the copy-then-clear + cancel mechanism this test
    // targets - rehydrateForUid's own persist-repoint behavior is exercised by other tests already.
    const originalRehydrateForUid = useScanStore.getState().rehydrateForUid;
    useScanStore.setState({ rehydrateForUid: () => Promise.resolve() });

    try {
      // 1) Commit an initial legacy blob to disk with REAL timers - this is the data adoptLegacyLocalData
      // is SUPPOSED to copy forward. "pagehide" forces the coalesced write to flush synchronously, the
      // same technique scanStore.persistBrick.test.ts uses to force a deterministic flush.
      useScanStore.getState().processScan(SEEDED_CODE);
      window.dispatchEvent(new Event("pagehide"));
      const committed = window.localStorage.getItem("sis-scan-v1");
      expect(committed).toBeTruthy();

      // 2) A SECOND scan races in right before the user clicks "adopt" - its write is coalesced/pending
      // (scheduled for the next tick) and must NOT be allowed to flush before we control the clock.
      vi.useFakeTimers();
      useScanStore.getState().processScan(RACING_CODE);

      // 3) Adopt runs: copies the (on-disk, seeded-scan-only) legacy blob into the uid key, then deletes
      // "sis-scan-v1" directly from the raw backing store (migrateLegacyBlobOnce/Async, out of this
      // file's scope - the fix under test lives in adoptLegacyLocalData itself).
      await useScanStore.getState().adoptLegacyLocalData("adopt-uid-f4");

      // Immediately after adopt, the legacy key must already be gone (the copy-then-clear's own delete).
      expect(window.localStorage.getItem("sis-scan-v1")).toBeNull();

      // 4) Advance the fake clock so the step-2 pending write - still queued the whole time - would
      // flush now, if it had not been cancelled. THE BUG (without the fix): this recreates "sis-scan-v1"
      // here with the racing scan's content, the exact resurrection a shared-device adopt banner must
      // never offer to the next sign-in.
      await vi.runAllTimersAsync();

      expect(window.localStorage.getItem("sis-scan-v1")).toBeNull();
    } finally {
      useScanStore.setState({ rehydrateForUid: originalRehydrateForUid });
    }
  });
});
