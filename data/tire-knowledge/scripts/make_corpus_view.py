"""Generate a searchable HTML table view of tire_corpus_flat.csv. Zero credits, read-only."""
import csv, html, json, collections, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rows = list(csv.DictReader(open(os.path.join(ROOT, 'tire_corpus_flat.csv'), encoding='utf-8')))
cols = list(rows[0].keys())
brands = collections.Counter(r['brand'] for r in rows)
try:
    spent = json.load(open(os.path.join(ROOT, 'firecrawl_policy.json')))['total_credits_spent']
except Exception:
    spent = '?'

CSS = """body{font:13px/1.4 system-ui,Segoe UI,Arial;margin:0;padding:16px;background:#0f1115;color:#e6e6e6}
h1{font-size:18px;margin:0 0 4px}.meta{color:#9aa;margin-bottom:12px}
input,select{padding:6px 8px;background:#1b1f27;color:#e6e6e6;border:1px solid #333;border-radius:6px;margin-right:8px}
table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #2a2f3a;padding:4px 6px;text-align:left;white-space:nowrap}
th{position:sticky;top:0;background:#1b1f27}tr:nth-child(even){background:#161a21}
td.bc{font-family:Consolas,monospace;color:#7fd1b9}.wrap{max-height:80vh;overflow:auto;border:1px solid #2a2f3a;border-radius:8px}
a{color:#6cb6ff}"""

JS = """function f(){var q=document.getElementById('q').value.toLowerCase(),b=document.getElementById('b').value,rows=document.querySelectorAll('#t tbody tr'),c=0;
rows.forEach(function(r){var t=r.textContent.toLowerCase(),br=r.getAttribute('data-b');var ok=(!q||t.indexOf(q)>-1)&&(!b||br===b);r.style.display=ok?'':'none';if(ok)c++;});
document.getElementById('cnt').textContent=c+' shown';}
window.onload=f;"""

opts = ''.join('<option>%s</option>' % html.escape(b) for b, _ in brands.most_common())
th = ''.join('<th>%s</th>' % html.escape(c) for c in cols)

def cell(c, v):
    v = html.escape(v or '')
    if c == 'source_url':
        return '<td><a href="%s" target="_blank">link</a></td>' % v
    if c == 'barcode':
        return '<td class="bc">%s</td>' % v
    return '<td>%s</td>' % v

body = ''.join('<tr data-b="%s">%s</tr>' % (html.escape(r['brand']), ''.join(cell(c, r[c]) for c in cols)) for r in rows)
meta = '%d verified rows &middot; %d unique barcodes &middot; %d brands &middot; %s/50 Firecrawl credits spent' % (
    len(rows), len({r['barcode'] for r in rows}), len(brands), spent)

out = (
    '<!doctype html><html><head><meta charset="utf-8"><title>Tire Corpus</title><style>' + CSS + '</style></head><body>'
    '<h1>Tire Barcode Corpus</h1><div class="meta">' + meta + '</div>'
    '<div><input id="q" placeholder="search any field..." size="30" oninput="f()"> '
    '<select id="b" onchange="f()"><option value="">All brands</option>' + opts + '</select> <span id="cnt"></span></div>'
    '<div class="wrap"><table id="t"><thead><tr>' + th + '</tr></thead><tbody>' + body + '</tbody></table></div>'
    '<script>' + JS + '</script></body></html>'
)
dest = os.path.join(ROOT, 'tire_corpus_view.html')
open(dest, 'w', encoding='utf-8').write(out)
print('wrote', dest, '|', len(rows), 'rows')
