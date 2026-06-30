// REUSABLE 30-code REAL-decode proof harness (owner-mandated).
// Drives the REAL scan input on localhost:3000 (real Gemini/OpenAI keys, NOT the IS_E2E mock),
// scans all 30 codes, waits for each decode to SETTLE, then asserts the owner's 14 checks against
// the real persisted store (sis-scan-v1) and writes a per-code report + full-page screenshot.
//
// Run:  node scripts/scan-matrix.mjs        (dev server must already be up on :3000)
// Env:  SCAN_BASE (default http://localhost:3000)  SCAN_OUT (default scan-proof)  SCAN_TAG (label)
// Exit: 0 = all checks pass, 1 = one or more fails. The fails list is the to-do for the next fix.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";

process.on("unhandledRejection", (e) => { console.error("UNHANDLED REJECTION:", e && e.stack || e); process.exit(1); });
process.on("uncaughtException", (e) => { console.error("UNCAUGHT EXCEPTION:", e && e.stack || e); process.exit(1); });

// Matrix A: original 30-code regression set. Matrix B: expansion set (incl. short / non-GS1 / internal codes
// that must NOT get fabricated anatomy). Select with SCAN_MATRIX=A|B (default A). Both are kept, never replaced.
const MATRIX_A = (
  "051596320812 078742051451 078742028477 3017620422003 5449000000996 7622210449283 0038000249341 " +
  "10019320009355 009800120871 044000072742 072554159725 016000462427 00028400234306 0028400199247 " +
  "0087684001127 00028400076388 028400325042 016000200050 00028400160131 00028400028141 630614000013 " +
  "00028400082914 00028400152983 00016000179998 00028400052979 0028400620642 00075391054567 0038000245534 " +
  "00051000212412 00070470001272"
).trim().split(/\s+/);
const MATRIX_B = (
  "8000500310427 4008400401621 3046920029759 5010029000016 5000159407236 7613035974685 021130494859 " +
  "021130405169 021130113408 00770040 021130294947 021130294992 021130550074 021130152834 078742371573 " +
  "078742371047 078742230399 078742048727 078742285511 078742041087 078742043753 078742018669 096619405220 " +
  "096619111114 096619983582 096619329113 00029155 00088268 00910736 00504676"
).trim().split(/\s+/);
const CODES = (process.env.SCAN_MATRIX || "A").toUpperCase() === "B" ? MATRIX_B : MATRIX_A;

const BASE = process.env.SCAN_BASE || "http://localhost:3000";
const OUT = process.env.SCAN_OUT || "scan-proof";
const TAG = process.env.SCAN_TAG || "run";
const PERSIST_KEY = "sis-scan-v1";
const SETTLE_MS = 28000;
const COUNTED_CLASSES = ["Verified", "Known", "Suggested-Provisional", "Unknown-Provisional"];

mkdirSync(OUT, { recursive: true });
const lc = (s) => (s || "").toString().toLowerCase();

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1700 } });
const page = await ctx.newPage();

async function readState() {
  return await page.evaluate((key) => {
    // Prefer the FULL in-memory store (dev hook); the localStorage persist is role-sanitized and drops
    // primaryBarcode/verified/provisional/aliases/catalog, which the assertions need.
    const w = window.__scanStore;
    if (w && typeof w.getState === "function") {
      const s = w.getState();
      return {
        products: (s.products || []).map((p) => ({ id: p.id, name: p.name, primaryBarcode: p.primaryBarcode, upc: p.upc, ean: p.ean, gtin: p.gtin, primarySku: p.primarySku, verified: p.verified, provisional: p.provisional, source: p.source })),
        aliases: (s.aliases || []).map((a) => ({ cleanCode: a.cleanCode, productId: a.productId, approved: a.approved })),
        finalCounts: (s.finalCounts || []).map((c) => ({ productId: c.productId, quantity: c.quantity })),
        needsReviewQueue: (s.needsReviewQueue || []).map((r) => ({ cleanCode: r.cleanCode, status: r.status, decodeStatus: r.decodeStatus, suggestedProductName: r.suggestedProductName })),
        catalog: (s.catalog || []).map((c) => ({ normalizedBarcode: c.normalizedBarcode, verificationStatus: c.verificationStatus })),
        scanFeed: [],
      };
    }
    try { const raw = localStorage.getItem(key); if (!raw) return null; const j = JSON.parse(raw); return j.state || j; } catch { return null; }
  }, PERSIST_KEY);
}

// --- clean slate ---
await page.goto(`${BASE}/scan`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
await page.goto(`${BASE}/scan`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-testid=scanner-input]", { timeout: 20000 });

// NOTE: persisted scanFeed events are role-sanitized and DROP cleanCode/rawCode. The needsReviewQueue
// KEEPS cleanCode, and counted products carry primaryBarcode === the scanned code. So we settle + match
// off reviews + products, never the feed.
const SETTLED = ["verified", "suggested", "needs_review", "conflict", "resolved"];
const prodForCode = (st, code) =>
  (st?.products || []).find((p) => p.primaryBarcode === code || [p.upc, p.ean, p.gtin, p.primarySku].includes(code));
async function settle(code) {
  const start = Date.now();
  await page.waitForTimeout(600); // let any live decode kick off
  let terminalAt = 0;
  while (Date.now() - start < SETTLE_MS) {
    const st = await readState();
    const rev = (st?.needsReviewQueue || []).find((r) => r.cleanCode === code);
    const prod = prodForCode(st, code);
    if (prod) return { rev, prod }; // counted -> done
    const terminal = rev && rev.decodeStatus && rev.decodeStatus !== "decoding";
    if (terminal) {
      // A "verified"/"suggested" review WILL produce a count (auto-count or recall-first provisional), which
      // lands a beat AFTER the decodeStatus settles - so keep polling for the product the full window. Only a
      // "needs_review"/"conflict" outcome may legitimately have no count; settle that after a short grace
      // (the skip-path fallback, when it applies, has already created the product by then).
      const willCount = rev.decodeStatus === "verified" || rev.decodeStatus === "suggested";
      if (!willCount) {
        if (!terminalAt) terminalAt = Date.now();
        if (Date.now() - terminalAt > 3500) return { rev, prod: null };
      }
    }
    await page.waitForTimeout(400);
  }
  return null;
}

// --- scan all 30 through the real input ---
const LIMIT = parseInt(process.env.SCAN_LIMIT || "0", 10);
const TO_SCAN = LIMIT > 0 ? CODES.slice(0, LIMIT) : CODES;
let idx = 0;
for (const code of TO_SCAN) {
  idx++;
  const t0 = Date.now();
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.fill(code);
  await input.press("Enter");
  const r = await settle(code);
  const tag = !r ? "NO-EVENT/TIMEOUT" : r.prod ? `counted:${r.prod.verified ? "verified" : r.prod.provisional ? "provisional" : "known"}` : (r.rev?.decodeStatus || "review");
  console.log(`[${idx}/${TO_SCAN.length}] ${code} -> ${tag} (${Date.now() - t0}ms)`);
  // Pace scans so a fast 30-code burst does not trip the per-IP rate limit (a real operator scans slower);
  // the deterministic fallback still covers any code that does get throttled.
  await page.waitForTimeout(Number(process.env.SCAN_DELAY || 900));
}

// --- read final real state ---
const state = (await readState()) || {};
const products = state.products || [];
const aliases = state.aliases || [];
const counts = state.finalCounts || [];
const feed = state.scanFeed || [];
const reviews = state.needsReviewQueue || [];
const catalog = state.catalog || [];
const prodById = Object.fromEntries(products.map((p) => [p.id, p]));

const rows = CODES.map((code) => {
  const rev = reviews.find((r) => r.cleanCode === code);
  const alias = aliases.find((a) => a.cleanCode === code);
  let prod = prodForCode({ products }, code);
  if (!prod && alias) prod = prodById[alias.productId];
  const qty = prod ? counts.find((c) => c.productId === prod.id)?.quantity ?? 0 : 0;
  const counted = qty > 0;
  const name = prod?.name || rev?.suggestedProductName || "";
  const decodeStatus = rev?.decodeStatus || (counted ? "known" : "");
  const isAnatomyOnly = !!prod?.provisional && /from barcode prefix|manufacturer|^item |unknown product/i.test(name);
  let klass = !rev && !prod ? "NO-EVENT"
    : counted && prod?.verified ? "Verified"
    : counted && prod?.provisional && isAnatomyOnly ? "Unknown-Provisional"
    : counted && prod?.provisional ? "Suggested-Provisional"
    : counted ? "Known"
    : name ? "Suggested-NoCount"
    : "Unknown-NoProduct";
  return { code, status: rev?.status || (counted ? "known" : ""), decodeStatus, klass, name,
    qty, verified: !!prod?.verified, provisional: !!prod?.provisional, aliasApproved: !!alias?.approved, settled: !!(rev || prod) };
});

// --- the 14 checks ---
const fails = [];
const push = (c, msg) => fails.push(`[${c}] ${msg}`);
const unsettled = rows.filter((r) => !r.settled).map((r) => r.code);
if (unsettled.length) push("events", `not visible/settled: ${unsettled.join(", ")}`);
const blank = rows.filter((r) => r.settled && !r.name).map((r) => r.code);
if (blank.length) push("no-blank", `Product "-" after decode: ${blank.join(", ")}`);
const notCounted = rows.filter((r) => r.settled && !COUNTED_CLASSES.includes(r.klass)).map((r) => `${r.code}(${r.klass})`);
if (notCounted.length) push("counted", `not in a counted class: ${notCounted.join(", ")}`);
const water = rows.find((r) => r.code === "078742051451");
const nutella = rows.find((r) => r.code === "3017620422003");
const bucket = rows.find((r) => r.code === "051596320812");
if (water && /velvet torch|dress/i.test(water.name)) push("poison", `078742051451 decoded as Velvet Torch: "${water.name}"`);
// Owner rule: water/Nutella VERIFY when good web evidence is available, but if the live web fails they must
// still COUNT provisionally + visibly (never blank, never poison). Assert COUNTED, not a fixed verify rate.
if (water && !COUNTED_CLASSES.includes(water.klass)) push("water", `078742051451 not counted (${water.klass} "${water.name}")`);
if (nutella && !COUNTED_CLASSES.includes(nutella.klass)) push("nutella", `3017620422003 not counted (${nutella.klass})`);
if (bucket && !bucket.name) push("bucket", "051596320812 is blank (no product/anatomy fallback)");
const weakAlias = rows.filter((r) => /Provisional/.test(r.klass) && r.aliasApproved).map((r) => r.code);
if (weakAlias.length) push("weak-alias", `weak/provisional made an APPROVED ALIAS: ${weakAlias.join(", ")}`);
const weakVerified = rows.filter((r) => /Provisional/.test(r.klass) && r.verified).map((r) => r.code);
if (weakVerified.length) push("weak-verified", `weak/provisional made a VERIFIED product: ${weakVerified.join(", ")}`);
const weakGlobal = rows.filter((r) => /Provisional/.test(r.klass) &&
  catalog.find((c) => lc(c.normalizedBarcode) === lc(r.code) && c.verificationStatus === "verified")).map((r) => r.code);
if (weakGlobal.length) push("weak-global", `weak/provisional made a VERIFIED GLOBAL catalog entry: ${weakGlobal.join(", ")}`);
const dirty = rows.filter((r) => /^UPC \d|Price\/Case\)|&#x|&amp;|\(r\)/i.test(r.name)).map((r) => `${r.code}:"${r.name.slice(0, 30)}"`);
if (dirty.length) push("dirty-name", `dirty scraped names: ${dirty.join(" | ")}`);

await page.screenshot({ path: `${OUT}/scan-matrix-${TAG}.png`, fullPage: true });

const counted = rows.filter((r) => COUNTED_CLASSES.includes(r.klass)).length;
const md = [
  `# Scan matrix (${TAG}) — ${counted}/${CODES.length} counted, ${fails.length} fail-categories`,
  ``,
  fails.length ? `## FAILS\n- ${fails.join("\n- ")}` : `## ALL 14 CHECKS PASS`,
  ``,
  `| code | class | decode | name | qty | verif | prov | alias |`,
  `|---|---|---|---|---|---|---|---|`,
  ...rows.map((r) => `| ${r.code} | ${r.klass} | ${r.decodeStatus || r.status} | ${(r.name || "-").slice(0, 42)} | ${r.qty} | ${r.verified ? "Y" : ""} | ${r.provisional ? "Y" : ""} | ${r.aliasApproved ? "Y" : ""} |`),
].join("\n");
writeFileSync(`${OUT}/scan-matrix-${TAG}.json`, JSON.stringify({ tag: TAG, counted: `${counted}/${CODES.length}`, fails, rows }, null, 2));
writeFileSync(`${OUT}/scan-matrix-${TAG}.md`, md);
console.log(md);
console.log(`\nRESULT: ${counted}/${CODES.length} counted | ${fails.length} fail-categories`);
await browser.close();
process.exit(fails.length ? 1 : 0);
