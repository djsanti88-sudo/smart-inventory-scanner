import { resolve } from "node:path";
import { getLocalDemoDatabasePreflight } from "@/server/localDemoDatabase";
import { createLocalDemoStatusHandler } from "./statusHandler";

export const runtime = "nodejs";

export const GET = createLocalDemoStatusHandler({
  runtimeRoot: resolve("reports/local-tire-demo/runtime"),
  ledgerPath: () => process.env.SCANBIN_LOCAL_DEMO_EGRESS_LEDGER ??
    resolve("reports/local-tire-demo/runtime/egress.jsonl"),
  preflight: getLocalDemoDatabasePreflight,
});
