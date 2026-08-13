// Regression guard for DT-1 (2026-08-13, docs/superpowers/reports/2026-08-13-loop1-data.md):
// build-retail-knowledge.mjs reads data/retail-knowledge/retail_off.jsonl and unconditionally
// renameSync's a brand-new retailKnowledge.generated.json over the committed ~4M-barcode index,
// with zero comparison to the prior barcode count. A truncated/partial/stale JSONL (interrupted
// download, wrong snapshot, disk issue) silently produces a near-empty index and reports success
// -- the exact bug class already fixed in the sibling scripts/build-tire-knowledge.mjs (F1,
// 2026-08-12, MIN_RETAINED_FRACTION guard).
//
// These tests run the real generator in a throwaway repo root and assert it refuses to shrink an
// existing index, and that --force still allows a deliberate rebuild.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GENERATOR = join(process.cwd(), "scripts", "build-retail-knowledge.mjs");

let root;

/** Build a throwaway repo root holding a LARGE existing retail index and a tiny JSONL input. */
function makeRoot({ priorBarcodes, jsonlLines }) {
  const dir = mkdtempSync(join(tmpdir(), "rk-shrinkguard-"));
  const dataDir = join(dir, "data", "retail-knowledge");
  const outDir = join(dir, "src", "server", "retail-knowledge");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  // The dangerous input: a tiny/truncated JSONL (stand-in for an interrupted download).
  const lines = jsonlLines ?? [
    JSON.stringify({ code: "0100000000001", product_name: "Truncated Snack", brands: "Acme" }),
  ];
  writeFileSync(join(dataDir, "retail_off.jsonl"), lines.join("\n") + "\n");

  if (priorBarcodes !== null) {
    // A stand-in for the real 4M-barcode committed index: many barcodes, so any
    // truncated-JSONL rebuild is a collapse.
    const entries = [];
    for (let i = 0; i < priorBarcodes; i++) {
      entries.push(`"${String(200000000000 + i)}":["Product ${i}","Brand","Category"]`);
    }
    writeFileSync(
      join(outDir, "retailKnowledge.generated.json"),
      `{"generated_at":"2026-07-01T00:00:00.000Z","index":{${entries.join(",")}}}`,
    );
    writeFileSync(
      join(outDir, "retailKnowledge.generated.meta.json"),
      JSON.stringify({ generated_at: "2026-07-01T00:00:00.000Z", unique_barcodes: priorBarcodes }, null, 2) + "\n",
    );
  }
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
  const raw = readFileSync(join(dir, "src", "server", "retail-knowledge", "retailKnowledge.generated.json"), "utf8");
  return Object.keys(JSON.parse(raw).index).length;
}

beforeEach(() => { root = null; });
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe("build-retail-knowledge output-sanity guard (DT-1)", () => {
  it("refuses to overwrite a large existing index with a truncated-JSONL rebuild", () => {
    root = makeRoot({ priorBarcodes: 5000 });

    const result = runGenerator(root);

    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/shrink|smaller|force/i);
    // The critical assertion: the existing corpus survived untouched.
    expect(barcodeCount(root)).toBe(5000);
  });

  it("allows a deliberate shrink when --force is passed", () => {
    root = makeRoot({ priorBarcodes: 5000 });

    const result = runGenerator(root, ["--force"]);

    expect(result.code).toBe(0);
    expect(barcodeCount(root)).toBeLessThan(5000);
  });

  it("still generates normally when no prior index exists (bootstrap case)", () => {
    root = makeRoot({
      priorBarcodes: null,
      jsonlLines: [
        JSON.stringify({ code: "0100000000001", product_name: "Bootstrap Snack", brands: "Acme" }),
        JSON.stringify({ code: "0100000000002", product_name: "Bootstrap Soda", brands: "Acme" }),
      ],
    });

    const result = runGenerator(root);

    expect(result.code).toBe(0);
    expect(barcodeCount(root)).toBeGreaterThan(0);
  });
});
