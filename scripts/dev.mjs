#!/usr/bin/env node
// Backend-safe dev launcher. Picks the Firebase backend BEFORE starting `next dev` and prints a clear
// banner, so a routine `npm run dev` can NEVER silently write to production Firestore.
//
//   npm run dev            -> MOCK backend (no Firebase at all). The safe default.
//   npm run dev:emulator   -> Firebase EMULATOR (run `npm run emulators` first). Local, no cloud.
//   npm run dev:prod       -> PRODUCTION Firestore. Deliberate opt-in only; loud warning + every scan
//                             writes to the real cloud project.
//
// Cross-platform (no cross-env dependency): we set NEXT_PUBLIC_* in this process's env and spawn
// `next dev`, which inherits them. Next does not override env vars already present in process.env, so
// these win over .env.local.

import { spawn } from "node:child_process";
import { buildDevEnvironment } from "./dev-environment.mjs";

const mode = process.argv.includes("--prod") ? "prod" : process.argv.includes("--emulator") ? "emulator" : "mock";

// Forward any extra args (e.g. -p 3002) to next dev, minus our mode flags.
const passthrough = process.argv.slice(2).filter((a) => a !== "--prod" && a !== "--emulator" && a !== "--mock");

const env = buildDevEnvironment(mode);
const RED = "\x1b[41m\x1b[97m";
const YEL = "\x1b[33m";
const GRN = "\x1b[32m";
const RST = "\x1b[0m";

if (mode === "mock") {
  env.NEXT_PUBLIC_FIREBASE_BACKEND = "0";
  env.NEXT_PUBLIC_FIREBASE_USE_EMULATOR = "0";
  // Fully Firebase-free: also bypass Firebase Auth so a routine local session makes ZERO cloud calls
  // (no Firestore writes AND no production auth sign-in). This is the local demo/offline path.
  env.NEXT_PUBLIC_E2E_AUTH_BYPASS = "1";
  delete env.NEXT_PUBLIC_FIREBASE_ALLOW_PROD;
  console.log(`${GRN}[dev] MOCK backend — no Firebase (no Firestore, no cloud auth). Local data only. Safe default.${RST}`);
  console.log(`      For Firebase testing: npm run dev:emulator   |   Production (deliberate): npm run dev:prod`);
} else if (mode === "emulator") {
  env.NEXT_PUBLIC_FIREBASE_BACKEND = "1";
  env.NEXT_PUBLIC_FIREBASE_USE_EMULATOR = "1";
  delete env.NEXT_PUBLIC_FIREBASE_ALLOW_PROD;
  console.log(`${YEL}[dev] FIREBASE EMULATOR backend (127.0.0.1). No cloud writes.${RST}`);
  console.log(`      Make sure the emulators are running:  npm run emulators`);
} else {
  // PRODUCTION — deliberate opt-in. Loud, unmissable warning. ALLOW_PROD flips the in-app guard so the
  // scanner is usable, but the red in-app banner stays visible for the whole session.
  env.NEXT_PUBLIC_FIREBASE_BACKEND = "1";
  env.NEXT_PUBLIC_FIREBASE_USE_EMULATOR = "0";
  env.NEXT_PUBLIC_FIREBASE_ALLOW_PROD = "1";
  const bar = "=".repeat(72);
  console.log(`${RED}${bar}${RST}`);
  console.log(`${RED}  ⚠  PRODUCTION FIREBASE  ⚠   EVERY SCAN WRITES TO THE REAL CLOUD PROJECT.   ${RST}`);
  console.log(`${RED}  Project: ${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "(from .env.local)"}                                   ${RST}`);
  console.log(`${RED}  This is NOT for routine testing. Use 'npm run dev' (mock) or 'dev:emulator'.${RST}`);
  console.log(`${RED}${bar}${RST}`);
}

const child = spawn("next", ["dev", ...passthrough], { stdio: "inherit", env, shell: true });
child.on("exit", (code) => process.exit(code ?? 0));
