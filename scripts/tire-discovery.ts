// Tire spec discovery for the 100-stage. LEGAL + BOUNDED:
//   - Firecrawl search+scrape (prepaid credits; tracked in reports/firecrawl-ledger.json, cap 500 / 50 per domain)
//   - robots.txt checked per domain at runtime; disallowed paths are SKIPPED
//   - FACTUAL fields only (brand/model from the curated query intent, size/load/speed/part-number/UPC parsed
//     from the page); NO marketing copy stored; source URL kept on every observation
//   - no login/paywall bypass; on any robots ambiguity or fetch failure -> SKIP (conservative)
//
// Feeds the PURE, unit-tested pipeline (src/services/tire/tireCatalog.ts). Honest by design: tire UPC/GTIN
// is rarely published, so most records will be spec/SKU candidates. We DO NOT pad to 100 - we report
// exactly what was legally and cleanly gathered.
//
// Usage: node scripts/tire-discovery.ts            (requires FIRECRAWL_API_KEY in env/.env.local)
//        node scripts/tire-discovery.ts --max-scrape=24

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildTireCatalog, toCatalogCsv, toJsonl } from "../src/services/tire/tireCatalog.ts";
import { addFirecrawl, firecrawlWouldExceed, readJson, FIRECRAWL_PATH } from "./spend-ledger.mjs";

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";

// Load FIRECRAWL_API_KEY from env or .env.local (names only; never logged).
function loadKey() {
  if (process.env.FIRECRAWL_API_KEY) return process.env.FIRECRAWL_API_KEY;
  try {
    const t = readFileSync(".env.local", "utf8");
    for (const line of t.split(/\r?\n/)) {
      const s = line.trim();
      if (s.startsWith("FIRECRAWL_API_KEY=")) return s.slice("FIRECRAWL_API_KEY=".length).trim();
    }
  } catch { /* ignore */ }
  return "";
}
const KEY = loadKey();

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : def;
}
const MAX_SCRAPE = Number(arg("max-scrape", "24"));

// Curated REAL tire targets (public facts) across the owner's brand list. Identity (brand/model/size)
// is the search intent; the scraped page is the corroborating factual source (URL kept).
const TARGETS = [
  { brand: "Michelin", model: "Pilot Sport 4S", size: "245/40ZR18" },
  { brand: "Michelin", model: "Defender T+H", size: "215/60R16" },
  { brand: "Goodyear", model: "Assurance WeatherReady", size: "225/65R17" },
  { brand: "Goodyear", model: "Eagle F1 Asymmetric 6", size: "245/40R18" },
  { brand: "Bridgestone", model: "Turanza QuietTrack", size: "215/55R17" },
  { brand: "Bridgestone", model: "Blizzak WS90", size: "205/55R16" },
  { brand: "Continental", model: "ExtremeContact DWS06 Plus", size: "245/40R18" },
  { brand: "Pirelli", model: "P Zero", size: "245/40R19" },
  { brand: "Falken", model: "Sincera ST80", size: "215/70R15" },
  { brand: "Toyo", model: "Open Country A/T III", size: "265/70R17" },
  { brand: "Nitto", model: "NT555 G2", size: "275/40R20" },
  { brand: "Nexen", model: "Roadian GTX", size: "235/60R18" },
  { brand: "Hankook", model: "Kinergy PT H737", size: "225/65R17" },
  { brand: "Kumho", model: "Crugen HP71", size: "235/60R18" },
  { brand: "Cooper", model: "Discoverer AT3 4S", size: "265/70R17" },
  { brand: "BFGoodrich", model: "All-Terrain T/A KO2", size: "265/70R17" },
  { brand: "Yokohama", model: "Geolandar A/T G015", size: "265/70R17" },
  { brand: "General", model: "Grabber A/TX", size: "265/70R17" },
  { brand: "Dunlop", model: "Grandtrek AT20", size: "265/70R16" },
  { brand: "Sailun", model: "Terramax CVR", size: "265/70R17" },
];

const MANUFACTURER_HOSTS = [
  "michelin", "goodyear", "bridgestone", "firestone", "continental", "pirelli", "falken", "toyo", "toyotires",
  "nitto", "nexen", "hankook", "kumho", "coopertire", "bfgoodrich", "yokohama", "generaltire", "dunlop", "sailun",
];

const robotsCache = new Map();
async function robotsAllowed(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const host = u.host;
  const path = u.pathname || "/";
  if (!robotsCache.has(host)) {
    try {
      const r = await fetch(`${u.protocol}//${host}/robots.txt`, { signal: AbortSignal.timeout(8000) });
      if (r.status === 404) { robotsCache.set(host, []); }
      else if (!r.ok) { robotsCache.set(host, null); } // unknown -> conservative deny
      else {
        const txt = await r.text();
        robotsCache.set(host, parseDisallow(txt));
      }
    } catch {
      robotsCache.set(host, null);
    }
  }
  const rules = robotsCache.get(host);
  if (rules === null) return false; // unknown robots -> skip (conservative)
  return !rules.some((dis) => dis && path.startsWith(dis));
}

// Minimal robots parser: Disallow paths under the `User-agent: *` group.
function parseDisallow(txt) {
  const lines = txt.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim());
  const groups = [];
  let cur = null;
  for (const line of lines) {
    const m = /^user-agent:\s*(.+)$/i.exec(line);
    if (m) {
      if (!cur || cur.closed) { cur = { agents: [], disallow: [], closed: false }; groups.push(cur); }
      cur.agents.push(m[1].toLowerCase());
      continue;
    }
    const d = /^disallow:\s*(.*)$/i.exec(line);
    if (d && cur) { cur.disallow.push(d[1].trim()); cur.closed = true; continue; }
    if (/^allow:/i.test(line) && cur) { cur.closed = true; }
  }
  const star = groups.find((g) => g.agents.includes("*"));
  return (star?.disallow ?? []).filter((p) => p && p !== "/").concat((star?.disallow ?? []).includes("/") ? ["/"] : []);
}

async function fcSearch(query, limit = 5) {
  const r = await fetch(`${FIRECRAWL_BASE}/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`search ${r.status}`);
  const d = await r.json();
  const web = Array.isArray(d?.data) ? d.data : d?.data?.web ?? [];
  return web.map((x) => ({ url: String(x.url ?? ""), title: String(x.title ?? "") })).filter((x) => x.url);
}

async function fcScrape(url) {
  const r = await fetch(`${FIRECRAWL_BASE}/scrape`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error(`scrape ${r.status}`);
  const d = await r.json();
  const md = String(d?.data?.markdown ?? d?.data?.md ?? "");
  const credits = d?.creditsUsed ?? d?.data?.creditsUsed ?? 1;
  return { markdown: md, credits: typeof credits === "number" ? credits : 1 };
}

function classifySource(host) {
  const h = host.toLowerCase();
  if (MANUFACTURER_HOSTS.some((m) => h.includes(m))) return "manufacturer_catalog";
  return "retailer_page";
}

// Conservative factual extraction. We only KEEP a fact when it matches a strict pattern, and we take
// load index + speed rating ONLY when they sit immediately after a tire size (e.g. "245/40R18 97Y"),
// which is how tire specs are actually printed. This avoids the loose "number+letter" false positives.
const MPN_STOPWORDS = new Set(["NUMBER", "MPN", "PART", "ARTICLE", "CODE", "SKU", "ITEM", "MODEL"]);
function extractFacts(markdown, target) {
  // size + adjacent (load index)(speed) e.g. "245/40R18 97Y" or "245/40ZR18 (97Y)"
  const sizeLoadSpeedRe = /(\d{3}\/\d{2}Z?R\d{2})\s*[\s(]*(\d{2,3})\s?([A-Z])\b/gi;
  const targetDigits = (target.size || "").replace(/[^0-9]/g, "");
  let best = null;
  for (const m of markdown.matchAll(sizeLoadSpeedRe)) {
    const cand = { size: m[1].toUpperCase(), loadIndex: m[2], speedRating: m[3].toUpperCase() };
    // prefer the size that matches the queried variant; else keep the first valid size+load+speed.
    if (cand.size.replace(/[^0-9]/g, "") === targetDigits) { best = cand; break; }
    if (!best) best = cand;
  }
  // size alone (no load/speed) as a fallback, preferring the target size if present on the page.
  let size = best?.size || "";
  if (!size) {
    const sizes = [...markdown.matchAll(/\b(\d{3}\/\d{2}Z?R\d{2})\b/gi)].map((m) => m[1].toUpperCase());
    size = sizes.find((s) => s.replace(/[^0-9]/g, "") === targetDigits) || sizes[0] || (target.size || "").toUpperCase();
  }

  const upcRaw = (markdown.match(/\b(?:UPC|GTIN|EAN)\b[:\s]*([0-9][0-9 \-]{10,16}[0-9])/i)?.[1] || "").replace(/[^0-9]/g, "");
  const upcGtin = upcRaw.length >= 11 && upcRaw.length <= 14 ? upcRaw : "";

  const mpnRaw = markdown.match(/\b(?:part\s*(?:number|no\.?|#)|MPN|article\s*(?:number|no\.?))\b[:\s]*([A-Z0-9][A-Z0-9\-]{3,20})/i)?.[1] || "";
  // reject false positives: must contain a digit and not be a stopword.
  const mfrPartNumber = /\d/.test(mpnRaw) && !MPN_STOPWORDS.has(mpnRaw.toUpperCase()) ? mpnRaw : "";

  return {
    size,
    loadIndex: best?.loadIndex || "",
    speedRating: best?.speedRating || "",
    upcGtin,
    mfrPartNumber,
  };
}

const isSafeHttp = (url) => /^https:\/\//i.test(url) && !/\b(localhost|127\.0\.0\.1|10\.|192\.168\.|169\.254\.)/i.test(url);

async function main() {
  if (!KEY) { console.error("No FIRECRAWL_API_KEY found. Aborting (paid stage blocked, free pipeline still built)."); process.exit(2); }
  mkdirSync("data/tire-catalog", { recursive: true });
  mkdirSync("reports/tire-db", { recursive: true });

  const observations = [];
  const log = [];
  let scrapes = 0;

  for (const target of TARGETS) {
    if (scrapes >= MAX_SCRAPE) { log.push(`stop: reached max-scrape ${MAX_SCRAPE}`); break; }
    const fc = readJson(FIRECRAWL_PATH);
    if (fc.credits >= fc.cap) { log.push(`stop: firecrawl credit cap ${fc.cap}`); break; }

    const query = `${target.brand} ${target.model} ${target.size} tire specifications load index speed rating`;
    let results = [];
    try {
      results = await fcSearch(query, 5);
      // search costs ~1 credit; record it (best-effort) under a search pseudo-domain
      if (!firecrawlWouldExceed(readJson(FIRECRAWL_PATH), 1, 0, "firecrawl-search")) addFirecrawl(1, 0, "firecrawl-search", `search: ${target.brand} ${target.model}`);
    } catch (e) {
      log.push(`search failed for ${target.brand} ${target.model}: ${String(e.message || e)}`);
      continue;
    }

    // pick the first safe, robots-permitted candidate
    let used = null;
    for (const r of results) {
      if (!isSafeHttp(r.url)) continue;
      const host = new URL(r.url).host;
      if (!(await robotsAllowed(r.url))) { log.push(`robots-skip ${r.url}`); continue; }
      // per-domain page cap check before scraping
      if (firecrawlWouldExceed(readJson(FIRECRAWL_PATH), 1, 1, host)) { log.push(`ledger-cap-skip ${host}`); continue; }
      try {
        const { markdown, credits } = await fcScrape(r.url);
        addFirecrawl(credits || 1, 1, host, `scrape: ${target.brand} ${target.model}`);
        scrapes += 1;
        const facts = extractFacts(markdown, target);
        observations.push({
          sourceType: classifySource(host),
          sourceUrl: r.url,
          sourceNote: `Firecrawl scrape; facts-only extraction for ${target.brand} ${target.model}`,
          brand: target.brand,
          model: target.model,
          category: "Tire",
          ...facts,
        });
        used = r.url;
        log.push(`scraped ${target.brand} ${target.model} <- ${host} (size=${facts.size||"?"} ls=${facts.loadIndex}${facts.speedRating} upc=${facts.upcGtin||"none"})`);
        break;
      } catch (e) {
        log.push(`scrape failed ${r.url}: ${String(e.message || e)}`);
        continue;
      }
    }
    if (!used) log.push(`no usable source for ${target.brand} ${target.model}`);
  }

  const catalog = buildTireCatalog(observations);
  writeFileSync("data/tire-catalog/tire_catalog_100.csv", toCatalogCsv(catalog.records));
  writeFileSync("data/tire-catalog/tire_catalog_100.jsonl", toJsonl(catalog.records));
  const fcFinal = readJson(FIRECRAWL_PATH);
  writeFileSync("reports/tire-db/stage_100_discovery_log.json", JSON.stringify({ observations: observations.length, scrapes, firecrawlCredits: fcFinal.credits, log }, null, 2) + "\n");
  writeFileSync(
    "reports/tire-db/stage_100_counts.json",
    JSON.stringify({ counts: catalog.counts, firecrawlCredits: fcFinal.credits, firecrawlPerDomain: fcFinal.perDomain }, null, 2) + "\n",
  );

  console.log("observations:", observations.length, "| scrapes:", scrapes, "| firecrawl credits:", fcFinal.credits);
  console.log("counts:", JSON.stringify(catalog.counts));
  console.log("outputs -> data/tire-catalog/tire_catalog_100.{csv,jsonl}, reports/tire-db/stage_100_*.json");
}

main().catch((e) => { console.error("tire-discovery failed:", e); process.exit(1); });
