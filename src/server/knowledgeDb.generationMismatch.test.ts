// Regression guard for DT2-1 (2026-08-13, docs/superpowers/reports/2026-08-13-loop2-data.md):
// build-knowledge-db.mjs's two paired outputs (.db and .db.gz) can end up describing different
// corpus generations if the process crashes between the two renameSync calls (see
// build-knowledge-db.pairconsistency.test.mjs for the generator side of the fix). This file proves
// the CONSUMER side: src/server/knowledgeDb.ts must verify whichever file it opens (direct .db, or a
// .gz decompressed to /tmp) against a small committed manifest (knowledge.generated.manifest.json,
// recording a sha256 fingerprint of the finalized DB content) and refuse to silently serve a
// generation that doesn't match -- while still treating a totally ABSENT corpus (no manifest, no
// db, no gz) as the normal, already-handled case, never a crash.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { __resetKnowledgeDbForTests, __resolveAndVerifyDbPathForTests } from "@/server/knowledgeDb";

function sha256(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

describe("knowledgeDb generation-mismatch detection (DT2-1)", () => {
  let dir: string;
  let dbPath: string;
  let gzPath: string;
  let tmpDbPath: string;
  let manifestPath: string;
  let errorSpy: ReturnType<typeof import("vitest")["vi"]["spyOn"]>;

  beforeEach(async () => {
    __resetKnowledgeDbForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledgeDb-genmismatch-"));
    dbPath = path.join(dir, "src-server", "knowledge.generated.db");
    gzPath = path.join(dir, "src-server", "knowledge.generated.db.gz");
    tmpDbPath = path.join(dir, "tmp", "knowledge.generated.db");
    manifestPath = path.join(dir, "src-server", "knowledge.generated.manifest.json");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(path.dirname(tmpDbPath), { recursive: true });
    const { vi } = await import("vitest");
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    const { vi } = await import("vitest");
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
    __resetKnowledgeDbForTests();
  });

  it("opens the DB normally when its content matches the manifest's recorded fingerprint", () => {
    const content = "real-sqlite-db-bytes";
    fs.writeFileSync(dbPath, content);
    fs.writeFileSync(manifestPath, JSON.stringify({ db_sha256: sha256(Buffer.from(content)) }));

    const result = __resolveAndVerifyDbPathForTests({ dbPath, gzPath, tmpDbPath, manifestPath });

    expect(result).toEqual({ status: "ok", path: dbPath });
  });

  it("refuses (loud, non-crashing) when the .db content does NOT match the manifest's fingerprint", () => {
    fs.writeFileSync(dbPath, "a-different-generation-of-bytes");
    fs.writeFileSync(manifestPath, JSON.stringify({ db_sha256: sha256(Buffer.from("stale-generation-bytes")) }));

    const result = __resolveAndVerifyDbPathForTests({ dbPath, gzPath, tmpDbPath, manifestPath });

    expect(result).toEqual({ status: "mismatch" });
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls.some((call: unknown[]) => /mismatch/i.test(String(call[0])))).toBe(true);
  });

  it("does NOT throw an uncaught exception on mismatch -- the app must keep running with the corpus disabled", () => {
    fs.writeFileSync(dbPath, "new-generation");
    fs.writeFileSync(manifestPath, JSON.stringify({ db_sha256: sha256(Buffer.from("old-generation")) }));

    expect(() => __resolveAndVerifyDbPathForTests({ dbPath, gzPath, tmpDbPath, manifestPath })).not.toThrow();
  });

  it("treats a totally absent corpus (no db, no gz, no manifest) as the normal handled case, not an error", () => {
    const result = __resolveAndVerifyDbPathForTests({ dbPath, gzPath, tmpDbPath, manifestPath });

    expect(result).toEqual({ status: "missing" });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("proceeds normally when the manifest is simply absent (older build, or bootstrap before this feature existed)", () => {
    fs.writeFileSync(dbPath, "some-db-with-no-manifest-yet");

    const result = __resolveAndVerifyDbPathForTests({ dbPath, gzPath, tmpDbPath, manifestPath });

    expect(result).toEqual({ status: "ok", path: dbPath });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("verifies the decompressed .gz content against the SAME db_sha256 manifest field (gz path resolves to identical bytes as .db would)", () => {
    const content = "decompressed-db-content-should-match-db_sha256";
    fs.writeFileSync(gzPath, gzipSync(Buffer.from(content)));
    fs.writeFileSync(manifestPath, JSON.stringify({ db_sha256: sha256(Buffer.from(content)) }));

    const result = __resolveAndVerifyDbPathForTests({ dbPath, gzPath, tmpDbPath, manifestPath });

    expect(result).toEqual({ status: "ok", path: tmpDbPath });
  });

  it("refuses when the decompressed .gz content does NOT match the manifest (stale .gz left behind by a crashed rename pair)", () => {
    fs.writeFileSync(gzPath, gzipSync(Buffer.from("stale-gz-generation")));
    fs.writeFileSync(manifestPath, JSON.stringify({ db_sha256: sha256(Buffer.from("new-generation-that-crashed-before-gz-rename")) }));

    const result = __resolveAndVerifyDbPathForTests({ dbPath, gzPath, tmpDbPath, manifestPath });

    expect(result).toEqual({ status: "mismatch" });
    expect(errorSpy).toHaveBeenCalled();
  });
});
