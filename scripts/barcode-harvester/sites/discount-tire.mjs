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
