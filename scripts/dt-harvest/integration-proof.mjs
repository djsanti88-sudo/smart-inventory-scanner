// DT harvest Task 6 Step 2: integration proof - 10 newly-added Discount Tire GTINs
// resolve through the REAL decode route at the FREE corpus rung ($0, no paid provider).
// Run against a dev server started with paid-provider keys BLANKED, so a paid rung is
// impossible: any resolution MUST come from the local corpus. Proves the applied rows
// are live in production's rung-1 path, not just present in the DB file.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PROOF_PORT || "3109";
const BASE = `http://localhost:${PORT}`;

// 10 GTINs the apply step reported as NEWLY added (spot-check sample), across brands.
const CODES = [
  "092971223670", "086699385932", "721506740220", "848983008237", "6419440288420",
  "715459479207", "758823001796", "6932877105172", "6953913130491", "054137093626",
];

async function decode(code) {
  const res = await fetch(`${BASE}/api/ai-lookup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, mode: "decode", scanContext: "tire" }),
  });
  const body = await res.json();
  return { code, status: body?.decision?.status ?? "(none)", path: body?.debug?.path ?? body?.debug?.corroborationPath ?? "?", aiCalled: body?.debug?.aiCalled ?? body?.aiCalled ?? null, name: body?.results?.[0]?.productName ?? body?.decision?.productName ?? "" };
}

async function main() {
  const results = [];
  for (const code of CODES) {
    try {
      results.push(await decode(code));
    } catch (err) {
      results.push({ code, status: "ERROR", path: err.message.split("\n")[0], aiCalled: null, name: "" });
    }
  }
  let pass = 0;
  for (const r of results) {
    // Success = resolved (verified/known) from a corpus/local path with NO AI call.
    const corpusPath = /corpus|tire|exact|known/i.test(r.path);
    const resolved = /verified|known/i.test(r.status);
    const free = r.aiCalled === false || r.aiCalled === null;
    const ok = resolved && corpusPath && free;
    if (ok) pass++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${r.code}  status=${r.status} path=${r.path} aiCalled=${r.aiCalled} name="${r.name}"`);
  }
  console.log(`\nIntegration proof: ${pass}/${CODES.length} newly-added DT GTINs resolve verified at the free corpus rung.`);
  process.exitCode = pass === CODES.length ? 0 : 1;
}
main();
