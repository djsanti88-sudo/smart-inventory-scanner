// Cross-device live drill (prevention item 8, "Never Again" decision package, section 8).
//
// HONEST CONSTRAINT (read this before trusting the output): on a mock/no-login preview deployment,
// each Playwright browser CONTEXT has its own isolated localStorage and there is no shared cloud
// backend behind it, so two "devices" (contexts) never actually see each other's state. A true
// cross-device race (device A scans, device B refreshes and sees it, device B deletes, device A
// refreshes and does not see an inflated count) CANNOT be exercised against a mock preview. Running
// two independent contexts there and calling it "cross-device" would be a fake proof.
//
// So this script detects backend mode FIRST (GET /api/ai-lookup -> `e2e` field: true only when the
// SERVER's own e2e/mock guard - IS_E2E - is set) purely for REPORTING, and only ever runs ONE of two
// scenarios:
//
//   MOCK/COUNT-LAW MODE (today, on every current preview - including ones deployed with real,
//   configured provider keys where `e2e:false`): runs a LOCAL race drill in EACH of the two contexts
//   independently (not a cross-device test) that proves the count law survives a scan -> delete ->
//   undo -> reload sequence within one device: scan N codes = feed N rows, delete a counted product
//   transfers its quantity onto an "Unidentified item" row (never vanishes), undo restores the exact
//   pre-delete rows, and a reload preserves all of it. Results are labeled "local-only drill (mock
//   backend)" everywhere, never "cross-device proof".
//
//   PAID API COST TRUTH RULE: this drill must be $0 regardless of what the server reports, so it
//   ALWAYS force-mocks the client-side /api/ai-lookup route (page.route, same technique the repo's
//   own e2e specs use - see e2e/count-always.spec.ts) before scanning anything. It never trusts the
//   server's `e2e` flag as a safety guarantee - a preview can be deployed with live keys and
//   `e2e:false` (confirmed on this repo's current preview) while still being scanned safely, because
//   the client never even attempts a live network call once routed.
//
//   LIVE MODE (future, once a real cloud backend + login is deployed): runs the actual two-device
//   scenario across the two contexts sharing one account - A scans and syncs, B refreshes and sees
//   the count, B deletes, A refreshes and asserts no inflation. Not implemented yet (no live/cloud
//   preview with shared cross-device state exists to test it against); the script only ever detects
//   and reports this gap, never silently no-ops or fakes a pass.
//
// Usage: node scripts/cross-device-drill.mjs <BASE_URL>
// Self-test target used by the author: a current preview URL (see PROGRESS.md / memory for the
// latest one). Codes are pulled from the repo's known tire/retail corpus; the route mock guarantees
// $0 spend even though these are real barcode-shaped values.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"));
const { chromium } = require("@playwright/test");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "e2e", "proof");
fs.mkdirSync(OUT, { recursive: true });

const BASE = process.argv[2];
if (!BASE) {
  console.error("Usage: node scripts/cross-device-drill.mjs <BASE_URL>");
  process.exit(1);
}

// 12 known codes from the repo's real corpus (owner-supplied set + a few more from the same batch
// family used elsewhere in this repo's e2e/proof scripts, e.g. count-always.spec.ts / double-run
// scratchpad drafts) - free/deterministic or cache-hit codes, never live-decode triggers in mock mode.
const CODES = [
  "086699117120",
  "086699679611",
  "848983012906",
  "697662129691",
  "697662131854",
  "697662137658",
  "086699368492",
  "715459275427",
  "5452000649706",
  "086699205636",
  "086699999999",
  "848983000001",
];

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function detectBackendMode(base) {
  // The GET /api/ai-lookup status endpoint reports `e2e` (true when the SERVER's own e2e/mock guard,
  // IS_E2E, forces mock-only providers - src/app/api/ai-lookup/route.ts:130,197) and whether real
  // provider keys are configured. This is purely INFORMATIONAL for the report below - it is NOT what
  // makes this drill safe to run. Safety comes from the client-side page.route mock applied in
  // runLocalDrill() regardless of what this reports, per the project's Paid API Cost Truth Rule (never
  // trust a server-reported flag as a spend guarantee when a client-side mock can guarantee $0 directly).
  //
  // "live cross-device" (a real shared-state backend two devices could race against, e.g. an
  // authenticated Firestore-backed session both contexts join) is a SEPARATE axis from
  // "server has live AI keys configured" - this endpoint has no signal for the former yet (that needs
  // a login/session probe once real multi-device accounts exist on a deployed target), so "live mode"
  // below is never auto-detected; it is only ever reported as not-yet-implemented.
  const res = await fetch(new URL("/api/ai-lookup", base), { method: "GET" });
  if (!res.ok) {
    return { serverE2e: null, serverKeysConfigured: null, reason: `GET /api/ai-lookup returned ${res.status}`, raw: null };
  }
  const json = await res.json().catch(() => null);
  if (!json) return { serverE2e: null, serverKeysConfigured: null, reason: "GET /api/ai-lookup returned non-JSON", raw: null };
  const keysConfigured = Array.isArray(json.missingKeys) && json.missingKeys.length === 0;
  return {
    serverE2e: json.e2e === true,
    serverKeysConfigured: keysConfigured,
    reason: `GET /api/ai-lookup reports e2e:${json.e2e}, missingKeys:${JSON.stringify(json.missingKeys)} (informational only - client-side route mock is what guarantees $0 spend, see runLocalDrill)`,
    raw: json,
  };
}

async function feedCount(page) {
  const txt = (await page.textContent("body").catch(() => "")) || "";
  const m = txt.match(/(\d+)\s+scans/);
  return m ? Number(m[1]) : null;
}

async function totalQty(page) {
  // Sum every qty-<productId> cell in the final-count table (the session's counted total).
  return page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll('[data-testid^="qty-"]'));
    return cells.reduce((sum, el) => sum + (Number(el.textContent?.trim() || "0") || 0), 0);
  });
}

async function scanCodes(page, codes, label) {
  const input = page.getByTestId("scanner-input");
  await input.click({ timeout: 15000 });
  const before = (await feedCount(page)) ?? 0;
  for (const code of codes) {
    await input.fill(code);
    await input.press("Enter");
    await page.waitForTimeout(120);
  }
  // Drain: wait until the feed count stops moving (short quiet window; these are known/cached codes
  // so no live decode latency is expected).
  let last = -1;
  for (let i = 0; i < 30; i++) {
    const now = (await feedCount(page)) ?? 0;
    if (now === last && now >= before + codes.length) break;
    last = now;
    await page.waitForTimeout(300);
  }
  const after = (await feedCount(page)) ?? 0;
  log(`  [${label}] scanned ${codes.length} codes: feed ${before} -> ${after}`);
  return { before, after, registered: after - before };
}

/**
 * Local race drill run inside ONE browser context (one "device"), proving the count law across
 * scan -> delete -> undo -> reload. Returns a result object; never throws on an assertion failure -
 * failures are recorded so the script can report a clear PASS/FAIL per device without crashing the
 * other device's run.
 */
async function runLocalDrill(context, label, codes) {
  // COST SAFETY (Paid API Cost Truth Rule): force-mock /api/ai-lookup for THIS context regardless of
  // what the target server reports. GET returns a static "AI off" status (mirrors NO_AI_STATUS in
  // e2e/count-always.spec.ts) so the app's own UI shows AI disabled; any POST (a real decode attempt)
  // is answered with an empty json and never allowed to reach the real network / real provider. This
  // makes the drill $0 even against a preview deployed with live, configured provider keys.
  await context.route("**/api/ai-lookup", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        json: {
          liveEnabled: false, autoDecodeOnScan: false, geminiEnabled: false, openaiEnabled: false,
          geminiConfigured: false, openaiConfigured: false, premiumFallback: false, mode: "off",
          dailyLimit: 200, missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"], e2e: true,
        },
      });
    }
    return route.fulfill({ json: {} }); // any POST (decode attempt) must never reach the real network
  });

  const page = await context.newPage();
  const result = { label, checks: [], screenshots: [] };
  const record = (name, pass, detail) => {
    result.checks.push({ name, pass, detail });
    log(`  [${label}] ${pass ? "PASS" : "FAIL"}: ${name}${detail ? " - " + detail : ""}`);
  };

  try {
    // ---- Step 1: scan N codes, assert feed N / count N (TOP-LEVEL LAW: every scan appears + counts) ----
    await page.goto(`${BASE}/scan`, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(1000);

    const { before, after, registered } = await scanCodes(page, codes, label);
    record("scan N = feed count N", registered === codes.length, `expected +${codes.length}, got +${registered} (before=${before}, after=${after})`);

    const qtyAfterScan = await totalQty(page);
    record("total counted qty >= scans registered", qtyAfterScan >= registered, `qty=${qtyAfterScan}, registered=${registered}`);

    await page.screenshot({ path: path.join(OUT, `cross-device-${label}-01-scanned.png`), fullPage: true });
    result.screenshots.push(`cross-device-${label}-01-scanned.png`);

    // ---- Step 2: go to /products, delete the first counted product, assert transfer (qty preserved) ----
    await page.goto(`${BASE}/products`, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(1000);

    const body = page.getByTestId("products-body");
    const rows = body.locator('tr[data-testid^="product-row-"]');
    const rowCount = await rows.count().catch(() => 0);
    if (rowCount === 0) {
      record("delete-transfer drill reachable", false, "no product rows found on /products - skipping delete/undo checks");
    } else {
      page.once("dialog", (d) => d.accept()); // plain-language confirm on delete
      const firstDeleteBtn = page.locator('[data-testid^="delete-product-"]').first();
      const hasDeleteBtn = (await firstDeleteBtn.count().catch(() => 0)) > 0;

      if (!hasDeleteBtn) {
        record("delete-transfer drill reachable", false, "no delete-product-* button rendered (SHOW_ADVANCED_ACTIONS gate or role); count-preservation not exercised this run");
      } else {
        const testid = await firstDeleteBtn.getAttribute("data-testid");
        const productId = (testid ?? "").replace("delete-product-", "");

        // Go back to /scan to read the pre-delete total qty (products page has no qty column).
        await page.goto(`${BASE}/scan`, { waitUntil: "networkidle", timeout: 60000 });
        await page.waitForTimeout(500);
        const qtyBeforeDelete = await totalQty(page);

        await page.goto(`${BASE}/products`, { waitUntil: "networkidle", timeout: 60000 });
        await page.waitForTimeout(500);
        page.once("dialog", (d) => d.accept());
        await page.locator(`[data-testid="delete-product-${productId}"]`).click();

        await page.waitForTimeout(800);
        const rowGone = await page.getByTestId(`product-row-${productId}`).count();
        record("deleted row disappears from /products", rowGone === 0, `remaining rows with this id: ${rowGone}`);
        const bannerVisible = await page.getByTestId("undo-delete-banner").isVisible().catch(() => false);
        record("undo-delete-banner appears after delete", bannerVisible);
        await page.screenshot({ path: path.join(OUT, `cross-device-${label}-02-deleted.png`), fullPage: true });
        result.screenshots.push(`cross-device-${label}-02-deleted.png`);

        // Count law: deleting must TRANSFER quantity onto a minted "Unidentified item" provisional,
        // never drop it (src/stores/scanStore.ts deleteProductsInternal, ~line 6415-6520).
        await page.goto(`${BASE}/scan`, { waitUntil: "networkidle", timeout: 60000 });
        await page.waitForTimeout(500);
        const qtyAfterDelete = await totalQty(page);
        record(
          "delete transfers qty (total unchanged, never vanishes)",
          qtyAfterDelete === qtyBeforeDelete,
          `before=${qtyBeforeDelete}, after=${qtyAfterDelete}`,
        );

        // ---- Step 3: undo the delete, assert exact restoration ----
        await page.goto(`${BASE}/products`, { waitUntil: "networkidle", timeout: 60000 });
        await page.waitForTimeout(500);
        const undoBtn = page.getByTestId("undo-delete");
        const canUndo = await undoBtn.isVisible().catch(() => false);
        if (canUndo) {
          await undoBtn.click();
          await page.waitForTimeout(800);
          const restored = await page.getByTestId(`product-row-${productId}`).count();
          record("undo restores the deleted row", restored === 1, `rows found: ${restored}`);
          await page.screenshot({ path: path.join(OUT, `cross-device-${label}-03-undone.png`), fullPage: true });
          result.screenshots.push(`cross-device-${label}-03-undone.png`);

          await page.goto(`${BASE}/scan`, { waitUntil: "networkidle", timeout: 60000 });
          await page.waitForTimeout(500);
          const qtyAfterUndo = await totalQty(page);
          record("undo restores exact pre-delete total qty", qtyAfterUndo === qtyBeforeDelete, `before=${qtyBeforeDelete}, afterUndo=${qtyAfterUndo}`);
        } else {
          record("undo restores the deleted row", false, "undo-delete button not visible; cannot verify restoration");
        }
      }
    }

    // ---- Step 4: reload, assert persistence (feed + totals survive a refresh) ----
    await page.goto(`${BASE}/scan`, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(500);
    const qtyBeforeReload = await totalQty(page);
    const feedBeforeReload = (await feedCount(page)) ?? 0;
    await page.reload({ waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(1000);
    const qtyAfterReload = await totalQty(page);
    const feedAfterReload = (await feedCount(page)) ?? 0;
    record("reload preserves total qty", qtyAfterReload === qtyBeforeReload, `before=${qtyBeforeReload}, after=${qtyAfterReload}`);
    record("reload preserves feed count", feedAfterReload === feedBeforeReload, `before=${feedBeforeReload}, after=${feedAfterReload}`);
    await page.screenshot({ path: path.join(OUT, `cross-device-${label}-04-reloaded.png`), fullPage: true });
    result.screenshots.push(`cross-device-${label}-04-reloaded.png`);
  } catch (err) {
    record("drill completed without a thrown error", false, String(err?.message || err));
  } finally {
    await page.close().catch(() => {});
  }

  result.allPass = result.checks.every((c) => c.pass);
  return result;
}

async function main() {
  log(`Target: ${BASE}`);
  const detection = await detectBackendMode(BASE);
  log(`Server-reported status (informational only): ${detection.reason}`);

  // NOTE on "live mode": a true cross-device scenario needs a real cloud backend where two devices
  // share state through an authenticated account (A scans+syncs, B refreshes and sees it, B deletes,
  // A refreshes and asserts no inflation). No such target - independent of whether the server has live
  // AI keys configured - currently exists to test against (this repo's previews are all single-context,
  // no-login or open-demo, with each browser context's localStorage fully isolated). So this script has
  // exactly one implemented scenario today: the LOCAL race drill below, run once per "device" (browser
  // context), always under a client-side ai-lookup route mock so it costs $0 regardless of the target's
  // real configuration. If a genuine shared-backend target becomes available, extend this script with a
  // real cross-device branch instead of relabeling this one - do not claim cross-device proof here.
  const browser = await chromium.launch({ headless: true });
  const summary = {
    base: BASE,
    startedAt: new Date().toISOString(),
    serverReportedE2e: detection.serverE2e,
    serverKeysConfigured: detection.serverKeysConfigured,
    detectionReason: detection.reason,
    crossDeviceScenario: "NOT_IMPLEMENTED (no shared-state backend target available; see script header)",
  };

  log("Running the LOCAL race drill independently in two isolated browser contexts (each force-mocked to $0 AI spend).");
  log("LABEL: local-only drill (mock backend) - NOT a cross-device proof (no shared state exists to race against with any target available today).");

  const [ctxA, ctxB] = await Promise.all([browser.newContext(), browser.newContext()]);
  const codesA = CODES.slice(0, 6);
  const codesB = CODES.slice(6, 12);

  const [resultA, resultB] = await Promise.all([
    runLocalDrill(ctxA, "deviceA", codesA),
    runLocalDrill(ctxB, "deviceB", codesB),
  ]);

  await Promise.all([ctxA.close(), ctxB.close()]);
  await browser.close();

  summary.mode = "local-only drill (mock backend)";
  summary.deviceA = resultA;
  summary.deviceB = resultB;
  summary.overallPass = resultA.allPass && resultB.allPass;
  summary.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, "cross-device-summary.json"), JSON.stringify(summary, null, 2));

  console.log("\n================= RESULT: local-only drill (mock backend) =================");
  console.log(`Base URL: ${BASE}`);
  console.log(`Server-reported status (informational only, not a safety signal): ${detection.reason}`);
  for (const r of [resultA, resultB]) {
    console.log(`\nDevice ${r.label}:`);
    for (const c of r.checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}: ${c.name}${c.detail ? " - " + c.detail : ""}`);
  }
  console.log(`\nOverall: ${summary.overallPass ? "PASS" : "FAIL"}`);
  console.log("IMPORTANT: this run exercised the count law LOCALLY in two isolated devices, one at a time");
  console.log("in parallel. It did NOT exercise a real cross-device race (no shared backend exists on this");
  console.log("preview). Re-run against a live/cloud-backed deployment once one exists for the real drill.");
  console.log(`\nArtifacts written to: ${OUT}`);
  console.log("  cross-device-summary.json, cross-device-deviceA-*.png, cross-device-deviceB-*.png");

  if (!summary.overallPass) process.exitCode = 1;
}

main().catch((err) => {
  console.error("DRILL CRASHED:", err);
  process.exitCode = 1;
});
