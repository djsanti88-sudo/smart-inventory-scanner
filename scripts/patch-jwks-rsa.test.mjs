// F-14: prove the jwks-rsa patch's hash guard fails LOUDLY on upstream drift instead of the old
// silent no-op, while staying idempotent when already patched. Runs entirely against a temp fixture
// directory (never the real node_modules/jwks-rsa tree) so this test is safe to run without npm ci.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyAndPatch, runAll, sha256, TARGETS } from "./patch-jwks-rsa.cjs";

const UTILS_SPEC = TARGETS["node_modules/jwks-rsa/src/utils.js"];
const INDEX_SPEC = TARGETS["node_modules/jwks-rsa/src/index.js"];

/** Reconstruct the pristine pre-patch content by reversing the known edits on a patched string. */
function reverseEdits(patched, edits) {
  let out = patched;
  for (const [from, to] of edits) out = out.split(to).join(from);
  return out;
}

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jwks-rsa-patch-test-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(name, content) {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe("patch-jwks-rsa hash guard", () => {
  it("patches a pristine-original fixture and the result hashes to the known patched value", () => {
    // Read the REAL current (already-patched) file that ships in this repo's node_modules and
    // reverse the edits to reconstruct the exact pristine original - a safe, read-only operation
    // that never writes to the real tree.
    const realPatched = fs.readFileSync("node_modules/jwks-rsa/src/utils.js", "utf8");
    expect(sha256(realPatched)).toBe(UTILS_SPEC.patchedSha256);
    const original = reverseEdits(realPatched, UTILS_SPEC.edits);
    expect(sha256(original)).toBe(UTILS_SPEC.originalSha256);

    const fixture = writeFixture("utils.js", original);
    const status = verifyAndPatch(fixture, UTILS_SPEC);
    expect(status).toBe("patched");
    const written = fs.readFileSync(fixture, "utf8");
    expect(sha256(written)).toBe(UTILS_SPEC.patchedSha256);
  });

  it("is idempotent: re-running against an already-patched fixture no-ops without rewriting", () => {
    const realPatched = fs.readFileSync("node_modules/jwks-rsa/src/index.js", "utf8");
    const fixture = writeFixture("index.js", realPatched);
    const before = fs.statSync(fixture).mtimeMs;

    const status = verifyAndPatch(fixture, INDEX_SPEC);
    expect(status).toBe("already-patched");
    expect(fs.readFileSync(fixture, "utf8")).toBe(realPatched);
    expect(fs.statSync(fixture).mtimeMs).toBe(before);
  });

  it("THROWS LOUDLY when the fixture content matches neither the known original nor patched hash (simulated upstream drift)", () => {
    const realPatched = fs.readFileSync("node_modules/jwks-rsa/src/utils.js", "utf8");
    const original = reverseEdits(realPatched, UTILS_SPEC.edits);
    // Simulate an upstream release that reshuffled the file: alter a byte so it hashes to neither
    // known value.
    const drifted = original.replace("function resolveAlg(jwk)", "function resolveAlgorithm(jwk)");
    expect(sha256(drifted)).not.toBe(UTILS_SPEC.originalSha256);
    expect(sha256(drifted)).not.toBe(UTILS_SPEC.patchedSha256);

    const fixture = writeFixture("utils.js", drifted);
    expect(() => verifyAndPatch(fixture, UTILS_SPEC)).toThrow(/matches neither the known-good original/);
    // Must NOT have written anything on the throw path.
    expect(fs.readFileSync(fixture, "utf8")).toBe(drifted);
  });

  it("skips silently (does not throw) when the target file is absent", () => {
    const missing = path.join(tmpDir, "does-not-exist.js");
    expect(verifyAndPatch(missing, UTILS_SPEC)).toBe("absent");
  });

  it("runAll patches every target and reports per-file status", () => {
    const realUtilsPatched = fs.readFileSync("node_modules/jwks-rsa/src/utils.js", "utf8");
    const realIndexPatched = fs.readFileSync("node_modules/jwks-rsa/src/index.js", "utf8");
    const utilsOriginal = reverseEdits(realUtilsPatched, UTILS_SPEC.edits);
    const utilsFixture = writeFixture("utils.js", utilsOriginal);
    const indexFixture = writeFixture("index.js", realIndexPatched); // already patched

    const results = runAll({
      [utilsFixture]: UTILS_SPEC,
      [indexFixture]: INDEX_SPEC,
    });
    expect(results[utilsFixture]).toBe("patched");
    expect(results[indexFixture]).toBe("already-patched");
  });
});
