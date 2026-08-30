// Task 9 STEP 1 (OWNER-GATED, paid): decode the 16 tire codes missing from BOTH local SQLite and
// Turso corpus, through the real /api/ai-lookup decode pipeline, and write a REVIEW JSON only.
// This script NEVER upserts anything - Step 3 (owner-approved rows -> Turso via the dt-harvest
// apply path) happens later, after the owner reviews scripts/backfill-missing-tires-review.json.
//
// v2 strict upsert criteria (wrong identity is worse than unknown - see task-9-brief.md):
// a row is kept ONLY if decision.status is "verified" or "suggested" AND results[0] has ALL of:
//   brand, model/productName, tire size, load index, speed rating, >=1 source URL, AND
//   decision.exactCodeEvidenceVerifiedByApp === true (app-verified, never the model's self-claim).
// Anything missing even one of those fields is recorded under "rejected" with the missing fields
// listed. No exceptions, no "close enough" rows.
//
// Field names verified against src/types.ts (AiLookupResult, DecodeDecision) and the route's
// response shape (src/app/api/ai-lookup/route.ts, DecodePayload: { results, decision, ... }):
//   results[0].brand           - AiLookupResult.brand
//   results[0].productName     - AiLookupResult.productName (model/product name)
//   results[0].sourceUrls      - AiLookupResult.sourceUrls (string[])
//   decision.status            - DecodeDecision.status ("verified" | "suggested" | "conflict" | "needs_review")
//   decision.exactCodeEvidenceVerifiedByApp - DecodeDecision.exactCodeEvidenceVerifiedByApp (boolean)
//   decision.evidenceStrength  - DecodeDecision.evidenceStrength
// Tire size + load index + speed rating are NOT separate flat fields on AiLookupResult - they are
// parsed deterministically from the product name / specsShort / specsFull via matchTireSize()
// (src/products/tires/tireSizeNormalizer.ts). matchTireSize().canonical is e.g. "225/60R18 103H":
// the leading token (before the first space) is the tire SIZE, and the trailing token (if present)
// is the combined LOAD INDEX + SPEED RATING (digits = load index, trailing letter = speed rating).
// This script reimplements that same parsing inline (copied logic, not imported) because it must
// run standalone via `node scripts/backfill-missing-tires.mjs` without pulling in the Next.js/TS
// build graph. If tireSizeNormalizer.ts changes its size grammar, update the regexes below too.
//
// Usage:
//   node scripts/backfill-missing-tires.mjs --live
//   DECODE_BASE=http://localhost:3100 node scripts/backfill-missing-tires.mjs --live
//
// Refuses to run without --live (cost warning). This hits a local dev server whose unresolved rows
// can call GPT-5.4 mini, so every code can spend real money.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LIVE = process.argv.includes("--live");
if (!LIVE) {
  console.error(
    "COST WARNING: this script POSTs to a live GPT-5.4 mini decode server.\n" +
    "Each of the 16 codes can consume the configured GPT decode budget.\n" +
    "Refusing to run without --live. Re-run as: node scripts/backfill-missing-tires.mjs --live"
  );
  process.exit(1);
}

const BASE = (process.env.DECODE_BASE || "http://localhost:3000").replace(/\/$/, "");
const OUT_PATH = fileURLToPath(new URL("./backfill-missing-tires-review.json", import.meta.url));
const PACE_MS = 1500;
const TIMEOUT_MS = 90_000;

// The 16 codes absent from BOTH local SQLite and Turso corpus (13 Michelin, 3 Goodyear).
const CODES = [
  "697662160311",
  "697662160328",
  "697662133469",
  "086699137685",
  "086699165459",
  "086699212016",
  "086699300546",
  "086699332844",
  "086699339157",
  "086699430304",
  "086699431998",
  "086699525222",
  "086699778642",
  "086699855275",
  "086699979674",
  "086699998538",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- tire size / load index / speed rating extraction (mirrors src/products/tires/tireSizeNormalizer.ts) ---

const METRIC = /(P|LT|ST)?\s*(\d{3})\s*\/\s*(\d{2})\s*(ZR|R)\s*(\d{2}(?:\.\d)?)/i;
const FLOTATION = /(\d{2})\s*X\s*(\d{1,2}\.\d{1,2})\s*(?:ZR|R|-)?\s*(\d{2}(?:\.\d)?)/i;
const COMMERCIAL = /(\d{2,3})\s*(ZR|R)\s*(\d{2}\.\d)/i;
const SPACED = /\b(\d{3})\s+(\d{2})\s+(\d{2})\b/;
const NOSEP = /\b(\d{7})\b/;

const okWidth = (w) => w >= 125 && w <= 395;
const okAspect = (a) => a >= 20 && a <= 90;
const okRim = (r) => r >= 8 && r <= 30;

const LOAD_SPEED = /(\d{2,3}(?:\/\d{2,3})?)\s*([A-Z])\b/gi;
const SPEED_LETTERS = new Set("ABCDEFGHJKLMNPQRSTUVWY".split(""));

function findLoadSpeed(remainder) {
  for (const m of remainder.matchAll(LOAD_SPEED)) {
    const speed = m[2].toUpperCase();
    if (SPEED_LETTERS.has(speed)) return { loadIndex: m[1], speedRating: speed, raw: m[0] };
  }
  return null;
}

function matchTireSize(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;

  let m = METRIC.exec(s);
  if (m) {
    const prefix = (m[1] ?? "").toUpperCase();
    const size = `${prefix}${m[2]}/${m[3]}${m[4].toUpperCase()}${m[5]}`;
    const ls = findLoadSpeed(s.replace(m[0], " "));
    return { size, loadIndex: ls?.loadIndex ?? null, speedRating: ls?.speedRating ?? null };
  }

  m = FLOTATION.exec(s);
  if (m) {
    const size = `${m[1]}X${m[2]}R${m[3]}`;
    const ls = findLoadSpeed(s.replace(m[0], " "));
    return { size, loadIndex: ls?.loadIndex ?? null, speedRating: ls?.speedRating ?? null };
  }

  m = COMMERCIAL.exec(s);
  if (m) {
    const size = `${m[1]}${m[2].toUpperCase()}${m[3]}`;
    const ls = findLoadSpeed(s.replace(m[0], " "));
    return { size, loadIndex: ls?.loadIndex ?? null, speedRating: ls?.speedRating ?? null };
  }

  m = SPACED.exec(s);
  if (m && okWidth(Number(m[1])) && okAspect(Number(m[2])) && okRim(Number(m[3]))) {
    const size = `${m[1]}/${m[2]}R${m[3]}`;
    const ls = findLoadSpeed(s.replace(m[0], " "));
    return { size, loadIndex: ls?.loadIndex ?? null, speedRating: ls?.speedRating ?? null };
  }

  m = NOSEP.exec(s);
  if (m) {
    const d = m[1];
    const [w, a, r] = [d.slice(0, 3), d.slice(3, 5), d.slice(5, 7)];
    if (okWidth(Number(w)) && okAspect(Number(a)) && okRim(Number(r))) {
      return { size: `${w}/${a}R${r}`, loadIndex: null, speedRating: null };
    }
  }

  return null;
}

/** Try the product name, then specsShort, then specsFull, in that order (first confident hit wins). */
function extractSizeLoadSpeed(result) {
  const candidates = [result?.productName, result?.specsShort, result?.specsFull];
  for (const c of candidates) {
    const m = matchTireSize(c);
    if (m?.size) return m;
  }
  return { size: null, loadIndex: null, speedRating: null };
}

// --- decode POST (shape modeled on scripts/dt-harvest/state/test-preview-200.mjs) ---

async function decode(code) {
  const url = `${BASE}/api/ai-lookup`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rawCode: code, cleanCode: code, mode: "decode", scanContext: "tire" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  return { httpStatus: res.status, body };
}

/** Evaluate ALL v2 strict criteria for one decode response. Returns { keep, row, missing }. */
function evaluate(code, body) {
  const decision = body?.decision;
  const result = body?.results?.[0];
  const missing = [];

  const statusOk = decision?.status === "verified" || decision?.status === "suggested";
  if (!statusOk) missing.push(`decision.status is "${decision?.status ?? "(none)"}", need verified/suggested`);

  const brand = result?.brand?.trim() || "";
  if (!brand) missing.push("brand");

  const model = result?.productName?.trim() || "";
  if (!model) missing.push("model/productName");

  const { size, loadIndex, speedRating } = extractSizeLoadSpeed(result ?? {});
  if (!size) missing.push("tire size");
  if (!loadIndex) missing.push("load index");
  if (!speedRating) missing.push("speed rating");

  const sourceUrls = Array.isArray(result?.sourceUrls) ? result.sourceUrls.filter(Boolean) : [];
  if (sourceUrls.length === 0) missing.push("source URL");

  const evidenceVerified = decision?.exactCodeEvidenceVerifiedByApp === true;
  if (!evidenceVerified) missing.push("exactCodeEvidenceVerifiedByApp !== true");

  const keep = missing.length === 0;
  const row = {
    code,
    brand: brand || null,
    model: model || null,
    size,
    load: loadIndex,
    speed: speedRating,
    sourceUrls,
    evidenceStrength: decision?.evidenceStrength ?? "none",
    exactCodeEvidenceVerifiedByApp: evidenceVerified,
    decisionStatus: decision?.status ?? "(none)",
  };
  return { keep, row, missing };
}

async function main() {
  console.log(`Backfill decode: ${BASE}  |  ${CODES.length} codes  |  pace ${PACE_MS}ms  |  timeout ${TIMEOUT_MS}ms`);

  const prior = existsSync(OUT_PATH)
    ? JSON.parse(readFileSync(OUT_PATH, "utf8"))
    : { startedAt: new Date().toISOString(), kept: [], rejected: [] };
  const done = new Set([...prior.kept.map((r) => r.code), ...prior.rejected.map((r) => r.code)]);

  let errorCount = 0;

  for (let i = 0; i < CODES.length; i++) {
    const code = CODES[i];
    if (done.has(code)) {
      console.log(`[${i + 1}/${CODES.length}] ${code} -> skip (already in output)`);
      continue;
    }

    try {
      const { httpStatus, body } = await decode(code);
      if (httpStatus !== 200) {
        prior.rejected.push({ code, reason: `HTTP ${httpStatus}`, missing: ["http_200"] });
        console.log(`[${i + 1}/${CODES.length}] ${code} -> HTTP ${httpStatus}, rejected`);
      } else {
        const { keep, row, missing } = evaluate(code, body);
        if (keep) {
          prior.kept.push(row);
          console.log(`[${i + 1}/${CODES.length}] ${code} -> KEPT (${row.brand} ${row.model}, ${row.size} ${row.load}${row.speed})`);
        } else {
          prior.rejected.push({ code, reason: "missing required field(s)", missing });
          console.log(`[${i + 1}/${CODES.length}] ${code} -> rejected: ${missing.join(", ")}`);
        }
      }
    } catch (e) {
      errorCount++;
      prior.rejected.push({ code, reason: `error: ${String(e?.message ?? e).slice(0, 200)}`, missing: ["no_response"] });
      console.log(`[${i + 1}/${CODES.length}] ${code} -> ERROR: ${String(e?.message ?? e).slice(0, 150)}`);
    }

    prior.updatedAt = new Date().toISOString();
    writeFileSync(OUT_PATH, JSON.stringify(prior, null, 2));

    if (i < CODES.length - 1) await sleep(PACE_MS);
  }

  console.log("\n===== SUMMARY =====");
  console.log(`kept: ${prior.kept.length}`);
  console.log(`rejected: ${prior.rejected.length}`);
  console.log(`errors: ${errorCount}`);
  console.log(`review file: ${OUT_PATH}`);
}

main();
