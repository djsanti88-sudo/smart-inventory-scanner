import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { createLocalDemoStatusHandler } from "./statusHandler";

const original = process.env.SCANBIN_LOCAL_DEMO;

afterEach(() => {
  if (original === undefined) delete process.env.SCANBIN_LOCAL_DEMO;
  else process.env.SCANBIN_LOCAL_DEMO = original;
});

describe("GET /api/local-demo/status", () => {
  it("returns only sanitized cross-process ledger evidence on loopback", async () => {
    process.env.SCANBIN_LOCAL_DEMO = "1";
    const root = mkdtempSync(join(tmpdir(), "scanbin-status-"));
    try {
      const runtimeRoot = join(root, "runtime");
      mkdirSync(runtimeRoot);
      const ledger = join(runtimeRoot, "ledger.jsonl");
      writeFileSync(ledger, `${JSON.stringify({
        pid: 4321,
        timestamp: "2026-07-29T00:00:00.000Z",
        method: "GET",
        protocol: "https:",
        host: "example.com",
        path: "/blocked",
      })}\n`);
      const handler = createLocalDemoStatusHandler({
        runtimeRoot,
        ledgerPath: ledger,
        preflight: () => ({ databaseSha256: "a".repeat(64) }),
      });
      const response = await handler(new NextRequest("http://127.0.0.1:3400/api/local-demo/status"));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        localDemo: true,
        externalDecodeEnabled: false,
        databaseSha256: "a".repeat(64),
        egress: {
          blockedAttemptCount: 1,
          attempts: [{
            pid: 4321,
            timestamp: "2026-07-29T00:00:00.000Z",
            method: "GET",
            protocol: "https:",
            host: "example.com",
            path: "/blocked",
          }],
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns 404 outside explicit demo mode or loopback", async () => {
    const root = mkdtempSync(join(tmpdir(), "scanbin-status-gate-"));
    try {
      const runtimeRoot = join(root, "runtime");
      mkdirSync(runtimeRoot);
      const ledger = join(runtimeRoot, "ledger.jsonl");
      writeFileSync(ledger, "");
      const handler = createLocalDemoStatusHandler({
        runtimeRoot,
        ledgerPath: ledger,
        preflight: () => ({ databaseSha256: "b".repeat(64) }),
      });
      delete process.env.SCANBIN_LOCAL_DEMO;
      expect((await handler(new NextRequest("http://localhost/api/local-demo/status"))).status).toBe(404);
      process.env.SCANBIN_LOCAL_DEMO = "1";
      expect((await handler(new NextRequest("http://192.0.2.10/api/local-demo/status"))).status).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for a malformed or escaped ledger", async () => {
    process.env.SCANBIN_LOCAL_DEMO = "1";
    const root = mkdtempSync(join(tmpdir(), "scanbin-status-bad-"));
    try {
      const runtimeRoot = join(root, "runtime");
      mkdirSync(runtimeRoot);
      const outside = join(root, "outside.jsonl");
      writeFileSync(outside, "{}\n");
      const escaped = createLocalDemoStatusHandler({
        runtimeRoot,
        ledgerPath: outside,
        preflight: () => ({ databaseSha256: "c".repeat(64) }),
      });
      expect((await escaped(new NextRequest("http://localhost/api/local-demo/status"))).status).toBe(500);

      const malformedPath = join(runtimeRoot, "bad.jsonl");
      writeFileSync(malformedPath, "{bad}\n");
      const malformed = createLocalDemoStatusHandler({
        runtimeRoot,
        ledgerPath: malformedPath,
        preflight: () => ({ databaseSha256: "c".repeat(64) }),
      });
      expect((await malformed(new NextRequest("http://localhost/api/local-demo/status"))).status).toBe(500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
