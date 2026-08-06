import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const scrub = /^(?:NEXT_PUBLIC_)?(?:OPENAI|GO_?UPC|FIRECRAWL|BRAVE|GEMINI|GOOGLE|TURSO)(?:_|$)/i;
const sensitiveSurvivor = /^(?:NEXT_PUBLIC_)?(?:OPENAI_API_KEY|GO_?UPC_API_KEY|FIRECRAWL_API_KEY|BRAVE(?:_SEARCH)?_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|TURSO_(?:DATABASE_URL|AUTH_TOKEN))$/i;
export function certificationEnvironment(base = process.env) {
  const clean = Object.fromEntries(Object.entries(base).filter(([key]) => !scrub.test(key)));
  return { ...clean, NEXT_PUBLIC_FIREBASE_BACKEND: "1", NEXT_PUBLIC_FIREBASE_USE_EMULATOR: "1", NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-smart-inventory", NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL: "http://127.0.0.1:9099", NEXT_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST: "127.0.0.1", NEXT_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT: "8080", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099", FIREBASE_PROJECT_ID: "demo-smart-inventory", GCLOUD_PROJECT: "demo-smart-inventory", GOOGLE_CLOUD_PROJECT: "demo-smart-inventory", NEXT_PUBLIC_AUTH_MODE: "live", IS_E2E: "0", NEXT_PUBLIC_E2E_AUTH_BYPASS: "0", NEXT_PUBLIC_DISABLE_TELEMETRY: "1", TRUSTED_EXACT_BOSS_BUSINESS_IDS: "local-corpus-certification", ENABLE_LIVE_AI_LOOKUP: "0", MASTER_CATALOG_APPEND: "0", OPENAI_API_KEY: "", GO_UPC_API_KEY: "", GOUPC_API_KEY: "", FIRECRAWL_API_KEY: "", BRAVE_SEARCH_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", TURSO_DATABASE_URL: "", TURSO_AUTH_TOKEN: "" };
}
export function sameCertifiedEnvironment(build, start) { return JSON.stringify(build) === JSON.stringify(start) && !Object.entries(start).some(([key, value]) => sensitiveSurvivor.test(key) && value); }
export function main() {
  const env = certificationEnvironment(); const npmCli = process.env.npm_execpath || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(npmCli)) throw new Error("Cannot locate npm CLI for controlled corpus production build.");
  const build = spawnSync(process.execPath, [npmCli, "run", "build"], { stdio: "inherit", env, shell: false });
  if (build.status !== 0 || !existsSync(".next/BUILD_ID")) throw new Error("Controlled corpus production build failed.");
  const port = process.env.BOSS_CORPUS_PORT || "3400";
  const child = spawn(process.execPath, [npmCli, "run", "start", "--", "--port", port], { stdio: "inherit", env, shell: false });
  child.on("exit", (code) => process.exit(code ?? 1));
}
if (process.argv[1]?.endsWith("production-server.mjs")) main();
