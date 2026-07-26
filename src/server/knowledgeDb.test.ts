// Proves the fail-loud temp-fallback staleness gate in resolveDbPath (build-prevention item 4,
// "Never Again" package). Root cause: a fresh worktree has no local knowledge.generated.db, so
// resolveDbPath fell back silently to whatever copy happened to sit in %TEMP%/os.tmpdir() -- which
// can be a stale corpus left over from a much older session (confirmed: a real June-29 stale copy
// coexisted with fresh July-22 copies on this machine). That silent staleness manufactured phantom
// test failures that looked like real regressions. Fix: when falling back to the temp copy, compare
// its mtime against a staleness bound; throw a clear, actionable error if it's stale, warn once (not
// every call) if it's fresh enough. Production's Vercel gz-decompress path must be unaffected: it
// writes /tmp itself on every cold start, so its temp copy is never allowed to look "stale" relative
// to that write.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  __resetKnowledgeDbForTests,
  __resolveDbPathForTests,
  TEMP_DB_STALENESS_MS,
} from "@/server/knowledgeDb";

describe("knowledgeDb resolveDbPath fail-loud temp staleness gate", () => {
  let dir: string;
  let dbPath: string;
  let gzPath: string;
  let tmpDbPath: string;
  let warnSpy: ReturnType<typeof import("vitest")["vi"]["spyOn"]>;

  beforeEach(async () => {
    __resetKnowledgeDbForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledgeDb-test-"));
    dbPath = path.join(dir, "src-server", "knowledge.generated.db");
    gzPath = path.join(dir, "src-server", "knowledge.generated.db.gz");
    tmpDbPath = path.join(dir, "tmp", "knowledge.generated.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(path.dirname(tmpDbPath), { recursive: true });
    const { vi } = await import("vitest");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    const { vi } = await import("vitest");
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
    __resetKnowledgeDbForTests();
  });

  it("returns the uncompressed DB_PATH directly when it exists (no temp fallback involved)", () => {
    fs.writeFileSync(dbPath, "real-db");
    const resolved = __resolveDbPathForTests({ dbPath, gzPath, tmpDbPath });
    expect(resolved).toBe(dbPath);
  });

  it("throws a clear, actionable error when the only available copy is a STALE temp fallback (>7 days old)", () => {
    fs.writeFileSync(tmpDbPath, "stale-temp-db");
    const staleTime = Date.now() - (TEMP_DB_STALENESS_MS + 24 * 60 * 60 * 1000); // 8 days old
    fs.utimesSync(tmpDbPath, staleTime / 1000, staleTime / 1000);

    expect(() => __resolveDbPathForTests({ dbPath, gzPath, tmpDbPath })).toThrow(
      /provision-worktree|stale|knowledge\.generated\.db/i,
    );
  });

  it("warns once (not throws) when the temp fallback is fresh enough (<=7 days old)", () => {
    fs.writeFileSync(tmpDbPath, "fresh-temp-db");
    const freshTime = Date.now() - 24 * 60 * 60 * 1000; // 1 day old
    fs.utimesSync(tmpDbPath, freshTime / 1000, freshTime / 1000);

    const resolved = __resolveDbPathForTests({ dbPath, gzPath, tmpDbPath });
    expect(resolved).toBe(tmpDbPath);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/temp/i);
  });

  it("preserves production behavior: gz decompress path still writes+returns TMP_DB_PATH, never treated as stale on first write", () => {
    const gzip = require("node:zlib").gzipSync as (b: Buffer) => Buffer;
    fs.writeFileSync(gzPath, gzip(Buffer.from("decompressed-db-contents")));

    const resolved = __resolveDbPathForTests({ dbPath, gzPath, tmpDbPath });
    expect(resolved).toBe(tmpDbPath);
    expect(fs.readFileSync(tmpDbPath, "utf8")).toBe("decompressed-db-contents");
  });

  it("error message names the provisioning script so a fresh worktree session knows the exact fix", () => {
    fs.writeFileSync(tmpDbPath, "stale-temp-db");
    const staleTime = Date.now() - (TEMP_DB_STALENESS_MS + 1000);
    fs.utimesSync(tmpDbPath, staleTime / 1000, staleTime / 1000);

    try {
      __resolveDbPathForTests({ dbPath, gzPath, tmpDbPath });
      expect.fail("expected resolveDbPath to throw for a stale temp fallback");
    } catch (e) {
      expect((e as Error).message).toMatch(/scripts[\\/]provision-worktree\.mjs/);
    }
  });
});
