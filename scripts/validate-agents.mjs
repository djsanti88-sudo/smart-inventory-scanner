// Validates every .claude/agents/*.md follows the house style.
// CLI: node scripts/validate-agents.mjs  (exit 1 if any invalid)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateAgentFile(text) {
  const errors = [];
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) {
    errors.push('missing frontmatter');
  } else {
    for (const key of ['name', 'description', 'tools', 'model']) {
      if (!new RegExp(`^${key}:`, 'm').test(fm[1])) errors.push('missing frontmatter key: ' + key);
    }
  }
  if (!/```json[\s\S]*?```/.test(text)) errors.push('missing json findings block');
  if (!/score|<0-100>/i.test(text)) errors.push('missing score line');
  if (/[—–]/.test(text)) errors.push('contains em or en dash');
  return { ok: errors.length === 0, errors };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = path.resolve('.claude/agents');
  let bad = 0;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const res = validateAgentFile(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!res.ok) { bad++; console.error(`FAIL ${f}: ${res.errors.join('; ')}`); }
  }
  console.log(bad ? `${bad} invalid agent file(s)` : 'all agents valid');
  process.exit(bad ? 1 : 0);
}

