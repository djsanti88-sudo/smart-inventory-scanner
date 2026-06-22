import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// STATIC server-only boundary guard. The global tire barcode corpus must never reach a customer browser,
// so NO client-bundled module may import src/server/tire-knowledge. This walks src/ and fails if any
// "use client" file, client component, or Zustand store imports @/server/tire-knowledge or the generated
// index. (The `server-only` package enforces this at build time too; this test fails fast + explains why.)

const SRC = join(process.cwd(), "src");
const FORBIDDEN = /@\/server\/tire-knowledge|tireKnowledge\.generated|TireKnowledgeProvider|tireKnowledgeIndex/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules") continue;
      out.push(...walk(p));
    } else if (/\.(ts|tsx|js|jsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe("server-only boundary: tire-knowledge is never client-bundled", () => {
  const files = walk(SRC);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no 'use client' file imports the tire-knowledge corpus", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const isClient = /^\s*["']use client["']/m.test(src);
      if (isClient && FORBIDDEN.test(src)) offenders.push(f.replace(process.cwd(), ""));
    }
    expect(offenders, "client files importing the server-only corpus").toEqual([]);
  });

  it("no client store / component imports the tire-knowledge corpus", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (!/[\\/](stores|components)[\\/]/.test(f)) continue;
      if (FORBIDDEN.test(readFileSync(f, "utf8"))) offenders.push(f.replace(process.cwd(), ""));
    }
    expect(offenders, "client stores/components importing the server-only corpus").toEqual([]);
  });

  it("the index reader + provider declare the server-only boundary", () => {
    for (const f of ["tireKnowledgeIndex.ts", "TireKnowledgeProvider.ts"]) {
      const src = readFileSync(join(SRC, "server", "tire-knowledge", f), "utf8");
      expect(src, `${f} must import 'server-only'`).toMatch(/import ["']server-only["']/);
    }
  });
});
