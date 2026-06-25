// Weekly intelligence pipeline (permanent): ensure a real dev server -> live tire decode scan on FRESH
// codes (speed + accuracy + cost) -> clean tire-focused report -> PDF -> email. Runs on the Claude
// subscription for judgment; the live tire decode uses your mini-model keys (a few cents per run).
// Usage: node scripts/weekly-intel.mjs   (or: npm run intel:now)
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { renderReport } from './render-report-pdf.mjs';
import { sendReport } from './email-report.mjs';
import { loadEnvLocal } from './lib/load-env.mjs';

loadEnvLocal(); // GMAIL_USER / GMAIL_APP_PASSWORD / AI keys from .env.local

const PORT = Number(process.env.INTEL_PORT || 3200);
const BASE = `http://localhost:${PORT}`;
const COUNT = Number(process.env.INTEL_TIRE_COUNT || 15);
const date = new Date().toISOString().slice(0, 10);
const reportDir = `reports/product-intel/${date}`;

const sh = (cmd) => { console.log('> ' + cmd); execSync(cmd, { stdio: 'inherit' }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serverReady() {
  try {
    const s = await (await fetch(BASE + '/api/ai-lookup')).json();
    return !s.e2e && (s.geminiConfigured || s.openaiConfigured);
  } catch { return false; }
}

(async () => {
  let started = null;
  if (!(await serverReady())) {
    console.log(`Starting dev server on :${PORT} for live decode ...`);
    started = spawn('npm', ['run', 'dev', '--', '-p', String(PORT)], { detached: true, stdio: 'ignore', shell: true });
    for (let i = 0; i < 60 && !(await serverReady()); i++) await sleep(2000);
    if (!(await serverReady())) {
      console.error('Dev server did not become ready in time.');
      if (started) { try { execSync('taskkill /pid ' + started.pid + ' /T /F'); } catch {} }
      process.exit(1);
    }
  }
  try {
    // 1. Live tire decode scan on FRESH rotated codes (writes scan-health.json).
    try { sh(`node scripts/weekly-tire-scan.ts --base=${BASE} --count=${COUNT} --date=${date}`); }
    catch (e) { console.warn('Tire scan failed; report will show placeholder scan health. ' + e); }
    // 2. Build the clean tire-focused report (reads scan-health.json).
    sh(`node scripts/build-report-html.mjs ${reportDir}`);
    // 3. Render PDF (+ PNG preview).
    const htmlPath = path.join(path.resolve(reportDir), 'report.html');
    const { pdf } = await renderReport(htmlPath, path.join(path.resolve(reportDir), 'report.pdf'));
    // 4. Email (PDF attached). Degrades gracefully if Gmail creds are absent.
    const html = fs.readFileSync(htmlPath, 'utf8');
    const res = await sendReport({ to: 'djsanti88@gmail.com', date, html, pdfPath: pdf });
    console.log(`STATUS: date=${date} report=${htmlPath} pdf=${pdf} emailed=${res.sent}${res.reason ? ' reason=' + res.reason : ''}`);
  } finally {
    if (started) { console.log('Stopping the dev server we started.'); try { execSync('taskkill /pid ' + started.pid + ' /T /F'); } catch {} }
  }
})();
