import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Proves secrets are read SERVER-SIDE ONLY. Client code (components, stores, app pages, browser libs)
// must never read provider API keys OR the Firebase Admin service account - that would leak a secret into
// the browser bundle. Only server route handlers + provider modules + firebaseAdmin.ts may read them.

// INVERTED ALLOWLIST (folder reorganization, 2026-08-30). This used to be a hand-listed set of five
// client directories. That is a trap: when client code moves to a new feature folder, the guard keeps
// passing while silently scanning less and less. The folder reorganization moved 163 client files out
// of src/components and src/lib, leaving the old list covering 24 files and src/components EMPTY -
// still green, no longer guarding.
//
// So: scan EVERYTHING under src/ except the directories that are legitimately server-only or tooling.
// A new feature folder is covered automatically; only an explicit addition here can shrink coverage.
const SERVER_ONLY_DIRS = new Set([
  "server", // server-only by construction (its own boundary tests cover it)
  "test", // vitest stubs
  "eval", // offline decode-accuracy harness, never bundled
]);
const CLIENT_DIRS = readdirSync(join(process.cwd(), "src"))
  .filter((name) => {
    if (SERVER_ONLY_DIRS.has(name)) return false;
    return statSync(join(process.cwd(), "src", name)).isDirectory();
  })
  .map((name) => join("src", name));
const FORBIDDEN = [
  "process.env.OPENAI_API_KEY",
  // Firebase Admin (service account / privileged SDK) must never be reachable from client code.
  // Patterns are precise so a prose mention in a comment is not a false positive:
  "@/sync-database/cloud/firebaseAdmin", // importing the server-only Admin client
  "firebase-admin", // the Admin SDK package
  "FIREBASE_SERVICE_ACCOUNT_PATH", // local service-account path env
  "GOOGLE_APPLICATION_CREDENTIALS", // ADC path env
  "getAdminDb(", // calling the Admin Firestore factory
  "getAdminAuth(", // calling the Admin Auth factory
];

// src/app/api holds SERVER route handlers, which legitimately read keys; they were never in scope
// (the original list named only src/app/(app) and src/app/login). Skip them by path, not by omission.
const isServerRouteDir = (full: string) => /[\\/]app[\\/]api[\\/]/.test(full) || full.endsWith(join("app", "api"));

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
    if (statSync(full).isDirectory()) {
      if (isServerRouteDir(full)) continue;
      out = out.concat(walk(full));
    } else out.push(full);
  }
  return out;
}

describe("API key safety", () => {
  // COVERAGE FLOOR. The failure mode this guard is most exposed to is not a leaked key - it is
  // scanning nothing and reporting green. Assert we are actually looking at a realistic amount of
  // client code, so a future move that strands files outside the scan fails loudly here instead of
  // quietly passing. Raise the floor if the app grows; never delete it.
  it("actually scans the client surface (guards against silently scanning nothing)", () => {
    const scanned = CLIENT_DIRS.flatMap((dir) => walk(join(process.cwd(), dir))).filter(
      (f) => /\.(ts|tsx)$/.test(f) && !f.includes(".test."),
    );
    expect(scanned.length, `client files scanned across ${CLIENT_DIRS.length} dirs`).toBeGreaterThan(120);
  });

  it("no client file reads provider API keys from the environment", () => {
    const offenders: string[] = [];
    for (const dir of CLIENT_DIRS) {
      for (const file of walk(join(process.cwd(), dir))) {
        if (!/\.(ts|tsx)$/.test(file) || file.includes(".test.")) continue;
        const src = readFileSync(file, "utf8");
        // `import "server-only"` makes a file impossible to include in the client bundle (build fails),
        // so such files are allowed to reference the service-role key.
        if (/import\s+["']server-only["']/.test(src)) continue;
        for (const needle of FORBIDDEN) if (src.includes(needle)) offenders.push(`${file} -> ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
