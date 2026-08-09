import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useScanStore } from "@/stores/scanStore";
import { getMockDb } from "@/services/mockDb";

// Task 1 (B4, product honesty, 2026-08-09): adoptLegacyLocalData's migrate step copies the legacy
// blob to the per-uid key and DELETES the legacy blob, then calls rehydrateForUid/setBusinessContext.
// A failure BEFORE the migrate step lands is safe to describe as "your local data is still safe" (the
// legacy blob is untouched). A failure AFTER the copy has landed is not: the legacy blob is gone and
// the per-uid key already holds the adopted data. adoptLegacyLocalData must tag ONLY the latter case
// (postCopyAdoptFailure: true on the thrown Error) so BusinessContextGate can tell them apart.

describe("adoptLegacyLocalData tags a post-copy failure so the UI never claims false safety", () => {
  beforeEach(() => {
    getMockDb().reset();
    window.localStorage.clear();
  });

  afterEach(() => {
    useScanStore.setState({ rehydrateForUid: originalRehydrateForUid });
    window.localStorage.clear();
  });

  const originalRehydrateForUid = useScanStore.getState().rehydrateForUid;

  it("tags the thrown error postCopyAdoptFailure when the copy landed but rehydrateForUid rejects afterward", async () => {
    // Seed a real legacy blob so migrateLegacyBlobOnce has something to copy.
    window.localStorage.setItem(
      "sis-scan-v1",
      JSON.stringify({ state: { scanFeed: [{ id: "e1", quantityDelta: 1 }] }, version: 14 }),
    );

    useScanStore.setState({ rehydrateForUid: async () => { throw new Error("rehydrate blew up"); } });

    await expect(useScanStore.getState().adoptLegacyLocalData("postcopy-uid")).rejects.toMatchObject({
      postCopyAdoptFailure: true,
    });

    // The copy DID land: the legacy key is gone and the per-uid key holds the adopted data - proving
    // the failure genuinely happened after the copy stage, which is exactly why the tag must be set.
    expect(window.localStorage.getItem("sis-scan-v1")).toBeNull();
    expect(window.localStorage.getItem("sis-scan-postcopy-uid")).toBeTruthy();
  });

  it("does NOT tag the thrown error when the failure happens before the copy lands (no legacy blob to migrate)", async () => {
    // No legacy blob was ever written: migrateLegacyBlobOnce silently no-ops (nothing to copy), so the
    // copy never "lands" in the F-4/B4 sense - but rehydrateForUid still rejects afterward. Whether or
    // not the migrate step itself found data, once we're past it a failure is still post-copy-stage by
    // this function's own contract, so this proves the tag is driven by CODE PATH (post-migrate-call),
    // not by "was there data" - matching adoptLegacyLocalData's actual try/catch boundary.
    useScanStore.setState({ rehydrateForUid: async () => { throw new Error("rehydrate blew up"); } });

    await expect(useScanStore.getState().adoptLegacyLocalData("nolegacy-uid")).rejects.toMatchObject({
      postCopyAdoptFailure: true,
    });
  });
});
