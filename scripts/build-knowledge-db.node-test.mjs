import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import Database from "better-sqlite3";

const SCRIPT = resolve("scripts/build-knowledge-db.mjs");

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value), "utf8");
}

function fixtureWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "knowledge-db-test-"));
  const inputs = join(root, "inputs");
  const outputs = join(root, "outputs");
  mkdirSync(inputs, { recursive: true });
  mkdirSync(outputs, { recursive: true });

  const tireJson = join(inputs, "tires.json");
  const retailJson = join(inputs, "retail.json");
  const retailMeta = join(inputs, "retail.meta.json");
  const outputDb = join(outputs, "knowledge.db");
  const outputGzip = join(outputs, "knowledge.db.gz");
  const receipt = join(outputs, "knowledge.receipt.json");

  writeJson(tireJson, { barcodeIndex: {} });
  writeJson(retailJson, {
    generated_at: "2026-08-03T00:00:00.000Z",
    index: {
      "049000006346": ["Coca-Cola Classic", "Coca-Cola", "Beverages"],
      "3017620422003": ["Nutella", "Ferrero", "Spreads"],
    },
  });
  writeJson(retailMeta, { unique_barcodes: 2 });

  return { root, tireJson, retailJson, retailMeta, outputDb, outputGzip, receipt };
}

function runBuilder(fx, extraArgs = [], env = {}) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--tire-json", fx.tireJson,
      "--retail-json", fx.retailJson,
      "--retail-meta", fx.retailMeta,
      "--output-db", fx.outputDb,
      "--output-gzip", fx.outputGzip,
      "--receipt", fx.receipt,
      ...extraArgs,
    ],
    { cwd: fx.root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, env: { ...process.env, ...env } },
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fullModeArgs(fx, expectedTireSha256 = sha256(readFileSync(fx.tireJson))) {
  return ["--require-retail", "--expected-tire-sha256", expectedTireSha256];
}

test("CLI paths build only the requested disposable artifacts", () => {
  const fx = fixtureWorkspace();
  try {
    const result = runBuilder(fx);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(fx.outputDb), true);
    assert.equal(existsSync(fx.outputGzip), true);
    assert.equal(existsSync(join(fx.root, "src", "decoding", "server", "knowledge", "knowledge.generated.db")), false);

    const db = new Database(fx.outputDb, { readonly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM retail").get().c, 2);
    } finally {
      db.close();
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("required mode accepts the space-bounded retail JSON gzip", () => {
  const fx = fixtureWorkspace();
  try {
    const gzPath = `${fx.retailJson}.gz`;
    writeFileSync(gzPath, gzipSync(readFileSync(fx.retailJson)));
    rmSync(fx.retailJson);
    fx.retailJson = gzPath;
    const result = runBuilder(fx, fullModeArgs(fx));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(existsSync(fx.outputDb));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("--require-retail fails closed for missing, invalid, LFS-pointer, and meta-count mismatch inputs", async (t) => {
  const cases = [
    ["missing retail", (fx) => rmSync(fx.retailJson)],
    ["invalid retail", (fx) => writeFileSync(fx.retailJson, "not json", "utf8")],
    ["LFS pointer retail", (fx) => writeFileSync(fx.retailJson, "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n", "utf8")],
    ["meta count mismatch", (fx) => writeJson(fx.retailMeta, { unique_barcodes: 999 })],
  ];

  for (const [name, arrange] of cases) {
    await t.test(name, () => {
      const fx = fixtureWorkspace();
      try {
        arrange(fx);
        writeFileSync(fx.outputDb, "prior-db", "utf8");
        writeFileSync(fx.outputGzip, "prior-gzip", "utf8");

        const result = runBuilder(fx, fullModeArgs(fx));
        assert.notEqual(result.status, 0, "required retail failure must be non-zero");
        assert.equal(readFileSync(fx.outputDb, "utf8"), "prior-db");
        assert.equal(readFileSync(fx.outputGzip, "utf8"), "prior-gzip");
      } finally {
        rmSync(fx.root, { recursive: true, force: true });
      }
    });
  }
});

test("--require-retail requires valid, hash-pinned tire input without replacing prior artifacts", async (t) => {
  const cases = [
    ["missing tire", (fx) => rmSync(fx.tireJson), "0".repeat(64)],
    ["invalid tire", (fx) => writeFileSync(fx.tireJson, "not json", "utf8"), "0".repeat(64)],
    ["LFS pointer tire", (fx) => writeFileSync(fx.tireJson, "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n", "utf8"), "0".repeat(64)],
    ["missing expected hash", () => {}, null],
    ["malformed expected hash", () => {}, "not-a-sha256"],
    ["mismatched expected hash", () => {}, "0".repeat(64)],
  ];

  for (const [name, arrange, expectedHash] of cases) {
    await t.test(name, () => {
      const fx = fixtureWorkspace();
      try {
        arrange(fx);
        writeFileSync(fx.outputDb, "prior-db", "utf8");
        writeFileSync(fx.outputGzip, "prior-gzip", "utf8");
        const args = expectedHash === null
          ? ["--require-retail"]
          : ["--require-retail", "--expected-tire-sha256", expectedHash];

        const result = runBuilder(fx, args);
        assert.notEqual(result.status, 0, "required tire failure must be non-zero");
        assert.match(result.stderr + result.stdout, /tire|expected-tire-sha256/i);
        assert.equal(readFileSync(fx.outputDb, "utf8"), "prior-db");
        assert.equal(readFileSync(fx.outputGzip, "utf8"), "prior-gzip");
      } finally {
        rmSync(fx.root, { recursive: true, force: true });
      }
    });
  }
});

test("--require-retail rechecks the pinned tire hash before promotion", () => {
  const fx = fixtureWorkspace();
  try {
    writeFileSync(fx.outputDb, "prior-db", "utf8");
    writeFileSync(fx.outputGzip, "prior-gzip", "utf8");

    const result = runBuilder(
      fx,
      fullModeArgs(fx),
      { NODE_ENV: "test", KNOWLEDGE_DB_TEST_FAIL_TIRE_RECHECK: "1" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /tire.*hash.*changed|tire.*changed/i);
    assert.equal(readFileSync(fx.outputDb, "utf8"), "prior-db");
    assert.equal(readFileSync(fx.outputGzip, "utf8"), "prior-gzip");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("--require-retail hashes and parses the same captured tire bytes", () => {
  const fx = fixtureWorkspace();
  try {
    const capturedTireBytes = readFileSync(fx.tireJson);
    const replacementPath = join(fx.root, "replacement-tires.json");
    const replacementBytes = Buffer.from(JSON.stringify({
      barcodeIndex: {
        "012345678901": { canonical_product_uid: "replacement" },
      },
    }));
    writeFileSync(replacementPath, replacementBytes);
    writeFileSync(fx.outputDb, "prior-db", "utf8");
    writeFileSync(fx.outputGzip, "prior-gzip", "utf8");

    const result = runBuilder(
      fx,
      fullModeArgs(fx, sha256(replacementBytes)),
      {
        NODE_ENV: "test",
        KNOWLEDGE_DB_TEST_REPLACE_TIRE_AFTER_READ: replacementPath,
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /Tire JSON SHA-256 mismatch/i);
    assert.match(result.stderr + result.stdout, new RegExp(sha256(capturedTireBytes)));
    assert.deepEqual(readFileSync(fx.tireJson), replacementBytes, "the swap hook must have exercised the TOCTOU boundary");
    assert.equal(readFileSync(fx.outputDb, "utf8"), "prior-db");
    assert.equal(readFileSync(fx.outputGzip, "utf8"), "prior-gzip");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("retail barcode is a primary key and promoted gzip exactly reproduces the validated database", () => {
  const fx = fixtureWorkspace();
  try {
    const result = runBuilder(fx, fullModeArgs(fx));
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const dbBytes = readFileSync(fx.outputDb);
    const decompressedBytes = gunzipSync(readFileSync(fx.outputGzip));
    assert.equal(sha256(decompressedBytes), sha256(dbBytes));

    const db = new Database(fx.outputDb);
    try {
      assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
      assert.throws(
        () => db.prepare("INSERT INTO retail (barcode, product_name, brand, category) VALUES (?, ?, ?, ?)").run("049000006346", "Wrong", "Wrong", "Wrong"),
        /UNIQUE constraint failed: retail\.barcode/,
      );
    } finally {
      db.close();
    }

    const receipt = JSON.parse(readFileSync(fx.receipt, "utf8"));
    assert.equal(receipt.dbSha256, sha256(dbBytes));
    assert.equal(receipt.decompressedGzipDbSha256, receipt.dbSha256);
    assert.equal(receipt.retailCount, 2);
    assert.equal(receipt.integrityCheck, "ok");
    assert.equal(receipt.tireInputSha256, sha256(readFileSync(fx.tireJson)));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("zero-padding-equivalent retail keys fail before replacing prior artifacts", () => {
  const fx = fixtureWorkspace();
  try {
    writeJson(fx.retailJson, {
      index: {
        "049000006346": ["Coca-Cola Classic", "Coca-Cola", "Beverages"],
        "0049000006346": ["Wrong Product", "Wrong Brand", "Hardware"],
      },
    });
    writeFileSync(fx.outputDb, "prior-db", "utf8");
    writeFileSync(fx.outputGzip, "prior-gzip", "utf8");

    const result = runBuilder(fx, fullModeArgs(fx));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /zero-padding|variant-family/i);
    assert.equal(readFileSync(fx.outputDb, "utf8"), "prior-db");
    assert.equal(readFileSync(fx.outputGzip, "utf8"), "prior-gzip");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("a failure after DB promotion restores the exact prior DB and gzip", () => {
  const fx = fixtureWorkspace();
  try {
    writeFileSync(fx.outputDb, "prior-db", "utf8");
    writeFileSync(fx.outputGzip, "prior-gzip", "utf8");

    const result = runBuilder(
      fx,
      fullModeArgs(fx),
      { NODE_ENV: "test", KNOWLEDGE_DB_TEST_FAIL_AFTER_DB_PROMOTION: "1" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /simulated promotion failure/i);
    assert.equal(readFileSync(fx.outputDb, "utf8"), "prior-db");
    assert.equal(readFileSync(fx.outputGzip, "utf8"), "prior-gzip");
    assert.equal(existsSync(fx.receipt), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("a failure at the late commit boundary restores the exact prior DB, gzip, and receipt", () => {
  const fx = fixtureWorkspace();
  try {
    writeFileSync(fx.outputDb, "prior-db", "utf8");
    writeFileSync(fx.outputGzip, "prior-gzip", "utf8");
    writeFileSync(fx.receipt, "prior-receipt", "utf8");

    const result = runBuilder(
      fx,
      fullModeArgs(fx),
      { NODE_ENV: "test", KNOWLEDGE_DB_TEST_FAIL_BEFORE_COMMIT: "1" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /simulated late commit failure/i);
    assert.equal(readFileSync(fx.outputDb, "utf8"), "prior-db");
    assert.equal(readFileSync(fx.outputGzip, "utf8"), "prior-gzip");
    assert.equal(readFileSync(fx.receipt, "utf8"), "prior-receipt");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
