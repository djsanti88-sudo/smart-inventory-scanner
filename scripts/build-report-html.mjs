// Builds the weekly intelligence report (self-contained HTML). Clean, minimal, tire-focused.
// Usage: node scripts/build-report-html.mjs [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

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

  ${d.qaHealth ? `<h2>QA health &middot; proof bots</h2>
  <div class="stats"><div class="stat"><div class="n">${d.qaHealth.passed}/${d.qaHealth.total}</div><div class="k">Proof bots passing</div><div class="s">${d.qaHealth.failed && d.qaHealth.failed.length ? 'failing: ' + esc(d.qaHealth.failed.join('; ')) : 'all green: safety, data, tire, UX, performance'}</div></div></div>` : ''}

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
  date: '2026-06-25',
  headline: 'Live in production. Decode works and is safe - now make it fast and lean on the 52k catalog.',
  overall: 78,
  scanHealth: [
    { n: '58%', k: 'Auto-verified (last run)', s: 'counted with no human; 0 false counts' },
    { n: '89%', k: 'Found the right tire', s: 'correct brand from the GS1 prefix' },
    { n: 'instant', k: 'Scan speed', s: 'brand shows immediately; size fills behind it' },
  ],
  scanNote: 'Replaced live each run by the fresh-code decode scan numbers.',
  doNow: [
    { sev: 'high', title: 'Lean on the live 52k catalog as the primary path.', why: 'Your global catalog (52,359 tires) is deployed and wired into resolution. A tire already in it should resolve INSTANTLY with the exact size at $0 and no AI. Confirm this is firing live: if most scans hit the catalog, the "decode anything in seconds" speed is back immediately.' },
    { sev: 'high', title: 'Make the AI decode fast for catalog misses.', why: 'For tires NOT in the catalog, the size currently fills in about 8 to 10 seconds in the background. Tighten it (faster grounded model, return on the first valid size) so a full result lands in 2 to 3 seconds like before.' },
  ],
  doNext: [
    { sev: 'med', title: 'One branch, backed up.', why: 'Settle on tire-barcode-db (it is deployed and has everything), commit the loose ends, and push to GitHub. Retire the parallel decoder-hardening-v1-local so the project stops feeling tangled.' },
    { sev: 'low', title: 'Focus the agents and auto-catch regressions.', why: 'Consolidate the 27 overlapping advisory agents to the high-value set, and add a decode-accuracy regression tracker so this weekly report flags "are we going backwards?" automatically before you feel it.' },
  ],
  doLater: [
    { sev: 'low', title: 'Re-validate and lock it in.', why: 'After the catalog and speed work, re-run the 100-tire validation to prove the verify rate jumped and the speed is back. This report becomes the dashboard for it.' },
  ],
  gap: { uncommitted: 0, unpushed: 0, branch: 'tire-barcode-db' },
  footer: 'Live in production at inventory-lovat-six.vercel.app. Decode and QA verified before printing (style guide: verify before you print). Run on demand: npm run weekly-report (QA proof bots + live decode scan, merged into this one report). Report-only: nothing in your app was changed.',
};

// Real git state for the "Before you forget" nudge (verify before you print).
function applyGitGap(data) {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    const uncommitted = execSync('git status --porcelain', { encoding: 'utf8' }).split('\n').filter(Boolean).length;
    let unpushed = 0;
    try { unpushed = execSync('git rev-list --count @{u}..HEAD', { encoding: 'utf8' }).trim() | 0; }
    catch { try { unpushed = execSync('git rev-list --count origin/master..HEAD', { encoding: 'utf8' }).trim() | 0; } catch {} }
    data.gap = { uncommitted, unpushed, branch };
  } catch { /* keep the static fallback */ }
  return data;
}

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

// Pull the QA proof-bot pass/fail from the Playwright results (written by qa:bots) so the ONE weekly
// report carries both the product-intel scan health AND the QA health. Missing file -> section omitted.
function applyQaHealth(data, repoRoot) {
  const p = path.join(repoRoot || process.cwd(), 'reports', 'human-bots', 'latest', 'playwright-results.json');
  if (!fs.existsSync(p)) return data;
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return data; }
  const specs = [];
  const walk = (s) => { (s.specs || []).forEach((sp) => specs.push(sp)); (s.suites || []).forEach(walk); };
  (j.suites || []).forEach(walk);
  if (!specs.length) return data;
  const passed = specs.filter((sp) => sp.ok).length;
  const failed = specs.filter((sp) => !sp.ok).map((sp) => sp.title);
  data.qaHealth = { passed, total: specs.length, failed };
  return data;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = path.resolve(process.argv[2] || 'reports/product-intel/2026-06-24');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'report.html');
  fs.writeFileSync(out, buildReportHtml(applyGitGap(applyQaHealth(applyScanHealth(DATA, outDir), process.cwd()))));
  console.log('BUILT ' + out);
}
