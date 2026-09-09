import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useScanStore } from "@/stores/scanStore";
import { getMockDb } from "@/sync-database/mock/mockDb";

// SECONDARY FINDING (root-caused 2026-08-09 from the adopt emulator spot-check): after adoption +
// reload, an EMPTY "sis-scan-v1" (+ its "::stamp" sibling) reappeared even though a per-uid namespace
// was active. It is PRODUCT CODE, not a proof artifact:
//
//   StoreHydrator calls useScanStore.persist.rehydrate() on every page load, while the persist name is
//   still the DEFAULT legacy key (the uid is only known after BusinessContextGate's async auth
//   bootstrap). Zustand's hydrate ends by invoking onRehydrateStorage's callback -> setHasHydrated(true)
//   -> a store set() -> the persist middleware's setItem() on the CURRENT name. The initial (empty)
//   state is therefore written straight back to "sis-scan-v1".
//
// Test 1 reproduces that write. Test 2 pins the fix: rehydrateForUid sweeps a NON-meaningful legacy
// blob (and its stamp) once the per-uid namespace is active. Test 3 pins the safety rule: a MEANINGFUL
// pre-account blob (adoptable, or deliberately kept via "Start fresh (leave it)") is never destroyed.
//
// jsdom has no indexedDB, so the real store here runs on the localStorage-backed coalesced wrapper;
// "pagehide" forces its pending write to flush synchronously (same technique as persistBrick.test.ts).

const LEGACY_KEY = "sis-scan-v1";
const STAMP_KEY = `${LEGACY_KEY}::stamp`;
const SEEDED_CODE = "6419440485331"; // seed Nokian tire barcode (known match)

describe("the legacy persist key does not accumulate residue once a per-uid namespace is active", () => {
  beforeEach(() => {
    getMockDb().reset();
    window.localStorage.clear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    // Leave persist pointed back at the legacy key for any later test in this process.
    (useScanStore as unknown as { persist: { setOptions: (o: { name: string }) => void } }).persist.setOptions({
      name: LEGACY_KEY,
    });
    window.localStorage.clear();
  });

  it("REPRODUCTION: a plain persist.rehydrate() (StoreHydrator, before the uid is known) writes the empty state back to sis-scan-v1", async () => {
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();

    await useScanStore.persist.rehydrate();
    window.dispatchEvent(new Event("pagehide")); // flush the coalesced write

    // This is the observed residue: the legacy key is recreated by the hydrate -> setHasHydrated set().
    const residue = window.localStorage.getItem(LEGACY_KEY);
    expect(residue).toBeTruthy();
    const parsed = JSON.parse(residue!) as { state?: { scanFeed?: unknown[]; finalCounts?: unknown[] } };
    expect(parsed.state?.scanFeed ?? []).toEqual([]);
    expect(parsed.state?.finalCounts ?? []).toEqual([]);
  });

  it("FIX: rehydrateForUid sweeps that empty residue (blob + ::stamp) once the per-uid key is active", async () => {
    await useScanStore.persist.rehydrate();
    window.dispatchEvent(new Event("pagehide"));
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeTruthy();

    await useScanStore.getState().rehydrateForUid("uid-residue-sweep");
    window.dispatchEvent(new Event("pagehide"));

    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(window.localStorage.getItem(STAMP_KEY)).toBeNull();
  });

  it("SAFETY: a MEANINGFUL pre-account blob is never swept - 'Start fresh (leave it)' must leave it adoptable", async () => {
    // A real anonymous session's data lands in the legacy key.
    useScanStore.getState().processScan(SEEDED_CODE);
    window.dispatchEvent(new Event("pagehide"));
    const anonBlob = window.localStorage.getItem(LEGACY_KEY);
    expect(anonBlob).toBeTruthy();
    expect(JSON.parse(anonBlob!).state.scanFeed.length).toBeGreaterThan(0);

    // The owner signs in and chooses "Start fresh (leave it)": the gate calls rehydrateForUid directly.
    await useScanStore.getState().rehydrateForUid("uid-start-fresh");
    window.dispatchEvent(new Event("pagehide"));

    const stillThere = window.localStorage.getItem(LEGACY_KEY);
    expect(stillThere).toBeTruthy();
    expect(JSON.parse(stillThere!).state.scanFeed.length).toBeGreaterThan(0);
  });
});
