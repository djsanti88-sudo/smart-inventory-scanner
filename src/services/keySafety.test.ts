import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Proves secrets are read SERVER-SIDE ONLY. Client code (components, stores, app pages, browser libs)
// must never read provider API keys OR the Firebase Admin service account - that would leak a secret into
// the browser bundle. Only server route handlers + provider modules + firebaseAdmin.ts may read them.

const CLIENT_DIRS = ["src/components", "src/stores", "src/app/(app)", "src/app/login", "src/lib"];
const FORBIDDEN = [
  "process.env.GEMINI_API_KEY",
  "process.env.OPENAI_API_KEY",
  // Firebase Admin (service account / privileged SDK) must never be reachable from client code.
  // Patterns are precise so a prose mention in a comment is not a false positive:
  "@/lib/firebaseAdmin", // importing the server-only Admin client
  "firebase-admin", // the Admin SDK package
  "FIREBASE_SERVICE_ACCOUNT_PATH", // local service-account path env
  "GOOGLE_APPLICATION_CREDENTIALS", // ADC path env
  "getAdminDb(", // calling the Admin Firestore factory
  "getAdminAuth(", // calling the Admin Auth factory
];

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
        // `import "server-only"` makes a file impossible to include in the client bundle (build fails),
        // so such files are allowed to reference the service-role key.
        if (/import\s+["']server-only["']/.test(src)) continue;
        for (const needle of FORBIDDEN) if (src.includes(needle)) offenders.push(`${file} -> ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
