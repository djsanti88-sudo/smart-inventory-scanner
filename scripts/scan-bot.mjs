// Live scan bot: logs into the deployed app as the test bot, scans 10 real catalog barcodes one-by-one
// through the real UI, reads each result, and writes a report. Proves login works (api-key) + the global
// 52k catalog resolves live in the browser.
// Usage: node scripts/scan-bot.mjs [baseUrl]
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = process.argv[2] || "https://inventory-lovat-six.vercel.app";
const EMAIL = "scanbot@smartinventory.app";
const PASSWORD = "ScanBot2026";
const N = 10;

function parseCsv(t) { const L = t.split(/\r?\n/).filter(Boolean); const h = L[0].split(","); return L.slice(1).map((ln) => { const c = ln.split(","); const o = {}; h.forEach((k, i) => (o[k] = (c[i] ?? "").trim())); return o; }); }
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const rows = parseCsv(readFileSync("data/tire-knowledge/tire_corpus_flat.csv", "utf8")).filter((r) => r.barcode);
let sample;
if (process.env.CODES) {
  const want = process.env.CODES.trim().split(/\s+/);
  const byBc = new Map(rows.map((r) => [r.barcode, r]));
  sample = want.map((bc) => byBc.get(bc) || { barcode: bc, brand: "?", model: "?", size_canonical: "?" });
} else {
  const idx = new Set(); while (idx.size < N) idx.add(Math.floor(Math.random() * rows.length));
  sample = [...idx].map((i) => rows[i]);
}

mkdirSync("reports/scan-bot", { recursive: true });
const b = await chromium.launch();
const page = await (await b.newContext()).newPage();
const report = { base: BASE, when: new Date().toISOString(), login: "", results: [] };

try {
  // --- LOGIN (wait for hydration; verify the field actually holds the value) ---
  await page.goto(BASE + "/login", { waitUntil: "networkidle", timeout: 40000 });
  const emailIn = page.getByTestId("login-email");
  const pwIn = page.getByTestId("login-password");
  await emailIn.waitFor({ state: "visible", timeout: 20000 });
  await page.waitForTimeout(1500); // let React hydrate the controlled inputs
  for (let attempt = 0; attempt < 3; attempt++) {
    await emailIn.click(); await emailIn.fill(""); await emailIn.fill(EMAIL);
    await pwIn.click(); await pwIn.fill(""); await pwIn.fill(PASSWORD);
    if ((await emailIn.inputValue()) === EMAIL && (await pwIn.inputValue()) === PASSWORD) break;
    await page.waitForTimeout(1000);
  }
  await page.getByTestId("login-button").click();
  await page.waitForTimeout(6000);
  const errCount = await page.getByTestId("login-error").count();
  if (errCount) {
    report.login = "FAILED: " + (await page.getByTestId("login-error").innerText());
    console.log(report.login);
    writeFileSync("reports/scan-bot/report.json", JSON.stringify(report, null, 2));
    await page.screenshot({ path: "reports/scan-bot/login-error.png" });
    await b.close(); process.exit(1);
  }
  report.login = "SUCCESS (url=" + page.url() + ")";
  console.log(report.login);

  // --- SELECT THE BOT'S BUSINESS (multi-business gate) ---
  const BOT_BIZ = "biz-C1kxpqNrW7SZoUUyYZ4WLWXPNVL2";
  await page.goto(BASE + "/business", { waitUntil: "domcontentloaded", timeout: 40000 });
  const sel = page.getByTestId(`select-business-${BOT_BIZ}`);
  await sel.waitFor({ timeout: 20000 });
  await sel.click();
  await page.waitForURL(/\/scan/, { timeout: 20000 }).catch(() => {});

  // --- GET TO SCANNER ---
  const startBtn = page.getByTestId("start-session");
  if (await startBtn.count()) await startBtn.click().catch(() => {});
  await page.getByTestId("scanner-input").waitFor({ timeout: 20000 });
  await page.screenshot({ path: "reports/scan-bot/00-scanner.png", fullPage: true });

  // --- SCAN 10, one by one ---
  let resolved = 0, correct = 0;
  for (let i = 0; i < sample.length; i++) {
    const r = sample[i];
    const input = page.getByTestId("scanner-input");
    await input.click(); await input.fill(r.barcode); await input.press("Enter");
    await page.waitForTimeout(2500); // allow async cloud-catalog lookup to settle
    const rowLoc = page.getByTestId("scan-feed-body").locator("tr").first();
    const rowText = (await rowLoc.count()) ? (await rowLoc.innerText()).replace(/\s+/g, " ").trim() : "(no row)";
    const lower = rowText.toLowerCase();
    const isKnown = /known/.test(lower) || lower.includes(norm(r.brand));
    const brandMatch = lower.includes(norm(r.brand)) || lower.includes((r.brand || "").toLowerCase());
    if (isKnown) resolved++;
    if (brandMatch) correct++;
    report.results.push({ n: i + 1, barcode: r.barcode, expected: `${r.brand} ${r.model} ${r.size_canonical}`, resolved: isKnown, brandMatch, rowText });
    console.log(`  [${i + 1}] ${r.barcode} exp=${r.brand} -> ${isKnown ? "RESOLVED" : "unresolved"}${brandMatch ? " (brand OK)" : ""}`);
  }
  await page.screenshot({ path: "reports/scan-bot/01-after-10.png", fullPage: true });
  report.summary = { scanned: sample.length, resolved, brandCorrect: correct };
  console.log(`\nSUMMARY: ${resolved}/${sample.length} resolved, ${correct}/${sample.length} brand-correct`);
} catch (e) {
  report.error = String(e?.message || e);
  console.log("BOT ERROR:", report.error);
} finally {
  writeFileSync("reports/scan-bot/report.json", JSON.stringify(report, null, 2));
  await b.close();
}
