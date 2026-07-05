// FORENSIC single-code tracer: runs the EXACT benchmark deps but logs every pipeline stage -
// candidates per provider, snippet findings, junk verdicts, page evidence, final decision.
// Usage: npx tsx scripts/fetchv2-forensic.mts CODE1,CODE2,...
import { readFileSync } from "node:fs";
import { braveProvider, firecrawlSearchProvider, type MinimalFetch, type DiscoveryCandidate } from "../src/services/fetchV2/sources/discovery";
import { snippetFindings } from "../src/services/fetchV2/pageEvidence/snippetEvidence";
import { usableIdentityName } from "../src/services/fetchV2/pageEvidence/junkRules";
import { classifyIdentifier } from "../src/services/fetchV2/classify";
import { normalizeVariants } from "../src/services/fetchV2/normalize";
import { fetchV2, type FetchV2Deps } from "../src/services/fetchV2/index";
import { firecrawlKeysFromEnv } from "../src/services/ai/firecrawlProvider";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const braveKey = process.env.BRAVE_SEARCH_API_KEY!;
const fcKeys = firecrawlKeysFromEnv();
const CODES = (process.argv[2] ?? "").split(",").filter(Boolean);

const brave = braveProvider({ apiKey: braveKey, fetchImpl: fetch as unknown as MinimalFetch, timeoutMs: 12_000 });
const fc = firecrawlSearchProvider({ apiKeys: fcKeys, fetchImpl: fetch as unknown as MinimalFetch, timeoutMs: 15_000, retryDelayMs: 1500 });

function show(label: string, cands: DiscoveryCandidate[], variants: string[], code: string) {
  console.log(`  [${label}] ${cands.length} candidates`);
  for (const c of cands.slice(0, 8)) {
    const hay = (c.title + " " + c.snippet).replace(/[\s-]/g, "");
    const vis = variants.some((v) => /^\d+$/.test(v) && hay.includes(v));
    console.log(`     ${vis ? "CODE-VISIBLE" : "code-hidden "} | usableName=${usableIdentityName(c.title, code)} | ${c.url.slice(0, 55)} | ${c.title.slice(0, 55)}`);
  }
}

(async () => {
  for (const code of CODES) {
    console.log(`\n=== ${code} ===`);
    const id = classifyIdentifier(code);
    const norm = normalizeVariants(code, id.type);
    console.log(`  type=${id.type} public=${id.isPublicBarcode} checkDigit=${id.checkDigitValid} variants=${norm.all.join(",")}`);

    await new Promise((r) => setTimeout(r, 1200));
    const b = await brave.search(norm.primary);
    show("brave", b, norm.all, norm.primary);
    const bSnips = snippetFindings(b, norm.all, norm.primary);
    console.log(`  brave snippetFindings: ${bSnips.length}`, bSnips.map((s) => `${s.host}:"${s.name.slice(0, 35)}"`).join(" | "));

    await new Promise((r) => setTimeout(r, 1500));
    const q = await fc.search(`"${norm.primary}"`);
    show("fc-quoted", q, norm.all, norm.primary);
    const qSnips = snippetFindings(q, norm.all, norm.primary, { assumeCarrying: true });
    console.log(`  quoted snippetFindings(assume): ${qSnips.length}`, qSnips.map((s) => `${s.host}:"${s.name.slice(0, 35)}"`).join(" | "));

    await new Promise((r) => setTimeout(r, 1500));
    const loose = await fc.search(norm.primary); // the "paste it on Google" check
    show("fc-UNQUOTED", loose, norm.all, norm.primary);
    const lSnips = snippetFindings(loose, norm.all, norm.primary);
    console.log(`  unquoted snippetFindings(visible): ${lSnips.length}`, lSnips.map((s) => `${s.host}:"${s.name.slice(0, 35)}"`).join(" | "));

    // Now the REAL pipeline with the same deps the benchmark uses (1 scrapeless page fetcher to isolate discovery).
    const deps: FetchV2Deps = {
      fetchPage: async (url) => {
        try {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 8000);
          const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: controller.signal }).finally(() => clearTimeout(t));
          const html = res.ok ? (await res.text()).slice(0, 400_000) : "";
          return { ok: res.ok, status: res.status, html };
        } catch { return { ok: false, status: 0, html: "" }; }
      },
      discovery: [
        { name: "brave", search: async () => b },   // reuse captured results: deterministic replay
        { name: "firecrawl", search: (() => { let calls = 0; return async () => (calls++ === 0 ? q : loose); })() },
      ],
    };
    const r = await fetchV2(code, deps, { mode: "balanced", maxSourcesPerCode: 3, maxTotalMs: 25_000 });
    console.log(`  PIPELINE: ${r.outcome} | product="${r.product.name.slice(0, 50)}" | loc=${r.evidence.codeLocation} | rules=${r.debug.rulesFired.join(" ~ ").slice(0, 160)}`);
  }
})();
