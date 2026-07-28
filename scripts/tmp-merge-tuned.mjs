// Add the tuned gpt-5.4-mini run as its own column ("gpt-5.4-mini-tuned") alongside the existing
// baseline results, so the report A/Bs baseline vs tuned on the same 21 codes.
import fs from "node:fs";
const base = JSON.parse(fs.readFileSync("scripts/tmp-mini-bakeoff-results.json", "utf8"));
const tuned = JSON.parse(fs.readFileSync("scripts/tmp-mini-tuned-results.json", "utf8"));
const keep = base.rows.filter((r) => r.model !== "gpt-5.4-mini-tuned");
const merged = { ...base, models: [...base.models.filter((m) => m !== "gpt-5.4-mini-tuned"), "gpt-5.4-mini-tuned"], rows: [...keep, ...tuned.rows] };
fs.writeFileSync("scripts/tmp-mini-bakeoff-results.json", JSON.stringify(merged, null, 2));
const c = (m) => merged.rows.filter((r) => r.model === m && !r.error).length;
console.log(`Merged tuned. models=${merged.models.join(", ")} | completed: baseline-mini ${c("gpt-5.4-mini")}, tuned ${c("gpt-5.4-mini-tuned")}`);
