import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./polish-backfill.mts";

function product(over) {
  return {
    id: "p1", businessId: "b", name: "Cooper Discoverer AT3 265/70R17", brand: "Cooper",
    category: "Tire", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "",
    gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "", productUrl: "",
    location: "", notes: "", status: "active", source: "manual", confidence: 1, verified: true,
    createdAt: "t", updatedAt: "t", createdBy: "seed", updatedBy: "seed",
    ...over,
  };
}

let dirs = [];
function tmpFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), "polish-backfill-test-"));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(content));
  return file;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("scripts/polish-backfill CLI", () => {
  it("prints usage and returns exit code 1 when --file is missing", async () => {
    const logs = [];
    const orig = console.log;
    console.log = (m) => logs.push(m);
    const code = await run([]);
    console.log = orig;
    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/Usage:/);
  });

  it("--dry-run prints changes but writes nothing", async () => {
    const file = tmpFile("snap.json", { products: [product({ id: "p1" })] });
    const before = readFileSync(file, "utf8");
    const code = await run(["--file", file, "--dry-run"]);
    expect(code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before); // untouched
  });

  it("without --dry-run, writes structured fields in place (idempotent)", async () => {
    const file = tmpFile("snap.json", { products: [product({ id: "p1" })] });
    await run(["--file", file]);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.products[0].structuredBrand).toBe("Cooper");
    expect(after.products[0].sizeTag).toBe("2657017");
    expect(after.products[0].structuredBy).toBe("deterministic");

    // Second run over its own output is a no-op (idempotent) - the file content does not change.
    const afterFirstRun = readFileSync(file, "utf8");
    await run(["--file", file]);
    expect(readFileSync(file, "utf8")).toBe(afterFirstRun);
  });

  it("skips a product already stamped structuredBy human", async () => {
    const humanProduct = product({ id: "p2", structuredBy: "human", structuredBrand: "Human Brand" });
    const file = tmpFile("snap.json", { products: [humanProduct] });
    await run(["--file", file]);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.products[0].structuredBrand).toBe("Human Brand"); // untouched
  });

  it("accepts a plain Product[] array and a raw persisted {state:{products}} snapshot", async () => {
    const arrFile = tmpFile("arr.json", [product({ id: "p3" })]);
    await run(["--file", arrFile]);
    expect(JSON.parse(readFileSync(arrFile, "utf8"))[0].structuredBrand).toBe("Cooper");

    const persistedFile = tmpFile("persisted.json", { state: { products: [product({ id: "p4" })] }, version: 6 });
    await run(["--file", persistedFile]);
    expect(JSON.parse(readFileSync(persistedFile, "utf8")).state.products[0].structuredBrand).toBe("Cooper");
  });

  it("--out writes to a different file, leaving the input untouched", async () => {
    const file = tmpFile("snap.json", { products: [product({ id: "p5" })] });
    const outFile = file.replace("snap.json", "out.json");
    const before = readFileSync(file, "utf8");
    await run(["--file", file, "--out", outFile]);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(outFile, "utf8")).products[0].structuredBrand).toBe("Cooper");
  });
});

describe("scripts/polish-backfill CLI --llm flag (Task 4 review fix)", () => {
  const ORIGINAL_GEMINI_KEY = process.env.GEMINI_API_KEY;

  afterEach(() => {
    if (ORIGINAL_GEMINI_KEY === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = ORIGINAL_GEMINI_KEY;
  });

  // SAFETY NOTE: this repo's real .env.local may hold a real GEMINI_API_KEY on the developer's
  // machine. `run()`'s --llm path has a HARD guard (`if (llm && process.env.VITEST)`) that skips
  // constructing the live provider entirely whenever Vitest is the runner (Vitest always sets
  // process.env.VITEST) - regardless of whether a key is present in process.env or .env.local. This
  // test deliberately runs WITH the real key still in the environment to prove that guard, not
  // around it - it must never even attempt a network call.
  it("--llm never constructs the live provider under the test runner, even with a real key present - reports eligible count and skips", async () => {
    // "Widget Cleaner Pro" has no recognizable brand and no size -> deterministic confidence 0.4 (< 0.6, eligible).
    const lowConfidence = product({ id: "low1", name: "Widget Cleaner Pro", brand: "" });
    const file = tmpFile("snap.json", { products: [lowConfidence] });

    const logs = [];
    const orig = console.log;
    console.log = (m) => logs.push(String(m));
    const code = await run(["--file", file, "--llm", "--dry-run"]);
    console.log = orig;

    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/--llm skipped: running under the test runner/);
    expect(logs.join("\n")).toMatch(/1 row\(s\) would be LLM-eligible/);
    // dry-run + guarded -> file untouched either way, and no structuredBy "llm" anywhere.
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.products[0].structuredBy).not.toBe("llm");
  });

  it("without --llm, a low-confidence row is still reported as LLM-eligible but never polished", async () => {
    const lowConfidence = product({ id: "low2", name: "Widget Cleaner Pro", brand: "" });
    const file = tmpFile("snap.json", { products: [lowConfidence] });

    const logs = [];
    const orig = console.log;
    console.log = (m) => logs.push(String(m));
    await run(["--file", file]);
    console.log = orig;

    expect(logs.join("\n")).toMatch(/1 row\(s\)\. Pass --llm/);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.products[0].structuredBy).toBe("deterministic"); // deterministic pass only
  });

  it("a high-confidence row is never reported as LLM-eligible", async () => {
    // "Cooper Discoverer AT3 265/70R17" has both a brand and a tire size -> confidence 0.9.
    const file = tmpFile("snap.json", { products: [product({ id: "hc1" })] });

    const logs = [];
    const orig = console.log;
    console.log = (m) => logs.push(String(m));
    await run(["--file", file]);
    console.log = orig;

    expect(logs.join("\n")).toMatch(/LLM-eligible.*: 0 row\(s\)/);
  });
});
