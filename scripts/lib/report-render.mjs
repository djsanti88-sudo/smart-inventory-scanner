// Deterministic HTML renderer for the weekly report. One self-contained file (inline CSS, no assets).
// Groups findings BY TEAM, assigns every finding a stable reference NUMBER (#1, #2, ...) sorted by
// severity then team, renders a 16-dimension score grid, a 7+ competitor table, the decode accuracy
// scorecard, what-changed, and the two-currency cost ledger. No em or en dashes in any copy.
//
// Run:  node scripts/lib/report-render.mjs <data.json> <out.html>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { costToHtml } from './cost-ledger.mjs';

const TEAMS = [
  { key: 'technical_qa', name: 'Technical and QA' },
  { key: 'security', name: 'Security and Data Protection' },
  { key: 'decode', name: 'Barcode, Inventory and Decode' },
  { key: 'business', name: 'Business and Product' },
  { key: 'verification', name: 'Verification and Synthesis' },
];

const SEV = {
  blocker: { rank: 0, label: 'BLOCKER', sq: '#7f1d1d', bg: '#fee2e2', fg: '#7f1d1d' },
  high: { rank: 1, label: 'HIGH', sq: '#dc2626', bg: '#fee2e2', fg: '#991b1b' },
  medium: { rank: 2, label: 'MEDIUM', sq: '#d97706', bg: '#ffedd5', fg: '#9a3412' },
  low: { rank: 3, label: 'LOW', sq: '#ca8a04', bg: '#fef9c3', fg: '#854d0e' },
  info: { rank: 4, label: 'INFO', sq: '#2563eb', bg: '#dbeafe', fg: '#1e40af' },
};
const sev = (s) => SEV[String(s || 'info').toLowerCase()] || SEV.info;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function arrow(d) {
  if (d == null || d === '') return ''; // no history yet -> no arrow (not a misleading "flat")
  const n = Number(d) || 0;
  if (n > 0) return `<span style="color:#16a34a">up ${n}</span>`;
  if (n < 0) return `<span style="color:#dc2626">down ${Math.abs(n)}</span>`;
  return `<span style="color:#6b7280">flat</span>`;
}
function conf(c) {
  const m = { high: '#16a34a', medium: '#d97706', low: '#dc2626' };
  const k = String(c || 'low').toLowerCase();
  return `<span style="font-size:11px;color:${m[k] || '#6b7280'}">confidence ${esc(k)}</span>`;
}
// Assign stable reference numbers: sort by severity rank, then team order, then title.
function assignRefs(findings) {
  const teamOrder = Object.fromEntries(TEAMS.map((t, i) => [t.key, i]));
  const sorted = [...(findings || [])].sort((a, b) => {
    const r = sev(a.severity).rank - sev(b.severity).rank;
    if (r) return r;
    const t = (teamOrder[a.team] ?? 9) - (teamOrder[b.team] ?? 9);
    if (t) return t;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
  sorted.forEach((f, i) => { f.ref = i + 1; });
  return sorted;
}

function thumb(screenshot) {
  if (!screenshot) return '';
  const rel = esc(screenshot);
  return `<a href="${rel}" target="_blank"><img src="${rel}" alt="proof" style="max-width:220px;max-height:150px;border:1px solid #e5e7eb;border-radius:6px;margin-top:8px"/></a>`;
}

function findingCard(f) {
  const s = sev(f.severity);
  const statusBadge = f.status && f.status !== 'new'
    ? `<span style="font-size:11px;padding:1px 6px;border-radius:4px;background:#f3f4f6;color:#374151;margin-left:6px">${esc(f.status)}</span>` : '';
  const refuted = f.refuterResult
    ? `<div style="font-size:12px;color:#6b7280;margin-top:4px">Adversarial check: ${esc(typeof f.refuterResult === 'string' ? f.refuterResult : JSON.stringify(f.refuterResult))}</div>` : '';
  const rows = [];
  if (f.affects) rows.push(`<strong>Who it affects:</strong> ${esc(f.affects)}`);
  if (f.businessImpact) rows.push(`<strong>Business impact:</strong> ${esc(f.businessImpact)}`);
  if (f.securityImpact) rows.push(`<strong>Security impact:</strong> ${esc(f.securityImpact)}`);
  if (f.file) rows.push(`<strong>Where:</strong> <code style="font-size:12px">${esc(f.file)}</code>`);
  if (f.evidence && f.evidence.length) rows.push(`<strong>Evidence:</strong> ${esc(f.evidence.join('; '))}`);
  const meta = rows.length ? `<div style="font-size:13px;color:#374151;margin-top:6px;line-height:1.6">${rows.join('<br/>')}</div>` : '';
  return `
  <div id="f${f.ref}" style="border:1px solid #e5e7eb;border-left:4px solid ${s.sq};border-radius:8px;padding:12px 14px;margin:10px 0;background:#fff">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="font-weight:800;font-size:15px;color:#111827">#${f.ref}</span>
      <span style="display:inline-block;width:11px;height:11px;border-radius:2px;background:${s.sq}"></span>
      <span style="font-size:11px;font-weight:700;color:${s.fg};background:${s.bg};padding:1px 7px;border-radius:4px">${s.label}</span>
      <span style="font-weight:600;color:#111827">${esc(f.title)}</span>${statusBadge}
      ${f.ownerActionNeeded ? '<span style="font-size:11px;color:#9a3412;background:#ffedd5;padding:1px 7px;border-radius:4px">owner action needed</span>' : ''}
      <span style="margin-left:auto">${conf(f.confidence)}</span>
    </div>
    ${f.explanation ? `<div style="font-size:14px;color:#1f2937;margin-top:8px;line-height:1.55">${esc(f.explanation)}</div>` : ''}
    ${meta}
    ${f.fix ? `<div style="font-size:13px;color:#065f46;background:#ecfdf5;border-radius:6px;padding:8px 10px;margin-top:8px"><strong>Fix (#${f.ref}):</strong> ${esc(f.fix)} ${f.autoFixable ? '<em>(auto-fixable)</em>' : ''}</div>` : ''}
    ${refuted}
    ${thumb(f.screenshot)}
  </div>`;
}

function teamSection(team, findings) {
  const mine = findings.filter((f) => f.team === team.key);
  if (!mine.length) return '';
  const scoreNote = (() => {
    const blockers = mine.filter((f) => sev(f.severity).rank <= 1).length;
    return `${mine.length} finding(s), ${blockers} high or blocker`;
  })();
  return `
  <section style="margin-top:26px">
    <h2 style="font-size:18px;margin:0 0 2px;border-bottom:2px solid #111827;padding-bottom:6px">${esc(team.name)}</h2>
    <div style="font-size:12px;color:#6b7280;margin:6px 0">${scoreNote}</div>
    ${mine.map(findingCard).join('')}
  </section>`;
}

function topPriorities(findings, priorities) {
  // priorities may be {ref,line} OR qa-triage's {title,severity}. Refs are assigned at render time,
  // so resolve each priority to a finding (by ref, else by title) AFTER numbering. Else top 5 by severity.
  const norm = (priorities && priorities.length)
    ? priorities.map((p) => {
        const byRef = p.ref != null ? findings.find((x) => x.ref === p.ref) : null;
        const byTitle = byRef || findings.find((x) => String(x.title || '').trim() === String(p.title || p.line || '').trim());
        return { ref: byTitle ? byTitle.ref : null, line: p.line || p.title || (byTitle && byTitle.title) || '', sevKey: byTitle ? byTitle.severity : p.severity };
      })
    : findings.slice(0, 5).map((f) => ({ ref: f.ref, line: f.title, sevKey: f.severity }));
  const li = norm.map((p) => {
    const s = sev(p.sevKey);
    const num = p.ref != null ? `<strong>#${p.ref}</strong> ` : '';
    return `<li style="margin:6px 0"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${s.sq};margin-right:6px"></span>${num}${esc(p.line)}</li>`;
  }).join('');
  return `
  <section style="margin-top:18px;padding:14px 16px;border-radius:10px;background:#f9fafb;border:1px solid #e5e7eb">
    <h2 style="font-size:18px;margin:0 0 6px">Top priorities this week</h2>
    <ol style="margin:0;padding-left:20px;font-size:14px;color:#111827">${li}</ol>
    <div style="font-size:12px;color:#6b7280;margin-top:8px">Reference items by number. You can tell me "do all except #3 and #7".</div>
  </section>`;
}

function blockers(findings) {
  const b = findings.filter((f) => sev(f.severity).rank === 0 || f.status === 'worsened' || f.status === 'regressed');
  if (!b.length) return '';
  const li = b.map((f) => `<li><strong>#${f.ref}</strong> ${esc(f.title)} ${f.status && f.status !== 'new' ? `(${esc(f.status)})` : ''}</li>`).join('');
  return `<section style="margin-top:16px;padding:12px 16px;border-radius:8px;background:#7f1d1d;color:#fee2e2"><h2 style="margin:0 0 6px;font-size:16px">Blockers and regressions</h2><ul style="margin:0;padding-left:18px">${li}</ul></section>`;
}

function scoreGrid(scores) {
  if (!scores || !scores.length) return '';
  const cards = scores.map((d) => {
    const v = Number(d.score) || 0;
    const color = v >= 80 ? '#16a34a' : v >= 60 ? '#d97706' : '#dc2626';
    return `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px">
      <div style="font-size:12px;color:#6b7280">${esc(d.dimension)}</div>
      <div style="font-size:22px;font-weight:800;color:${color}">${v}<span style="font-size:12px;color:#9ca3af">/100</span> <span style="font-size:12px;font-weight:500">${arrow(d.delta)}</span></div>
      <div>${conf(d.confidence)}</div>
      ${d.reason ? `<div style="font-size:12px;color:#374151;margin-top:4px">${esc(d.reason)}</div>` : ''}
      ${d.topFix ? `<div style="font-size:12px;color:#1d4ed8;margin-top:4px">Top fix: ${esc(d.topFix)}</div>` : ''}
    </div>`;
  }).join('');
  return `<section style="margin-top:22px"><h2 style="font-size:18px;margin:0 0 8px">Score grid</h2><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">${cards}</div></section>`;
}

function competitorTable(c) {
  if (!c || !c.rows || !c.rows.length) return '';
  const cols = c.columns || ['Competitor', 'Target customer', 'Pricing', 'Inventory', 'Scanning', 'Tire support', 'Integrations', 'AI/automation', 'We win', 'We lose', 'Wedge'];
  const head = cols.map((h) => `<th style="text-align:left;padding:6px 8px;border-bottom:2px solid #e5e7eb;font-size:12px">${esc(h)}</th>`).join('');
  const body = c.rows.map((r) => {
    const cells = Array.isArray(r) ? r : cols.map((_, i) => r[Object.keys(r)[i]]);
    return `<tr>${cells.map((cell) => `<td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;font-size:12px;vertical-align:top">${esc(cell)}</td>`).join('')}</tr>`;
  }).join('');
  const src = c.sourceNote ? `<div style="font-size:12px;color:#6b7280;margin-top:6px">${esc(c.sourceNote)}</div>` : '';
  return `<section style="margin-top:24px"><h2 style="font-size:18px;margin:0 0 8px">Competitor comparison (${c.rows.length})</h2><div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${src}</section>`;
}

function accuracySection(a) {
  if (!a) return '';
  const banner = a.provisional
    ? `<div style="padding:8px 12px;border-radius:6px;background:#fef9c3;color:#854d0e;font-size:13px;margin-bottom:8px">PROVISIONAL: the 10 ground-truth codes are not owner-confirmed yet, so this score is not trustworthy. Confirm data/accuracy/hard-codes.json to make it real.</div>`
    : '';
  const rows = (a.perCode || []).map((p) => {
    const ok = p.verdict === 'correct' ? '#16a34a' : p.verdict === 'wrong' ? '#dc2626' : '#d97706';
    return `<tr><td style="padding:5px 8px;font-family:monospace;font-size:12px">${esc(p.code)}</td><td style="padding:5px 8px;font-size:12px">${esc(p.expected)}</td><td style="padding:5px 8px;font-size:12px">${esc(p.got)}</td><td style="padding:5px 8px;font-size:12px;color:${ok};font-weight:700">${esc(p.verdict)}</td><td style="padding:5px 8px;font-size:12px">${esc(p.note || '')}</td></tr>`;
  }).join('');
  return `<section style="margin-top:24px"><h2 style="font-size:18px;margin:0 0 8px">Live decode accuracy</h2>${banner}
    <div style="font-size:14px;margin-bottom:8px">Correct ${a.correct || 0} / Wrong ${a.wrong || 0} / Needs Review ${a.needsReview || 0} of ${a.total || 0}</div>
    <table style="width:100%;border-collapse:collapse"><thead><tr style="border-bottom:2px solid #e5e7eb"><th style="text-align:left;padding:5px 8px;font-size:12px">Code</th><th style="text-align:left;padding:5px 8px;font-size:12px">Expected</th><th style="text-align:left;padding:5px 8px;font-size:12px">Got</th><th style="text-align:left;padding:5px 8px;font-size:12px">Verdict</th><th style="text-align:left;padding:5px 8px;font-size:12px">Note</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function changedSection(ch) {
  if (!ch) return '';
  const list = (title, arr, color) => arr && arr.length
    ? `<div style="flex:1;min-width:200px"><div style="font-weight:700;color:${color};font-size:13px">${title}</div><ul style="margin:4px 0;padding-left:18px;font-size:13px">${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
  const open = ch.stillOpen && ch.stillOpen.length
    ? `<div style="margin-top:10px"><div style="font-weight:700;font-size:13px">Still open</div><ul style="margin:4px 0;padding-left:18px;font-size:13px">${ch.stillOpen.map((o) => `<li>${esc(o.title)} (${Number(o.ageDays) || 0} days, ${esc(o.severity || '')})</li>`).join('')}</ul></div>` : '';
  return `<section style="margin-top:24px"><h2 style="font-size:18px;margin:0 0 8px">What changed since last time${ch.since ? ` (${esc(ch.since)})` : ''}</h2>
    <div style="display:flex;gap:16px;flex-wrap:wrap">${list('Better', ch.better, '#16a34a')}${list('Worse', ch.worse, '#dc2626')}${list('Still unknown', ch.unknown, '#6b7280')}</div>${open}</section>`;
}

function proposedFixes(findings) {
  const af = findings.filter((f) => f.autoFixable);
  if (!af.length) return '';
  const li = af.map((f) => `<li><strong>#${f.ref}</strong> ${esc(f.fix || f.title)}</li>`).join('');
  return `<section style="margin-top:22px"><h2 style="font-size:18px;margin:0 0 6px">Proposed auto-fixable items</h2><div style="font-size:12px;color:#6b7280;margin-bottom:6px">Applied only when you run with --apply. Reference by number.</div><ul style="margin:0;padding-left:20px;font-size:14px">${li}</ul></section>`;
}

export function renderReport(data = {}) {
  const m = data.meta || {};
  const findings = assignRefs(data.findings || []);
  // Backfill deltas from the previous run (data.previous = { overall, scores: { "<dimension>": n } }).
  const prev = data.previous || {};
  const scores = (data.scores || []).map((s) =>
    s.delta == null && prev.scores && prev.scores[s.dimension] != null
      ? { ...s, delta: (Number(s.score) || 0) - Number(prev.scores[s.dimension]) }
      : s
  );
  const overallDelta = m.overallDelta != null
    ? m.overallDelta
    : prev.overall != null
      ? (Number(m.overallScore) || 0) - Number(prev.overall)
      : null;
  const transparency = data.transparency
    ? `<div style="font-size:12px;color:#6b7280;margin-top:6px">Verification: ${esc(JSON.stringify(data.transparency))}</div>` : '';
  const overallColor = (Number(m.overallScore) || 0) >= 80 ? '#16a34a' : (Number(m.overallScore) || 0) >= 60 ? '#d97706' : '#dc2626';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Weekly Report ${esc(m.product || 'Smart Inventory')} ${esc(m.date || '')}</title></head>
<body style="margin:0;background:#f3f4f6;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111827">
<div style="max-width:1000px;margin:0 auto;padding:24px 18px 60px">
  <header style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;border-bottom:3px solid #111827;padding-bottom:12px">
    <h1 style="margin:0;font-size:24px">${esc(m.product || 'Smart Inventory')} weekly report</h1>
    <span style="color:#6b7280">${esc(m.date || '')} | mode ${esc(m.mode || 'lean')} | ${esc(m.branch || '')} ${esc(m.commit || '')}</span>
    <span style="margin-left:auto;font-size:28px;font-weight:800;color:${overallColor}">${Number(m.overallScore) || 0}<span style="font-size:14px;color:#9ca3af">/100</span> <span style="font-size:14px">${arrow(overallDelta)}</span></span>
  </header>
  ${data.summary ? `<section style="margin-top:14px;font-size:15px;line-height:1.6;color:#1f2937">${esc(data.summary)}</section>` : ''}
  ${transparency}
  ${topPriorities(findings, data.priorities)}
  ${blockers(findings)}
  ${scoreGrid(scores)}
  ${TEAMS.map((t) => teamSection(t, findings)).join('')}
  ${accuracySection(data.accuracy)}
  ${competitorTable(data.competitors)}
  ${proposedFixes(findings)}
  ${changedSection(data.changed)}
  ${costToHtml(data.cost || { mode: m.mode })}
  <footer style="margin-top:30px;color:#9ca3af;font-size:12px">Generated by /weekly-report. Report-only unless run with --apply. Screenshots are real proof paths.</footer>
</div></body></html>`;
}

// CLI
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const [, , dataPath, outPath] = process.argv;
  if (!dataPath || !outPath) {
    console.error('usage: node scripts/lib/report-render.mjs <data.json> <out.html>');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const html = renderReport(data);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // guard: no em or en dashes in generated copy (checked BEFORE writing the canonical file)
  const bad = (html.match(/[—–]/g) || []).length;
  if (bad > 0) {
    const rejected = outPath.replace(/\.html$/i, '.rejected.html');
    fs.writeFileSync(rejected, html, 'utf8');
    console.error(`REFUSED: ${bad} em/en dash(es) in report copy. Wrote ${rejected}, did NOT write ${outPath}.`);
    process.exit(2);
  }
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`wrote ${outPath} (${html.length} bytes, ${(data.findings || []).length} findings, em/en-dashes: 0)`);
}
