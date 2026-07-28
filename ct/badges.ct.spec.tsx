import { test, expect } from "@playwright/experimental-ct-react";
import { SyncBadge } from "@/components/badges";

// Example component test (the CT scaffold's proof-of-life). Mounts the pure presentational
// SyncBadge in a real browser and asserts its rendered text per sync status. SyncBadge is a good
// CT target: no store, no next/*, no backend - just props -> markup, which is exactly what CT is for.
test.describe("SyncBadge (component test)", () => {
  test("renders the 'Saved' label for a synced item", async ({ mount }) => {
    const component = await mount(<SyncBadge status="synced" />);
    await expect(component).toHaveText("Saved");
    await expect(component).toHaveAttribute("data-testid", "sync-badge");
  });

  // One mount per test: Playwright CT mounts into a single React root, so a second mount() in the
  // same test throws. Each status gets its own test.
  test("renders the 'Not saved yet' label for a pending item", async ({ mount }) => {
    const component = await mount(<SyncBadge status="pending" />);
    await expect(component).toHaveText("Not saved yet");
  });

  test("renders the 'Save error' label for a failed item", async ({ mount }) => {
    const component = await mount(<SyncBadge status="error" />);
    await expect(component).toHaveText("Save error");
  });
});
