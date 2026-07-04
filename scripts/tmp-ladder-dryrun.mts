// TEMP dry-run probe (spec 2026-07-04). Run modes:
//   LADDER_MOCK=1 npx tsx scripts/tmp-ladder-dryrun.mts   -> canned AI + fetch, 3 inline codes, asserts outcomes, $0
//   npx tsx scripts/tmp-ladder-dryrun.mts                  -> LIVE, $15 hard cap (Task 9 only, owner-authorized)
import { readFileSync, writeFileSync } from "node:fs";
import { enrichWithPageFetch, type FetchImpl } from "../src/services/ai/pageFetch";
import { selectBarcodeUrls } from "../src/services/ai/barcodeSources";
import { verifyAsinPage, looksLikeAsin } from "../src/services/ai/asinVerify";
import { crossCheck } from "../src/services/ai/crossCheckEngine";
import { detectCodeType } from "../src/services/codeTypeDetector"; // real module (grep confirmed); NOT src/services/codeType
import { normalizeResult } from "../src/services/ai/provider";

// Real CodeType union (src/types.ts): "upc_a" | "ean_13" | "gtin_14" | "numeric_sku" | "alpha_sku"
// | "vendor_label" | "messy" | "empty". The "public barcode" allowlist below MUST use these exact
// strings (the brief's placeholder ["upc","ean","gtin","gtin14","barcode"] does not match reality).
const PUBLIC_BARCODE_TYPES = ["upc_a", "ean_13", "gtin_14"];

const BUDGET_USD = 15.0;
const MOCK = process.env.LADDER_MOCK === "1";
const PROMPT = (code: string) =>
  `Identify the product for barcode ${code}. Search the web. Return JSON only: {"brand":"","productName":"","specs":"","gtin":"","confidence":0.0,"exactCodeFound":false,"basis":"","sourceUrls":[]}. If you find this exact code in a real page, set exactCodeFound true and confidence to match the evidence. If you cannot, STILL return your single best guess from partial matches, barcode prefix ownership, or similar listings - set exactCodeFound false, confidence 0.4 or less, and say why in basis. Keep it brief. Never leave productName empty if you have any plausible guess.`;

// --- keys (never printed) ---
const env = (() => { try { return readFileSync(new URL("../.env.local", import.meta.url), "utf8"); } catch { return ""; } })();
const keyOf = (name: string) => env.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "") || process.env[name] || "";
const GEMINI_KEY = keyOf("GEMINI_API_KEY");
const OPENAI_KEY = keyOf("OPENAI_API_KEY");

let spent = 0;
type AiGuess = { brand: string; productName: string; confidence: number; exactCodeFound: boolean; sourceUrls: string[]; basis: string; cost: number; secs: number; error?: string };

function parseGuess(text: string): Omit<AiGuess, "cost" | "secs"> {
  let p: Record<string, unknown> = {};
  try { const s = text.indexOf("{"), e = text.lastIndexOf("}"); if (s !== -1 && e > s) p = JSON.parse(text.slice(s, e + 1)); } catch { /* raw */ }
  return {
    brand: String(p.brand ?? ""), productName: String(p.productName ?? ""),
    confidence: Number(p.confidence ?? 0), exactCodeFound: Boolean(p.exactCodeFound),
    sourceUrls: Array.isArray(p.sourceUrls) ? p.sourceUrls.map(String) : [], basis: String(p.basis ?? ""),
  };
}

const errGuess = (t0: number, label: string): AiGuess =>
  ({ brand: "", productName: "", confidence: 0, exactCodeFound: false, sourceUrls: [], basis: "", cost: 0, secs: (Date.now() - t0) / 1000, error: label });

async function geminiGuess(code: string): Promise<AiGuess> {
  const t0 = Date.now();
  try {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: PROMPT(code) }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.2, maxOutputTokens: 3000, thinkingConfig: { thinkingLevel: "low" } } }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json();
  if (!res.ok) return { brand: "", productName: "", confidence: 0, exactCodeFound: false, sourceUrls: [], basis: "", cost: 0, secs: (Date.now() - t0) / 1000, error: `gemini ${res.status}` };
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p: { text?: string }) => p?.text ?? "").join("\n");
  const urls = (cand?.groundingMetadata?.groundingChunks ?? []).map((c: { web?: { uri?: string } }) => c?.web?.uri).filter(Boolean);
  const u = data?.usageMetadata ?? {};
  const cost = ((u.promptTokenCount ?? 0) / 1e6) * 1.5 + (((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) / 1e6) * 9 + ((cand?.groundingMetadata?.webSearchQueries ?? []).length) * 0.014;
  const g = parseGuess(text);
  return { ...g, sourceUrls: [...new Set([...g.sourceUrls, ...urls])], cost, secs: (Date.now() - t0) / 1000 };
  } catch (e) { return errGuess(t0, `gemini ${String(e).slice(0, 80)}`); }
}

async function gpt55Guess(code: string): Promise<AiGuess> {
  const t0 = Date.now();
  try {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: "gpt-5.5", input: PROMPT(code), tools: [{ type: "web_search", search_context_size: "low" }], reasoning: { effort: "low" }, max_output_tokens: 6000, max_tool_calls: 5 }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json();
  if (!res.ok) return { brand: "", productName: "", confidence: 0, exactCodeFound: false, sourceUrls: [], basis: "", cost: 0, secs: (Date.now() - t0) / 1000, error: `openai ${res.status}` };
  let text = ""; let searches = 0; const urls: string[] = [];
  for (const item of data?.output ?? []) {
    if (item?.type === "web_search_call") searches++;
    if (item?.type !== "message") continue;
    for (const part of item?.content ?? []) if (part?.type === "output_text") { text += part.text ?? ""; for (const a of part.annotations ?? []) if (a?.type === "url_citation" && a.url) urls.push(a.url); }
  }
  const cost = ((data?.usage?.input_tokens ?? 0) / 1e6) * 5 + ((data?.usage?.output_tokens ?? 0) / 1e6) * 30 + searches * 0.01;
  const g = parseGuess(text);
  return { ...g, sourceUrls: [...new Set([...g.sourceUrls, ...urls])], cost, secs: (Date.now() - t0) / 1000 };
  } catch (e) { return errGuess(t0, `openai ${String(e).slice(0, 80)}`); }
}

// --- mock layer (LADDER_MOCK=1): canned guesses + fetch pages; asserts the ladder wiring ---
const MOCK_CODES = [
  { code: "078742028477", group: "upcEan", expected: "verified-ok", truth: "Member's Mark Purified Water 40 Pack" },
  { code: "X00MOCK111", group: "fnsku", expected: "suggest-only", truth: "Mock FNSKU product" },
  { code: "749000000010", group: "canary", expected: "must-refuse", truth: "does not exist" },
];
const mockGemini = async (code: string): Promise<AiGuess> => code === "078742028477"
  ? { brand: "Member's Mark", productName: "Purified Water 40 Pack", confidence: 0.95, exactCodeFound: true, sourceUrls: ["https://www.upcitemdb.com/upc/78742028477"], basis: "", cost: 0, secs: 0.1 }
  : code === "X00MOCK111"
    ? { brand: "MockCo", productName: "Mock FNSKU product", confidence: 0.3, exactCodeFound: false, sourceUrls: [], basis: "fnsku not public", cost: 0, secs: 0.1 }
    : { brand: "", productName: "Imaginary Thing", confidence: 0.2, exactCodeFound: false, sourceUrls: [], basis: "nothing found", cost: 0, secs: 0.1 };
const mockFetchImpl: FetchImpl = async (url) => ({
  ok: url.includes("78742028477"), status: url.includes("78742028477") ? 200 : 404,
  text: async () => url.includes("78742028477")
    ? `<html><head><title>Member's Mark Purified Water 40 pack 16.9 oz | UPCitemdb</title></head><body>UPC 078742028477 Member's Mark Purified Water</body></html>`
    : "",
});

type Row = { code: string; group: string; expected: string; truth: string };
type Result = Row & {
  codeType: string;
  stage: Record<string, unknown>;
  outcome: "verified" | "suggested" | "refused";
  product?: string;
  guessConfidence?: number;
  cost: number;
  secs: number;
};

// --- the ladder ---
async function runLadder(row: Row): Promise<Result> {
  const t0 = Date.now();
  const code = row.code;
  const codeType = detectCodeType(code);
  let cost = 0;
  const stage: Record<string, unknown> = {};

  // ASIN short-circuit (owner rule): dp page fetch decides
  if (looksLikeAsin(code)) {
    const a = await verifyAsinPage(code, MOCK ? { fetchImpl: mockFetchImpl } : undefined);
    stage.asin = a;
    const outcome = a.verified ? "verified" : "suggested";
    return { ...row, codeType, stage, outcome, cost, secs: (Date.now() - t0) / 1000 };
  }

  // Stage 1: Gemini guess
  const g = MOCK ? await mockGemini(code) : await geminiGuess(code);
  cost += g.cost; stage.gemini = g;

  // Stage 2: cheap verification - Gemini-cited URLs + tiered barcode DB URLs, real fetch machinery.
  // enrichWithPageFetch builds its OWN candidate list from the OLD 5-host barcodeDbUrls() internally
  // and merges it with whatever we pass as extraUrls (see pageFetch.ts:257: uniq([...extraUrls,
  // ...barcodeDbUrls(code)])). To actually exercise the NEW tiered pool (selectBarcodeUrls, up to
  // 15 hosts) we pass it explicitly as part of extraUrls, ahead of the Gemini-cited URLs so the
  // dedupe+slice(maxPages) keeps the broadest set. maxPages caps the total fetched at 8 per the brief.
  const combinedUrls = [...new Set([...g.sourceUrls.slice(0, 4), ...selectBarcodeUrls(code)])];
  const enrich = await enrichWithPageFetch({
    code,
    codeType,
    extraUrls: combinedUrls,
    maxPages: 8,
    fetchImpl: MOCK ? mockFetchImpl : undefined,
  });
  stage.fetch = { verified: enrich.evidence.verified, strength: enrich.evidence.strength, pages: enrich.pageCount, product: enrich.result?.productName ?? "" };
  // Hypothesis corroboration: fetched product agrees with Gemini's guess?
  const agree = enrich.result && g.productName ? crossCheck(enrich.result, normalizeResult({ productName: g.productName, brand: g.brand })).decision === "agree" : false;
  stage.agreeWithGemini = agree;

  if (enrich.result && enrich.evidence.verified && PUBLIC_BARCODE_TYPES.includes(String(codeType))) {
    return { ...row, codeType, stage, outcome: "verified", product: enrich.result.productName, cost, secs: (Date.now() - t0) / 1000 };
  }

  // Stage 3: gpt-5.5 boost, only when cheap verify failed
  const b = MOCK ? { ...(await mockGemini(code)), cost: 0 } : await gpt55Guess(code);
  cost += b.cost; stage.gpt55 = b;
  if (b.sourceUrls.length > 0 && !MOCK) {
    const enrich2 = await enrichWithPageFetch({ code, codeType, extraUrls: b.sourceUrls.slice(0, 6), maxPages: 6 });
    stage.fetch2 = { verified: enrich2.evidence.verified, strength: enrich2.evidence.strength, product: enrich2.result?.productName ?? "" };
    if (enrich2.result && enrich2.evidence.verified && PUBLIC_BARCODE_TYPES.includes(String(codeType))) {
      return { ...row, codeType, stage, outcome: "verified", product: enrich2.result.productName, cost, secs: (Date.now() - t0) / 1000 };
    }
  }

  // No verification anywhere -> suggested (best guess attached) or refused (no guess at all)
  const best = b.productName || g.productName;
  return { ...row, codeType, stage, outcome: best ? "suggested" : "refused", product: best, guessConfidence: Math.min(b.confidence || 0, 0.4) || Math.min(g.confidence || 0, 0.4), cost, secs: (Date.now() - t0) / 1000 };
}

// --- main ---
const rows: Row[] = MOCK ? MOCK_CODES : JSON.parse(readFileSync(new URL("../e2e/fixtures/dryrun-codes.json", import.meta.url), "utf8")).codes;
const WORST_PER_CODE = 0.3; // reviewer-corrected: 5.5 worst = 6K out ($0.18) + 5 searches ($0.05) + input; gemini search count uncapped by request -> extra headroom
const RESULTS_URL = new URL(MOCK ? "./tmp-ladder-mock-results.json" : "./tmp-ladder-dryrun-results.json", import.meta.url);

// RESUME: prior completed rows (incl. log-reconstructed ones) are skipped; their spend still
// counts against the cap so a crash can never launder budget.
let results: Result[] = [];
if (!MOCK) {
  try {
    const prior = JSON.parse(readFileSync(RESULTS_URL, "utf8"));
    results = (prior.rows ?? []).filter((r: Result) => r.outcome !== "error");
    spent = Number(prior.spent) || results.reduce((s: number, r: Result) => s + (r.cost ?? 0), 0);
    console.log(`RESUME: ${results.length} rows loaded, $${spent.toFixed(2)} already spent`);
  } catch { /* fresh run */ }
}
const done = new Set(results.map((r) => r.code));

for (const row of rows) {
  if (done.has(row.code)) continue;
  if (!MOCK && spent + WORST_PER_CODE > BUDGET_USD) { console.log(`BUDGET GUARD: stopping at ${row.code} ($${spent.toFixed(2)} spent)`); break; }
  let r: Result;
  try {
    r = await runLadder(row);
  } catch (e) {
    r = { ...row, outcome: "error", error: String(e).slice(0, 160), cost: 0, secs: 0 } as Result;
  }
  spent += r.cost ?? 0;
  results.push(r);
  console.log(`[${r.group}] ${r.code} -> ${r.outcome}${r.product ? ` "${r.product}"` : ""} | expected ${r.expected} | $${(r.cost ?? 0).toFixed(3)} | ${(r.secs ?? 0).toFixed(1)}s | spent $${spent.toFixed(2)}`);
  writeFileSync(RESULTS_URL, JSON.stringify({ spent, rows: results }, null, 2)); // incremental: crash-safe
}
writeFileSync(RESULTS_URL, JSON.stringify({ spent, rows: results }, null, 2));

if (MOCK) {
  const by = Object.fromEntries(results.map((r) => [r.code, r.outcome]));
  const ok = by["078742028477"] === "verified" && by["X00MOCK111"] === "suggested" && by["749000000010"] !== "verified";
  console.log(ok ? "MOCK SELF-TEST PASS" : `MOCK SELF-TEST FAIL: ${JSON.stringify(by)}`);
  process.exit(ok ? 0 : 1);
}
console.log(`\nDONE. Spend $${spent.toFixed(2)} of $${BUDGET_USD}.`);
