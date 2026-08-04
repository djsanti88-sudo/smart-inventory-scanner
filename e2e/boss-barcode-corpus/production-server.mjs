import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const scrub = /^(?:NEXT_PUBLIC_)?(?:OPENAI|GO_?UPC|FIRECRAWL|BRAVE|GEMINI|GOOGLE|TURSO)(?:_|$)/i;
export function certificationEnvironment(base = process.env) {
  const clean = Object.fromEntries(Object.entries(base).filter(([key]) => !scrub.test(key)));
  return { ...clean, NEXT_PUBLIC_FIREBASE_BACKEND: "1", NEXT_PUBLIC_FIREBASE_USE_EMULATOR: "1", NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-smart-inventory", NEXT_PUBLIC_AUTH_MODE: "live", IS_E2E: "0", NEXT_PUBLIC_E2E_AUTH_BYPASS: "0", NEXT_PUBLIC_DISABLE_TELEMETRY: "1", TRUSTED_EXACT_BOSS_BUSINESS_IDS: "local-corpus-certification", ENABLE_LIVE_AI_LOOKUP: "0", MASTER_CATALOG_APPEND: "0", OPENAI_API_KEY: "", GO_UPC_API_KEY: "", GOUPC_API_KEY: "", FIRECRAWL_API_KEY: "", BRAVE_SEARCH_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", TURSO_DATABASE_URL: "", TURSO_AUTH_TOKEN: "" };
}
export function sameCertifiedEnvironment(build, start) { return JSON.stringify(build) === JSON.stringify(start) && !Object.entries(start).some(([key, value]) => scrub.test(key) && value); }
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
