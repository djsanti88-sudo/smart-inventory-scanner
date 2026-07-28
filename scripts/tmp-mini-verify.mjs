// FREE model-existence check (GET /v1/models/<id> does NOT bill tokens). Confirms which candidate
// "mini" IDs actually exist before we spend anything on the paid 21-code bakeoff. Key read from
// .env.local at runtime, never printed. Usage: node scripts/tmp-mini-verify.mjs
import fs from "node:fs";

const env = {};
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
const KEY = env.OPENAI_API_KEY;
if (!KEY) { console.error("missing OPENAI_API_KEY in .env.local"); process.exit(1); }

const CANDIDATES = ["gpt-5.5", "gpt-5.5-mini", "gpt-5-mini", "gpt-5.4-mini", "gpt-5.5-pro", "gpt-5"];

(async () => {
  console.log("Checking OpenAI model availability (free GET /v1/models/<id>):\n");
  for (const id of CANDIDATES) {
    try {
      const r = await fetch(`https://api.openai.com/v1/models/${id}`, {
        headers: { Authorization: `Bearer ${KEY}` },
      });
      if (r.ok) {
        const d = await r.json();
        console.log(`  EXISTS   ${id.padEnd(16)} (owned_by: ${d.owned_by || "?"})`);
      } else if (r.status === 404) {
        console.log(`  MISSING  ${id.padEnd(16)} (404 - not a valid model id for this key)`);
      } else {
        console.log(`  ???      ${id.padEnd(16)} (HTTP ${r.status})`);
      }
    } catch (e) {
      console.log(`  ERROR    ${id.padEnd(16)} ${String(e.message || e).slice(0, 60)}`);
    }
  }
})();
