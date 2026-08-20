import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import test from "node:test";

let builder;
try {
  builder = await import("./build-retail-knowledge.mjs");
} catch {
  builder = null;
}

const code = "049000006346";
const execFileAsync = promisify(execFile);

test("exports an isolated builder seam", () => {
  assert.equal(typeof builder?.buildRetailKnowledge, "function");
});

test("projects enriched and legacy rows, excludes review/quarantine/conflicts, and emits receipts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "retail-builder-"));
  const input = join(dir, "source.jsonl");
  const output = join(dir, "retail.json");
  const meta = join(dir, "retail.meta.json");
  const receipts = join(dir, "receipts");
  const rows = [
    { code, product_name_raw: "  Cola &amp; Lime ", brands_raw: "Acme", main_category_en_raw: "Sodas", _payload_sha256: "a".repeat(64), url_raw: "https://example/a" },
    { code: "036000291452", product_name: "Legacy Soda", brands: "Legacy", main_category_en: "Beverages", _payload_sha256: "b".repeat(64) },
    { code: "012345678905", product_name_raw: "Example", _payload_sha256: "c".repeat(64) },
    { code: "0123456789055", product_name_raw: "No Primary", brands_raw: "Acme", _payload_sha256: "d".repeat(64) },
    { code: "049000006353", product_name_raw: "Conflicted", brands_raw: "Acme", _payload_sha256: "e".repeat(64), _duplicate_observations: [{ payload_sha256: "f".repeat(64), differing_raw_fields: { product_name_raw: "Other" } }] },
  ];
  await writeFile(input, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const result = await builder.buildRetailKnowledge({ input, outputJson: output, outputMeta: meta, receiptDir: receipts, mode: "fixture" });
  const index = JSON.parse(await readFile(output, "utf8")).index;
  const serializedOutput = await readFile(output, "utf8");
  const generatedMeta = JSON.parse(await readFile(meta, "utf8"));
  const review = (await readFile(join(receipts, "review.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const diff = JSON.parse(await readFile(join(receipts, "projection-diff.json"), "utf8"));

  assert.deepEqual(index[code], ["Cola & Lime", "Acme", "Sodas"]);
  assert.deepEqual(index["036000291452"], ["Legacy Soda", "Legacy", "Beverages"]);
  assert.equal(index["012345678905"], undefined);
  assert.equal(index["0123456789055"], undefined);
  assert.equal(index["049000006353"], undefined);
  assert.equal(generatedMeta.classifications.known, 2);
  assert.equal(generatedMeta.classifications.review, 2);
  assert.equal(generatedMeta.classifications.quarantined, 1);
  assert.equal(generatedMeta.conflicting_duplicates, 1);
  assert.equal(review.length, 3);
  assert.ok(review.some((item) => item.barcode === "049000006353" && item.reason === "duplicate_conflict"));
  assert.equal(review.find((item) => item.barcode === "049000006353")?.source_line, 5);
  assert.equal(serializedOutput.includes("\n  \"index\""), false, "serving JSON remains compact");
  assert.equal(diff.dequarantined.length, 0);
  assert.equal(result.knownCount, 2);
});

test("category duplicate evidence is a review conflict", async () => {
  const dir = await mkdtemp(join(tmpdir(), "retail-category-conflict-"));
  const input = join(dir, "source.jsonl"); const output = join(dir, "out.json"); const meta = join(dir, "meta.json"); const receipts = join(dir, "receipts");
  await writeFile(input, `${JSON.stringify({ code, product_name_raw: "Soda", main_category_raw: "en:a", _duplicate_observations: [{ differing_raw_fields: { categories_raw: "en:b" } }] })}\n`);
  await builder.buildRetailKnowledge({ input, outputJson: output, outputMeta: meta, receiptDir: receipts, mode: "fixture" });
  assert.equal(JSON.parse(await readFile(output, "utf8")).index[code], undefined);
  assert.match(await readFile(join(receipts, "review.jsonl"), "utf8"), /duplicate_conflict/);
});

test("full mode derives quarantine diffs from an explicit baseline review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "retail-review-diff-"));
  const input = join(dir, "source.jsonl"); const output = join(dir, "out.json"); const meta = join(dir, "meta.json"); const receipts = join(dir, "receipts"); const baseline = join(dir, "baseline.json"); const priorReview = join(dir, "prior.jsonl");
  await writeFile(input, `${JSON.stringify({ code, product_name_raw: "Soda" })}\n`); await writeFile(baseline, JSON.stringify({ index: { [code]: ["Soda"] } })); await writeFile(priorReview, `${JSON.stringify({ barcode: code, status: "quarantined" })}\n`);
  await assert.rejects(builder.buildRetailKnowledge({ input, outputJson: output, outputMeta: meta, receiptDir: receipts, baselineJson: baseline, baselineReview: priorReview, knownCountFloor: 1, maxDrift: 99, mode: "full" }), /dequarantine forbidden/);
});

test("late promotion failure restores the exact prior artifact set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "retail-promotion-rollback-"));
  const input = join(dir, "source.jsonl");
  const output = join(dir, "out.json");
  const meta = join(dir, "meta.json");
  const receipts = join(dir, "receipts");
  const review = join(receipts, "review.jsonl");
  const diff = join(receipts, "projection-diff.json");
  await writeFile(input, `${JSON.stringify({ code, product_name_raw: "Soda" })}\n`);
  await writeFile(output, "prior-output\r\n");
  await writeFile(meta, "prior-meta\r\n");
  await writeFile(review, "prior-review\r\n", { recursive: true }).catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(receipts, { recursive: true });
    await writeFile(review, "prior-review\r\n");
  });
  await writeFile(diff, "prior-diff\r\n");

  await assert.rejects(
    builder.buildRetailKnowledge({
      input, outputJson: output, outputMeta: meta, receiptDir: receipts,
      mode: "fixture", promotionFailAfter: 2,
    }),
    /injected promotion failure/,
  );

  assert.equal(await readFile(output, "utf8"), "prior-output\r\n");
  assert.equal(await readFile(meta, "utf8"), "prior-meta\r\n");
  assert.equal(await readFile(review, "utf8"), "prior-review\r\n");
  assert.equal(await readFile(diff, "utf8"), "prior-diff\r\n");
});

test("CLI executes with explicit disposable paths on Windows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "retail-cli-"));
  const input = join(dir, "source.jsonl");
  const output = join(dir, "out.json");
  const meta = join(dir, "meta.json");
  const receipts = join(dir, "receipts");
  await writeFile(input, `${JSON.stringify({ code, product_name_raw: "Soda" })}\n`);
  const { stdout } = await execFileAsync(process.execPath, [
    join(process.cwd(), "scripts", "build-retail-knowledge.mjs"),
    "--input", input,
    "--output-json", output,
    "--output-meta", meta,
    "--receipt-dir", receipts,
    "--mode", "fixture",
  ]);
  assert.match(stdout, /OK 1 products/);
  assert.equal(JSON.parse(await readFile(output, "utf8")).index[code][0], "Soda");
});

test("reads the space-bounded enriched JSONL gzip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "retail-gzip-input-"));
  const input = join(dir, "source.jsonl.gz");
  const output = join(dir, "out.json");
  const meta = join(dir, "meta.json");
  const receipts = join(dir, "receipts");
  await writeFile(input, gzipSync(`${JSON.stringify({ code, product_name_raw: "Soda" })}\n`));
  const result = await builder.buildRetailKnowledge({
    input, outputJson: output, outputMeta: meta, receiptDir: receipts, mode: "fixture",
  });
  assert.equal(result.knownCount, 1);
});

test("writes and reuses a space-bounded serving JSON gzip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "retail-gzip-output-"));
  const input = join(dir, "source.jsonl");
  const output = join(dir, "out.json.gz");
  const meta = join(dir, "meta.json");
  const receipts = join(dir, "receipts");
  await writeFile(input, `${JSON.stringify({ code, product_name_raw: "Soda" })}\n`);
  await builder.buildRetailKnowledge({
    input, outputJson: output, outputMeta: meta, receiptDir: receipts, mode: "fixture",
  });
  const serving = JSON.parse(gunzipSync(await readFile(output)).toString("utf8"));
  assert.equal(serving.index[code][0], "Soda");

  const secondOutput = join(dir, "second.json.gz");
  const result = await builder.buildRetailKnowledge({
    input,
    outputJson: secondOutput,
    outputMeta: join(dir, "second.meta.json"),
    receiptDir: join(dir, "second-receipts"),
    baselineJson: output,
    mode: "fixture",
  });
  assert.deepEqual(result.diff.added, []);
});

test("repairs a physical newline embedded in a generated JSON string", async () => {
  const dir = await mkdtemp(join(tmpdir(), "retail-split-json-"));
  const input = join(dir, "source.jsonl");
  const output = join(dir, "out.json");
  const meta = join(dir, "meta.json");
  const receipts = join(dir, "receipts");
  await writeFile(input, `{"code":"${code}","product_name_raw":"A\nB"}\n`);
  const result = await builder.buildRetailKnowledge({
    input, outputJson: output, outputMeta: meta, receiptDir: receipts, mode: "fixture",
  });
  assert.equal(result.meta.invalid_json_rows, 0);
  assert.equal(JSON.parse(await readFile(output, "utf8")).index[code][0], "A B");
});

test("does not mislabel a duplicate-conflict review demotion as quarantine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "retail-review-label-"));
  const input = join(dir, "source.jsonl");
  const output = join(dir, "out.json");
  const meta = join(dir, "meta.json");
  const receipts = join(dir, "receipts");
  const baseline = join(dir, "baseline.json");
  const priorReview = join(dir, "prior.jsonl");
  await writeFile(input, `${JSON.stringify({
    code,
    product_name_raw: "Soda",
    _duplicate_observations: [{ differing_raw_fields: { product_name_raw: "Other" } }],
  })}\n`);
  await writeFile(baseline, JSON.stringify({ index: { [code]: ["Soda"] } }));
  await writeFile(priorReview, "");
  const result = await builder.buildRetailKnowledge({
    input, outputJson: output, outputMeta: meta, receiptDir: receipts,
    baselineJson: baseline, baselineReview: priorReview,
    knownCountFloor: 0, maxDrift: 10, mode: "full",
  });
  assert.deepEqual(result.diff.removed, [code]);
  assert.deepEqual(result.diff.newlyQuarantined, []);
});
