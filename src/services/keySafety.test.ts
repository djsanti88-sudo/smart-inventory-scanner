import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Proves provider API keys are read SERVER-SIDE ONLY. Client code (components, stores, app pages)
// must never read process.env.GEMINI_API_KEY / OPENAI_API_KEY - that would leak the secret into the
// browser bundle. Only the server route + provider modules may read them.

const CLIENT_DIRS = ["src/components", "src/stores", "src/app/(app)", "src/app/login"];
const FORBIDDEN = ["process.env.GEMINI_API_KEY", "process.env.OPENAI_API_KEY"];

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else out.push(full);
  }
  return out;
}

describe("API key safety", () => {
  it("no client file reads provider API keys from the environment", () => {
    const offenders: string[] = [];
    for (const dir of CLIENT_DIRS) {
      for (const file of walk(join(process.cwd(), dir))) {
        if (!/\.(ts|tsx)$/.test(file) || file.includes(".test.")) continue;
        const src = readFileSync(file, "utf8");
        for (const needle of FORBIDDEN) if (src.includes(needle)) offenders.push(`${file} -> ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
