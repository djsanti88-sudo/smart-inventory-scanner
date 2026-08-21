import { test, expect, type Route } from "./fixtures";

// Camera scan proof (Task 3.2). Chromium is launched with fake UI/device media-stream flags so
// getUserMedia() resolves with a synthetic camera feed with no real hardware and no permission
// prompt. Decode itself stays fully mocked via page.route on /api/ai-lookup - this spec proves the
// camera OVERLAY opens/closes and wires into the scan path, not barcode decoding accuracy (that is
// covered by the mocked unit/component tests for cameraScanner + CameraScanButton).
test.use({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
});

const PROOF = "e2e/proof";

test("camera scan overlay opens and closes over the scan page", async ({ page }) => {
  await page.route("**/api/ai-lookup", async (route: Route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: {
          liveEnabled: false,
          autoDecodeOnScan: false,
          openaiConfigured: false,
          missingKeys: ["OPENAI_API_KEY"],
          mode: "off",
          dailyLimit: 100,
        },
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ providerNames: [], results: [], decision: { status: "needs_review", confidence: 0, reason: "mocked", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false } }) });
  });

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  // Scan input is focused by default (scanner-workflow rule).
  await expect(page.getByTestId("scanner-input")).toBeFocused();

  await page.getByTestId("camera-scan-button").click();

  const overlay = page.getByTestId("camera-scan-overlay");
  await expect(overlay).toBeVisible();
  // The fake device feed should reach the "streaming" state and render the video element.
  await expect(page.getByTestId("camera-scan-video")).toBeVisible();

  await page.screenshot({ path: `${PROOF}/camera-scan.png` });

  await page.getByTestId("camera-scan-cancel").click();
  await expect(overlay).not.toBeVisible();

  // Cancelling refocuses the hardware-scanner input so continuous scanning keeps working.
  await expect(page.getByTestId("scanner-input")).toBeFocused();
});
