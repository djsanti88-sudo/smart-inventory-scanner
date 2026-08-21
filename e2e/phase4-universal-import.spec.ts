import path from "node:path";
import { test, expect, type Page, type Route } from "./fixtures";

// Task 11 (Phase 4 Stage A ship gate) AC5 e2e proof: the Universal Import panel on /products, driven
// through the real UI, for both desktop and phone viewports. Uses the reordered/renamed TSV fixture
// (src/services/import/__fixtures__/reordered-renamed.tsv), which carries a real RUNTIME-corpus part
// number (Falken Wildpeak A/T3W, manufacturer_part_number 28030703, size LT275/70R18, barcode
// 848983006493 - queried directly from src/server/knowledge.generated.db, the DB the app actually
// loads; the older tire_corpus_seed.csv is stale pre-generation source data and is NOT what
// /api/reconcile/match reads) so the LOCAL /api/reconcile/match route (real committed corpus, no live
// network) reports one genuine exact match. Only /api/ai-lookup is route-mocked, matching every other
// P3/P4 mock spec - /api/reconcile/match and /api/import-mapping are local-only routes over the
// committed corpus and the mock KV seam, never a live provider.
//
// Deterministic exact-match count: the fixture has exactly 2 data rows. Row 1 (PN 28030703, brand
// Falken, size LT275/70R18) hits the part-number-exact path in identityMatcher.ts (AM-R4: brand AND
// size both corroborate) -> status "exact" - verified directly against a live local dev server before
// this fixture was finalized (see the Task 11 report for the curl proof). Row 2 (PN WIDGET-100, no
// size, brand Acme) has no corpus hit and no tire signal -> "unmatched" -> "review". So the real
// headline is deterministically "Matched 1 of 2 automatically".

const PROOF = "e2e/proof";
const FIXTURE = path.join(__dirname, "..", "src", "services", "import", "__fixtures__", "reordered-renamed.tsv");

const NO_AI_STATUS = {
  liveEnabled: false, autoDecodeOnScan: false, openaiConfigured: false,
  mode: "off", missingKeys: ["OPENAI_API_KEY"], e2e: true,
};

async function mockAiLookup(page: Page) {
  await page.route("**/api/ai-lookup", async (route: Route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: NO_AI_STATUS });
    return route.fulfill({ json: {} });
  });
}

async function runImportFlow(page: Page, viewportLabel: string) {
  await mockAiLookup(page);
  await page.goto("/products");

  const panel = page.getByTestId("universal-import-panel");
  await expect(panel).toBeVisible();

  await page.getByTestId("universal-import-file").setInputFiles(FIXTURE);

  const preview = page.getByTestId("import-preview");
  await expect(preview).toBeVisible();

  const headline = page.getByTestId("import-headline");
  await expect(headline).toHaveText("Matched 1 of 2 automatically");

  await page.screenshot({ path: `${PROOF}/p4-preview-${viewportLabel}.png`, fullPage: true });

  await page.getByTestId("import-apply").click();
  const summary = page.getByTestId("import-summary");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("Applied");

  await page.screenshot({ path: `${PROOF}/p4-applied-${viewportLabel}.png`, fullPage: true });

  // Past-apply gap (real AC5 requirement): the imported quantity must show up on the Boss Report.
  // report-total-items is the real testid (src/app/(app)/report/page.tsx); it renders
  // "Total items: <strong>{report.totalItems}</strong>".
  await page.goto("/report");
  const totalItems = page.getByTestId("report-total-items");
  await expect(totalItems).toBeVisible();
  const text = (await totalItems.textContent()) ?? "";
  const match = text.match(/Total items:\s*(\d+)/);
  expect(match).not.toBeNull();
  expect(Number(match?.[1] ?? 0)).toBeGreaterThan(0);

  await page.screenshot({ path: `${PROOF}/p4-report-${viewportLabel}.png`, fullPage: true });
}

test.describe("Phase 4 Stage A: universal import end to end", () => {
  test("desktop (1280x800): upload, preview, apply, and the count reaches the Boss Report", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await runImportFlow(page, "desktop");
  });

  test("phone (390x844): upload, preview, apply, and the count reaches the Boss Report", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await runImportFlow(page, "phone");
  });
});
