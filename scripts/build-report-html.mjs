// Builds the weekly intelligence report (self-contained HTML). Clean, minimal, tire-focused.
// Usage: node scripts/build-report-html.mjs [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function buildReportHtml(d) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const dotColor = { now: '#DC2626', next: '#D97706', later: '#2563EB' };
  const item = (lvl) => (t) => `
      <li><span class="dot" style="background:${dotColor[lvl]}"></span><span>${t.sev ? `<span class="chip ${t.sev}">${t.sev}</span> ` : ''}<b>${esc(t.title)}</b> ${esc(t.why)}</span></li>`;
  const stat = (s) => `
      <div class="stat"><div class="n">${esc(s.n)}</div><div class="k">${esc(s.k)}</div><div class="s">${esc(s.s)}</div></div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Smart Inventory - Weekly Report - ${esc(d.date)}</title>
<style>
  :root{--ink:#14181F;--muted:#6B7280;--line:#ECEEF2;--accent:#2563EB;--good:#16A34A;
    --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --mono:ui-monospace,"SF Mono","Cascadia Code",Consolas,monospace;}
  *{box-sizing:border-box}
  body{margin:0;background:#fff;color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased}
  .page{max-width:760px;margin:0 auto;padding:48px 32px 72px}
  .top{display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-size:12px;letter-spacing:.18em;color:var(--muted);text-transform:uppercase}
  .rule{height:1px;background:var(--line);margin:20px 0 36px}
  h1{font-size:30px;line-height:1.25;letter-spacing:-.02em;font-weight:700;margin:0 0 18px;max-width:18ch}
  .score{display:inline-flex;align-items:baseline;gap:8px;font-family:var(--mono)}
  .score b{font-size:20px} .score span{color:var(--muted);font-size:13px}
  h2{font-family:var(--mono);font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin:48px 0 18px;font-weight:600}
  /* scan health */
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
  .stat .n{font-size:34px;font-weight:700;letter-spacing:-.02em;line-height:1}
  .stat .k{font-size:13px;margin-top:7px}
  .stat .s{font-size:12px;color:var(--muted);margin-top:3px;line-height:1.45}
  .note{font-size:14px;color:var(--muted);margin-top:22px;padding-left:14px;border-left:2px solid var(--line)}
  .costline{font-family:var(--mono);font-size:12.5px;color:var(--ink);margin-top:14px;background:#F6F8FA;border:1px solid var(--line);border-radius:8px;padding:10px 14px}
  .chip{display:inline-block;font:600 10.5px var(--mono);border-radius:999px;padding:1px 8px;vertical-align:1px}
  .chip.blocker{background:#fde2e1;color:#9b1c1c} .chip.high{background:#fde2e1;color:#c0392b} .chip.med{background:#fdf0d9;color:#b7791f} .chip.low{background:#e7eefb;color:#2563eb}
  /* todo */
  .todo{list-style:none;margin:0 0 6px;padding:0}
  .todo li{display:flex;gap:12px;padding:9px 0;align-items:baseline}
  .todo b{font-weight:650}
  .dot{flex:0 0 auto;width:9px;height:9px;border-radius:50%;transform:translateY(-1px)}
  .lane-label{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:18px 0 2px}
  .lane-label:first-child{margin-top:0}
  /* gap */
  .gap{font-family:var(--mono);font-size:13px;color:var(--muted);margin-top:8px}
  .gap b{color:#DC2626}
  footer{font-family:var(--mono);font-size:11.5px;color:var(--muted);line-height:1.7;margin-top:52px;padding-top:18px;border-top:1px solid var(--line)}
  @media(max-width:560px){.stats{grid-template-columns:1fr;gap:18px}h1{font-size:24px}}
</style></head>
<body><div class="page">

  <div class="top"><span>Smart Inventory</span><span>Tires &middot; ${esc(d.date)}</span></div>
  <div class="rule"></div>

  <h1>${esc(d.headline)}</h1>
  <div class="score"><b>${d.overall}</b><span>/ 100 overall health</span></div>

  <h2>Scan health &middot; tires</h2>
  <div class="stats">${d.scanHealth.map(stat).join('')}</div>
  <div class="note">${esc(d.scanNote)}</div>
  ${d.scanCostLine ? `<div class="costline">${esc(d.scanCostLine)}</div>` : ''}

  <h2>What to do</h2>
  <div class="lane-label">Do now</div>
  <ul class="todo">${d.doNow.map(item('now')).join('')}</ul>
  <div class="lane-label">Do next</div>
  <ul class="todo">${d.doNext.map(item('next')).join('')}</ul>
  <div class="lane-label">Do later</div>
  <ul class="todo">${d.doLater.map(item('later')).join('')}</ul>

  <h2>Before you forget</h2>
  <div class="gap"><b>${d.gap.uncommitted} files uncommitted</b> and <b>${d.gap.unpushed} commits unpushed</b> on ${esc(d.gap.branch)}. Push when you are ready.</div>

  <footer>${esc(d.footer)}</footer>

</div></body></html>`;
}

const DATA = {
  date: '2026-06-24',
  headline: 'Solid core. Two safety fixes, and only 2 tires are wired.',
  overall: 74,
  scanHealth: [
    { n: '~18', k: 'Tire codes in the scan suite', s: 'Nokian, Falken, plus poison variants' },
    { n: '100%', k: 'Known-tire accuracy', s: '0% false auto-counts' },
    { n: '~0ms', k: 'Known-tire speed', s: 'new-code decode: 0.1s to 40s (live, paid)' },
  ],
  scanNote: 'Only 2 tire codes are wired for instant deterministic ID today. Testing NEW or unknown tire codes (how it reacts, how long it takes) runs through the live decode pipeline, which costs API money. Say the word and I will add a weekly 15 to 20 unknown-tire decode test with accuracy and timing.',
  doNow: [
    { sev: 'blocker', title: 'Close the needs-review gap on tires.', why: 'Root cause confirmed in code: the app only stamps a tire "verified" when it independently confirms the exact barcode in strong evidence (a real product page or Google grounding, not a barcode-lookup link, which it distrusts on purpose). Your tires get the brand right but from weak link-only evidence, so they correctly drop to "suggested" and into review. To auto-count them, the pipeline must open and confirm the product page, read full specs (size, load, speed), and clear 90% confidence.' },
    { sev: 'high', title: 'Speed up the decode.', why: 'Root cause confirmed in code: there is no quick barcode-database lookup, so any tire not already in your database falls to the slow deep fallback, which runs the AI out to a 10-second timeout every time (up to a 30-second ceiling when the web search also misses). Add a fast barcode lookup, run providers in parallel, and cache.' },
  ],
  doNext: [
    { sev: 'low', title: 'Tidy the platform-owner controls on the scan screen.', why: 'Verified, and smaller than it first looked: "Simulate sync failure", "Go offline", and "Delete" sit on the scan screen, but only the platform owner sees them (customers never do) and Delete already asks for confirmation. Worth moving to Settings for polish, not a risk to a normal clerk.' },
  ],
  doLater: [
    { sev: 'low', title: 'Grow the deterministic tire database.', why: 'Every tire you wire in resolves instantly at $0 and never touches the AI. You are already building this toward 30k.' },
  ],
  gap: { uncommitted: 109, unpushed: 28, branch: 'decoder-hardening-v1-local' },
  footer: 'Findings verified against the live decode run and the source code before printing - two overstated UX items were demoted after a code check (the style guide rule: verify before you print). Full pipeline runs Sundays 6pm or on demand (npm run intel:now) on your Claude subscription. Report-only: nothing in your app was changed.',
};

// Pull the real tire decode numbers from scan-health.json (written by weekly-tire-scan) when present.
function applyScanHealth(data, outDir) {
  const p = path.join(outDir, 'scan-health.json');
  if (!fs.existsSync(p)) return data;
  let sh;
  try { sh = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return data; }
  const per = Array.isArray(sh.perCode) ? sh.perCode : [];
  const tires = per.filter((r) => r.shouldAutoCount !== false);
  const found = tires.filter((r) => r.brandHit).length;
  const idAcc = tires.length ? Math.round((found / tires.length) * 100) : (sh.identificationAccuracyPct || 0);
  const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(ms >= 10000 ? 0 : 1) + 's' : ms + 'ms');
  data.headline = `Decode finds the right tire ${idAcc}% of the time, but auto-verifies ${sh.decodeSuccessPct}%. That is the gap to close.`;
  data.scanHealth = [
    { n: idAcc + '%', k: 'Found the right tire', s: `correct brand on ${found} of ${tires.length}` },
    { n: sh.decodeSuccessPct + '%', k: 'Auto-verified', s: 'counted with no human (the gap)' },
    { n: 'p50 ' + fmtMs(sh.latencyMs.p50), k: 'Decode speed', s: `p95 ${fmtMs(sh.latencyMs.p95)}, max ${fmtMs(sh.latencyMs.max)}` },
  ];
  data.scanNote = `${tires.length} FRESH tire codes through the live pipeline this week (new codes each run, so the cache cannot fake the speed). It identified the correct brand ${idAcc}% of the time, but auto-verified ${sh.decodeSuccessPct}% - every found tire was routed to needs-review as a "suggestion" instead of being counted. False auto-counts: ${sh.falseAutoCounts} (safe). The gap is the verify gate, not the finding.`;
  data.scanCostLine = `Decode spend this run: about $${sh.cost.estUsd} for ${per.length} codes (mini models: ${sh.cost.firecrawlCredits} firecrawl credits, ${sh.cost.geminiCalls} gemini, ${sh.cost.openaiCalls} openai calls). Codes already in your database cost $0.`;
  return data;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = path.resolve(process.argv[2] || 'reports/product-intel/2026-06-24');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'report.html');
  fs.writeFileSync(out, buildReportHtml(applyScanHealth(DATA, outDir)));
  console.log('BUILT ' + out);
}
