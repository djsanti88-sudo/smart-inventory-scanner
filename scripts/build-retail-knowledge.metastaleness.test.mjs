// Regression guard for historical finding DT2-2 (2026-08-13; see docs/HISTORY.md):
// build-retail-knowledge.mjs's shrink guard (DT-1b) uses retailKnowledge.generated.meta.json as its
// baseline for "how many barcodes existed before this run". If a PRIOR run crashed between its two
// renameSync calls (index renamed, meta not), the meta left on disk describes an OLDER, smaller
// index than what is actually sitting at retailKnowledge.generated.json. That stale meta then
// silently WEAKENS the guard on the NEXT run: a genuinely shrunken rebuild can pass because it is
// being compared against a baseline that is itself already stale, not the real corpus about to be
// overwritten.
//
// Fix: priorBarcodeCount() now verifies the meta actually describes the CURRENT index on disk
// (recorded index_size_bytes must match the index's actual current byte size, and the index's mtime
// must not be NEWER than the meta's mtime -- in a healthy run meta is always written strictly after
// the index finishes) and falls back to counting the real index directly when it does not, rather
// than trusting a baseline that may have silently rotted.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GENERATOR = join(process.cwd(), "scripts", "build-retail-knowledge.mjs");
const TRUE_INDEX_BARCODES = 5000; // the real, current on-disk index -- what must actually be protected
const STALE_META_BARCODES = 1000; // what a rotted meta from a much older generation would claim
const REBUILD_BARCODES = 4000; // a real shrink vs TRUE_INDEX (4000 < 5000*0.9=4500) but would
// PASS if wrongly evaluated against the stale meta's baseline (4000 >= 1000*0.9=900)

let root;

function makeIndexEntries(n, offset) {
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(`"${String(offset + i)}":["Product ${i}","Brand","Category"]`);
  return parts.join(",");
}

function makeRoot({ staleMeta, rebuildBarcodes = REBUILD_BARCODES }) {
  const dir = mkdtempSync(join(tmpdir(), "rk-metastaleness-"));
  const dataDir = join(dir, "data", "retail-knowledge");
  const outDir = join(dir, "src", "decoding", "server", "knowledge", "retail");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const lines = [];
  for (let i = 0; i < rebuildBarcodes; i++) {
    lines.push(JSON.stringify({ code: String(100000000000 + i), product_name: `Product ${i}`, brands: "Acme" }));
  }
  writeFileSync(join(dataDir, "retail_off.jsonl"), lines.join("\n") + "\n");

  // The REAL current index on disk.
  const indexPath = join(outDir, "retailKnowledge.generated.json");
  writeFileSync(indexPath, `{"generated_at":"2026-08-01T00:00:00.000Z","index":{${makeIndexEntries(TRUE_INDEX_BARCODES, 200000000000)}}}`);

  const metaPath = join(outDir, "retailKnowledge.generated.meta.json");
  const metaBarcodes = staleMeta ? STALE_META_BARCODES : TRUE_INDEX_BARCODES;
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        generated_at: "2026-07-01T00:00:00.000Z",
        unique_barcodes: metaBarcodes,
        // A stale meta's recorded size describes the SMALLER, older index it was written for --
        // not the true current file's byte size.
        index_size_bytes: staleMeta ? 1234 : statSync(indexPath).size,
      },
      null,
      2,
    ) + "\n",
  );

  if (staleMeta) {
    // Simulate the crash sequence: the index was rewritten (fresh mtime) AFTER the meta was last
    // written (old mtime) -- i.e. meta is stale relative to the index, exactly DT2-2's scenario.
    const oldTime = (Date.now() - 60 * 60 * 1000) / 1000; // meta: 1 hour old
    utimesSync(metaPath, oldTime, oldTime);
    const newTime = Date.now() / 1000; // index: just now
    utimesSync(indexPath, newTime, newTime);
  }

  return dir;
}

function runGenerator(cwd, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [GENERATOR, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

function barcodeCount(dir) {
  const raw = readFileSync(join(dir, "src", "decoding", "server", "knowledge", "retail", "retailKnowledge.generated.json"), "utf8");
  return Object.keys(JSON.parse(raw).index).length;
}

beforeEach(() => { root = null; });
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe("build-retail-knowledge shrink-guard robustness against a stale meta baseline (DT2-2)", () => {
  it("still refuses a real shrink even when the meta's own recorded baseline is stale/rotted (falls back to counting the real index)", () => {
    root = makeRoot({ staleMeta: true });

    const result = runGenerator(root);

    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/shrink|smaller|force/i);
    expect(barcodeCount(root)).toBe(TRUE_INDEX_BARCODES);
  });

  it("also refuses the same real shrink when the meta is fresh and accurate (no regression on the healthy fast path)", () => {
    root = makeRoot({ staleMeta: false });

    const result = runGenerator(root);

    expect(result.code).toBe(1);
    expect(barcodeCount(root)).toBe(TRUE_INDEX_BARCODES);
  });

  it("would have WRONGLY allowed the shrink if the guard trusted the stale meta's claimed 1000-barcode baseline (sanity check on the test's own numbers)", () => {
    // Not exercising the real script here -- just proving the arithmetic of the exploit this test
    // guards against, so a future edit to REBUILD_BARCODES/STALE_META_BARCODES can't silently make
    // this suite meaningless.
    expect(REBUILD_BARCODES).toBeGreaterThanOrEqual(Math.ceil(STALE_META_BARCODES * 0.9));
    expect(REBUILD_BARCODES).toBeLessThan(Math.ceil(TRUE_INDEX_BARCODES * 0.9));
  });
});
