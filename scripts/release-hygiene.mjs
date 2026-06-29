// Release-hygiene check: "did I forget to commit / push / deploy?" Deterministic, fast, no deps.
// Reports the work that has NOT been safely shipped, in plain English, with a risk verdict.
// Run:  node scripts/release-hygiene.mjs            (human-readable)
//       node scripts/release-hygiene.mjs --json     (machine output for the weekly report)
//
// Deploy-drift (is production behind local?) needs the deploy target (Vercel) and is added by the
// release-hygiene AGENT via the Vercel MCP; this script covers the local git side, which is the part
// that loses work. NOTE: this repo lives on OneDrive and has had .git partial-sync issues, so
// committed-but-unpushed work here is genuinely at risk - pushing is the real backup.
//
// Security: uses execFileSync with an ARGUMENT ARRAY (no shell), so branch names or refs that contain
// shell metacharacters are passed as literal args and can never inject a command.
import { execFileSync } from 'node:child_process';

function git(args) {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}
function gitLines(args) { const o = git(args); return o ? o.split('\n').map((s) => s.trim()).filter(Boolean) : []; }
function num(args) { const n = Number(git(args)); return Number.isFinite(n) ? n : 0; }

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) || '(unknown)';
const head = git(['rev-parse', '--short', 'HEAD']) || '(none)';
const hasUpstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) !== '';

// uncommitted (working tree + staged)
const dirty = gitLines(['status', '--porcelain']);
const SECRET_RE = /\.(env|pem|key|p12|pfx)$|secret|credential|sa-key|service.?account|playwright-results\.json/i;
const secretSuspects = dirty.map((l) => l.slice(3)).filter((f) => SECRET_RE.test(f));

// unpushed / behind (no upstream -> the whole branch is effectively "unpushed")
const ahead = hasUpstream ? num(['rev-list', '--count', '@{u}..HEAD']) : num(['rev-list', '--count', 'HEAD']);
const behind = hasUpstream ? num(['rev-list', '--count', 'HEAD..@{u}']) : 0;
const aheadCommits = hasUpstream ? gitLines(['log', '@{u}..HEAD', '--oneline']).slice(0, 8) : gitLines(['log', '--oneline', '-8']);

// stashes + branch sprawl
const stashes = gitLines(['stash', 'list']);
const localBranches = gitLines(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
const branchesNoRemote = localBranches.filter((b) => git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${b}@{u}`]) === '');

const lastCommitWhen = git(['log', '-1', '--format=%cr']) || '(none)';

const flags = [];
if (dirty.length) flags.push({ sev: 'high', kind: 'uncommitted', detail: `${dirty.length} uncommitted file(s) - you could lose this work.` });
if (secretSuspects.length) flags.push({ sev: 'blocker', kind: 'secret_risk', detail: `${secretSuspects.length} changed file(s) look like secrets/keys: ${secretSuspects.slice(0, 5).join(', ')} - do NOT commit before checking (gitleaks).` });
if (!hasUpstream) flags.push({ sev: 'high', kind: 'no_remote', detail: `Branch "${branch}" has NO upstream - it has NEVER been pushed. On OneDrive that is your only copy.` });
else if (ahead) flags.push({ sev: 'high', kind: 'unpushed', detail: `${ahead} commit(s) committed but NOT pushed - not backed up, and customers do not have them.` });
if (behind) flags.push({ sev: 'medium', kind: 'behind', detail: `${behind} commit(s) on the remote you do not have locally - pull before you push.` });
if (stashes.length) flags.push({ sev: 'low', kind: 'stash', detail: `${stashes.length} stash(es) - work you set aside and may have forgotten.` });
if (branchesNoRemote.length > 1) flags.push({ sev: 'low', kind: 'branch_sprawl', detail: `${branchesNoRemote.length} local branch(es) never pushed: ${branchesNoRemote.slice(0, 6).join(', ')}.` });

const worst = flags.reduce((m, f) => Math.min(m, { blocker: 0, high: 1, medium: 2, low: 3 }[f.sev] ?? 3), 4);
const verdict = flags.length === 0
  ? 'CLEAN: everything is committed and pushed. (Deploy status is checked separately by the agent.)'
  : worst <= 1
    ? 'ACTION NEEDED: you have unshipped work that is at risk or not live.'
    : 'MINOR: a few housekeeping items, nothing urgent.';

const result = { branch, head, hasUpstream, uncommitted: dirty.length, secretSuspects, ahead, behind, aheadCommits, stashes: stashes.length, branchesNoRemote, lastCommitWhen, flags, verdict, deployDrift: 'unknown (checked by the release-hygiene agent via Vercel)' };

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('=== Release hygiene: did you forget to ship? ===');
  console.log(`branch: ${branch} @ ${head} | last commit: ${lastCommitWhen}`);
  console.log(verdict + '\n');
  if (!flags.length) console.log('Nothing local is at risk. Remember to check it is DEPLOYED if a fix needs to reach customers.');
  for (const f of flags) console.log(`  [${f.sev.toUpperCase()}] ${f.detail}`);
  if (ahead && hasUpstream) { console.log('\nUnpushed commits:'); aheadCommits.forEach((c) => console.log('   ' + c)); }
  console.log('\nReminder: pushed != deployed. A fix protects customers only after it is live.');
}
