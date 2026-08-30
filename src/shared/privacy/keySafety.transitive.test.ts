import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

// TRANSITIVE key-safety guard (2026-08-12).
//
// keySafety.test.ts is cited in CLAUDE.md, AGENTS.md, and GUARDRAILS.md as the proof
// that "API keys live server-side in EVERY environment - never shipped to the browser."
// Its actual coverage is narrower than that claim: it scans a five-directory allowlist
// (src/components, src/stores, src/app/(app), src/app/login, src/lib) and greps each
// file's OWN text. It never follows imports, and it never looks at src/services/** at all.
//
// So this passes today and ships a key:
//     src/services/quoteHelper.ts   ->  reads process.env.OPENAI_API_KEY, no "server-only"
//     src/components/Quote.tsx      ->  imports it
// The component's own text is clean, so the allowlist scan sees nothing, and
// src/services is never scanned regardless.
//
// This test closes that gap by walking the real import graph out of every client entry
// point and failing on any REACHABLE module that reads a secret. It complements the
// original rather than replacing it -- keep both.

const SRC = join(process.cwd(), "src");

const SECRET_READS = [
  "process.env.OPENAI_API_KEY",
  "process.env.TURSO_AUTH_TOKEN",
  "FIREBASE_SERVICE_ACCOUNT_PATH",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules") continue;
      out.push(...walk(p));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** Resolve an import specifier to a file on disk, or null for packages / unresolvable paths. */
function resolveImport(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // node_modules package
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

function importsOf(file: string, src: string): string[] {
  const specs: string[] = [];
  const re = /(?:from\s+|import\s+)["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) specs.push(m[1]);
  return specs.map((s) => resolveImport(s, file)).filter((p): p is string => p !== null);
}

const isServerOnly = (src: string) => /import\s+["']server-only["']/.test(src);

// Folders that are CLIENT BY CONSTRUCTION. Pre-reorganization this was just components/ and stores/.
// The folder reorganization emptied components/ and spread that UI across feature folders, so the
// old two-name regex would have quietly stopped treating them as entry points - a client helper with
// no "use client" directive would then never be walked. Listed explicitly, and asserted below.
const CLIENT_BY_CONSTRUCTION =
  /[\\/](components|stores|authentication|users-businesses|user-interface|scanning|inventory|review|sessions|import|reconcile|reports|sync-database|products|admin|decoding)[\\/]/;

/** Client entry points: "use client" files, plus everything in a client-by-construction folder. */
function clientEntryPoints(): string[] {
  return walk(SRC).filter((f) => {
    // Match on the path RELATIVE to src/, never the absolute path: the repo itself lives in a
    // directory called "inventory", so an absolute-path test would match every file in the project.
    const rel = f.slice(SRC.length);
    // server/ wins: it is server by construction even inside a feature folder (e.g. decoding/server).
    if (/[\\/]server[\\/]/.test(rel)) return false;
    // src/app/api holds server route handlers, which legitimately read secrets.
    if (/^[\\/]app[\\/]api[\\/]/.test(rel)) return false;
    if (CLIENT_BY_CONSTRUCTION.test(rel)) return true;
    return /^\s*["']use client["']/m.test(readFileSync(f, "utf8"));
  });
}

describe("API key safety (transitive)", () => {
  const entries = clientEntryPoints();

  it("finds client entry points to walk", () => {
    expect(entries.length).toBeGreaterThan(20);
  });

  it("no module reachable from client code reads a provider secret", () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    // BFS over the import graph, remembering how we got to each module.
    const queue: Array<{ file: string; chain: string[] }> = entries.map((f) => ({ file: f, chain: [f] }));

    while (queue.length) {
      const { file, chain } = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);

      const src = readFileSync(file, "utf8");
      const rel = (p: string) => p.replace(process.cwd(), "").replace(/\\/g, "/");

      // `import "server-only"` makes a module impossible to include in a client bundle -
      // the build fails loudly. Reaching one from client code is itself the bug; stop here
      // rather than reporting every secret beneath it.
      if (isServerOnly(src)) {
        if (chain.length > 1) offenders.push(`server-only module reachable from client: ${chain.map(rel).join(" -> ")}`);
        continue;
      }

      for (const needle of SECRET_READS) {
        if (src.includes(needle)) offenders.push(`${needle} reachable from client: ${chain.map(rel).join(" -> ")}`);
      }

      for (const dep of importsOf(file, src)) queue.push({ file: dep, chain: [...chain, dep] });
    }

    expect(offenders, "secrets reachable from client code via the import graph").toEqual([]);
  });
});
