import { describe, it, expect } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// DT-1 (2026-08-13) retail counterpart to src/server/tire-knowledge/corpusDrift.test.ts. The tire
// gate additionally parses the full generated.json payload and re-derives the actual barcode-key
// count -- affordable there because that file is ~53MB. The retail counterpart
// (retailKnowledge.generated.json) is a ~259MB Git-LFS-tracked file (~4M barcodes); JSON.parse-ing
// it on every `npm run test` run would make the whole suite slow and memory-heavy for a check that
// gains little over a cheap manifest read, so this test deliberately stays LIGHT: it reads only the
// small committed retailKnowledge.generated.meta.json (a few hundred bytes) and the on-disk SIZE of
// the payload file (a stat(), not a parse), and asserts both are still plausible for the real
// ~4M-barcode corpus. This still catches the DT-1 failure mode this test exists for -- a truncated,
// partial, or stale regen collapsing the index to a near-empty file -- without the cost of a full
// parse on every local/CI run.
const OUT_DIR = join(process.cwd(), "src", "server", "retail-knowledge");
const META_PATH = join(OUT_DIR, "retailKnowledge.generated.meta.json");
const JSON_PATH = join(OUT_DIR, "retailKnowledge.generated.json");

// Conservative floors, well below the committed corpus (~4,047,273 barcodes / ~259MB as of
// 2026-08-05) so legitimate future re-harvests with fewer example/test rows skipped still pass;
// tight enough to fail hard on a truncated-download or stale-snapshot collapse.
const MIN_PLAUSIBLE_BARCODES = 1_000_000;
const MIN_PLAUSIBLE_BYTES = 50 * 1024 * 1024; // 50MB

/** Detect a Git LFS pointer file (~130 bytes, starts with "version https://git-lfs") -- the shape
 *  this file has on a machine/CI that never ran `git lfs pull`. Not a corpus regression, so the
 *  size check below skips rather than fails when it sees one (mirrors build-knowledge-db.mjs's
 *  own isLfsPointer detection). */
async function isLfsPointer(path: string): Promise<boolean> {
  const { size } = await stat(path);
  if (size > 500) return false;
  const content = await readFile(path, "utf8");
  return content.startsWith("version https://git-lfs");
}

describe("retail corpus drift gate (manifest + on-disk size floor, DT-1)", () => {
  it("committed manifest reports a plausible barcode count", async () => {
    const meta = JSON.parse(await readFile(META_PATH, "utf8")) as { unique_barcodes?: number };
    expect(meta.unique_barcodes).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_BARCODES);
  });

  it("committed payload file size is plausible for the full corpus (not a truncated/pointer stub)", async () => {
    if (await isLfsPointer(JSON_PATH)) {
      console.warn("[retailCorpusDrift.test] retailKnowledge.generated.json is an LFS pointer (LFS content not pulled) -- skipping size check.");
      return;
    }
    const { size } = await stat(JSON_PATH);
    expect(size).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_BYTES);
  });
});
