#!/usr/bin/env node
// Track 2 strategy "bots" are ANALYSIS routines whose output is the markdown/CSV reports in
// reports/strategy-bots/latest/ (authored from app features + Track 1 reports + public competitor research).
// This runner validates the reports exist and prints a setup note. It does NOT scrape competitors itself;
// competitor research used public web search (sources cited in competition_report.md). To refresh
// competitor data with Firecrawl/web tools, those run in the assistant session (keys are server-side only).

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DIR = resolve(process.cwd(), "reports/strategy-bots/latest");
const REPORTS = {
  marketing: "marketing_advice.md",
  roi: ["feature_roi_matrix.md", "feature_roi_matrix.csv"],
  pricing: "pricing_recommendations.md",
  competition: ["competition_report.md", "competitor_matrix.csv"],
  buyer: "website_buyer_review.md",
  monetization: "monetization_recommendations.md",
  master: "TRACK2_STRATEGY_MASTER_REPORT.md",
};

const which = process.argv[2];
const groups = which && REPORTS[which] ? { [which]: REPORTS[which] } : REPORTS;

let ok = true;
for (const [name, files] of Object.entries(groups)) {
  for (const f of [].concat(files)) {
    const present = existsSync(resolve(DIR, f));
    if (!present) ok = false;
    console.log(`${present ? "OK " : "MISSING"}  ${name}: reports/strategy-bots/latest/${f}`);
  }
}
console.log(ok ? "\nAll requested strategy reports present." : "\nSome reports are missing.");
console.log("Note: competitor pricing is public list pricing (cited in competition_report.md); verify before quoting. Tire-DB pricing is not public.");
process.exit(ok ? 0 : 1);
