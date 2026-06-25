import { describe, it, expect, afterAll } from 'vitest';
import { renderReport } from '../render-report-pdf.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-'));
const html = path.join(tmp, 'report.html');
fs.writeFileSync(html, '<html><body><h1>Smart Inventory</h1><p>score 88</p></body></html>');

describe('renderReport', () => {
  it('writes a non-empty pdf and png from an html file', async () => {
    const out = path.join(tmp, 'report.pdf');
    const res = await renderReport(html, out);
    expect(fs.existsSync(res.pdf)).toBe(true);
    expect(fs.statSync(res.pdf).size).toBeGreaterThan(1000);
    expect(fs.existsSync(res.png)).toBe(true);
    expect(fs.statSync(res.png).size).toBeGreaterThan(1000);
  }, 60000);
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
});
