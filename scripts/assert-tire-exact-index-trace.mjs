import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const traceDir = join(root, ".next", "server");
if (!existsSync(traceDir)) throw new Error("Missing .next/server trace output; run next build first.");
const traces = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".nft.json")) traces.push(path);
  }
}
walk(traceDir);
const traced = new Set(traces.flatMap((file) => JSON.parse(readFileSync(file, "utf8")).files ?? []));
const required = ["manifest.json", ...Array.from({ length: 64 }, (_, n) => `${n.toString(16).padStart(2, "0")}.json`)];
const missing = required.filter((name) => ![...traced].some((file) => file.replace(/\\/g, "/").endsWith(`/exact-index/${name}`)));
if (missing.length) throw new Error(`Exact-index trace missing: ${missing.join(", ")}`);
const forbidden = [...traced].filter((file) => /tireKnowledge\.generated\.json|knowledge\.generated\.db/i.test(file));
if (forbidden.length) throw new Error(`Legacy corpus unexpectedly traced: ${forbidden.join(", ")}`);
console.log(`Exact-index trace assertion passed (${required.length} assets).`);
