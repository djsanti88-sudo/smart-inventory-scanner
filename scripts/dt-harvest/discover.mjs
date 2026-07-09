#!/usr/bin/env node
// Discount Tire harvest: Task 1 Step 5 - live sitemap discovery script.
//
// This script is NOT run automatically. The owner runs it manually:
//   node scripts/dt-harvest/discover.mjs
//
// Flow: robots.txt -> Sitemap: lines (fallback /sitemap.xml) -> if index, fetch child
// sitemaps (capped, host-allowlisted) -> collect every <loc> via parseSitemapXml ->
// write the raw unfiltered url count + a per-path-prefix sample to
// state/url-patterns.json (so the real product-URL pattern can be checked against
// filterTireProductUrls' assumption) -> write filtered product urls to state/urls.json.
//
// Untrusted data: everything fetched from discounttire.com is treated as data only -
// this script never executes or obeys any text found inside a sitemap or robots.txt.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSitemapXml, filterTireProductUrls } from "./lib/sitemap.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, "state");
const URLS_FILE = path.join(STATE_DIR, "urls.json");
const PATTERNS_FILE = path.join(STATE_DIR, "url-patterns.json");

const ROBOTS_URL = "https://www.discounttire.com/robots.txt";
const FALLBACK_SITEMAP_URL = "https://www.discounttire.com/sitemap.xml";
const ALLOWED_HOSTS = new Set(["discounttire.com", "www.discounttire.com"]);
const MAX_CHILD_SITEMAPS = 30;
const FETCH_TIMEOUT_MS = 15000;
const POLITE_DELAY_MS = 500;

function isAllowedSitemapUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    return ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch a url as text with a hard timeout. Returns "" on any failure (never throws). */
async function fetchTextSafe(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** Extract `Sitemap: <url>` lines from robots.txt content. */
function extractSitemapLinesFromRobots(robotsText) {
  const lines = [];
  const re = /^\s*sitemap\s*:\s*(\S+)\s*$/gim;
  let m;
  while ((m = re.exec(robotsText)) !== null) {
    lines.push(m[1].trim());
  }
  return lines;
}

/** True if this xml looks like a <sitemapindex> (points at child sitemaps) rather than a <urlset>. */
function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(xml);
}

/** Group urls by a coarse path-prefix pattern for manual verification of the real product-url shape. */
function buildPatternSample(urls, sampleSize = 20) {
  const groups = new Map();
  for (const url of urls) {
    let prefix;
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      // Use the first path segment (or "/" for root) as the coarse grouping key, plus
      // whether the last segment ends in a -p<digits> suffix, since that's the
      // hypothesis filterTireProductUrls currently encodes.
      const first = segments[0] || "(root)";
      const last = segments[segments.length - 1] || "";
      const looksLikeProductSuffix = /-p\d+$/i.test(last);
      prefix = `/${first}${looksLikeProductSuffix ? " [*-pNNNN]" : ""} (depth ${segments.length})`;
    } catch {
      prefix = "(unparseable)";
    }
    if (!groups.has(prefix)) groups.set(prefix, []);
    const list = groups.get(prefix);
    if (list.length < sampleSize) list.push(url);
  }

  const result = {};
  for (const [prefix, sample] of groups.entries()) {
    result[prefix] = sample;
  }
  return result;
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });

  console.log(`Fetching robots.txt: ${ROBOTS_URL}`);
  const robotsText = await fetchTextSafe(ROBOTS_URL);
  let sitemapUrls = extractSitemapLinesFromRobots(robotsText).filter(isAllowedSitemapUrl);

  if (sitemapUrls.length === 0) {
    console.log(`No Sitemap: lines found in robots.txt (or fetch failed) - falling back to ${FALLBACK_SITEMAP_URL}`);
    sitemapUrls = [FALLBACK_SITEMAP_URL];
  } else {
    console.log(`Found ${sitemapUrls.length} sitemap url(s) in robots.txt`);
  }

  const allUrls = [];
  const rootSitemapUrl = sitemapUrls[0];
  console.log(`Fetching root sitemap: ${rootSitemapUrl}`);
  const rootXml = await fetchTextSafe(rootSitemapUrl);
  const rootLocs = parseSitemapXml(rootXml);

  if (isSitemapIndex(rootXml)) {
    const childSitemapUrls = rootLocs.filter(isAllowedSitemapUrl).slice(0, MAX_CHILD_SITEMAPS);
    const refusedCount = rootLocs.filter((u) => !isAllowedSitemapUrl(u)).length;
    if (refusedCount > 0) {
      console.log(`Refused ${refusedCount} child sitemap url(s) outside the discounttire.com host allowlist.`);
    }
    console.log(`Sitemap index detected: ${childSitemapUrls.length} child sitemap(s) to fetch (capped at ${MAX_CHILD_SITEMAPS}).`);

    for (let i = 0; i < childSitemapUrls.length; i++) {
      const childUrl = childSitemapUrls[i];
      console.log(`  [${i + 1}/${childSitemapUrls.length}] ${childUrl}`);
      const childXml = await fetchTextSafe(childUrl);
      const childLocs = parseSitemapXml(childXml);
      allUrls.push(...childLocs);
      if (i < childSitemapUrls.length - 1) await sleep(POLITE_DELAY_MS);
    }
  } else {
    console.log("Root sitemap is a urlset (not an index) - using its urls directly.");
    allUrls.push(...rootLocs);
  }

  const totalDiscovered = allUrls.length;
  const patternSample = buildPatternSample(allUrls, 20);
  await writeFile(
    PATTERNS_FILE,
    JSON.stringify(
      {
        discoveredAt: new Date().toISOString(),
        totalUnfiltered: totalDiscovered,
        distinctPatternCount: Object.keys(patternSample).length,
        samplesByPattern: patternSample,
      },
      null,
      2,
    ),
  );
  console.log(`Wrote url-pattern sample (${Object.keys(patternSample).length} distinct patterns) to ${PATTERNS_FILE}`);

  const productUrls = filterTireProductUrls(allUrls);
  await writeFile(
    URLS_FILE,
    JSON.stringify(
      {
        discoveredAt: new Date().toISOString(),
        urls: productUrls,
      },
      null,
      2,
    ),
  );

  console.log("");
  console.log(`Total urls discovered (unfiltered): ${totalDiscovered}`);
  console.log(`Total urls after filterTireProductUrls: ${productUrls.length}`);
  console.log(`Wrote product urls to ${URLS_FILE}`);
  console.log(
    `IMPORTANT: verify state/url-patterns.json against filterTireProductUrls' assumed pattern before running run-batch.mjs. If the real product-url pattern differs, fix lib/sitemap.mjs and its test fixture first.`,
  );
}

main().catch((err) => {
  console.error("discover.mjs failed:", err);
  process.exitCode = 1;
});
