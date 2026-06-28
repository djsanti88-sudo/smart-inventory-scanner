// Weekly 10-code live decode accuracy bot. Runs the owner-confirmed hard codes through the REAL
// /api/ai-lookup decode pipeline, scores each correct / wrong / needs-review against
// data/accuracy/hard-codes.json, and records ESTIMATED third-party spend into cost.json.
//
// SAFE BY DEFAULT: it only spends (POSTs to live providers) when LIVE_AI_TEST=1. Otherwise it does a
// dry run: prints the no-token GET status and writes a $0, provisional result. Run:
//   node scripts/dev (in one terminal), then:
//   LIVE_AI_TEST=1 node scripts/weekly-accuracy.ts [--deep] [--out=reports/product-intel/<date>] [--date=YYYY-MM-DD]
//
// Plain JS in a .ts file (CommonJS, no "type":"module") so `node scripts/weekly-accuracy.ts` runs on
// Node 24 type-stripping with no toolchain, matching scripts/live-decode-smoke.ts.
const fs = require("node:fs");
const path = require("node:path");

let BASE = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const PORT_CANDIDATES = process.env.SMOKE_BASE_URL
  ? [process.env.SMOKE_BASE_URL]
  : ["http://localhost:3000", "http://localhost:3100", "http://localhost:3300"];
const LIVE = process.env.LIVE_AI_TEST === "1";
const DEEP = process.argv.includes("--deep") || process.env.WEEKLY_DEEP === "1";
const CAP = Number(process.env.THIRDPARTY_CAP_USD || (DEEP ? 2 : 0.5));
const FIXTURE = path.resolve("data/accuracy/hard-codes.json");

function arg(name, def) {
  const p = process.argv.find((a) => a.startsWith(name + "="));
  return p ? p.slice(name.length + 1) : def;
}
const DATE = arg("--date", new Date().toISOString().slice(0, 10));
const OUT = path.resolve(arg("--out", "reports/product-intel/" + DATE));

// Rough per-call USD estimates (LABELED estimate, not exact billing). Conservative high side.
const EST = { geminiFast: 0.0015, geminiPro: 0.01, openaiFast: 0.006, openaiPro: 0.03, firecrawl: 0.01 };

function codeType(c) {
  if (/^\d{12}$/.test(c)) return "upc_a";
  if (/^\d{13}$/.test(c)) return "ean_13";
  if (/^\d{14}$/.test(c)) return "gtin_14";
  if (/^(X0|B0)[0-9A-Z]{8}$/i.test(c)) return "vendor_label";
  return /^\d+$/.test(c) ? "numeric_sku" : "alpha_sku";
}
function brandHit(productName, brand) {
  return !!brand && String(productName || "").toLowerCase().includes(String(brand).toLowerCase());
}

async function decode(code, ct) {
  const r = await fetch(BASE + "/api/ai-lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: DEEP ? "decode-deep" : "decode",
      deep: DEEP,
      rawCode: code,
      cleanCode: code,
      codeType: ct,
      confidenceThreshold: 0.8,
      allowImageSuggestions: true,
    }),
  });
  return r.json();
}

function scoreCode(entry, data) {
  const dec = data.decision || {};
  const best = (data.results || [])[0] || {};
  const name = best.productName || "";
  const verified = dec.status === "verified";
  const exp = entry.expected || {};
  const hint = String(exp.productHint || "").toLowerCase();
  const expectNeedsReview =
    /needs review|poison|vendor|unknown|trap/.test(hint) || ["vendor_label", "unknown_new"].includes(entry.type);

  if (verified && (exp.mustNotBe || []).some((b) => brandHit(name, b)))
    return { verdict: "wrong", got: name, reason: "matched a forbidden brand (" + (exp.mustNotBe || []).join("/") + ")" };
  if (expectNeedsReview)
    return verified
      ? { verdict: "wrong", got: name, reason: "auto-decoded a code that should hold for review" }
      : { verdict: "correct", got: "needs review: " + (dec.reason || ""), reason: "correctly held for review" };
  if (exp.brand) {
    if (verified && brandHit(name, exp.brand)) return { verdict: "correct", got: name };
    if (verified) return { verdict: "wrong", got: name, reason: "wrong brand (expected " + exp.brand + ")" };
    return { verdict: "needs-review", got: "needs review: " + (dec.reason || ""), reason: "did not confidently decode (unknown is acceptable)" };
  }
  return { verdict: "unscored", got: verified ? name : "needs review", reason: "expected answer not owner-confirmed" };
}

function estCost(data) {
  const names = data.providerNames || [];
  let usd = 0;
  for (const n of names) {
    const s = String(n);
    if (s.startsWith("gemini")) usd += /pro|deep/.test(s) ? EST.geminiPro : EST.geminiFast;
    else if (s.startsWith("openai")) usd += /pro|deep/.test(s) ? EST.openaiPro : EST.openaiFast;
  }
  // Firecrawl spend: the route exposes debug.firecrawlCreditsEstimated (not a boolean "firecrawl").
  const fc = Number((data.debug && (data.debug.firecrawlCreditsEstimated || data.debug.firecrawlCandidates)) || 0);
  if (fc > 0) usd += EST.firecrawl * fc;
  return { usd, calls: names.length };
}

function mergeCost(entry, skippedNote) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, "cost.json");
  let cost = { mode: DEEP ? "deep" : "lean", capUsd: CAP, thirdParty: [], claude: { agents: 0, estTokens: 0, note: "Covered by Claude subscription. Zero out-of-pocket cash." }, skipped: [] };
  try { cost = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  if (!Array.isArray(cost.thirdParty)) cost.thirdParty = [];
  if (entry) cost.thirdParty.push(entry);
  if (skippedNote) { if (!Array.isArray(cost.skipped)) cost.skipped = []; cost.skipped.push(skippedNote); }
  cost.capUsd = CAP;
  fs.writeFileSync(file, JSON.stringify(cost, null, 2));
  return file;
}

async function main() {
  console.log("=== Weekly decode accuracy bot ===");
  console.log("base:", BASE, "| mode:", DEEP ? "deep" : "lean", "| cap: $" + CAP.toFixed(2), "| LIVE:", LIVE ? "1 (will spend)" : "(dry, $0)");

  let fixture;
  try { fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8")); }
  catch (e) { console.error("Cannot read fixture", FIXTURE, String(e)); process.exit(1); }
  const all = fixture.codes || [];
  const runnable = all.filter((c) => c.code && String(c.code).trim());
  const provisional = !fixture.confirmedByOwner || all.some((c) => !c.confirmed);

  let status = null;
  for (const cand of PORT_CANDIDATES) {
    try {
      const r = await fetch(cand + "/api/ai-lookup");
      if (r.ok) { status = await r.json(); BASE = cand; break; }
    } catch (e) {}
  }
  if (!status) { console.error("Cannot reach the dev server on any of", PORT_CANDIDATES.join(", "), "- start it with `npm run dev` (or set SMOKE_BASE_URL)."); process.exit(1); }
  console.log("server:", BASE);

  const canLive = LIVE && !status.e2e && (status.geminiConfigured || status.openaiConfigured);
  const result = {
    date: DATE, mode: DEEP ? "deep" : "lean", provisional, ranLive: false,
    total: 0, correct: 0, wrong: 0, needsReview: 0, unscored: 0, perCode: [],
  };

  if (!canLive) {
    const why = !LIVE ? "dry mode (LIVE_AI_TEST not 1)" : status.e2e ? "server is IS_E2E mock-only" : "no provider keys configured server-side";
    console.log("\nNOT running live providers ->", why, "-> $0 spent.");
    result.perCode = runnable.map((c) => ({ code: c.code, expected: (c.expected && (c.expected.brand || c.expected.productHint)) || "(unconfirmed)", got: "(not run)", verdict: "dry", note: why }));
    result.total = runnable.length;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "accuracy.json"), JSON.stringify(result, null, 2));
    const cf = mergeCost(null, "live accuracy not run: " + why);
    console.log("wrote", path.join(OUT, "accuracy.json"), "and updated", cf, "($0).");
    if (provisional) console.log("NOTE: ground-truth codes are not owner-confirmed -> score will be labeled PROVISIONAL.");
    return;
  }

  let spent = 0, calls = 0, ran = 0;
  for (const entry of runnable) {
    if (spent + 0.04 > CAP) { result.perCode.push({ code: entry.code, expected: entry.expected.brand || entry.expected.productHint || "", got: "(skipped)", verdict: "skipped", note: "third-party cap $" + CAP + " reached" }); continue; }
    const ct = entry.type === "vendor_label" ? "vendor_label" : codeType(String(entry.code));
    let data;
    try { data = await decode(String(entry.code), ct); }
    catch (e) { result.perCode.push({ code: entry.code, expected: entry.expected.brand || "", got: "(request failed)", verdict: "error", note: String(e) }); continue; }
    const sc = scoreCode(entry, data);
    const c = estCost(data);
    spent += c.usd; calls += c.calls; ran++;
    if (sc.verdict === "correct") result.correct++;
    else if (sc.verdict === "wrong") result.wrong++;
    else if (sc.verdict === "needs-review") result.needsReview++;
    else result.unscored++;
    result.perCode.push({ code: entry.code, expected: entry.expected.brand || entry.expected.productHint || "", got: sc.got, verdict: sc.verdict, confidence: (data.decision || {}).status, note: sc.reason });
    console.log("  " + entry.code + " -> " + sc.verdict + " (" + sc.got.slice(0, 60) + ")  est $" + spent.toFixed(3));
  }
  result.ranLive = true;
  result.total = ran;

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "accuracy.json"), JSON.stringify(result, null, 2));
  const cf = mergeCost({ provider: "decode (Gemini/OpenAI)", detail: ran + " codes, " + calls + " provider calls (estimated)", calls, usd: Math.round(spent * 100) / 100 });
  console.log("\nScored:", result.correct, "correct,", result.wrong, "wrong,", result.needsReview, "needs-review,", result.unscored, "unscored of", ran);
  console.log("Estimated third-party spend: $" + spent.toFixed(2), "(cap $" + CAP.toFixed(2) + ")");
  console.log("wrote", path.join(OUT, "accuracy.json"), "and merged", cf);
  if (provisional) console.log("WARNING: ground-truth not owner-confirmed -> score is PROVISIONAL and not trustworthy.");
}

main();
