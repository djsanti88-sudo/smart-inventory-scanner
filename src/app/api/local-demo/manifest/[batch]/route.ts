import { resolve } from "node:path";
import { getLocalDemoDatabasePreflight } from "@/server/localDemoDatabase";
import { createLocalDemoManifestHandler } from "./manifestHandler";

export const runtime = "nodejs";

export const GET = createLocalDemoManifestHandler({
  reportsRoot: resolve("reports/local-tire-demo"),
  preflight: getLocalDemoDatabasePreflight,
  expectedGitSha: () => process.env.SCANBIN_LOCAL_DEMO_GIT_SHA,
  expectedDatabaseSha256: () => process.env.SCANBIN_LOCAL_DEMO_DATABASE_SHA256,
});
