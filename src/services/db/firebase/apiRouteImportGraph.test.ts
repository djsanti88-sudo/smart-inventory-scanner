import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

// GUARD (Problem B regression): a server API route must NOT pull the CLIENT Firebase SDK into its bundle.
// `/api/resolve-scan` previously crashed on Vercel because it transitively imported `firebase/firestore`
// via businessDataLoader. This test walks each API route's FULL internal import graph (not just direct
// imports) and fails if any reachable module does a RUNTIME import from a client Firebase package.

const ROOT = process.cwd();
const FORBIDDEN = [
  "firebase/firestore",
  "firebase/app",
  "firebase/auth",
  "firebase/storage",
  "firebase/database",
  "firebase/functions",
  "firebase/messaging",
  "firebase/analytics",
  "@/lib/firebaseClient",
];

const IDENTITY_SOURCE_FORBIDDEN = [
  "@/server/upc/storage",
  "@libsql/client",
  "fetch",
  "@/server/decode/pipeline",
  "/api/ai-lookup",
];

// Resolve an import specifier to a repo file path, or null if it is external (node_modules) / unresolved.
function resolveInternal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = resolve(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // bare/external module
  const cands = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  return cands.find((c) => existsSync(c)) ?? null;
}

// Returns the runtime import/export specifiers in a source file (skips `import type` / `export type` —
// those are erased and cannot bundle client code).
function runtimeSpecifiers(src: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+([^;]*?)\s+from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const sideEffect = m[4];
    if (sideEffect) { out.push(sideEffect); continue; }
    const clause = m[2] ?? "";
    const spec = m[3];
    // whole-statement type-only import/export (e.g. `import type { X } from "..."`)
    if (/^type\b/.test(clause.trim())) continue;
    out.push(spec);
  }
  return out;
}

function walk(entry: string): { file: string; spec: string; chain: string[] }[] {
  const violations: { file: string; spec: string; chain: string[] }[] = [];
  const seen = new Set<string>();
  const stack: { file: string; chain: string[] }[] = [{ file: entry, chain: [entry] }];
  while (stack.length) {
    const { file, chain } = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const spec of runtimeSpecifiers(src)) {
      if (FORBIDDEN.includes(spec)) {
        violations.push({ file: file.replace(ROOT, "").replace(/\\/g, "/"), spec, chain });
        continue;
      }
      const internal = resolveInternal(spec, file);
      if (internal) stack.push({ file: internal, chain: [...chain, spec] });
    }
  }
  return violations;
}

function findApiRoutes(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...findApiRoutes(p));
    else if (/route\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("API route import-graph guard (no client Firebase SDK in server bundle)", () => {
  const routes = findApiRoutes(resolve(ROOT, "src/app/api"));

  it("finds at least the resolve-scan route", () => {
    expect(routes.some((r) => r.replace(/\\/g, "/").includes("resolve-scan/route"))).toBe(true);
  });

  for (const route of routes) {
    const rel = route.replace(ROOT, "").replace(/\\/g, "/");
    it(`${rel} does not transitively import a client Firebase SDK`, () => {
      const violations = walk(route);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });
  }
});

describe("read-only identity candidate-source import guard", () => {
  it("does not import storage, providers, decode, or AI lookup paths", () => {
    const source = resolve(ROOT, "src/server/identity/readOnlyCandidateSource.ts");
    const index = resolve(ROOT, "src/server/identity/localSnapshotIndex.ts");
    const imported = [...runtimeSpecifiers(readFileSync(source, "utf8")), ...runtimeSpecifiers(readFileSync(index, "utf8"))];

    expect(imported.filter((specifier) => IDENTITY_SOURCE_FORBIDDEN.includes(specifier))).toEqual([]);
  });
});
