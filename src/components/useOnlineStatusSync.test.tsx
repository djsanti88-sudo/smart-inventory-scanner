import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useOnlineStatusSync } from "@/components/useOnlineStatusSync";
import { useScanStore } from "@/stores/scanStore";

// Defect 2 (loop2-ui report UI2-1 follow-up): nothing listened for the browser's real "online"/"offline"
// events, so a genuine network drop never flipped the store's `online` flag and the documented
// "retries on reconnect" behavior had no reconnect signal to fire on. This proves the hook wires the two
// real DOM events to the store's existing public `setOnline` action, and that it never fires on mount
// (so it can never fight the manual "Go offline" test control, which calls the same action directly).

beforeEach(() => {
  useScanStore.setState({ online: true, pendingSyncQueue: [] });
});

afterEach(() => {
  cleanup();
  useScanStore.setState({ online: true, pendingSyncQueue: [] });
});

describe("useOnlineStatusSync", () => {
  it("does not touch the online flag on mount", () => {
    useScanStore.setState({ online: false });
    renderHook(() => useOnlineStatusSync());
    expect(useScanStore.getState().online).toBe(false);
  });

  it("flips the store offline when the browser fires a real 'offline' event", async () => {
    renderHook(() => useOnlineStatusSync());
    expect(useScanStore.getState().online).toBe(true);

    window.dispatchEvent(new Event("offline"));

    await waitFor(() => expect(useScanStore.getState().online).toBe(false));
  });

  it("flips the store back online when the browser fires a real 'online' event", async () => {
    useScanStore.setState({ online: false });
    renderHook(() => useOnlineStatusSync());

    window.dispatchEvent(new Event("online"));

    await waitFor(() => expect(useScanStore.getState().online).toBe(true));
  });

  it("removes its listeners on unmount (no further reaction after unmount)", async () => {
    const { unmount } = renderHook(() => useOnlineStatusSync());
    unmount();

    useScanStore.setState({ online: true });
    window.dispatchEvent(new Event("offline"));

    // Give any stray handler a tick to (wrongly) run, then assert nothing changed.
    await new Promise((r) => setTimeout(r, 0));
    expect(useScanStore.getState().online).toBe(true);
  });
});
