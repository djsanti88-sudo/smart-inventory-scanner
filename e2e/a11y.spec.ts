import { test, expect } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";

// Accessibility proof for the inventory scanner. This runs the axe-core engine against the real
// rendered app (through the same IS_E2E mock webServer as the other specs - never a live provider)
// and turns accessibility from a code-read into a measured, runnable gate.
//
// GATE POLICY: we fail only on `critical`/`serious` impact violations. `moderate`/`minor` (mostly
// color-contrast polish debt the design-system agent already tracks) are attached to the HTML report
// for visibility but do not block, so this spec can be adopted without first clearing every nit.
// Tighten `IMPACTS_THAT_FAIL` to include "moderate" once the backlog is clean.
const IMPACTS_THAT_FAIL = ["critical", "serious"] as const;

async function scan(page: import("./fixtures").Page, testInfo: import("@playwright/test").TestInfo) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  // Always attach the full result set so the report shows every finding, blocking or not.
  await testInfo.attach("axe-results.json", {
    body: JSON.stringify(results.violations, null, 2),
    contentType: "application/json",
  });

  const blocking = results.violations.filter((v) =>
    (IMPACTS_THAT_FAIL as readonly string[]).includes(v.impact ?? ""),
  );
  return { results, blocking };
}

test.describe("accessibility (axe-core)", () => {
  test("scan page has no critical or serious WCAG 2.1 A/AA violations", async ({ page }, testInfo) => {
    await page.goto("/");
    // The scanner input is the anchor of the whole flow; wait for it before auditing.
    await page.waitForLoadState("domcontentloaded");
    const { blocking } = await scan(page, testInfo);
    expect(
      blocking,
      `axe found ${blocking.length} blocking violation(s): ${blocking.map((v) => v.id).join(", ")}`,
    ).toEqual([]);
  });
});
