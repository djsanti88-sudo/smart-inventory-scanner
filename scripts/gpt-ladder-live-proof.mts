// GPT-5.5 ladder LIVE proof (Build 1, Task 7). Owner-authorized in the autonomous-run order.
// Order: canaries FIRST (junk codes must never verify/suggest), then the 53-code fetchV2 residue.
// HARD budget stop: spent + 0.39 > $7.00 aborts before the call (actuals from response usage).
// Crash-safe incremental writes; resume-skip on re-run.
// Run: npx tsx scripts/gpt-ladder-live-proof.mts --live
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gptFromScratch, GPT_LADDER_WORST_CASE_USD, type GptFromScratchResult } from "../src/services/ai/gptFromScratch";
import { shouldRunGptRung } from "../src/services/ai/gptLadderRung";
import { detectCodeType } from "../src/services/codeTypeDetector";

const LIVE = process.argv.includes("--live");
if (!LIVE) { console.error("live GPT-5.5 spend; pass --live to confirm"); process.exit(1); }
const HARD_CAP_USD = 7.0;
const OUT = new URL("./gpt-ladder-live-results.json", import.meta.url);

// .env.local -> process.env (values never logged)
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey) { console.error("OPENAI_API_KEY missing"); process.exit(1); }

// Canaries first (same set as the fetchV2 campaigns): unassigned-but-valid UPCs, invented vendor
// codes, and X00 FNSKUs. The vendor/X00 shapes must be BLOCKED by the rung's own gate at $0.
const CANARIES: Array<{ code: string; kind: string }> = [
  { code: "749000000015", kind: "unassigned_upc" },
  { code: "749000000022", kind: "unassigned_upc" },
  { code: "749000000039", kind: "unassigned_upc" },
  { code: "749000000046", kind: "unassigned_upc" },
  { code: "ZQX-99417-B", kind: "invented_vendor" },
  { code: "KMD-40521-X", kind: "invented_vendor" },
  { code: "VTR-88316-A", kind: "invented_vendor" },
  { code: "X00ZZZ9ZZ9", kind: "fnsku" },
  { code: "X00QZ9WZ9Q", kind: "fnsku" },
  { code: "X00Z9VZ0Z9", kind: "fnsku" },
];

const handoff: Array<{ code: string; group: string; outcome: string }> = JSON.parse(
  readFileSync(new URL("./fetchv2-ladder-handoff.json", import.meta.url), "utf8"),
);
const fixture = JSON.parse(readFileSync(new URL("./fetchv2-db-sample-200.json", import.meta.url), "utf8"));
const truthOf = new Map<string, string>(fixture.codes.map((c: { code: string; truth?: string }) => [c.code, c.truth ?? ""]));

interface Row {
  code: string; phase: "canary" | "residue"; kind?: string; group?: string;
  gate: "ran" | "blocked"; skipReason?: string;
  tier?: string; productName?: string; brand?: string; confidence?: number; exactCodeFound?: boolean;
  basis?: string; searches?: number; secs?: number; usd?: number; error?: string;
  truth?: string;
}

let rows: Row[] = [];
let spent = 0;
if (existsSync(OUT)) {
  const prev = JSON.parse(readFileSync(OUT, "utf8"));
  rows = prev.rows ?? [];
  spent = prev.spentUsd ?? 0;
}
const done = new Set(rows.map((r) => r.code));
const save = () => writeFileSync(OUT, JSON.stringify({ spentUsd: +spent.toFixed(4), hardCapUsd: HARD_CAP_USD, rows }, null, 1));

async function probe(code: string, phase: Row["phase"], extra: Partial<Row>): Promise<"ok" | "budget_stop"> {
  if (done.has(code)) return "ok";
  const codeType = detectCodeType(code);
  const gate = shouldRunGptRung({
    code, codeType, priorStatus: undefined, e2e: false, apiKeyPresent: true,
    budget: () => ({ allowed: spent + GPT_LADDER_WORST_CASE_USD <= HARD_CAP_USD, spentUsd: spent, capUsd: HARD_CAP_USD }),
  });
  if (!gate.run) {
    if (gate.skipReason === "budget_exceeded") return "budget_stop";
    rows.push({ code, phase, gate: "blocked", skipReason: gate.skipReason, usd: 0, ...extra });
    console.log(`[${rows.length}] ${code} BLOCKED (${gate.skipReason}) $0`);
    save();
    return "ok";
  }
  const t0 = Date.now();
  const r: GptFromScratchResult = await gptFromScratch(code, { apiKey });
  spent += r.usdActual;
  rows.push({
    code, phase, gate: "ran", tier: r.tier, productName: r.productName, brand: r.brand,
    confidence: r.confidence, exactCodeFound: r.exactCodeFound, basis: r.basis, searches: r.searches,
    secs: +((Date.now() - t0) / 1000).toFixed(2), usd: +r.usdActual.toFixed(4), error: r.error,
    truth: truthOf.get(code) ?? "", ...extra,
  });
  console.log(`[${rows.length}] ${code} -> ${r.tier} | ${(r.productName || r.error || "").slice(0, 60)} (${r.searches} srch, $${r.usdActual.toFixed(3)}, total $${spent.toFixed(2)})`);
  save();
  return "ok";
}

async function main() {
  console.log(`GPT-5.5 ladder live proof. Hard cap $${HARD_CAP_USD}. Resuming with ${rows.length} rows, $${spent.toFixed(2)} spent.`);
  for (const c of CANARIES) {
    if ((await probe(c.code, "canary", { kind: c.kind })) === "budget_stop") { console.log("BUDGET STOP"); return; }
  }
  const canaryFails = rows.filter((r) => r.phase === "canary" && (r.tier === "verified" || r.tier === "suggested"));
  if (canaryFails.length > 0) {
    console.error(`CANARY GATE FAILED: ${canaryFails.map((r) => r.code + ":" + r.tier).join(", ")} - HALTING before residue.`);
    return;
  }
  console.log("Canary gate PASSED (zero verified/suggested). Residue phase.");
  for (const h of handoff) {
    if ((await probe(h.code, "residue", { group: h.group })) === "budget_stop") { console.log("BUDGET STOP - residue truncated (documented, not silent)"); break; }
  }
  const ran = rows.filter((r) => r.gate === "ran");
  const tiers: Record<string, number> = {};
  for (const r of ran) tiers[r.tier ?? "?"] = (tiers[r.tier ?? "?"] ?? 0) + 1;
  console.log(`done. rows=${rows.length} ran=${ran.length} tiers=${JSON.stringify(tiers)}`);
  console.log(`computed floor $${spent.toFixed(2)}; true spend = OpenAI console`);
}
main().then(() => save());
