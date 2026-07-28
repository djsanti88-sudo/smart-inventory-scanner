import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Every API route that calls checkRateLimit must scope its key with an UPPERCASE route prefix
// (e.g. `POST:${ip}`, `DISPUTE:${ip}`, "EXPORT:" + ip). A bare-IP key means unrelated routes share
// ONE fixed-window bucket per IP - heavy AI decode traffic could 429 catalog disputes and vice
// versa (Codex interaction-review finding, 2026-07-27). The prefix keeps each route's budget
// independent while still keying on the caller IP.

const API_DIR = join(process.cwd(), "src", "app", "api");

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

describe("rate-limit bucket scoping", () => {
  const routeFiles = walk(API_DIR).filter((f) => f.endsWith("route.ts") && !f.includes(".test."));

  it("finds the API route files (guard against a moved tree silently passing)", () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  it("every checkRateLimit call site scopes its key with an UPPERCASE prefix", () => {
    const violations: string[] = [];
    for (const file of routeFiles) {
      const src = readFileSync(file, "utf8");
      // Match each call's first argument: checkRateLimit(<keyExpr>,
      const callRe = /checkRateLimit\(\s*([^,)]+)/g;
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(src)) !== null) {
        const keyExpr = m[1].trim();
        // Accepted shapes: `PREFIX:${...}` template, or "PREFIX:" + expr string concat.
        const scoped = /^`[A-Z][A-Z0-9_]*:\$\{/.test(keyExpr) || /^"[A-Z][A-Z0-9_]*:"/.test(keyExpr);
        if (!scoped) violations.push(`${file}: checkRateLimit(${keyExpr}, ...)`);
      }
    }
    expect(violations, `unscoped rate-limit keys share one bucket across routes:\n${violations.join("\n")}`).toEqual([]);
  });

  // Pins the ACTUAL literal prefix each of the four routes implicated in the Codex interaction-
  // review finding passes to checkRateLimit, not just "some uppercase prefix". This fails if a
  // route's specific prefix is renamed, collapsed onto another route's prefix (re-introducing
  // shared-bucket collisions), or removed outright - the generic "is it scoped" check above would
  // still pass if e.g. catalog-dispute's DISPUTE: was silently changed to REVIEW: (an ai-lookup/
  // catalog-review collision), so this check locks the exact strings down per file.
  it("pins the exact route-to-limiter key prefix for each known call site", () => {
    const expected: Array<{ file: string; pattern: RegExp }> = [
      { file: join(API_DIR, "ai-lookup", "route.ts"), pattern: /checkRateLimit\(\s*`GET:\$\{/ },
      { file: join(API_DIR, "ai-lookup", "route.ts"), pattern: /checkRateLimit\(\s*`POST:\$\{/ },
      { file: join(API_DIR, "catalog-dispute", "route.ts"), pattern: /checkRateLimit\(\s*`DISPUTE:\$\{/ },
      { file: join(API_DIR, "catalog-review", "route.ts"), pattern: /checkRateLimit\(\s*`REVIEW:\$\{/ },
      { file: join(API_DIR, "catalog-review", "[id]", "route.ts"), pattern: /checkRateLimit\(\s*`REVIEW_ID:\$\{/ },
      { file: join(API_DIR, "account", "export", "route.ts"), pattern: /checkRateLimit\(\s*`EXPORT:\$\{/ },
    ];
    const missing: string[] = [];
    for (const { file, pattern } of expected) {
      let src: string;
      try {
        src = readFileSync(file, "utf8");
      } catch {
        missing.push(`${file}: file not found`);
        continue;
      }
      if (!pattern.test(src)) {
        missing.push(`${file}: expected checkRateLimit call matching ${pattern} not found (prefix renamed, collapsed onto another route, or removed)`);
      }
    }
    expect(missing, `route-to-limiter key prefix drift detected:\n${missing.join("\n")}`).toEqual([]);
  });
});
