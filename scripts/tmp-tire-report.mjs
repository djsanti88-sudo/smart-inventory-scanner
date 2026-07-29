// Reviewable HTML table for the gpt-5.4-mini tire test. Reads scripts/tmp-tire-mini-results.json.
import fs from "node:fs";
const arg = (n, dv) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split("=")[1] : dv; };
const IN = arg("in", "scripts/tmp-tire-mini-results.json");
const OUTBASE = arg("out", "reports/tire-mini-review-2026-07-26");
const d = JSON.parse(fs.readFileSync(IN, "utf8"));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const done = d.rows.filter((r) => !r.error);
const cnt = (f) => done.filter(f).length;

const vClass = (v) => v === "MATCH" ? "ok" : v === "MISS" ? "bad" : v === "no-guess" ? "mut" : "warn";
const okMark = (b) => b ? `<span class="okc">Y</span>` : `<span class="badc">–</span>`;

const bodyRows = d.rows.map((r) => {
  if (r.error) return `<tr><td class="mono">${esc(r.code)}</td><td class="truth">${esc(r.brand)} ${esc(r.model)} <b>${esc(r.size)}</b></td><td class="answer err" colspan="2"><span class="badge err">${/429/.test(r.error) ? "not run — 429 quota" : "error — " + esc(r.error).slice(0, 50)}</span></td></tr>`;
  const a = r.model_ans || {};
  const said = `${esc(a.brand)} ${esc(a.model)}`.trim() || "(empty)";
  return `<tr>
    <td class="mono">${esc(r.code)}${r.lookupCode && r.lookupCode !== r.code ? `<div class="tag">looked up: ${esc(r.lookupCode)}</div>` : ""}<div class="tag">${esc(r.type || "")}</div></td>
    <td class="truth">${esc(r.brand)} ${esc(r.model)}<div><b>${esc(r.size)}</b> ${esc(r.load || "")}${esc(r.speed || "")}</div></td>
    <td class="answer ${vClass(r.verdict)}">
      <div class="ans">${said}</div>
      <div>size <b>${esc(a.size) || "–"}</b> ${esc(a.loadIndex || "")}${esc(a.speedRating || "")}</div>
      <div class="meta"><span class="badge ${vClass(r.verdict)}">${esc(r.verdict)}</span> brand ${okMark(r.brandOk)} · size ${okMark(r.sizeOk)} · model ${okMark(r.modelOk)}</div>
      <div class="meta">conf ${Number(a.confidence ?? 0).toFixed(2)} · exact ${a.exactCodeFound ? "Y" : "–"} · ${r.searches} searches · ${r.ms}ms · $${(r.usd || 0).toFixed(3)}</div>
    </td>
  </tr>`;
}).join("\n");

const STYLE = `
  :root { color-scheme: light dark; --bg:#0f1115; --card:#171a21; --line:#2a2f3a; --fg:#e6e9ef; --mut:#8b93a3; --ok:#3fb950; --bad:#f85149; --warn:#d29922; --err:#db6d28; --tag:#2d333b; }
  @media (prefers-color-scheme: light){ :root{ --bg:#f6f7f9; --card:#fff; --line:#e2e5ea; --fg:#1b1f27; --mut:#5a6472; --tag:#eef1f5; } }
  :root[data-theme="dark"]{ --bg:#0f1115; --card:#171a21; --line:#2a2f3a; --fg:#e6e9ef; --mut:#8b93a3; --tag:#2d333b; }
  :root[data-theme="light"]{ --bg:#f6f7f9; --card:#fff; --line:#e2e5ea; --fg:#1b1f27; --mut:#5a6472; --tag:#eef1f5; }
  * { box-sizing:border-box; } body{ margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif; padding:24px; }
  td, th { font-variant-numeric: tabular-nums; }
  h1{ font-size:20px; margin:0 0 4px; } .sub{ color:var(--mut); margin:0 0 16px; font-size:13px; }
  .note{ background:var(--card); border:1px solid var(--line); border-left:3px solid var(--ok); border-radius:8px; padding:10px 14px; margin:0 0 16px; font-size:13px; }
  .note b{ color:var(--fg); } .okc{ color:var(--ok); font-weight:700; } .badc{ color:var(--bad); font-weight:700; }
  table{ border-collapse:collapse; width:100%; background:var(--card); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  th,td{ text-align:left; padding:9px 11px; border-bottom:1px solid var(--line); vertical-align:top; }
  th{ background:var(--tag); font-size:12px; text-transform:uppercase; letter-spacing:.03em; color:var(--mut); }
  .mono{ font-family:ui-monospace,Menlo,monospace; font-size:12px; white-space:nowrap; }
  .truth{ max-width:230px; } .answer{ max-width:300px; } .ans{ font-weight:600; }
  .meta{ color:var(--mut); font-size:11.5px; margin-top:4px; }
  .badge{ display:inline-block; padding:1px 7px; border-radius:99px; font-size:11px; font-weight:700; margin-right:4px; }
  .badge.ok{ background:rgba(63,185,80,.16); color:var(--ok);} .badge.bad{ background:rgba(248,81,73,.16); color:var(--bad);} .badge.warn{ background:rgba(210,153,34,.18); color:var(--warn);} .badge.mut{ background:var(--tag); color:var(--mut);} .badge.err{ background:rgba(219,109,40,.16); color:var(--err);}
  .tag{ display:inline-block; padding:0 6px; border-radius:5px; background:var(--tag); color:var(--mut); font-size:10.5px; margin-top:3px; }
  td.ok{ background:rgba(63,185,80,.05);} td.bad{ background:rgba(248,81,73,.06);} td.warn{ background:rgba(210,153,34,.06);} td.mut{ background:rgba(139,147,163,.05);} td.err{ background:rgba(219,109,40,.05);}
  .scroll{ overflow-x:auto; }
`;
const CONTENT = `
<h1>gpt-5.4-mini on tire barcodes — corpus ground truth</h1>
<p class="sub">${done.length} tire barcodes sampled from the ${d.rows.length >= 20 ? "76k-row" : ""} tire corpus · live web_search · graded vs corpus brand/model/size · ${esc(d.ts)}</p>
<div class="note">
  <b>Results (gpt-5.4-mini, ${done.length} graded):</b>
  clean MATCH (brand+model+size) <b class="okc">${cnt((o) => o.verdict === "MATCH")}</b> ·
  brand+size ok <b>${cnt((o) => o.verdict === "PARTIAL(size-ok)")}</b> ·
  brand-only <b>${cnt((o) => o.verdict === "PARTIAL(brand-only)")}</b> ·
  MISS <b class="badc">${cnt((o) => o.verdict === "MISS")}</b> ·
  no-guess <b>${cnt((o) => o.verdict === "no-guess")}</b>
  <div style="margin-top:6px">field accuracy: brand <b>${cnt((o) => o.brandOk)}/${done.length}</b> · <b>size ${cnt((o) => o.sizeOk)}/${done.length}</b> · model <b>${cnt((o) => o.modelOk)}/${done.length}</b>.
  Auto-count safety: claimed <span class="tag">exactCodeFound</span> on <b>${cnt((o) => o.model_ans?.exactCodeFound)}</b>, of those <b class="badc">${cnt((o) => o.model_ans?.exactCodeFound && !o.sizeOk)}</b> had the WRONG size (would mis-count).
  Spend floor $${(d.spentFloor || 0).toFixed(2)} (true = OpenAI console).</div>
  <div style="margin-top:6px" class="mut">MATCH = brand+model+size all correct · size compared ignoring P/LT/ST service prefix · size is the identity-critical field for tires.</div>
</div>
<div class="scroll"><table>
<thead><tr><th>Barcode</th><th>Corpus truth (brand / model / size)</th><th>gpt-5.4-mini said</th></tr></thead>
<tbody>${bodyRows}</tbody>
</table></div>
`;
const TITLE = "gpt-5.4-mini tire test";
fs.writeFileSync(`${OUTBASE}.html`, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${TITLE}</title><style>${STYLE}</style></head><body>${CONTENT}</body></html>`);
fs.writeFileSync(`${OUTBASE}-artifact.html`, `<title>${TITLE}</title>\n<style>${STYLE}</style>\n${CONTENT}`);
console.log(`Wrote ${OUTBASE}.html + ${OUTBASE}-artifact.html (${done.length} graded)`);
