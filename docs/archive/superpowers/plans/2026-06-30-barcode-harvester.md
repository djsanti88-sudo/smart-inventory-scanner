# Barcode Harvester Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable Playwright-based barcode harvester that scrapes tire product data from retailer websites, deduplicates against the existing 76K corpus, and outputs net-new barcodes in the corpus CSV format.

**Architecture:** A core engine (`engine.mjs`) reads a per-site JSON config + optional custom extractor `.mjs`. Playwright drives a headless browser through catalog pages, extracts barcodes + specs, validates with GS1 check digit, deduplicates against the loaded corpus, and writes net-new entries to a timestamped CSV. The CSV feeds directly into the existing `build-tire-knowledge.mjs` pipeline.

**Tech Stack:** Node.js ESM, Playwright (already installed), `corpusRules.mjs` (existing check digit + normalization)

## Global Constraints

- All scripts are ESM (`.mjs`, `import` syntax)
- Reuse `corpusRules.mjs` for `validCheckDigit()`, `normBarcode()`, `normText()`
- Output CSV must match `tire_corpus_seed.csv` column schema exactly
- Serial crawling only, 2s delay between pages, 5s between brands
- No paid APIs, no authentication, no production deployment
- Barcodes with invalid check digits are logged and skipped, never written

---

### Task 1: Core Engine — CLI, Config Loading, Dedup Set

**Files:**
- Create: `scripts/barcode-harvester/engine.mjs`
- Create: `scripts/barcode-harvester/sites/.gitkeep`

**Interfaces:**
- Consumes: `corpusRules.mjs:normBarcode()`, `tireKnowledge.generated.json` (barcode index)
- Produces: `loadKnownBarcodes(): Set<string>`, `loadSiteConfig(name): {config, extractor}`, `parseArgs(): {site, dryRun, maxPages, resume, headless}`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p scripts/barcode-harvester/sites
mkdir -p scripts/barcode-harvester/output
touch scripts/barcode-harvester/sites/.gitkeep
echo "scripts/barcode-harvester/output/*.csv" >> .gitignore
```

- [ ] **Step 2: Write engine.mjs — arg parsing, config loading, dedup set**

Create `scripts/barcode-harvester/engine.mjs`:

```js
#!/usr/bin/env node
// Barcode Harvester — scrapes tire barcodes from retailer websites.
// Usage: node scripts/barcode-harvester/engine.mjs --site discount-tire [--dry-run] [--max-pages N] [--resume] [--headless false]

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { normBarcode, normText, validCheckDigit } from "../corpusRules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SITES_DIR = join(__dirname, "sites");
const OUTPUT_DIR = join(__dirname, "output");
const TIRE_INDEX = join(ROOT, "src", "server", "tire-knowledge", "tireKnowledge.generated.json");

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
      const lines = readFileSync(join(OUTPUT_DIR, f), "utf8").split("\n").slice(1); // skip header
      for (const line of lines) {
        const barcode = line.split(",")[12]; // barcode is column index 12
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
      extractor = await import(extractorPath);
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
      console.log("[harvester] Dry run — not visiting product pages.");
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
        console.error(`[harvester] ${stats.consecutiveErrors} consecutive errors — stopping (possible bot detection)`);
        break;
      }

      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.waitForTimeout(1000); // let JS render
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
    console.log(`  2. Copy to seed: cp ${outPath} src/server/tire-knowledge/seed/`);
    console.log(`  3. Rebuild index: node scripts/build-tire-knowledge.mjs`);
    console.log(`  4. Rebuild SQLite: node scripts/build-knowledge-db.mjs`);
  }
}

main().catch(e => { console.error("[harvester] Fatal:", e); process.exit(1); });
```

- [ ] **Step 3: Verify the engine loads and parses args**

```bash
node scripts/barcode-harvester/engine.mjs
# Expected: "Usage: node engine.mjs --site <name> ..."

node scripts/barcode-harvester/engine.mjs --site nonexistent
# Expected: "Site config not found: .../sites/nonexistent.json"
```

- [ ] **Step 4: Commit**

```bash
git add scripts/barcode-harvester/ .gitignore
git commit -m "feat: barcode harvester engine — CLI, config loading, dedup, CSV output"
```

---

### Task 2: Discount Tire Site Config + Custom Extractor

**Files:**
- Create: `scripts/barcode-harvester/sites/discount-tire.json`
- Create: `scripts/barcode-harvester/sites/discount-tire.mjs`

**Interfaces:**
- Consumes: Playwright `page` object, site config JSON
- Produces: `discoverProducts(page, config): string[]`, `extractProduct(page, url, config): ProductData | null`

**Important note:** Discount Tire is a JavaScript SPA. The exact DOM selectors need to be discovered by visiting the site with a visible browser. The config and extractor below use best-guess selectors that MUST be verified and tuned during the first run with `--headless false --max-pages 5`. This is expected — every new site config requires a manual tuning pass.

- [ ] **Step 1: Create the site config JSON**

Create `scripts/barcode-harvester/sites/discount-tire.json`:

```json
{
  "name": "discount-tire",
  "baseUrl": "https://www.discounttire.com",
  "catalog": {
    "strategy": "brand-list",
    "brandListUrl": "/tires-catalog",
    "brandLinkSelector": "a[href*='/tires/']",
    "productLinkSelector": "a[href*='/buy-tires/']",
    "paginationSelector": "button[aria-label='Next'], [data-testid='pagination-next']",
    "maxPagesPerBrand": 50
  },
  "product": {
    "barcodeSelector": "[data-testid='gtin'], .gtin, .upc-code, .product-upc",
    "brandSelector": ".product-brand, [data-testid='brand-name'], h1",
    "modelSelector": ".product-model, [data-testid='product-name'], h1",
    "sizeSelector": ".tire-size, [data-testid='tire-size'], .product-size",
    "specsSelector": ".product-specs, [data-testid='product-specs'], .tire-details"
  },
  "pacing": {
    "interPageDelayMs": 2500,
    "interBrandDelayMs": 6000,
    "maxConcurrent": 1,
    "maxConsecutiveErrors": 10,
    "respectRobotsTxt": true
  },
  "extractor": "discount-tire.mjs"
}
```

- [ ] **Step 2: Create the custom extractor**

Create `scripts/barcode-harvester/sites/discount-tire.mjs`:

```js
// Custom extractor for Discount Tire (discounttire.com).
// The site is a JavaScript SPA that requires interaction to navigate.
// Selectors below are best-guess and MUST be tuned with --headless false --max-pages 5.

/**
 * Discover product page URLs by navigating the tire catalog.
 * Strategy: iterate through tire brand pages, collect product links.
 */
export async function discoverProducts(page, config) {
  const urls = new Set();
  const baseUrl = config.baseUrl;

  // Navigate to tire catalog
  await page.goto(`${baseUrl}/tires`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  // Try to dismiss any popups/modals
  try {
    const closeBtn = page.locator('[aria-label="Close"], .modal-close, button:has-text("Close"), button:has-text("No thanks")').first();
    if (await closeBtn.isVisible({ timeout: 2000 })) await closeBtn.click();
  } catch { /* no modal */ }

  // Collect brand page links
  const brandLinks = await page.locator('a[href*="/tires/"]').all();
  const brandUrls = [];
  for (const link of brandLinks) {
    const href = await link.getAttribute("href");
    if (href && href.includes("/tires/") && !href.includes("catalog") && !href.includes("#")) {
      const full = href.startsWith("http") ? href : `${baseUrl}${href}`;
      if (!brandUrls.includes(full)) brandUrls.push(full);
    }
  }
  console.log(`[discount-tire] Found ${brandUrls.length} brand pages`);

  // Visit each brand page, collect product links
  for (const brandUrl of brandUrls) {
    try {
      await page.goto(brandUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(2000);

      // Scroll to load dynamic content
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => window.scrollBy(0, 800));
        await page.waitForTimeout(500);
      }

      // Collect product links
      const productLinks = await page.locator('a[href*="/buy-tires/"], a[href*="/p/"]').all();
      for (const link of productLinks) {
        const href = await link.getAttribute("href");
        if (href) {
          const full = href.startsWith("http") ? href : `${baseUrl}${href}`;
          urls.add(full);
        }
      }

      console.log(`[discount-tire] ${brandUrl.split("/").pop()}: ${productLinks.length} products (${urls.size} total)`);

      // Paginate if available
      let pageNum = 0;
      while (pageNum < config.catalog.maxPagesPerBrand) {
        const nextBtn = page.locator(config.catalog.paginationSelector).first();
        if (!(await nextBtn.isVisible({ timeout: 2000 }).catch(() => false))) break;
        await nextBtn.click();
        await page.waitForTimeout(2000);
        pageNum++;

        const moreLinks = await page.locator('a[href*="/buy-tires/"], a[href*="/p/"]').all();
        for (const link of moreLinks) {
          const href = await link.getAttribute("href");
          if (href) urls.add(href.startsWith("http") ? href : `${baseUrl}${href}`);
        }
      }
    } catch (e) {
      console.warn(`[discount-tire] Error on brand page ${brandUrl}: ${e.message}`);
    }

    await page.waitForTimeout(config.pacing.interBrandDelayMs);
  }

  return [...urls];
}

/**
 * Extract barcode + specs from a single product page.
 * Returns null if no barcode found.
 */
export async function extractProduct(page, url, config) {
  await page.waitForTimeout(1500); // let SPA render

  // Try to dismiss any popups
  try {
    const closeBtn = page.locator('[aria-label="Close"], .modal-close').first();
    if (await closeBtn.isVisible({ timeout: 1000 })) await closeBtn.click();
  } catch { /* no modal */ }

  // Extract text helper
  const text = async (...selectors) => {
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1000 })) {
          const t = (await el.textContent())?.trim();
          if (t) return t;
        }
      } catch { /* try next */ }
    }
    return "";
  };

  // Look for barcode/GTIN in the page
  // Strategy: check structured data (JSON-LD), data attributes, visible text
  let barcode = "";

  // 1. Check JSON-LD structured data
  try {
    const jsonLd = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        try {
          const d = JSON.parse(s.textContent);
          if (d.gtin || d.gtin12 || d.gtin13 || d.gtin14) return d.gtin || d.gtin12 || d.gtin13 || d.gtin14;
          if (d.offers?.gtin) return d.offers.gtin;
          if (Array.isArray(d["@graph"])) {
            for (const item of d["@graph"]) {
              if (item.gtin || item.gtin12 || item.gtin13) return item.gtin || item.gtin12 || item.gtin13;
            }
          }
        } catch { /* invalid JSON-LD */ }
      }
      return "";
    });
    if (jsonLd) barcode = String(jsonLd).trim();
  } catch { /* no JSON-LD */ }

  // 2. Check meta tags
  if (!barcode) {
    try {
      barcode = await page.evaluate(() => {
        const meta = document.querySelector('meta[property="product:upc"], meta[name="upc"], meta[itemprop="gtin12"], meta[itemprop="gtin13"]');
        return meta?.getAttribute("content")?.trim() || "";
      });
    } catch { /* no meta */ }
  }

  // 3. Check visible text with selectors
  if (!barcode) {
    barcode = await text(
      '[data-testid="gtin"]', '.gtin', '.upc-code', '.product-upc',
      '[itemprop="gtin12"]', '[itemprop="gtin13"]',
    );
  }

  // 4. Search page text for a barcode pattern near "UPC" or "GTIN"
  if (!barcode) {
    try {
      barcode = await page.evaluate(() => {
        const body = document.body.innerText;
        const match = body.match(/(?:UPC|GTIN|Barcode)[:\s]*(\d{12,14})/i);
        return match?.[1] || "";
      });
    } catch { /* no match */ }
  }

  if (!barcode) return null;

  // Extract product details
  const brand = await text('.product-brand', '[data-testid="brand-name"]', 'h1');
  const fullName = await text('.product-name', '[data-testid="product-name"]', 'h1');
  const sizeText = await text('.tire-size', '[data-testid="tire-size"]', '.product-size');

  // Parse brand/model from full name if separate fields aren't available
  let model = fullName;
  if (brand && model.toLowerCase().startsWith(brand.toLowerCase())) {
    model = model.slice(brand.length).trim();
  }

  // Parse size specs (e.g., "225/65R17 102H" -> size, load, speed)
  const sizeMatch = (sizeText || fullName).match(/(\d{3}\/\d{2}R\d{2})\s*(\d{2,3})\s*([A-Z])/i)
    || (sizeText || fullName).match(/((?:LT|P)?\d{3}\/\d{2,3}R\d{2})/i);
  const size = sizeMatch?.[1] || sizeText || "";
  const loadIndex = sizeMatch?.[2] || "";
  const speedRating = sizeMatch?.[3] || "";

  return {
    barcode: barcode.replace(/\D/g, ""),
    brand: brand || "",
    model: model || "",
    size,
    rawSizeText: sizeText || "",
    loadIndex,
    speedRating,
    loadRange: "",
    type: "",
    season: "",
    partNumber: "",
    sourceUrl: url,
  };
}
```

- [ ] **Step 3: Test with a visible browser (manual tuning)**

```bash
node scripts/barcode-harvester/engine.mjs --site discount-tire --headless false --max-pages 3
```

Watch the browser. Note which selectors work and which don't. Edit the extractor as needed. This is the expected tuning step for every new site.

- [ ] **Step 4: Test dry-run mode (discovery only)**

```bash
node scripts/barcode-harvester/engine.mjs --site discount-tire --dry-run
```

Expected: lists discovered product URLs without visiting them.

- [ ] **Step 5: Commit**

```bash
git add scripts/barcode-harvester/sites/
git commit -m "feat: Discount Tire site config + custom SPA extractor"
```

---

### Task 3: Smoke Test + npm Script

**Files:**
- Modify: `package.json` (add script)

**Interfaces:**
- Consumes: engine.mjs, discount-tire config
- Produces: `npm run harvest` command

- [ ] **Step 1: Add npm script**

Add to `package.json` scripts:

```json
"harvest": "node scripts/barcode-harvester/engine.mjs",
"harvest:discount-tire": "node scripts/barcode-harvester/engine.mjs --site discount-tire",
"harvest:test": "node scripts/barcode-harvester/engine.mjs --site discount-tire --max-pages 5 --headless false"
```

- [ ] **Step 2: Run a 5-page smoke test**

```bash
npm run harvest:test
```

Expected: visits up to 5 product pages, extracts any barcodes found, writes to `output/discount-tire-<timestamp>.csv`. Check the CSV:

```bash
cat scripts/barcode-harvester/output/discount-tire-*.csv
```

- [ ] **Step 3: Verify CSV format matches corpus schema**

```bash
node -e "
const { readFileSync } = require('fs');
const { readdirSync } = require('fs');
const dir = 'scripts/barcode-harvester/output';
const files = readdirSync(dir).filter(f => f.endsWith('.csv'));
if (!files.length) { console.log('No output CSVs yet'); process.exit(0); }
const lines = readFileSync(dir + '/' + files[0], 'utf8').split('\n');
const seedHeader = 'canonical_product_uid,brand,brand_normalized,model,model_normalized,size,raw_size_text,load_index,speed_rating,load_range,type,season,barcode,barcode_type,check_digit_valid,manufacturer_part_number,retailer_sku,confidence,current_status,usable_for,second_source_match,cross_checked,source_url,field_completeness_score,missing_fields,source_count';
console.log('Header match:', lines[0] === seedHeader);
console.log('Data rows:', lines.filter(l => l.trim() && l !== lines[0]).length);
"
```

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat: harvest npm scripts + smoke test verified"
```
