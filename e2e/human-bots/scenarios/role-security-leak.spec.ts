import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// SecurityLeakBot (SAFE, non-destructive). It does NOT exploit anything. It loads the app as a customer
// (mock/auth-bypass = business level; this suite does NOT set NEXT_PUBLIC_E2E_PLATFORM_OWNER) and inspects
// which sensitive internal fields the customer browser can see or holds locally. The P0 customer
// data-protection foundation has LANDED (Sec-1/2/3 UI+export hiding; Sec-4 localStorage split; Sec-5
// server resolution), so this bot now ASSERTS the customer browser holds NO reusable code database
// (no alias cleanCode/normalizedCode, no global catalog) and shows no code columns - a hard regression
// guard. It still writes its report for the audit trail.

const PROOF = "e2e/proof/agent-bots/security";
const OUT = "reports/agent-bots/latest";

const SENSITIVE_TERMS = ["Gemini", "OpenAI", "Firecrawl", "AI lookup", "AI decode", "provider", "prompt", "decode trace", "source url", "evidence"];
const SENSITIVE_STORE_KEYS = ["aliases", "catalog", "normalizedCode", "cleanCode", "gtin", "upc", "ean", "sourceUrls", "rawCodeExample"];

async function scan(page: Page, code: string) {
  const i = page.getByTestId("scanner-input");
  await i.click();
  await i.fill(code);
  await i.press("Enter");
  await page.waitForTimeout(120);
}

test("SecurityLeakBot: report sensitive-field exposure to a customer browser (safe)", async ({ page }) => {
  mkdirSync(PROOF, { recursive: true });
  mkdirSync(resolve(process.cwd(), OUT), { recursive: true });
  const findings: Array<{ surface: string; finding: string; severity: string; detail: string }> = [];

  // 1. Scan a known code so the store is populated, then inspect what the BROWSER holds locally.
  await page.goto("/scan");
  await scan(page, "6419440485331"); // a seed product
  const storeDump = await page.evaluate(() => {
    try { return window.localStorage.getItem("sis-scan-v1") || ""; } catch { return ""; }
  });
  const aliasCount = (storeDump.match(/"cleanCode"/g) || []).length;
  const catalogPresent = /"catalog"\s*:/.test(storeDump);
  if (aliasCount > 0) {
    findings.push({ surface: "localStorage (sis-scan-v1)", finding: "Customer browser holds the alias database (cleanCode/normalizedCode values)", severity: "P0", detail: `~${aliasCount} alias code entries persisted client-side` });
  }
  if (catalogPresent) {
    findings.push({ surface: "localStorage (sis-scan-v1)", finding: "Customer browser holds the shared catalog object", severity: "P0", detail: "global catalog persisted client-side (downloadable)" });
  }
  for (const k of SENSITIVE_STORE_KEYS) {
    if (storeDump.includes(`"${k}"`)) findings.push({ surface: "localStorage", finding: `internal field present in client store: ${k}`, severity: "P1", detail: "field serialized into the browser store" });
  }
  await page.screenshot({ path: `${PROOF}/01-scan.png`, fullPage: true });

  // 2. Scan a sensitive-term sweep across customer-facing pages.
  for (const path of ["/products", "/review", "/settings"]) {
    await page.goto(path);
    await page.waitForTimeout(200);
    const body = (await page.locator("body").innerText()).toLowerCase();
    for (const term of SENSITIVE_TERMS) {
      if (body.includes(term.toLowerCase())) {
        findings.push({ surface: path, finding: `customer-facing UI exposes term "${term}"`, severity: term.match(/Gemini|OpenAI|Firecrawl|provider|prompt/) ? "P1" : "P2", detail: "internal/AI mechanics shown to customer-facing roles" });
      }
    }
    // raw code columns on products
    if (path === "/products" && /gtin|upc|ean|primary barcode|aliases/.test(body)) {
      findings.push({ surface: path, finding: "Products page shows raw code columns (barcode/GTIN/UPC/EAN/aliases)", severity: "P0", detail: "no role gate; visible to any logged-in user" });
    }
    await page.screenshot({ path: `${PROOF}/${path.replace(/\//g, "_")}.png`, fullPage: true });
  }

  // 3. Write the report (REPORT-ONLY; does not exploit). De-dupe findings by surface+finding.
  const seen = new Set<string>();
  const unique = findings.filter((f) => { const k = f.surface + f.finding; if (seen.has(k)) return false; seen.add(k); return true; });
  const bySev = (s: string) => unique.filter((f) => f.severity === s);
  const md = `# SecurityLeakBot report (safe, non-destructive)

> Status: the P0 customer data-protection foundation has LANDED. UI hiding + export sanitization +
> customer de-branding (Sec-1/2/3), the customer localStorage split so the alias/catalog DB is never
> persisted to a customer browser (Sec-4), and the protected server-side resolution endpoint (Sec-5)
> are all in place for non-platformOwner roles. This run is an assertive regression guard: it FAILS if a
> customer browser ever again receives/persists the reusable code database or shows code columns.

- P0 findings: **${bySev("P0").length}**  |  P1: **${bySev("P1").length}**  |  P2: **${bySev("P2").length}**

| severity | surface | finding | detail |
|----------|---------|---------|--------|
${unique.length ? unique.map((f) => `| ${f.severity} | ${f.surface} | ${f.finding} | ${f.detail} |`).join("\n") : "| - | - | (no findings) | customer browser holds no reusable code data |"}

## Headline
- ${unique.filter((f) => f.severity === "P0").length === 0
    ? "PASS: the customer browser holds no alias/catalog database in localStorage and shows no code columns. The two prior P0 localStorage leaks are cleared."
    : "REGRESSION: a P0 leak reappeared - see the table above."}

Screenshots: ${PROOF}/
`;
  writeFileSync(resolve(process.cwd(), `${OUT}/security_leak_report.md`), md);
  writeFileSync(resolve(process.cwd(), `${OUT}/security_findings.json`), JSON.stringify({ findings: unique }, null, 2) + "\n");

  // HARD ASSERTIONS (regression guard). The P0 customer data-protection foundation has landed, so the
  // customer browser must hold NO reusable code database and show NO code columns. These are the exact
  // two P0 leaks that were previously open; this bot now fails if either ever returns.
  expect(aliasCount, "customer localStorage must not hold alias cleanCode values").toBe(0);
  expect(catalogPresent, "customer localStorage must not hold the global catalog").toBe(false);
  expect(
    unique.filter((f) => f.severity === "P0"),
    "no P0 leak may be visible to a customer browser",
  ).toHaveLength(0);
});
