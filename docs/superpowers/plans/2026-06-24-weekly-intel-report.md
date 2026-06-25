# Weekly Intelligence Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Sunday-6pm-CT and on-demand job that runs a 27-agent Claude fleet over the Smart Inventory app on both local and live, writes an HTML + PDF report with local-vs-live drift detection, and auto-emails it, entirely on the Claude subscription ($0 API).

**Architecture:** A Node orchestrator (`scripts/weekly-intel.mjs`) chains four stages: capture (existing `qa:bots` / `qa:bots:live`), judge (headless `claude -p "/inventory-review ..."`), render (Playwright HTML->PDF), email (nodemailer Gmail SMTP). The existing `/inventory-review` command + 12 agents are the engine; this plan extends the command (target=both + drift + growth section), adds 15 agents, and wraps it in automation + a Windows scheduled task.

**Tech Stack:** Node ESM (`.mjs`), Playwright chromium (installed), nodemailer (new dev dep), the `claude` CLI 2.1.107 headless mode, Windows Task Scheduler, Vitest for unit tests.

## Global Constraints

- $0 API: run `claude` normally (subscription auth), NEVER `--bare` (forces API key). AI decode route stays mocked. No live Gemini/OpenAI calls.
- Never deploy, never `git push`, never run `/inventory-review --apply` unless the owner asks.
- Secrets only in `.env.local` (gitignored). `.env.example` gets names only. Never log or commit a secret.
- No em dash or en dash in any report copy or agent output.
- New agent files match the existing style exactly: frontmatter `name`/`description`/`tools`/`model: sonnet`, a persona body, ONE fenced ```json findings block, a single `score_key: <0-100>` line, ending "No em dashes."
- Node scripts are ESM `.mjs`, pure where practical, no `next/*` imports.
- Email recipient: djsanti88@gmail.com.
- Do not commit unless the owner explicitly asks (owner doctrine overrides the skill's auto-commit).

---

# PHASE 1 - Pipeline backbone (de-risk + working on-demand emailed report)

Delivers a working `npm run intel:now` that produces an emailed HTML+PDF report using the **existing 12 agents**, with drift detection. Proves headless auth, PDF, and SMTP before any new agents.

### Task 1: SPIKE - prove headless `claude -p` runs the project command on the subscription

**Files:**
- Create: `scripts/spike-headless.ps1` (throwaway, deleted at end of task)

**Interfaces:**
- Produces: confidence that `claude -p "/inventory-review ..."` works unattended; if not, a documented blocker in PROGRESS.md (STOP and report to owner).

- [ ] **Step 1: Confirm a trivial headless agent dispatch works and writes a file**

Run from `C:\Users\djsan\inventory`:
```
claude -p "Create a file scripts/_spike.txt containing the word OK, then stop." --permission-mode acceptEdits --output-format text
```
Expected: command exits 0; `scripts/_spike.txt` exists and contains `OK`.

- [ ] **Step 2: Confirm the PROJECT slash command resolves headlessly (dry, no refresh)**

Run:
```
claude -p "/inventory-review --mode=daily --target=local" --permission-mode acceptEdits --output-format text
```
Expected: it locates the existing screenshots in `e2e/proof/` and writes `reports/product-intel/<today>/report.html`. (It may warn that some agents are slow; that is fine.) If it errors that the command is unknown, the headless runner cannot use project slash commands -> record blocker, STOP, tell owner (fallback: inline the command body into the `-p` prompt).

- [ ] **Step 3: Confirm auth is subscription, not API key**

Verify the run did NOT consume the API key: check there was no `ANTHROPIC_API_KEY`-based billing prompt and the run used the logged-in session. Document the result (one line) in `PROGRESS.md` under "Headless auth proof".

- [ ] **Step 4: Clean up**

```
Remove-Item scripts/_spike.txt, scripts/spike-headless.ps1 -ErrorAction SilentlyContinue
```

- [ ] **Step 5: Commit the PROGRESS.md note only** (ask owner first per doctrine; if not approved, leave uncommitted)

```
git add PROGRESS.md
git commit -m "chore: record headless claude -p subscription auth proof"
```

### Task 2: Install nodemailer (gated)

**Files:**
- Modify: `package.json` (devDependencies)

- [ ] **Step 1: Get explicit owner approval to install** (doctrine gate). Do not proceed without it.

- [ ] **Step 2: Install**

Run: `npm install --save-dev nodemailer`
Expected: `nodemailer` appears in `package.json` devDependencies; lockfile updates.

- [ ] **Step 3: Verify it imports**

Run: `node -e "import('nodemailer').then(m=>console.log('nodemailer', typeof m.createTransport))"`
Expected: `nodemailer function`

- [ ] **Step 4: Commit** (ask owner)

```
git add package.json package-lock.json
git commit -m "build: add nodemailer dev dependency for report email"
```

### Task 3: PDF + PNG renderer

**Files:**
- Create: `scripts/render-report-pdf.mjs`
- Test: `scripts/__tests__/render-report-pdf.test.mjs`

**Interfaces:**
- Produces: `renderReport(htmlPath, outPdfPath) -> { pdf: string, png: string }` (writes both, returns paths).

- [ ] **Step 1: Write the failing test**

```js
// scripts/__tests__/render-report-pdf.test.mjs
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
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run scripts/__tests__/render-report-pdf.test.mjs`
Expected: FAIL ("Cannot find module '../render-report-pdf.mjs'").

- [ ] **Step 3: Write the implementation** (generalized from the existing `build-report-pdf.mjs`)

```js
// scripts/render-report-pdf.mjs
import { chromium } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function renderReport(htmlPath, outPdfPath) {
  const abs = path.resolve(htmlPath);
  const out = path.resolve(outPdfPath);
  const pngOut = out.replace(/\.pdf$/i, '.png');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
    await page.emulateMedia({ media: 'screen' });
    await page.goto(pathToFileURL(abs).href, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      document.documentElement.style.setProperty('print-color-adjust', 'exact');
      document.documentElement.style.setProperty('-webkit-print-color-adjust', 'exact');
    });
    await page.waitForTimeout(400);
    const height = await page.evaluate(() => Math.ceil(document.body.scrollHeight) + 40);
    await page.screenshot({ path: pngOut, fullPage: true });
    await page.pdf({ path: out, width: '1300px', height: `${height}px`, printBackground: true, pageRanges: '1' });
    return { pdf: out, png: pngOut };
  } finally {
    await browser.close();
  }
}

// CLI: node scripts/render-report-pdf.mjs <in.html> <out.pdf>
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , inHtml, outPdf] = process.argv;
  renderReport(inHtml, outPdf || inHtml.replace(/\.html?$/i, '.pdf'))
    .then(r => console.log('RENDERED', JSON.stringify(r)))
    .catch(e => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run scripts/__tests__/render-report-pdf.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit** (ask owner)

```
git add scripts/render-report-pdf.mjs scripts/__tests__/render-report-pdf.test.mjs
git commit -m "feat: generalized report html to pdf+png renderer"
```

### Task 4: Publish-Gap / drift module

**Files:**
- Create: `scripts/lib/publish-gap.mjs`
- Test: `scripts/__tests__/publish-gap.test.mjs`

**Interfaces:**
- Produces:
  - `computePublishGap({ gitStatus, gitUnpushed, localScores, liveScores }) -> { dirty: boolean, items: Array<{kind, detail, severity}> }`
  - `gapToHtml(gap) -> string` (a self-contained HTML fragment, red banner when `dirty`).
- Consumes: caller passes raw strings from `git status --porcelain` and `git log @{u}..HEAD --oneline`, plus two score objects `{ [dimension]: number }`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/__tests__/publish-gap.test.mjs
import { describe, it, expect } from 'vitest';
import { computePublishGap, gapToHtml } from '../lib/publish-gap.mjs';

describe('computePublishGap', () => {
  it('flags uncommitted + unpushed + score drift', () => {
    const gap = computePublishGap({
      gitStatus: ' M src/app/page.tsx\n?? scripts/new.mjs\n',
      gitUnpushed: 'a1b2c3 wip: tweak scanner\n',
      localScores: { overall: 90, scanner_flow: 88 },
      liveScores: { overall: 78, scanner_flow: 70 },
    });
    expect(gap.dirty).toBe(true);
    expect(gap.items.some(i => i.kind === 'uncommitted')).toBe(true);
    expect(gap.items.some(i => i.kind === 'unpushed')).toBe(true);
    expect(gap.items.some(i => i.kind === 'score_drift' && i.detail.includes('scanner_flow'))).toBe(true);
  });

  it('is clean when nothing differs', () => {
    const gap = computePublishGap({ gitStatus: '', gitUnpushed: '', localScores: { overall: 80 }, liveScores: { overall: 80 } });
    expect(gap.dirty).toBe(false);
    expect(gap.items).toHaveLength(0);
    expect(gapToHtml(gap)).toContain('No drift');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run scripts/__tests__/publish-gap.test.mjs`
Expected: FAIL (module missing).

- [ ] **Step 3: Write the implementation**

```js
// scripts/lib/publish-gap.mjs
const DRIFT_THRESHOLD = 8; // points

export function computePublishGap({ gitStatus = '', gitUnpushed = '', localScores = {}, liveScores = {} }) {
  const items = [];
  const changed = gitStatus.split('\n').map(s => s.trim()).filter(Boolean);
  if (changed.length) items.push({ kind: 'uncommitted', severity: 'high', detail: `${changed.length} uncommitted file(s): ${changed.slice(0, 8).join(', ')}` });
  const commits = gitUnpushed.split('\n').map(s => s.trim()).filter(Boolean);
  if (commits.length) items.push({ kind: 'unpushed', severity: 'high', detail: `${commits.length} commit(s) not pushed: ${commits.slice(0, 5).join(' | ')}` });
  for (const dim of Object.keys(localScores)) {
    if (dim in liveScores) {
      const d = localScores[dim] - liveScores[dim];
      if (Math.abs(d) >= DRIFT_THRESHOLD) {
        items.push({ kind: 'score_drift', severity: Math.abs(d) >= 20 ? 'high' : 'medium', detail: `${dim}: local ${localScores[dim]} vs live ${liveScores[dim]} (delta ${d > 0 ? '+' : ''}${d})` });
      }
    }
  }
  return { dirty: items.length > 0, items };
}

export function gapToHtml(gap) {
  if (!gap.dirty) return `<section style="padding:12px 16px;border-radius:8px;background:#0f5132;color:#d1e7dd;font-family:system-ui">Publish-Gap: No drift. Local and live agree, working tree clean.</section>`;
  const rows = gap.items.map(i => `<li><strong>${i.kind}</strong> (${i.severity}): ${i.detail}</li>`).join('');
  return `<section style="padding:12px 16px;border-radius:8px;background:#842029;color:#f8d7da;font-family:system-ui"><h3 style="margin:0 0 6px">Publish-Gap: drift detected</h3><ul style="margin:0;padding-left:18px">${rows}</ul></section>`;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run scripts/__tests__/publish-gap.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit** (ask owner)

```
git add scripts/lib/publish-gap.mjs scripts/__tests__/publish-gap.test.mjs
git commit -m "feat: local-vs-live publish-gap drift detector"
```

### Task 5: Email sender (nodemailer, Gmail SMTP, graceful degrade)

**Files:**
- Create: `scripts/email-report.mjs`
- Test: `scripts/__tests__/email-report.test.mjs`

**Interfaces:**
- Produces:
  - `buildMessage({ to, date, html, pdfPath }) -> { to, subject, html, attachments }`
  - `sendReport(opts, env = process.env) -> Promise<{ sent: boolean, reason?: string }>` (returns `{sent:false, reason:'no-credentials'}` when `GMAIL_USER`/`GMAIL_APP_PASSWORD` are absent; never throws on missing creds).

- [ ] **Step 1: Write the failing test** (construction + graceful skip; no real network)

```js
// scripts/__tests__/email-report.test.mjs
import { describe, it, expect } from 'vitest';
import { buildMessage, sendReport } from '../email-report.mjs';

describe('email-report', () => {
  it('builds a message with pdf attachment and inline html', () => {
    const msg = buildMessage({ to: 'djsanti88@gmail.com', date: '2026-06-24', html: '<h1>hi</h1>', pdfPath: '/tmp/report.pdf' });
    expect(msg.to).toBe('djsanti88@gmail.com');
    expect(msg.subject).toContain('2026-06-24');
    expect(msg.html).toContain('<h1>hi</h1>');
    expect(msg.attachments[0].path).toBe('/tmp/report.pdf');
  });

  it('skips gracefully when credentials are missing', async () => {
    const res = await sendReport({ to: 'x@y.com', date: '2026-06-24', html: '<p>x</p>', pdfPath: '/tmp/x.pdf' }, {});
    expect(res.sent).toBe(false);
    expect(res.reason).toBe('no-credentials');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run scripts/__tests__/email-report.test.mjs`
Expected: FAIL (module missing).

- [ ] **Step 3: Write the implementation**

```js
// scripts/email-report.mjs
import nodemailer from 'nodemailer';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function buildMessage({ to, date, html, pdfPath }) {
  return {
    to,
    subject: `Smart Inventory weekly intel - ${date}`,
    html,
    attachments: pdfPath ? [{ filename: `smart-inventory-intel-${date}.pdf`, path: pdfPath }] : [],
  };
}

export async function sendReport(opts, env = process.env) {
  const user = env.GMAIL_USER;
  const pass = env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return { sent: false, reason: 'no-credentials' };
  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  const msg = buildMessage(opts);
  await transport.sendMail({ from: user, ...msg });
  return { sent: true };
}

// CLI: node scripts/email-report.mjs <date> <html-file> <pdf-file>
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fs = await import('node:fs');
  const [, , date, htmlFile, pdfFile] = process.argv;
  const html = fs.readFileSync(htmlFile, 'utf8');
  const res = await sendReport({ to: 'djsanti88@gmail.com', date, html, pdfPath: path.resolve(pdfFile) });
  console.log('EMAIL', JSON.stringify(res));
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run scripts/__tests__/email-report.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit** (ask owner)

```
git add scripts/email-report.mjs scripts/__tests__/email-report.test.mjs
git commit -m "feat: gmail smtp report sender with graceful no-cred skip"
```

### Task 6: Extend `/inventory-review` for `--target=both` + drift section

**Files:**
- Modify: `.claude/commands/inventory-review.md`

**Interfaces:**
- Produces: when invoked with `--target=both`, the command runs the capture/judge for local AND live, writes per-target `scores.json` (`scores.local.json`, `scores.live.json`), embeds the Publish-Gap section (via `node scripts/render` data) at the top of `report.html`, and leaves a clearly-marked empty "Growth & business" section placeholder (filled in Phase 2).

- [ ] **Step 1: Add target=both parsing + drift step to the command body**

Edit the Arguments block to accept `--target=both` (local default | live | both). After Step 5 (score), insert a "Step 5b - drift" instruction:
> If `--target=both`, run `git status --porcelain` and `git log @{u}..HEAD --oneline` (ignore errors if no upstream), then call `computePublishGap` semantics: compare `scores.local.json` vs `scores.live.json` per dimension (threshold 8) and render the Publish-Gap banner from `scripts/lib/publish-gap.mjs` (`gapToHtml`) as the FIRST section after the header. Write `scores.local.json` and `scores.live.json` separately and a merged `scores.json`.

Add to Step 6 the requirement: include a section `<!-- GROWTH SECTION -->` placeholder (empty in Phase 1).

- [ ] **Step 2: Manually verify the edit renders a drift banner**

Run (uses existing local screenshots; live will be skipped if no creds):
```
claude -p "/inventory-review --mode=daily --target=both" --permission-mode acceptEdits --output-format text
```
Expected: `reports/product-intel/<today>/report.html` contains a "Publish-Gap" section. If live creds absent, the banner notes live as "not configured".

- [ ] **Step 3: Commit** (ask owner)

```
git add .claude/commands/inventory-review.md
git commit -m "feat: inventory-review target=both with publish-gap drift section"
```

### Task 7: Orchestrator + npm scripts (the on-demand pipeline)

**Files:**
- Create: `scripts/weekly-intel.mjs`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `renderReport` (Task 3), `sendReport` (Task 5), the `/inventory-review` command (Task 6).
- Produces: `npm run intel:now` runs capture -> judge -> render -> email end to end and prints a final STATUS line.

- [ ] **Step 1: Write the orchestrator**

```js
// scripts/weekly-intel.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { renderReport } from './render-report-pdf.mjs';
import { sendReport } from './email-report.mjs';

const MODE = process.argv.includes('--monthly') ? 'monthly' : process.argv.includes('--daily') ? 'daily' : 'weekly';
const TARGET = process.argv.includes('--local') ? 'local' : process.argv.includes('--live') ? 'live' : 'both';
const date = new Date().toISOString().slice(0, 10); // orchestrator runs live, Date is allowed here (not in a workflow)
const reportDir = path.resolve('reports/product-intel', date);

function sh(cmd, opts = {}) { console.log('> ' + cmd); return execSync(cmd, { stdio: 'inherit', ...opts }); }
function shQuiet(cmd) { try { return execSync(cmd, { encoding: 'utf8' }); } catch { return ''; } }

(async () => {
  // 1. capture
  const wantLive = (TARGET === 'live' || TARGET === 'both') && process.env.GOD_EMAIL && process.env.GOD_PASSWORD;
  if (TARGET !== 'live') sh('npm run qa:bots');
  if (wantLive) { try { sh('npm run qa:bots:live'); } catch { console.warn('live capture failed, continuing local-only'); } }

  // 2. judge (subscription, NOT --bare)
  const effTarget = wantLive ? TARGET : 'local';
  sh(`claude -p "/inventory-review --mode=${MODE} --target=${effTarget} --refresh" --permission-mode acceptEdits --output-format text`);

  // 3. render
  const htmlPath = path.join(reportDir, 'report.html');
  if (!fs.existsSync(htmlPath)) { console.error('NO REPORT PRODUCED at ' + htmlPath); process.exit(1); }
  const { pdf } = await renderReport(htmlPath, path.join(reportDir, 'report.pdf'));

  // 4. email
  const html = fs.readFileSync(htmlPath, 'utf8');
  const res = await sendReport({ to: 'djsanti88@gmail.com', date, html, pdfPath: pdf });
  console.log(`STATUS: mode=${MODE} target=${effTarget} report=${htmlPath} pdf=${pdf} emailed=${res.sent}${res.reason ? ' reason=' + res.reason : ''}`);
})();
```

- [ ] **Step 2: Add npm scripts**

In `package.json` "scripts" add:
```json
"intel:now": "node scripts/weekly-intel.mjs --weekly",
"intel:local": "node scripts/weekly-intel.mjs --weekly --local",
"intel:live": "node scripts/weekly-intel.mjs --weekly --live"
```

- [ ] **Step 3: End-to-end proof (local target, with email creds set to self)**

Pre-req: owner has set `GMAIL_USER` + `GMAIL_APP_PASSWORD` in `.env.local` (Phase-1 setup). Then run:
```
npm run intel:local
```
Expected: prints a `STATUS:` line; `reports/product-intel/<today>/report.html` and `report.pdf` exist; an email arrives at djsanti88@gmail.com with the PDF attached. If creds not yet set, expect `emailed=false reason=no-credentials` and the files still present (graceful).

- [ ] **Step 4: Commit** (ask owner)

```
git add scripts/weekly-intel.mjs package.json
git commit -m "feat: weekly-intel orchestrator + intel:now on-demand pipeline"
```

---

# PHASE 2 - The 15 new agents

Additive markdown under `.claude/agents/`, then wire them into the command's fleets and fill the Growth section. Each agent follows the shared template; per-agent specifics are listed. A validator is the test.

### Task 8: Agent validator (the test harness for all agents)

**Files:**
- Create: `scripts/validate-agents.mjs`
- Test: `scripts/__tests__/validate-agents.test.mjs`

**Interfaces:**
- Produces: `validateAgentFile(text) -> { ok: boolean, errors: string[] }` checking: frontmatter has `name`, `description`, `tools`, `model`; body contains a ```json fenced block; body contains a line matching `/^[a-z_]+:\s*<?0-100>?/m` OR a `score` token; contains no em dash (`—`) or en dash (`–`).

- [ ] **Step 1: Write the failing test**

```js
// scripts/__tests__/validate-agents.test.mjs
import { describe, it, expect } from 'vitest';
import { validateAgentFile } from '../validate-agents.mjs';

const good = `---\nname: x\ndescription: d\ntools: Read\nmodel: sonnet\n---\nbody\n\`\`\`json\n[]\n\`\`\`\nscore_key: <0-100>\nNo em dashes.`;

describe('validateAgentFile', () => {
  it('passes a well-formed agent', () => {
    expect(validateAgentFile(good).ok).toBe(true);
  });
  it('fails on an em dash', () => {
    expect(validateAgentFile(good + '\nbad — dash').ok).toBe(false);
  });
  it('fails when the json block is missing', () => {
    expect(validateAgentFile(good.replace('```json\n[]\n```', '')).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** Run: `npx vitest run scripts/__tests__/validate-agents.test.mjs` -> FAIL.

- [ ] **Step 3: Write the implementation**

```js
// scripts/validate-agents.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateAgentFile(text) {
  const errors = [];
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) errors.push('missing frontmatter');
  else for (const key of ['name', 'description', 'tools', 'model']) {
    if (!new RegExp(`^${key}:`, 'm').test(fm[1])) errors.push('missing frontmatter key: ' + key);
  }
  if (!/```json[\s\S]*?```/.test(text)) errors.push('missing json findings block');
  if (!/score|<0-100>/i.test(text)) errors.push('missing score line');
  if (/[—–]/.test(text)) errors.push('contains em or en dash');
  return { ok: errors.length === 0, errors };
}

// CLI: validate every agent file
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = path.resolve('.claude/agents');
  let bad = 0;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
    const res = validateAgentFile(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!res.ok) { bad++; console.error(`FAIL ${f}: ${res.errors.join('; ')}`); }
  }
  console.log(bad ? `${bad} invalid agent file(s)` : 'all agents valid');
  process.exit(bad ? 1 : 0);
}
```

- [ ] **Step 4: Run the test -> PASS.** Run: `npx vitest run scripts/__tests__/validate-agents.test.mjs`

- [ ] **Step 5: Run the CLI against existing agents -> all valid.** Run: `node scripts/validate-agents.mjs` (expect "all agents valid").

- [ ] **Step 6: Commit** (ask owner). `git add scripts/validate-agents.mjs scripts/__tests__/validate-agents.test.mjs && git commit -m "feat: agent file validator"`

### Tasks 9-13: Create the 15 agents (one task per squad)

Shared template (every agent file). Replace ALL-CAPS slots per the per-agent spec, keep everything else:
```markdown
---
name: AGENT_NAME
description: ONE_LINE describing what it judges/advises and when /inventory-review dispatches it.
tools: TOOLS
model: sonnet
---

You are PERSONA. You are given the report dir, the screenshots/inputs to open, the mode, and the target (local vs live, where live is the real god account's real data). CONTEXT_SENTENCE.

## What you check
1. CHECK_1
2. CHECK_2
3. CHECK_3
4. CHECK_4
5. CHECK_5

## Output (return exactly this)
A short VERDICT_NOUN, then a fenced ```json block:
\`\`\`json
[{"fingerprint":"FPREFIX:<issue>","title":"...","category":"CATEGORY","severity":"blocker|high|medium|low","evidence":["<screenshot or file key>"],"recommendation":"...","auto_fixable":AUTOFIX}]
\`\`\`
Then one line: `SCORE_KEY: <0-100>` with a half-sentence why. No em dashes.
```

Per-agent specs (NAME | tools | persona | 5 checks | category | score_key | fprefix | auto_fixable default):

- [ ] **Task 9 - Deeper UX judges (4 files):**
  - `live-walkthrough` | tools: `Read, Bash(npx playwright*), Bash(npm run dev*)` | persona: "a clerk driving the LIVE running app, not just screenshots" | checks: 1 scan a known code and watch the count update, 2 scan an unknown then resolve it via Needs Review, 3 view the final-count table, 4 export CSV, 5 note every click where you hesitate or get stuck | category `usability` | score_key `ease_of_use` | fprefix `walkthrough` | auto_fixable false. Body must instruct: start the app (`npm run dev` on port 3100 or reuse a running one), drive it with Playwright, screenshot each step into the report dir.
  - `accessibility` | tools: `Read` | persona: "an accessibility auditor and a low-vision + colorblind user" | checks: 1 text/background contrast, 2 tap-target size on phone width, 3 keyboard focus order and visible focus, 4 colorblind-safe status colors (Decoding/Verified/Conflict), 5 labels/alt for icons and inputs | category `accessibility` | score_key `accessibility` | fprefix `a11y` | auto_fixable true (contrast/aria only).
  - `visual-polish` | tools: `Read` | persona: "a senior product designer judging premium vs hobby" | checks: 1 alignment and grid, 2 spacing rhythm, 3 type scale and hierarchy, 4 color harmony and restraint, 5 overall does-it-look-paid-SaaS | category `visual` | score_key `visual_polish` | fprefix `polish` | auto_fixable true (spacing/hex/font-size).
  - `copy-clarity` | tools: `Read` | persona: "a UX writer" | checks: 1 button labels are action-clear, 2 empty states explain what to do, 3 error messages are plain and recoverable, 4 headings orient the user, 5 no internal jargon leak (alias, FNSKU, idempotency, provider names) | category `copy` | score_key `copy_clarity` | fprefix `copy` | auto_fixable true (copy that is not user-data).
  - After writing: `node scripts/validate-agents.mjs` -> all valid. Commit (ask owner).

- [ ] **Task 10 - Engineering judges (3 files):**
  - `performance-device` | tools: `Read, Bash(npx*)` | persona: "a performance engineer on a cheap Android in the aisle" | checks: 1 first load time, 2 LCP/CLS/INP, 3 bundle weight, 4 scan-to-feedback latency, 5 jank during rapid scanning | category `performance` | score_key `performance` | fprefix `perf` | auto_fixable false. Body: prefer a Lighthouse pass (note it may be approximate from screenshots if the live URL is unavailable).
  - `code-review` | tools: `Read, Grep, Glob, Bash(git*)` | persona: "a staff engineer reviewing tech debt (NOT security)" | checks: 1 maintainability/structure, 2 dead or duplicated code, 3 risky patterns, 4 test coverage gaps, 5 files that have grown too large | category `engineering` | score_key `engineering_health` | fprefix `code` | auto_fixable false.
  - `qa-triage` | tools: `Read` | persona: "a QA lead who dedupes and prioritizes" | checks: 1 merge duplicate findings across agents, 2 drop known false positives, 3 rank by severity x reach, 4 separate blockers from nits, 5 produce the single prioritized action list | category `triage` | score_key `triage_confidence` | fprefix `triage` | auto_fixable false. Note: runs AFTER the other agents; its input is their combined findings.
  - Validate + commit (ask owner).

- [ ] **Task 11 - Customer-value advisors (3 files):**
  - `value-roi` | tools: `Read` | persona: "a shop owner deciding if this is worth paying for" | checks: 1 the single highest-ROI feature for a paying shop, 2 where current value falls short of price, 3 time saved per inventory session, 4 what would make them say 'worth it', 5 lowest-value surface to cut | category `value` | score_key `customer_value` | fprefix `roi` | auto_fixable false.
  - `conversion-activation` | tools: `Read` | persona: "a growth PM on the signup-to-first-scan funnel" | checks: 1 steps from signup to first successful scan, 2 the aha moment and how fast it arrives, 3 onboarding friction, 4 drop-off risks, 5 one change to lift activation | category `activation` | score_key `activation` | fprefix `activation` | auto_fixable false.
  - `retention-churn` | tools: `Read` | persona: "a retention analyst" | checks: 1 what brings a shop back next week, 2 top churn risk, 3 habit loop strength, 4 re-engagement trigger ideas, 5 the data the app should track to see churn early | category `retention` | score_key `retention` | fprefix `retention` | auto_fixable false.
  - Validate + commit (ask owner).

- [ ] **Task 12 - Marketing + growth advisors (3 files):**
  - `marketing-angle` | tools: `Read` | persona: "a product marketer (use the marketing skills)" | checks: 1 sharpest positioning line, 2 the ICP to target first, 3 top 3 channels, 4 the core message, 5 the proof points to show | category `marketing` | score_key `marketing_readiness` | fprefix `mkt` | auto_fixable false.
  - `pricing-strategy` | tools: `Read` | persona: "a pricing strategist (use the pricing-strategy skill)" | checks: 1 packaging/tiers, 2 freemium vs paid line, 3 per-seat vs usage vs flat, 4 anchor price, 5 what to gate behind paid | category `pricing` | score_key `pricing_clarity` | fprefix `price` | auto_fixable false.
  - `growth-loops` | tools: `Read` | persona: "a growth engineer designing CTAs and referral loops (use referral-program + growth-strategy skills)" | checks: 1 the single best in-app CTA, 2 an invite-a-friend mechanic that fits a B2B scanner, 3 the referral incentive, 4 where the loop closes, 5 the lightest viable version to ship first | category `growth` | score_key `growth_loop` | fprefix `loop` | auto_fixable false.
  - Validate + commit (ask owner).

- [ ] **Task 13 - Strategy advisors (2 files):**
  - `competitor-intel` | tools: `Read, WebSearch` | persona: "a competitive analyst vs other inventory/scanner SaaS" | checks: 1 the closest 3 competitors, 2 their pricing, 3 a feature you lack, 4 a wedge you can own, 5 the biggest competitive threat | category `competitive` | score_key `competitive_position` | fprefix `comp` | auto_fixable false.
  - `product-strategy` | tools: `Read` | persona: "a head of product on the SaaS roadmap" | checks: 1 multi-tenant readiness, 2 the next 3 roadmap bets in order, 3 the biggest strategic risk, 4 what to NOT build, 5 the 90-day focus | category `strategy` | score_key `strategy_clarity` | fprefix `strat` | auto_fixable false.
  - Validate + commit (ask owner).

### Task 14: Wire new agents into the command fleets + fill the Growth section

**Files:**
- Modify: `.claude/commands/inventory-review.md`

- [ ] **Step 1:** Update Step 2 (fleet selection) so: daily = unchanged; weekly = the 19 judges (run against both targets) + qa-triage synthesis + a light growth slice (value-roi, conversion-activation, growth-loops, run ONCE not per target); monthly = all 27 including the full advisor squad. State explicitly: advisors run once and are target-agnostic; judges run per target.

- [ ] **Step 2:** Update Step 6 so the report includes a "Growth & business" section (replacing the Phase-1 `<!-- GROWTH SECTION -->` placeholder) rendering each advisor's output: ROI ranked list, activation, retention, marketing angle, pricing, growth loop, competitor gaps, roadmap.

- [ ] **Step 3: Proof:** run `claude -p "/inventory-review --mode=weekly --target=both --refresh" --permission-mode acceptEdits --output-format text` and confirm `report.html` now contains the Growth section and new judge lenses, and `node scripts/validate-agents.mjs` passes.

- [ ] **Step 4: Commit** (ask owner). `git add .claude/commands/inventory-review.md && git commit -m "feat: wire 15 new agents into fleets + growth report section"`

---

# PHASE 3 - Schedule (Sunday 6pm CT) + setup docs

### Task 15: Windows Task Scheduler registration + setup doc

**Files:**
- Create: `scripts/register-weekly-task.ps1`
- Create: `docs/WEEKLY_INTEL_SETUP.md`
- Modify: `.env.example` (add names only)

**Interfaces:**
- Produces: a scheduled task `SmartInventoryWeeklyIntel` running `npm run intel:now` every Sunday 18:00 local, catch-up if missed, wake to run.

- [ ] **Step 1: Write the registration script**

```powershell
# scripts/register-weekly-task.ps1  (run once, from the project root)
$proj = (Resolve-Path "$PSScriptRoot\..").Path
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c cd /d `"$proj`" && npm run intel:now >> `"$proj\reports\product-intel\cron.log`" 2>&1"
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 6:00PM
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -RunOnlyIfNetworkAvailable
Register-ScheduledTask -TaskName "SmartInventoryWeeklyIntel" -Action $action -Trigger $trigger -Settings $settings -Description "Smart Inventory weekly product+growth intelligence report" -Force
Write-Host "Registered SmartInventoryWeeklyIntel for Sundays 6:00 PM (America/Chicago assumed = machine local time)."
```

- [ ] **Step 2: Write `docs/WEEKLY_INTEL_SETUP.md`** documenting: (a) Gmail app-password steps -> `GMAIL_USER`/`GMAIL_APP_PASSWORD`; (b) optional `GOD_EMAIL`/`GOD_PASSWORD` for live; (c) run `powershell -ExecutionPolicy Bypass -File scripts/register-weekly-task.ps1` once; (d) confirm machine timezone is America/Chicago or adjust the trigger; (e) on-demand = `npm run intel:now`; (f) note PC must be on (StartWhenAvailable catches up on next wake).

- [ ] **Step 3: Add names to `.env.example`:** `GMAIL_USER=`, `GMAIL_APP_PASSWORD=`, `GOD_EMAIL=`, `GOD_PASSWORD=` (names only, no values).

- [ ] **Step 4: Register + verify (owner consent for the scheduled task):**

Run: `powershell -ExecutionPolicy Bypass -File scripts/register-weekly-task.ps1` then `schtasks /query /tn SmartInventoryWeeklyIntel`
Expected: the task is listed with a Sunday 18:00 trigger.

- [ ] **Step 5: Commit** (ask owner). `git add scripts/register-weekly-task.ps1 docs/WEEKLY_INTEL_SETUP.md .env.example && git commit -m "feat: weekly schedule registration + setup docs"`

---

## Self-Review (done at write time)

**Spec coverage:** 27 agents -> Phase 1 uses existing 12; Phase 2 Tasks 9-13 add all 15 new (4+3+3+3+2). Both targets + drift -> Tasks 4, 6, 7. HTML+PDF -> Tasks 3, 6. Auto-email -> Tasks 2, 5, 7. Schedule Sun 6pm + on-demand -> Tasks 7 (intel:now) + 15. $0 API / subscription -> Task 1 spike + orchestrator never uses `--bare`. Setup/creds -> Task 15 + `.env.example`. Guardrails -> Global Constraints + graceful-degrade tests (Tasks 5, 7). All spec sections map to a task.

**Placeholder scan:** the only intentional placeholder is `<!-- GROWTH SECTION -->` in Phase 1, explicitly filled in Task 14. No TBD/TODO left in code steps; all code blocks are complete.

**Type consistency:** `renderReport(htmlPath, outPdfPath)->{pdf,png}` used identically in Tasks 3 and 7. `sendReport(opts, env)->{sent,reason}` and `buildMessage` consistent Tasks 5 and 7. `computePublishGap`/`gapToHtml` consistent Tasks 4 and 6. `validateAgentFile` consistent Tasks 8-13. Agent `score_key` names are unique per agent.

## Open risks carried from the spec

1. Headless auth under Task Scheduler (Task 1 proves the CLI path; Task 15 proves the scheduler path). If Task 1 fails, STOP and report - the whole automation depends on it.
2. Unattended permissions: orchestrator uses `--permission-mode acceptEdits`; if the fleet needs broader tools, a scoped settings allowlist may be required (adjust in Task 7).
3. `Date.now()`/`new Date()` is used in the orchestrator and is fine there (plain Node script, not a Workflow).
