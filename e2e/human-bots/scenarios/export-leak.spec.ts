import { test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ExportBot (safe): exercises the export buttons and reads each CSV's HEADER row to see which contain
// raw/internal code fields. Single role today (auth bypass) - role-segregated export checks become real
// once roles are wired. Reports honestly which exports would leak internal codes to a customer role.

const PROOF = "e2e/proof/agent-bots/export";
const OUT = "reports/agent-bots/latest";
const CODE_FIELDS = ["primary_barcode", "gtin", "upc", "ean", "aliases", "raw_code", "clean_code", "normalized", "raw_code_example", "normalized_code", "source_urls", "provider"];

const EXPORTS = [
  { testid: "export-final-counts", name: "final counts" },
  { testid: "export-products", name: "products" },
  { testid: "export-aliases", name: "aliases" },
  { testid: "export-raw-log", name: "raw scan log" },
  { testid: "export-unknowns", name: "unknowns" },
];

async function headerOf(page: Page, testid: string): Promise<string> {
  const btn = page.getByTestId(testid).first();
  if ((await btn.count()) === 0) return "(button not present)";
  try {
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 8000 }), btn.click()]);
    const stream = await download.createReadStream();
    let buf = "";
    for await (const chunk of stream) { buf += chunk.toString(); if (buf.length > 2000) break; }
    return buf.split(/\r?\n/)[0].replace(/^﻿/, "");
  } catch {
    return "(no download)";
  }
}

test("ExportBot: capture export headers and flag code-bearing exports", async ({ page }) => {
  mkdirSync(PROOF, { recursive: true });
  mkdirSync(resolve(process.cwd(), OUT), { recursive: true });

  await page.goto("/scan");
  // produce a little data so exports are non-empty
  const i = page.getByTestId("scanner-input");
  await i.click(); await i.fill("049000028904"); await i.press("Enter"); await page.waitForTimeout(150);

  // Exports now live in the unified "Export" dropdown - open it so the per-dataset CSV chips are present.
  await page.getByTestId("export-menu-trigger").click();

  const rows: Array<{ export: string; header: string; codeFields: string[] }> = [];
  for (const e of EXPORTS) {
    const header = await headerOf(page, e.testid);
    const codeFields = CODE_FIELDS.filter((f) => header.toLowerCase().includes(f));
    rows.push({ export: e.name, header, codeFields });
  }
  await page.screenshot({ path: `${PROOF}/exports.png`, fullPage: true });

  writeFileSync(resolve(process.cwd(), `${OUT}/export_headers_by_role.json`), JSON.stringify({ role: "current (auth-bypass; role gating not yet implemented)", exports: rows }, null, 2) + "\n");
  const leaky = rows.filter((r) => r.codeFields.length > 0);
  writeFileSync(
    resolve(process.cwd(), `${OUT}/export_leak_report.md`),
    `# ExportBot report\n\n> Role-segregated exports are part of the DEFERRED foundation. Today there is ONE effective role and\n> all exports are available with raw code fields. This documents which exports MUST be sanitized/owner-only\n> before non-platformOwner roles exist.\n\n| export | code-bearing fields in header |\n|--------|-------------------------------|\n${rows.map((r) => `| ${r.export} | ${r.codeFields.join(", ") || "(none detected)"} |`).join("\n")}\n\n**${leaky.length} of ${rows.length} exports contain raw/internal code fields** and must be platformOwner-only or sanitized for customer roles. Headers captured in export_headers_by_role.json. Screenshots: ${PROOF}/\n`,
  );
});
