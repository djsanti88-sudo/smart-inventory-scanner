#!/usr/bin/env node
// Barcode Harvester — scrapes tire barcodes from retailer websites.
// Usage: node scripts/barcode-harvester/engine.mjs --site discount-tire [--dry-run] [--max-pages N] [--resume] [--headless false]

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { normBarcode, normText, validCheckDigit } from "../corpusRules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SITES_DIR = join(__dirname, "sites");
const OUTPUT_DIR = join(__dirname, "output");
const TIRE_INDEX = join(ROOT, "src", "decoding", "server", "knowledge", "tire", "tireKnowledge.generated.json");

// --- CLI args ---
function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; };
  const has = (name) => args.includes(`--${name}`);
  const site = get("site");
  if (!site) { console.error("Usage: node engine.mjs --site <name> [--dry-run] [--max-pages N] [--resume] [--headless false]"); process.exit(1); }
  return {
    site,
    dryRun: has("dry-run"),
    maxPages: Number(get("max-pages", "0")) || 0,
    resume: has("resume"),
    headless: get("headless", "true") !== "false",
  };
}

// --- Load known barcodes for dedup ---
function loadKnownBarcodes() {
  const known = new Set();

  // 1. Existing corpus
  if (existsSync(TIRE_INDEX)) {
    try {
      const idx = JSON.parse(readFileSync(TIRE_INDEX, "utf8"));
      for (const key of Object.keys(idx.barcodeIndex || {})) known.add(normBarcode(key));
      console.log(`[harvester] Loaded ${known.size} known barcodes from tire corpus`);
    } catch (e) { console.warn("[harvester] Could not load tire index:", e.message); }
  }

  // 2. Previous harvest outputs
  if (existsSync(OUTPUT_DIR)) {
    for (const f of readdirSync(OUTPUT_DIR).filter(f => f.endsWith(".csv"))) {
      const lines = readFileSync(join(OUTPUT_DIR, f), "utf8").split("\n").slice(1);
      for (const line of lines) {
        const barcode = line.split(",")[12];
        if (barcode) known.add(normBarcode(barcode));
      }
    }
  }

  return known;
}

// --- Load site config + optional extractor ---
async function loadSiteConfig(name) {
  const configPath = join(SITES_DIR, `${name}.json`);
  if (!existsSync(configPath)) { console.error(`[harvester] Site config not found: ${configPath}`); process.exit(1); }
  const config = JSON.parse(readFileSync(configPath, "utf8"));

  let extractor = null;
  if (config.extractor) {
    const extractorPath = join(SITES_DIR, config.extractor);
    if (existsSync(extractorPath)) {
      extractor = await import(pathToFileURL(extractorPath).href);
      console.log(`[harvester] Loaded custom extractor: ${config.extractor}`);
    }
  }

  return { config, extractor };
}

// --- CSV output ---
const CSV_HEADER = "canonical_product_uid,brand,brand_normalized,model,model_normalized,size,raw_size_text,load_index,speed_rating,load_range,type,season,barcode,barcode_type,check_digit_valid,manufacturer_part_number,retailer_sku,confidence,current_status,usable_for,second_source_match,cross_checked,source_url,field_completeness_score,missing_fields,source_count";

function productToCsvRow(p) {
  const uid = [normText(p.brand), normText(p.model), normText(p.size)].filter(Boolean).join("-").replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const bn = normText(p.brand);
  const mn = normText(p.model);
  const barcodeType = p.barcode.length === 12 ? "upc_a" : p.barcode.length === 13 ? "ean_13" : p.barcode.length === 14 ? "gtin_14" : "upc_a";
  const missingFields = [!p.loadIndex && "load_index", !p.speedRating && "speed_rating", !p.loadRange && "load_range", !p.type && "type", !p.season && "season"].filter(Boolean).join(";");
  const completeness = (([p.brand, p.model, p.size, p.loadIndex, p.speedRating].filter(Boolean).length / 5) * 1.0).toFixed(1);
  const fields = [
    uid, p.brand, bn, p.model, mn, p.size, p.rawSizeText || p.size,
    p.loadIndex || "", p.speedRating || "", p.loadRange || "",
    p.type || "", p.season || "",
    p.barcode, barcodeType, "yes",
    p.partNumber || "", "",
    "verified_1src_strong", "active_retail", "auto_count_candidate",
    "", "", p.sourceUrl || "",
    completeness, missingFields, "1",
  ];
  return fields.map(f => String(f).includes(",") ? `"${f}"` : f).join(",");
}

// --- Default CSS-based extraction ---
async function extractWithSelectors(page, config) {
  const sel = config.product;
  const text = async (selector) => {
    try { return (await page.locator(selector).first().textContent({ timeout: 3000 }))?.trim() || ""; }
    catch { return ""; }
  };
  const barcode = await text(sel.barcodeSelector);
  if (!barcode) return null;
  return {
    barcode: normBarcode(barcode),
    brand: await text(sel.brandSelector),
    model: await text(sel.modelSelector),
    size: await text(sel.sizeSelector),
    rawSizeText: await text(sel.sizeSelector),
    loadIndex: "", speedRating: "", loadRange: "", type: "", season: "",
    partNumber: "", sourceUrl: page.url(),
  };
}

// --- Default CSS-based discovery ---
async function discoverWithSelectors(page, config) {
  const urls = new Set();
  const sel = config.catalog;
  const links = await page.locator(sel.productLinkSelector).all();
  for (const link of links) {
    const href = await link.getAttribute("href");
    if (href) urls.add(href.startsWith("http") ? href : `${config.baseUrl}${href}`);
  }
  return [...urls];
}

// --- Main ---
async function main() {
  const opts = parseArgs();
  const { config, extractor } = await loadSiteConfig(opts.site);
  const knownBarcodes = loadKnownBarcodes();
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = join(OUTPUT_DIR, `${opts.site}-${timestamp}.csv`);
  writeFileSync(outPath, CSV_HEADER + "\n");

  const stats = { pagesVisited: 0, newBarcodes: 0, skippedDuplicate: 0, skippedInvalid: 0, errors: 0, consecutiveErrors: 0 };

  console.log(`[harvester] Starting ${opts.site} | dry-run: ${opts.dryRun} | max-pages: ${opts.maxPages || "unlimited"} | resume: ${opts.resume}`);

  const browser = await chromium.launch({ headless: opts.headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Phase 1: Discover product URLs
    console.log("[harvester] Phase 1: Discovering product URLs...");
    let productUrls;
    if (extractor?.discoverProducts) {
      productUrls = await extractor.discoverProducts(page, config);
    } else {
      await page.goto(`${config.baseUrl}${config.catalog.brandListUrl}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);
      productUrls = await discoverWithSelectors(page, config);
    }
    console.log(`[harvester] Discovered ${productUrls.length} product URLs`);

    if (opts.dryRun) {
      console.log("[harvester] Dry run -- not visiting product pages.");
      for (const url of productUrls.slice(0, 20)) console.log(`  ${url}`);
      if (productUrls.length > 20) console.log(`  ... and ${productUrls.length - 20} more`);
      await browser.close();
      return;
    }

    // Load resume set
    const resumeSet = new Set();
    if (opts.resume && existsSync(outPath)) {
      const lines = readFileSync(outPath, "utf8").split("\n").slice(1);
      for (const line of lines) {
        const barcode = line.split(",")[12];
        if (barcode) resumeSet.add(normBarcode(barcode));
      }
      console.log(`[harvester] Resume: ${resumeSet.size} barcodes already in output`);
    }

    // Phase 2: Extract from each product page
    console.log("[harvester] Phase 2: Extracting barcodes...");
    const limit = opts.maxPages > 0 ? Math.min(opts.maxPages, productUrls.length) : productUrls.length;

    for (let i = 0; i < limit; i++) {
      const url = productUrls[i];

      if (stats.consecutiveErrors >= config.pacing.maxConsecutiveErrors) {
        console.error(`[harvester] ${stats.consecutiveErrors} consecutive errors -- stopping (possible bot detection)`);
        break;
      }

      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.waitForTimeout(1000);
        stats.pagesVisited++;

        let product;
        if (extractor?.extractProduct) {
          product = await extractor.extractProduct(page, url, config);
        } else {
          product = await extractWithSelectors(page, config);
        }

        if (!product || !product.barcode) {
          stats.errors++;
          stats.consecutiveErrors++;
          continue;
        }

        const barcode = normBarcode(product.barcode);

        // Dedup
        if (knownBarcodes.has(barcode) || resumeSet.has(barcode)) {
          stats.skippedDuplicate++;
          stats.consecutiveErrors = 0;
          if (stats.pagesVisited % 50 === 0) console.log(`[harvester] Progress: ${stats.pagesVisited}/${limit} pages, ${stats.newBarcodes} new, ${stats.skippedDuplicate} skipped`);
          await page.waitForTimeout(config.pacing.interPageDelayMs);
          continue;
        }

        // Validate check digit
        const barcodeType = barcode.length === 12 ? "upc_a" : barcode.length === 13 ? "ean_13" : barcode.length === 14 ? "gtin_14" : null;
        if (!validCheckDigit(barcode, barcodeType)) {
          console.log(`[harvester] SKIP (invalid check digit): ${barcode}`);
          stats.skippedInvalid++;
          stats.consecutiveErrors = 0;
          await page.waitForTimeout(config.pacing.interPageDelayMs);
          continue;
        }

        // Write to CSV
        product.barcode = barcode;
        appendFileSync(outPath, productToCsvRow(product) + "\n");
        knownBarcodes.add(barcode);
        stats.newBarcodes++;
        stats.consecutiveErrors = 0;

        if (stats.newBarcodes % 10 === 0 || stats.pagesVisited % 50 === 0) {
          console.log(`[harvester] Progress: ${stats.pagesVisited}/${limit} pages, ${stats.newBarcodes} new, ${stats.skippedDuplicate} skipped`);
        }
      } catch (e) {
        stats.errors++;
        stats.consecutiveErrors++;
        if (stats.consecutiveErrors <= 3) console.warn(`[harvester] Error on ${url}: ${e.message}`);
      }

      await page.waitForTimeout(config.pacing.interPageDelayMs);
    }
  } finally {
    await browser.close();
  }

  // Summary
  console.log(`\n[harvester] === SUMMARY ===`);
  console.log(`[harvester] Site: ${opts.site}`);
  console.log(`[harvester] Pages visited: ${stats.pagesVisited}`);
  console.log(`[harvester] New barcodes: ${stats.newBarcodes}`);
  console.log(`[harvester] Skipped (duplicate): ${stats.skippedDuplicate}`);
  console.log(`[harvester] Skipped (invalid): ${stats.skippedInvalid}`);
  console.log(`[harvester] Errors: ${stats.errors}`);
  console.log(`[harvester] Output: ${outPath}`);

  if (stats.newBarcodes > 0) {
    console.log(`\n[harvester] Next steps:`);
    console.log(`  1. Review: head -20 ${outPath}`);
    console.log(`  2. Copy to seed: cp ${outPath} src/decoding/server/knowledge/tire/seed/`);
    console.log(`  3. Rebuild index: node scripts/build-tire-knowledge.mjs`);
    console.log(`  4. Rebuild SQLite: node scripts/build-knowledge-db.mjs`);
  }
}

main().catch(e => { console.error("[harvester] Fatal:", e); process.exit(1); });
