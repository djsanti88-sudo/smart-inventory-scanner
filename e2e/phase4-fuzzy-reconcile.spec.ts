import { expect, test } from "./fixtures";

// Local minimal store shape for window.__scanStore, matching the cast pattern used across the
// other e2e specs (e.g. batch-approve.spec.ts) - there is no global ambient type for it.
type Store = {
  getState: () => {
    aliases: Array<{ cleanCode: string; approved: boolean }>;
    finalCounts: Array<{ quantity: number }>;
  };
};

test("fuzzy import stays in Needs Review until human confirmation", async ({ page }) => {
  await page.route("**/api/import-mapping**", async (route) => {
    await route.fulfill({
      json: route.request().method() === "GET" ? { mapping: null } : { ok: true },
    });
  });
  await page.route("**/api/reconcile/match", async (route) => {
    const body = route.request().postDataJSON() as { rows: Array<Record<string, unknown>> };
    await route.fulfill({
      json: {
        matches: body.rows.map((row) => ({
          row,
          status: "matched",
          reason: "Unique typo-tolerant candidate requires human confirmation.",
          confidence: 0.8,
          matchBasis: "identity_fuzzy",
          candidate: { uid: "one", brand: "Michelin", name: "Defender T H" },
        })),
      },
    });
  });

  await page.goto("/products");
  await page.getByTestId("universal-import-file").setInputFiles({
    name: "typo.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "PN,Make,Model,Tire Size,QOH\nMISS-1,Micheln,Defendr T H,225-65-17,4\n",
    ),
  });
  await expect(page.getByTestId("import-headline")).toHaveText("Matched 0 of 1 automatically");
  await page.getByTestId("import-apply").click();
  await expect(page.getByTestId("import-summary")).toContainText(
    "Applied 0. Needs Review 1. Rejected 0.",
  );

  const beforeConfirm = await page.evaluate(() => {
    const w = window as unknown as { __scanStore: Store };
    const state = w.__scanStore?.getState();
    return {
      approved: state?.aliases.some((item) => item.cleanCode === "MISS-1" && item.approved),
      quantity: state?.finalCounts.reduce((sum, item) => sum + item.quantity, 0),
    };
  });
  expect(beforeConfirm).toEqual({ approved: false, quantity: 0 });

  await page.goto("/review");
  // NeedsReviewTable.tsx: "Create new" (data-testid=open-create) only opens a blank create form and
  // needs a second "Save product" click; the one-click confirm for an existing AI/import suggestion
  // is "Approve suggestion" (data-testid=approve-suggestion), which calls resolveUnknown(...,
  // "create_new", { newProduct: <suggested product> }) directly. That is the actual single human
  // confirmation action the plan's "Create new product" click intended to exercise.
  await page.getByTestId("approve-suggestion").click();

  const afterConfirm = await page.evaluate(() => {
    const w = window as unknown as { __scanStore: Store };
    const state = w.__scanStore?.getState();
    return {
      approved: state?.aliases.some((item) => item.cleanCode === "MISS-1" && item.approved),
      quantity: state?.finalCounts.reduce((sum, item) => sum + item.quantity, 0),
    };
  });
  expect(afterConfirm).toEqual({ approved: true, quantity: 4 });
});
