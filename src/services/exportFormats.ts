// Multi-format export rendering. CSV is the single source of truth (csvExport.ts) - it already applies
// the customer/platform sanitization gate AND the CSV-injection guard. XLSX / PDF / HTML are derived by
// parsing that same CSV back into {headers, rows}, so every format inherits identical sanitization and
// never re-implements (or weakens) the column rules. The heavy libraries (exceljs, jspdf) are imported
// LAZILY inside each renderer so a plain CSV export never pays for them.

export type Dataset = { headers: string[]; rows: string[][] };

export interface ExportMeta {
  title: string; // human dataset title, e.g. "Final counts"
  businessName: string; // for the PDF/HTML header
  timestamp: string; // ISO or display string (passed in - never generated here, for determinism)
  filenameBase: string; // e.g. "final-counts"
}

const BOM = "﻿";

/** Parse a CSV string (our buildCsv output: BOM + CRLF lines + RFC-4180 quoting) into {headers, rows}. */
export function parseCsv(csv: string): Dataset {
  const text = csv.startsWith(BOM) ? csv.slice(BOM.length) : csv;
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); records.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  // flush trailing field/row (file may not end in newline)
  if (field.length > 0 || row.length > 0) { row.push(field); records.push(row); }
  const headers = records.shift() ?? [];
  // Undo the leading-apostrophe CSV-injection guard for DISPLAY formats (XLSX/PDF/HTML render text, not
  // formulas, so the guard is unnecessary there and would look like stray punctuation).
  const clean = (v: string) => (/^'[=+\-@]/.test(v) ? v.slice(1) : v);
  return { headers, rows: records.map((r) => r.map(clean)) };
}

function triggerDownload(blob: Blob, filename: string) {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** CSV: download the already-built CSV string verbatim (BOM + injection guard preserved). */
export function downloadCsv(csv: string, filenameBase: string) {
  triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8;" }), `${filenameBase}.csv`);
}

/** XLSX via exceljs (lazy). Every cell is written as TEXT so long barcodes never become 1.23E+11. */
export async function downloadXlsx(data: Dataset, meta: ExportMeta) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Smart Inventory Scanner";
  const ws = wb.addWorksheet(meta.title.slice(0, 31) || "Export");
  const header = ws.addRow(data.headers);
  header.font = { bold: true };
  header.eachCell((c) => { c.alignment = { vertical: "middle" }; });
  for (const r of data.rows) {
    const added = ws.addRow(r);
    added.eachCell((c) => { c.numFmt = "@"; }); // force text format so codes/SKUs stay exact
  }
  ws.columns.forEach((col) => {
    let max = 10;
    col.eachCell?.({ includeEmpty: false }, (cell) => { max = Math.max(max, String(cell.value ?? "").length + 2); });
    col.width = Math.min(max, 60);
  });
  const buf = await wb.xlsx.writeBuffer();
  triggerDownload(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${meta.filenameBase}.xlsx`);
}

/** PDF via jspdf + jspdf-autotable (lazy). Title + business + timestamp + a totals row. */
export async function downloadPdf(data: Dataset, meta: ExportMeta) {
  const { jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;
  const doc = new jsPDF({ orientation: data.headers.length > 6 ? "landscape" : "portrait" });
  doc.setFontSize(14);
  doc.text(meta.title, 14, 16);
  doc.setFontSize(10);
  doc.text(`${meta.businessName}  -  ${meta.timestamp}`, 14, 22);
  doc.text(`${data.rows.length} row(s)`, 14, 27);
  autoTable(doc, {
    head: [data.headers],
    body: data.rows,
    startY: 31,
    styles: { fontSize: 8, cellPadding: 1.5, overflow: "linebreak" },
    headStyles: { fillColor: [37, 99, 235] },
  });
  doc.save(`${meta.filenameBase}.pdf`);
}

/** Escape a value for safe interpolation into HTML (text + attributes). */
export function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/**
 * Interactive standalone HTML: data inlined as JSON, vanilla JS search/sort, NO external CDN. Every
 * interpolated value is HTML-escaped (title/business) and the data is JSON-encoded then rendered through
 * textContent in the browser, so a malicious product name can never inject markup.
 */
export function buildInteractiveHtml(data: Dataset, meta: ExportMeta): string {
  const payload = JSON.stringify(data).replace(/</g, "\\u003c"); // safe to embed in a <script>
  const title = escapeHtml(meta.title);
  const business = escapeHtml(meta.businessName);
  const ts = escapeHtml(meta.timestamp);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:0;padding:24px;color:#18181b;background:#fafafa}
  h1{font-size:22px;margin:0 0 4px} .meta{color:#52525b;font-size:14px;margin-bottom:16px}
  input{font-size:16px;padding:10px 12px;width:100%;max-width:420px;border:1px solid #d4d4d8;border-radius:8px;margin-bottom:12px}
  table{border-collapse:collapse;width:100%;background:#fff;font-size:14px}
  th,td{border:1px solid #e4e4e7;padding:8px 10px;text-align:left}
  th{background:#f4f4f5;cursor:pointer;position:sticky;top:0}
  tr:nth-child(even) td{background:#fafafa} .count{color:#52525b;font-size:13px;margin-top:8px}
</style></head><body>
<h1>${title}</h1>
<div class="meta">${business} &middot; ${ts}</div>
<input id="q" type="search" placeholder="Search..." aria-label="Search">
<table><thead><tr id="hdr"></tr></thead><tbody id="body"></tbody></table>
<div class="count" id="count"></div>
<script>
(function(){
  var DATA=${payload};
  var sortCol=-1, sortAsc=true, q="";
  var hdr=document.getElementById("hdr"), body=document.getElementById("body"), count=document.getElementById("count");
  DATA.headers.forEach(function(h,i){var th=document.createElement("th");th.textContent=h;th.onclick=function(){if(sortCol===i)sortAsc=!sortAsc;else{sortCol=i;sortAsc=true;}render();};hdr.appendChild(th);});
  function render(){
    var rows=DATA.rows.filter(function(r){return q===""||r.some(function(c){return String(c).toLowerCase().indexOf(q)>-1;});});
    if(sortCol>-1){rows=rows.slice().sort(function(a,b){var x=a[sortCol]||"",y=b[sortCol]||"";var n=parseFloat(x),m=parseFloat(y);var c=(!isNaN(n)&&!isNaN(m))?n-m:String(x).localeCompare(String(y));return sortAsc?c:-c;});}
    body.textContent="";
    rows.forEach(function(r){var tr=document.createElement("tr");r.forEach(function(c){var td=document.createElement("td");td.textContent=c;tr.appendChild(td);});body.appendChild(tr);});
    count.textContent=rows.length+" of "+DATA.rows.length+" row(s)";
  }
  document.getElementById("q").addEventListener("input",function(e){q=e.target.value.toLowerCase();render();});
  render();
})();
</script></body></html>`;
}

export function downloadHtml(data: Dataset, meta: ExportMeta) {
  triggerDownload(new Blob([buildInteractiveHtml(data, meta)], { type: "text/html;charset=utf-8;" }), `${meta.filenameBase}.html`);
}
