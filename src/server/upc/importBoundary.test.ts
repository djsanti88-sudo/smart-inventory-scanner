import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// STATIC server-only boundary guard. The Go-UPC decode archive + monthly usage counter are
// server-only: they hold the paid-lookup ledger and cached decode results and must never reach a
// customer browser. So NO client-bundled module may import src/server/upc. This walks src/ and fails
// if any "use client" file, client component, or Zustand store imports @/server/upc (any submodule).
// (The `server-only` package enforces this at build time too; this test fails fast + explains why.)
//
// NOTE: src/services/upc/* (gtin, goUpcClient, goUpcThrottle) are intentionally PURE and client-safe
// (no secrets, no filesystem, no network) and are deliberately NOT in the forbidden list. Only the
// src/server/upc modules are guarded here.

const SRC = join(process.cwd(), "src");
const FORBIDDEN = /@\/server\/upc|GoUpcProvider/;

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

describe("server-only boundary: upc modules are never client-bundled", () => {
  const files = walk(SRC);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no 'use client' file imports the server-only upc modules", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const isClient = /^\s*["']use client["']/m.test(src);
      if (isClient && FORBIDDEN.test(src)) offenders.push(f.replace(process.cwd(), ""));
    }
    expect(offenders, "client files importing the server-only upc modules").toEqual([]);
  });

  it("no client store / component imports the server-only upc modules", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (!/[\\/](stores|components)[\\/]/.test(f)) continue;
      if (FORBIDDEN.test(readFileSync(f, "utf8"))) offenders.push(f.replace(process.cwd(), ""));
    }
    expect(offenders, "client stores/components importing the server-only upc modules").toEqual([]);
  });

  it("the upc server modules declare the server-only boundary", () => {
    // GoUpcProvider.ts is guarded conditionally: it does not exist yet, but when it lands it must
    // carry the same first-line guard. existsSync keeps this green now and enforcing later.
    for (const f of [
      "storage.ts",
      "goUpcUsage.ts",
      "GoUpcProvider.ts",
      "upcItemDbUsage.ts",
      "UpcItemDbProvider.ts",
      "openFoodFactsUsage.ts",
      "OpenFoodFactsProvider.ts",
    ]) {
      const path = join(SRC, "server", "upc", f);
      if (!existsSync(path)) continue;
      const src = readFileSync(path, "utf8");
      // server-only guard must be the FIRST line so it runs before any other import side-effect.
      const firstLine = src.split(/\r?\n/, 1)[0].trim();
      expect(firstLine, `${f} must start with import "server-only"`).toMatch(
        /^import ["']server-only["'];?$/,
      );
    }
  });
});
