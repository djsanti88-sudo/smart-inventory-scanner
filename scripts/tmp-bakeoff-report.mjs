// Generate a self-contained, reviewable HTML table from the bakeoff results JSON. No hand-transcription:
// every cell comes from scripts/tmp-mini-bakeoff-results.json. Usage: node scripts/tmp-bakeoff-report.mjs
import fs from "node:fs";

const data = JSON.parse(fs.readFileSync("scripts/tmp-mini-bakeoff-results.json", "utf8"));
const fixture = JSON.parse(fs.readFileSync("e2e/fixtures/owner-problem-codes.json", "utf8"));
const MODELS = data.models; // ["gpt-5.5","gpt-5.4-mini","gpt-5.5-pro"]

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rowByCodeModel = {};
for (const r of data.rows) { rowByCodeModel[`${r.code}|${r.model}`] = r; }

// --- Lenient SEMANTIC grader (re-grades from each answer's RAW text; the old >=2-word grader
// produced false "wrong"s on correct-but-differently-worded answers). Verdicts: MATCH (clean),
// PARTIAL (brand or some tokens overlap, product not a clean match), MISS (no overlap), REVIEW
// (weak/vague truth string - human decides), no-guess (model honestly returned nothing). Advisory
// only: the RAW answer sits next to the truth so you can override by eye. ---
const STOP = new Set(["the", "a", "an", "of", "and", "for", "with", "in", "on", "to", "by", "oz", "ct", "pack", "product", "size", "family", "fl", "count", "each", "new", "case"]);
const stem = (w) => w.replace(/(es|s)$/, "");
const sigTokens = (s) => [...new Set(String(s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem))];
function grade(answer, expected, weak) {
  const e = sigTokens(expected);
  if (weak || e.length === 0) return { v: "review", n: 0, d: e.length };
  const a = new Set(sigTokens(answer));
  const overlap = e.filter((t) => a.has(t)).length;
  const ratio = overlap / e.length;
  if (ratio >= 0.5 || overlap >= 3) return { v: "MATCH", n: overlap, d: e.length };
  if (overlap >= 1) return { v: "PARTIAL", n: overlap, d: e.length };
  return { v: "MISS", n: overlap, d: e.length };
}
const truthOf = (c) => c.expect;

// per-model summary, recomputed from the fresh semantic grade over COMPLETED calls
const tally = {}; for (const m of MODELS) tally[m] = { answered: 0, match: 0, partial: 0, miss: 0, review: 0, noGuess: 0, errors: 0, usd: 0 };
for (const c of fixture.codes) for (const m of MODELS) {
  const r = rowByCodeModel[`${c.code}|${m}`]; if (!r) continue;
  const t = tally[m]; t.usd += r.usd || 0;
  if (r.error) { t.errors++; continue; }
  t.answered++;
  if (r.tier === "none") { t.noGuess++; continue; }
  const g = grade(`${r.brand || ""} ${r.productName || ""}`, truthOf(c), c.weak);
  t[g.v === "MATCH" ? "match" : g.v === "PARTIAL" ? "partial" : g.v === "MISS" ? "miss" : "review"]++;
}
const sumRows = MODELS.map((m) => {
  const t = tally[m];
  return `<tr><td class="mono">${esc(m)}</td><td>${t.answered}</td><td class="ok">${t.match}</td><td class="warn">${t.partial}</td><td class="bad">${t.miss}</td><td class="mut">${t.noGuess}</td><td class="mut">${t.review}</td><td class="err">${t.errors}</td><td>$${t.usd.toFixed(2)}</td></tr>`;
}).join("");

// --- Head-to-head (codes BOTH gpt-5.5 and gpt-5.4-mini completed) + mini auto-count safety ---
const gv = (r, c) => r.tier === "none" ? "no-guess" : grade(`${r.brand || ""} ${r.productName || ""}`, truthOf(c), c.weak).v;
let hh = { n: 0, a: { M: 0, P: 0, X: 0, N: 0 }, b: { M: 0, P: 0, X: 0, N: 0 } };
for (const c of fixture.codes) {
  const a = rowByCodeModel[`${c.code}|gpt-5.5`], b = rowByCodeModel[`${c.code}|gpt-5.4-mini`];
  if (!a || !b || a.error || b.error) continue;
  hh.n++;
  for (const [r, acc] of [[a, hh.a], [b, hh.b]]) { const v = gv(r, c); acc[v === "MATCH" ? "M" : v === "PARTIAL" ? "P" : v === "MISS" ? "X" : "N"]++; }
}
// per-model stats over completed calls: clean matches, verified-but-wrong (auto-count danger), etc.
function statsFor(model) {
  const s = { answered: 0, M: 0, P: 0, X: 0, N: 0, R: 0, verified: 0, verWrong: 0, usd: 0, ms: [], danger: [] };
  for (const c of fixture.codes) {
    const r = rowByCodeModel[`${c.code}|${model}`]; if (!r) continue;
    s.usd += r.usd || 0; if (r.error) continue;
    s.answered++; if (r.ms) s.ms.push(r.ms);
    const v = gv(r, c);
    s[v === "MATCH" ? "M" : v === "PARTIAL" ? "P" : v === "MISS" ? "X" : v === "review" ? "R" : "N"]++;
    if (r.tier === "verified") { s.verified++; if (v === "MISS") { s.verWrong++; s.danger.push({ code: c.code, said: `${r.brand || ""} ${r.productName || ""}`.trim(), truth: c.expect }); } }
  }
  return s;
}
const hasTuned = MODELS.includes("gpt-5.4-mini-tuned");
const base = statsFor("gpt-5.4-mini");
const tuned = hasTuned ? statsFor("gpt-5.4-mini-tuned") : null;
const abBlock = hasTuned ? `
  <div style="margin-top:6px"><b>Tuning A/B</b> (gpt-5.4-mini baseline vs tuned: +high-context +10 searches +hints +medium-reasoning +evidence-quote, both on all 21):
    <table style="margin-top:6px; width:auto"><thead><tr><th>Variant</th><th>Clean</th><th>Partial</th><th>Miss</th><th>No-guess</th><th class="badc">Verified-but-WRONG</th><th>Spend</th></tr></thead>
    <tbody>
    <tr><td class="mono">baseline</td><td class="okc">${base.M}</td><td>${base.P}</td><td>${base.X}</td><td>${base.N}</td><td class="badc">${base.verWrong}</td><td>$${base.usd.toFixed(2)}</td></tr>
    <tr><td class="mono">tuned</td><td class="okc">${tuned.M}</td><td>${tuned.P}</td><td>${tuned.X}</td><td>${tuned.N}</td><td class="${tuned.verWrong <= base.verWrong ? "okc" : "badc"}">${tuned.verWrong}</td><td>$${tuned.usd.toFixed(2)}</td></tr>
    </tbody></table>
    <span class="mut">The number that matters is Verified-but-WRONG (identities the mini would auto-count onto the wrong item): baseline ${base.verWrong} → tuned ${tuned.verWrong}.</span>
  </div>` : "";
const dangerRows = tuned ? tuned.danger : base.danger;
const findingsNote = `<div class="note find">
  <b>Key findings.</b>${abBlock}
  <div style="margin-top:6px"><b>Baseline reference — fair head-to-head</b> (the ${hh.n} codes both gpt-5.5 and gpt-5.4-mini answered): gpt-5.5 <b class="okc">${hh.a.M} clean</b> / ${hh.a.P} partial / ${hh.a.X} miss — vs — baseline gpt-5.4-mini <b class="okc">${hh.b.M} clean</b> / ${hh.b.P} partial / ${hh.b.X} miss.</div>
  ${dangerRows.length ? `<div style="margin-top:6px" class="mut">${hasTuned ? "TUNED" : "Baseline mini"} wrong auto-counts remaining: ${dangerRows.map((d) => `<div class="mono" style="font-size:11.5px">${esc(d.code)}: said "${esc(d.said).slice(0, 40)}" · truth "${esc(d.truth).slice(0, 34)}"</div>`).join("")}</div>` : `<div style="margin-top:6px" class="okc">Zero verified-but-wrong auto-counts remaining in the ${hasTuned ? "tuned" : "baseline"} run. 🎯</div>`}
</div>`;

const verdictClass = (v) => v === "MATCH" ? "ok" : v === "MISS" ? "bad" : v === "PARTIAL" ? "warn" : "mut";
function cell(r, c) {
  if (!r) return `<td class="mut">— (missing)</td>`;
  if (r.error) {
    const q = /429/.test(r.error) ? "not run — OpenAI 429 quota" : `error — ${esc(r.error).slice(0, 60)}`;
    return `<td class="answer err"><span class="badge err">${q}</span></td>`;
  }
  const answer = `${r.brand || ""} ${r.productName || ""}`.trim() || "(empty)";
  const specs = r.specs ? `<div class="specs">${esc(r.specs).slice(0, 90)}</div>` : "";
  const g = r.tier === "none" ? { v: "no-guess", n: 0, d: 0 } : grade(answer, truthOf(c), c.weak);
  const ratio = g.d ? ` <span class="tag">${g.n}/${g.d} truth words</span>` : "";
  return `<td class="answer ${verdictClass(g.v)}">
    <div class="ans">${esc(answer)}</div>${specs}
    <div class="meta"><span class="badge ${verdictClass(g.v)}">${esc(g.v)}</span>${ratio}
      <span class="tag">${esc(r.tier)}</span>
      conf ${Number(r.confidence).toFixed(2)} · exact ${r.exactCodeFound ? "Y" : "–"} · ${r.searches} search${r.searches === 1 ? "" : "es"} · ${r.ms}ms · $${(r.usd || 0).toFixed(3)}</div>
  </td>`;
}

const bodyRows = fixture.codes.map((c) => {
  const cells = MODELS.map((m) => cell(rowByCodeModel[`${c.code}|${m}`], c)).join("");
  return `<tr>
    <td class="code"><div class="mono">${esc(c.code)}</div>${c.weak ? '<span class="tag warn">weak</span>' : ""}</td>
    <td class="truth">${esc(c.expect)}</td>
    ${cells}
  </tr>`;
}).join("\n");

const completed = data.rows.filter((r) => !r.error).length;
const total = data.rows.length;

const STYLE = `
  :root { color-scheme: light dark; --bg:#0f1115; --card:#171a21; --line:#2a2f3a; --fg:#e6e9ef; --mut:#8b93a3; --ok:#3fb950; --bad:#f85149; --warn:#d29922; --err:#db6d28; --tag:#2d333b; }
  @media (prefers-color-scheme: light){ :root{ --bg:#f6f7f9; --card:#fff; --line:#e2e5ea; --fg:#1b1f27; --mut:#5a6472; --tag:#eef1f5; } }
  :root[data-theme="dark"]{ --bg:#0f1115; --card:#171a21; --line:#2a2f3a; --fg:#e6e9ef; --mut:#8b93a3; --tag:#2d333b; }
  :root[data-theme="light"]{ --bg:#f6f7f9; --card:#fff; --line:#e2e5ea; --fg:#1b1f27; --mut:#5a6472; --tag:#eef1f5; }
  * { box-sizing:border-box; } body{ margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif; padding:24px; }
  td, th { font-variant-numeric: tabular-nums; }
  h1{ font-size:20px; margin:0 0 4px; } .sub{ color:var(--mut); margin:0 0 16px; font-size:13px; }
  .note{ background:var(--card); border:1px solid var(--line); border-left:3px solid var(--warn); border-radius:8px; padding:10px 14px; margin:0 0 14px; font-size:13px; }
  .note.blk{ border-left-color:var(--bad); } .note b{ color:var(--fg); }
  .note.find{ border-left-color:var(--ok); } .okc{ color:var(--ok); } .badc{ color:var(--bad); }
  table{ border-collapse:collapse; width:100%; background:var(--card); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  th,td{ text-align:left; padding:9px 11px; border-bottom:1px solid var(--line); vertical-align:top; }
  th{ background:var(--tag); font-size:12px; text-transform:uppercase; letter-spacing:.03em; color:var(--mut); position:sticky; top:0; }
  .mono{ font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; }
  .code{ white-space:nowrap; } .truth{ max-width:190px; color:var(--fg); }
  .answer{ max-width:280px; } .ans{ font-weight:600; } .specs{ color:var(--mut); font-size:12px; margin-top:2px; }
  .meta{ color:var(--mut); font-size:11.5px; margin-top:5px; }
  .badge{ display:inline-block; padding:1px 7px; border-radius:99px; font-size:11px; font-weight:700; margin-right:4px; }
  .badge.ok{ background:rgba(63,185,80,.16); color:var(--ok); } .badge.bad{ background:rgba(248,81,73,.16); color:var(--bad); }
  .badge.mut{ background:var(--tag); color:var(--mut); } .badge.err{ background:rgba(219,109,40,.16); color:var(--err); }
  .badge.warn{ background:rgba(210,153,34,.18); color:var(--warn); }
  .tag{ display:inline-block; padding:1px 6px; border-radius:5px; background:var(--tag); color:var(--mut); font-size:11px; margin-right:4px; }
  .tag.warn{ color:var(--warn); }
  td.ok{ background:rgba(63,185,80,.05);} td.bad{ background:rgba(248,81,73,.06);} td.mut{ background:rgba(139,147,163,.05);} td.err{ background:rgba(219,109,40,.05);} td.warn{ background:rgba(210,153,34,.06);}
  .sumwrap{ overflow-x:auto; margin:0 0 20px; } .legend{ color:var(--mut); font-size:12px; margin:10px 0 22px; }
  .scroll{ overflow-x:auto; }
`;

const CONTENT = `
<h1>GPT decode bakeoff — 5.5 vs 5.4-mini vs 5.5-pro</h1>
<p class="sub">21 owner problem codes · live OpenAI web_search · production decode-ladder settings · generated ${esc(data.ts)}</p>

<div class="note"><b>Coverage:</b> <span class="mono">gpt-5.4-mini</span> is <b class="okc">COMPLETE (21/21)</b>. <span class="mono">gpt-5.5</span> (9/21) and <span class="mono">gpt-5.5-pro</span> (6/21) stay <b>partial</b> — quota-blocked earlier and deliberately NOT re-run (API authorized for the mini only). Rows marked <span class="badge err">not run</span> were never attempted, not model failures — judge fairly on the codes each answered (see the head-to-head below).</div>
${findingsNote}
<div class="note"><b>Grading (revised):</b> a lenient <b>semantic</b> match, not word-shape. <span class="badge ok">MATCH</span> = clean identity match · <span class="badge warn">PARTIAL</span> = brand/some tokens right, product not clean · <span class="badge bad">MISS</span> = no overlap · <span class="badge mut">REVIEW</span> = the truth string is vague/weak, you decide · <span class="badge mut">no-guess</span> = model honestly returned nothing. It's <b>advisory</b> — the raw answer sits beside the truth so you override by eye. The "N/M truth words" tag shows how many significant words of the expected string were found.</div>
<div class="note"><b>Caveats:</b> no true <span class="mono">gpt-5.5-mini</span> exists (404) — the "mini" here is <span class="mono">gpt-5.4-mini</span>, the nearest-generation mini. <span class="mono">gpt-5.5-pro</span> runs at <b>medium</b> reasoning (refuses <span class="mono">low</span>); 5.5 and mini are identical at <span class="mono">low</span>. $ = computed floor; true spend = OpenAI console.</div>

<div class="sumwrap"><table>
<thead><tr><th>Model</th><th>Answered</th><th>Match</th><th>Partial</th><th>Miss</th><th>No-guess</th><th>Review</th><th>Not run (429)</th><th>Spend floor</th></tr></thead>
<tbody>${sumRows}</tbody>
</table></div>

<div class="scroll"><table>
<thead><tr><th>Code</th><th>Expected (truth)</th>${MODELS.map((m) => `<th>${esc(m)}</th>`).join("")}</tr></thead>
<tbody>
${bodyRows}
</tbody>
</table></div>
<p class="legend">Each answer cell shows the model's raw brand + product name, its specs (if any), then verdict · tier · confidence · exact-code-claim · searches used · latency · cost. Green = grader match, red = mismatch, gray = honest no-guess, amber = quota-blocked.</p>
`;

const TITLE = "GPT decode bakeoff — review";
// Local standalone file (double-clickable).
const localHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${TITLE}</title><style>${STYLE}</style></head><body>${CONTENT}</body></html>`;
fs.writeFileSync("reports/mini-bakeoff-review-2026-07-26.html", localHtml);
// Artifact body (the Artifact system wraps it in <head>/<body> at publish time).
const artifactHtml = `<title>${TITLE}</title>\n<style>${STYLE}</style>\n${CONTENT}`;
fs.writeFileSync("reports/mini-bakeoff-artifact.html", artifactHtml);
console.log(`Wrote reports/mini-bakeoff-review-2026-07-26.html + reports/mini-bakeoff-artifact.html (${completed}/${total} completed, ${fixture.codes.length} codes)`);
