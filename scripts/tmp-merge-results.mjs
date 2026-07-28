// Merge the complete gpt-5.4-mini run into the existing 3-model results, KEEPING the gpt-5.5 and
// gpt-5.5-pro rows (which were only partial before the quota wall and were NOT re-run, per the
// owner's API-scoped-to-mini-only authorization). Mini rows are fully replaced with the complete run.
import fs from "node:fs";

const base = JSON.parse(fs.readFileSync("scripts/tmp-mini-bakeoff-results.json", "utf8"));
const mini = JSON.parse(fs.readFileSync("scripts/tmp-mini-only-results.json", "utf8"));

// keep every non-mini row from base, drop base's stale partial mini rows, add the complete mini rows
const keep = base.rows.filter((r) => r.model !== "gpt-5.4-mini");
const miniRows = mini.rows.filter((r) => r.model === "gpt-5.4-mini");
const merged = { ...base, ts: "2026-07-26", rows: [...keep, ...miniRows] };

fs.writeFileSync("scripts/tmp-mini-bakeoff-results.json", JSON.stringify(merged, null, 2));
const c = (m) => merged.rows.filter((r) => r.model === m && !r.error).length;
console.log(`Merged. Completed rows -> gpt-5.5:${c("gpt-5.5")}  gpt-5.4-mini:${c("gpt-5.4-mini")}  gpt-5.5-pro:${c("gpt-5.5-pro")}`);
