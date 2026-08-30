import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// F5 bundle-surgery (wave 2, 2026-07-20): derivedPrefixMap.json (2.37MB raw) used to be statically
// imported by the CLIENT-SAFE @/products/catalog/prefixIndex.ts, reaching the /scan bundle via
// scanStore.ts -> prefixFloor.ts -> prefixIndex.ts (see .superpowers/stress/fixes/
// f5-bundle-investigation.md). It now lives ONLY in @/server/catalog/prefixIndexServer.ts (guarded by
// the `server-only` package). This STATIC boundary guard walks src/ and fails if any "use client"
// file, client component, or Zustand store imports the server-only prefix-index module or the raw
// derivedPrefixMap.json directly - mirroring the existing server/upc and server/tire-knowledge
// boundary tests (server-only enforces this at build time too; this test fails fast + explains why).

const SRC = join(process.cwd(), "src");
const FORBIDDEN = /@\/server\/catalog\/prefixIndexServer|derivedPrefixMap\.json/;

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

describe("server-only boundary: derivedPrefixMap.json / prefixIndexServer are never client-bundled", () => {
  const files = walk(SRC);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no 'use client' file imports the server-only prefix index or the raw derived map", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const isClient = /^\s*["']use client["']/m.test(src);
      if (isClient && FORBIDDEN.test(src)) offenders.push(f.replace(process.cwd(), ""));
    }
    expect(offenders, "client files importing the server-only derived prefix map").toEqual([]);
  });

  it("no client store / component imports the server-only prefix index or the raw derived map", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (!/[\\/](stores|components)[\\/]/.test(f)) continue;
      if (FORBIDDEN.test(readFileSync(f, "utf8"))) offenders.push(f.replace(process.cwd(), ""));
    }
    expect(offenders, "client stores/components importing the server-only derived prefix map").toEqual([]);
  });

  it("the client-safe prefixIndex.ts module itself does not import the derived map", () => {
    const src = readFileSync(join(SRC, "products", "catalog", "prefixIndex.ts"), "utf8");
    // Comments may reference the filename for documentation; only a real ES import/require is forbidden.
    expect(
      src,
      "prefixIndex.ts must not statically import derivedPrefixMap.json",
    ).not.toMatch(/(?:import\s.*from\s+["']|require\(["'])[^"']*derivedPrefixMap\.json["')]/);
  });

  it("prefixIndexServer.ts declares the server-only boundary", () => {
    const src = readFileSync(join(SRC, "server", "catalog", "prefixIndexServer.ts"), "utf8");
    const firstLine = src.split(/\r?\n/, 1)[0].trim();
    expect(firstLine, "prefixIndexServer.ts must start with import \"server-only\"").toMatch(
      /^import ["']server-only["'];?$/,
    );
  });
});
