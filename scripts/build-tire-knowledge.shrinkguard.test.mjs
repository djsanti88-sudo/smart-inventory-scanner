// Regression guard for F1 (2026-08-12): build-tire-knowledge.mjs guarded its INPUTS
// (active harvester, absent snapshot, CSV parse error, missing columns) but never its
// OUTPUT. Snapshot precedence ends at the committed 2-row bootstrap seed, so on any
// machine without harvester snapshots -- a fresh clone, CI, this dev box -- the
// generator parsed that seed successfully, passed every validation, and atomically
// overwrote the real 79,108-barcode index with 2 records. Nothing was technically
// invalid, so "fail closed" never fired.
//
// These tests run the real generator in a throwaway repo root and assert it refuses to
// shrink an existing index, and that --force still allows a deliberate rebuild.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GENERATOR = join(process.cwd(), "scripts", "build-tire-knowledge.mjs");
const RULES = join(process.cwd(), "scripts", "corpusRules.mjs");
const REAL_SEED = join(process.cwd(), "src", "server", "tire-knowledge", "seed", "tire_corpus_seed.csv");

let root;

/** Build a throwaway repo root holding a LARGE existing index and only the tiny seed as input. */
function makeRoot({ priorBarcodes }) {
  const dir = mkdtempSync(join(tmpdir(), "tk-shrinkguard-"));
  const outDir = join(dir, "src", "server", "tire-knowledge");
  mkdirSync(join(outDir, "seed"), { recursive: true });
  // NOTE: the generator is invoked from its REAL path (so csv-parse and corpusRules
  // resolve against the repo's node_modules) but with cwd set to this throwaway root.
  // The generator derives every path from process.cwd(), so cwd fully sandboxes it.

  // The real 2-row bootstrap seed: the dangerous input.
  copyFileSync(REAL_SEED, join(outDir, "seed", "tire_corpus_seed.csv"));

  // A stand-in for the real corpus: many barcodes, so any seed-derived rebuild is a collapse.
  const barcodeIndex = {};
  for (let i = 0; i < priorBarcodes; i++) barcodeIndex[String(100000000000 + i)] = { canonical_product_uid: `uid-${i}` };
  writeFileSync(
    join(outDir, "tireKnowledge.generated.json"),
    JSON.stringify({ schema_version: "1.0.0", generated_at: "2026-07-26T00:00:00.000Z", barcodeIndex, partNumberIndex: {}, identityIndex: {} }),
  );
  writeFileSync(
    join(outDir, "tireKnowledge.generated.meta.json"),
    JSON.stringify({ schema_version: "1.0.0", barcode_index_count: priorBarcodes }, null, 2) + "\n",
  );
  return dir;
}

function runGenerator(cwd, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [GENERATOR, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

function barcodeCount(dir) {
  const raw = readFileSync(join(dir, "src", "server", "tire-knowledge", "tireKnowledge.generated.json"), "utf8");
  return Object.keys(JSON.parse(raw).barcodeIndex).length;
}

beforeEach(() => { root = null; });
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe("build-tire-knowledge output-sanity guard (F1)", () => {
  it("refuses to overwrite a large existing index with a seed-sized rebuild", () => {
    root = makeRoot({ priorBarcodes: 5000 });

    const result = runGenerator(root);

    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/shrink|smaller|force/i);
    // The critical assertion: the existing corpus survived untouched.
    expect(barcodeCount(root)).toBe(5000);
  });

  it("records the refusal in the status file instead of failing silently", () => {
    root = makeRoot({ priorBarcodes: 5000 });

    runGenerator(root);

    const status = JSON.parse(readFileSync(join(root, "coordination", "RAG_KNOWLEDGE_STATUS.json"), "utf8"));
    expect(status.status).toBe("failed");
    expect(status.failure_reason).toMatch(/shrink|smaller/i);
  });

  it("allows a deliberate shrink when --force is passed", () => {
    root = makeRoot({ priorBarcodes: 5000 });

    const result = runGenerator(root, ["--force"]);

    expect(result.code).toBe(0);
    expect(barcodeCount(root)).toBeLessThan(5000);
  });

  it("still generates normally when no prior index exists (bootstrap case)", () => {
    root = makeRoot({ priorBarcodes: 5000 });
    rmSync(join(root, "src", "server", "tire-knowledge", "tireKnowledge.generated.json"));
    rmSync(join(root, "src", "server", "tire-knowledge", "tireKnowledge.generated.meta.json"));

    const result = runGenerator(root);

    expect(result.code).toBe(0);
    expect(barcodeCount(root)).toBeGreaterThan(0);
  });
});
