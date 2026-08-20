import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const statePath = (runId) => resolve("outputs/boss-barcode-certification/preview-runs", `${runId}.json`);
export function writePreviewRunState(runId, state) {
  const target = statePath(runId); mkdirSync(resolve(target, ".."), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`; writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "w" }); renameSync(temp, target);
}
export function readPreviewRunState(runId) {
  const target = statePath(runId); if (!existsSync(target)) throw new Error("Preview certification run manifest is missing.");
  return JSON.parse(readFileSync(target, "utf8"));
}
