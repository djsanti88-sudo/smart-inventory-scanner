import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

// P3 (2026-06-22): a 65+ customer must not see engineer jargon or raw errors in Settings. As a customer
// (mock/auth-bypass = business level; no NEXT_PUBLIC_E2E_PLATFORM_OWNER), the Settings body must contain
// ONLY Export + Clean up + Danger zone - never "idempotent", "Debounce", "pending sync queue", a raw
// "Business ID" value, or AI/provider internals.

const PROOF = "e2e/proof/daily-2026-06-22";

const FORBIDDEN = ["idempotent", "Debounce", "ms)", "pending sync queue", "Business ID", "Submit mode", "Gemini", "OpenAI", "Auto-catalog"];

test("CustomerSettingsPlainBot: no jargon / raw errors in customer Settings (P3)", async ({ page }) => {
  mkdirSync(PROOF, { recursive: true });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Export" })).toBeVisible();
  const body = await page.locator("body").innerText();

  for (const term of FORBIDDEN) {
    expect(body, `customer Settings must not show "${term}"`).not.toContain(term);
  }
  // The customer keeps the things they actually use.
  expect(body).toMatch(/Export/);
  expect(body).toMatch(/Clean up|Clean up inventory/);

  await page.screenshot({ path: `${PROOF}/06-customer-settings.png`, fullPage: true });
});
