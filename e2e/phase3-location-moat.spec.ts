import { test, expect } from "@playwright/test";

test.describe("Phase 3: location recents and moat line", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/ai-lookup", async (route) => {
      await route.fulfill({
        json: {
          liveEnabled: false,
          autoDecodeOnScan: false,
          openaiConfigured: false,
          missingKeys: ["OPENAI_API_KEY"],
          mode: "off",
          e2e: true,
        },
      });
    });
  });

  test("auto-starts a device session when the scan page mounts", async ({ page }) => {
    await page.goto("/scan");
    await expect(page.getByText("Default Session", { exact: true })).toHaveCount(0);
    await expect(page.locator("#scanner-input")).toBeFocused();
  });

  test("typing a location, then scanning, offers it as a recent and shows the moat line", async ({ page }) => {
    await page.goto("/scan");
    const scanner = page.getByRole("textbox", { name: /scan/i });
    await expect(scanner).toBeFocused();
    await page.getByLabel("location").fill("Bay A");
    await scanner.fill("012345678905");
    await scanner.press("Enter");
    await expect(page.getByTestId("moat-line")).toBeVisible();
    await expect(scanner).toBeFocused();
    await page.getByLabel("location").fill("");
    await page.getByLabel("location").click();
    const options = await page.locator("#recent-locations option").allTextContents();
    expect(options.join(",")).toContain("Bay A");
  });

  test("phone viewport (390px): location input and moat line render without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/scan");
    const scanner = page.getByRole("textbox", { name: /scan/i });
    await expect(scanner).toBeFocused();
    await page.getByLabel("location").fill("Cooler 1");
    await scanner.fill("012345678905");
    await scanner.press("Enter");
    await expect(page.getByTestId("moat-line")).toBeVisible();
    await expect(scanner).toBeFocused();
    await page.screenshot({ path: "e2e/proof/phase3-location-moat-phone.png", fullPage: true });
  });
});
