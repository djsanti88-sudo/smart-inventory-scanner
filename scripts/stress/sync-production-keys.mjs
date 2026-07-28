// Owner-authorized 2026-07-20: copy BRAVE_SEARCH_API_KEY + OPENAI_API_KEY from .env.local to the
// Vercel PREVIEW env. Values never print; only variable names and success/failure are logged.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const VARS = ["OPENAI_API_KEY","BRAVE_SEARCH_API_KEY","FIRECRAWL_API_KEY_1","FIRECRAWL_API_KEY_2","FIRECRAWL_API_KEY_3","FIRECRAWL_API_KEY_4","FIRECRAWL_API_KEY_5","FIRECRAWL_API_KEY_6","FIRECRAWL_API_KEY_7"];
for (const name of VARS) {
  const value = env[name];
  if (!value) { console.log(name + ": MISSING in .env.local, skipped"); continue; }
  // Remove any existing production value first (add fails on duplicates). Ignore rm failure (may not exist).
  spawnSync("vercel", ["env", "rm", name, "production", "-y"], { stdio: "ignore", shell: true });
  const r = spawnSync("vercel", ["env", "add", name, "production"], { input: value, encoding: "utf8", shell: true });
  const ok = r.status === 0;
  console.log(name + ": " + (ok ? "SET on production (" + value.length + " chars)" : "FAILED: " + (r.stderr || "").split("\n").slice(-3).join(" ").slice(0, 200)));
}
