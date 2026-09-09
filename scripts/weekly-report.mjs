// Weekly Report (MERGED): the QA proof bots + the product-intelligence pipeline, producing ONE report
// (HTML + PDF, emailed) that carries BOTH the live decode scan health AND the QA bot health.
// Replaces running `qa:weekly-report` and `intel:now` separately.
// Usage: node scripts/weekly-report.mjs   (or: npm run weekly-report)
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const sh = (cmd, optional = false) => {
  console.log('\n> ' + cmd);
  try { execSync(cmd, { stdio: 'inherit' }); }
  catch (e) {
    if (!optional) throw e;
    console.warn(`(continuing) "${cmd}" reported failures - they will be surfaced in the QA-health section.`);
  }
};

// 1. QA proof bots (security, data, tire, UX, performance, manager). Writes
//    reports/human-bots/latest/playwright-results.json, which build-report-html reads for the QA-health
//    section. Optional: a bot failure must NOT abort the report - a failing bot is exactly what we want
//    the weekly report to show.
sh('npm run qa:bots:all', true);

// 2. Fresh Fable 5 PR review. This remains optional so a missing Python executable cannot prevent the
//    existing weekly report from running. reports/fable5/LATEST.json points at report.md for the review just produced.
sh('python -m tools.fable5 review-build --gate pr --no-cache', true);
try {
  const latest = JSON.parse(readFileSync('reports/fable5/LATEST.json', 'utf8'));
  console.log(`Fable 5 review: [${latest.verdict}](${latest.report})`);
} catch (e) {
  console.warn('(continuing) Fable 5 report pointer unavailable: ' + e.message);
}

// 3. Product-intelligence pipeline: ensures a dev server, runs a live FRESH-code decode scan, then builds
//    the report (which now folds in the QA-health section), renders the PDF, and emails it. Reuses the
//    existing, tested pipeline (scripts/weekly-intel.mjs -> build-report-html.mjs).
sh('node scripts/weekly-intel.mjs');

console.log('\nWeekly Report complete: ONE report (decode scan health + QA bot health), HTML + PDF, emailed.');
