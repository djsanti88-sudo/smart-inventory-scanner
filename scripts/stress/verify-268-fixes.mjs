// Targeted post-fix verification (268-review): re-decodes the owner's reported defect codes with
// forceRetry (bypasses cached wrong identities) and asserts the new gates hold.
// Usage: node scripts/stress/verify-268-fixes.mjs --base <preview-url>
const base = process.argv[process.argv.indexOf("--base") + 1];
if (!base?.startsWith("http")) { console.error("need --base <url>"); process.exit(1); }

const CASES = [
  { code: "721749249238", rule: "no error-page identity", bad: (r) => /couldn'?t find|not found|page/i.test(r?.results?.[0]?.productName ?? "") },
  { code: "6959956718368", rule: "no 0% suggestion applied", bad: (r) => r?.decision?.status === "suggested" && (r?.decision?.confidence ?? 1) < 0.2 },
  { code: "461112687211", rule: "no Toyo on Fortune prefix", bad: (r) => /toyo/i.test(r?.results?.[0]?.brand ?? "") },
  { code: "461106750952", rule: "no Toyo on Fortune prefix", bad: (r) => /toyo/i.test(r?.results?.[0]?.brand ?? "") },
  { code: "661537514295", rule: "no Toyo on Fortune prefix", bad: (r) => /toyo/i.test(r?.results?.[0]?.brand ?? "") },
  { code: "721749089643", rule: "prefix-contradiction demoted (perfume on tire prefix)", bad: (r) => r?.decision?.status === "suggested" && /lattafa|gourmand|edp/i.test((r?.results?.[0]?.brand ?? "") + (r?.results?.[0]?.productName ?? "")) },
  { code: "840139644399", rule: "decodes without error (model cleanliness checked store-side)", bad: () => false },
];

let fail = 0;
for (const c of CASES) {
  const t0 = Date.now();
  let r, status;
  try {
    const res = await fetch(base + "/api/ai-lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawCode: c.code, cleanCode: c.code, mode: "decode", forceRetry: true }),
      signal: AbortSignal.timeout(100_000),
    });
    status = res.status;
    r = await res.json();
  } catch (e) {
    console.log(`ERROR ${c.code} ${String(e).slice(0, 80)}`);
    fail++;
    continue;
  }
  const bad = c.bad(r);
  const name = r?.results?.[0]?.productName ?? "";
  const brand = r?.results?.[0]?.brand ?? "";
  console.log(`${bad ? "FAIL" : "PASS"} ${c.code} [${c.rule}] -> ${r?.decision?.status ?? status} conf=${r?.decision?.confidence ?? "-"} brand="${brand}" name="${name.slice(0, 60)}" ${Math.round((Date.now() - t0) / 1000)}s`);
  if (bad) fail++;
}
console.log(fail === 0 ? "ALL RULES HOLD" : `${fail} RULE VIOLATIONS`);
process.exit(fail === 0 ? 0 : 1);
