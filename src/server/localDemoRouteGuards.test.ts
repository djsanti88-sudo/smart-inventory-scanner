import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import {
  isLoopbackRequest,
  localDemoNoContentResponse,
  localDemoNullResponse,
  localDemoUnavailableResponse,
} from "./localDemoHttp";

const guardedHandlers = [
  ["src/app/api/telemetry/route.ts", "POST", "localDemoNoContentResponse"],
  ["src/app/api/prefix-floor/route.ts", "GET", "localDemoNullResponse"],
  ["src/app/api/catalog-dispute/route.ts", "POST", "localDemoNoContentResponse"],
  ["src/app/api/reconcile/match/route.ts", "POST", "localDemoUnavailableResponse"],
  ["src/app/api/import-mapping/route.ts", "GET", "localDemoUnavailableResponse"],
  ["src/app/api/import-mapping/route.ts", "PUT", "localDemoUnavailableResponse"],
  ["src/app/api/share/route.ts", "POST", "localDemoUnavailableResponse"],
  ["src/app/api/share/[token]/route.ts", "GET", "localDemoUnavailableResponse"],
  ["src/app/api/catalog-review/route.ts", "GET", "localDemoUnavailableResponse"],
  ["src/app/api/catalog-review/[id]/route.ts", "POST", "localDemoUnavailableResponse"],
  ["src/app/api/account/delete/route.ts", "POST", "localDemoUnavailableResponse"],
  ["src/app/api/account/export/route.ts", "POST", "localDemoUnavailableResponse"],
  ["src/app/api/resolve-scan/route.ts", "POST", "localDemoUnavailableResponse"],
  ["src/app/api/businesses/provision/route.ts", "POST", "localDemoUnavailableResponse"],
  ["src/app/api/businesses/members/route.ts", "POST", "localDemoUnavailableResponse"],
] as const;

describe("local demo route-level guards", () => {
  it.each([
    ["http://b01.localhost:3400/api/local-demo/manifest/01", "b01.localhost:3400"],
    ["http://BATCH-30.localhost:3400/api/local-demo/status", "batch-30.localhost:3400"],
    ["http://127.0.0.1:3400/api/local-demo/manifest/01", "b01.localhost:3400"],
    ["http://localhost:3400/api/local-demo/status", "127.0.0.1:3500"],
  ])("allows independently loopback URL and Host authorities (%s via %s)", (url, host) => {
    expect(isLoopbackRequest(new NextRequest(url, { headers: { host } }))).toBe(true);
  });

  it.each([
    ["http://evil-localhost.com:3400/api/local-demo/status", "evil-localhost.com:3400"],
    ["http://localhost.evil.com:3400/api/local-demo/status", "localhost.evil.com:3400"],
    ["http://b01.localhost:3400/api/local-demo/status", "192.0.2.10:3400"],
    ["http://b01.localhost:3400/api/local-demo/status", "evil.com@b01.localhost:3400"],
  ])("rejects non-loopback or spoofed evidence authorities (%s via %s)", (url, host) => {
    expect(isLoopbackRequest(new NextRequest(url, { headers: { host } }))).toBe(false);
  });

  it.each(guardedHandlers)(
    "%s %s checks demo mode as its first executable statement",
    (path, method, responseHelper) => {
      const source = readFileSync(resolve(path), "utf8");
      const lines = source.split(/\r?\n/);
      const start = lines.findIndex((line) =>
        line.startsWith(`export async function ${method}`)
      );
      expect(start).toBeGreaterThanOrEqual(0);
      const opening = lines.findIndex(
        (line, index) =>
          index >= start &&
          /\)\s*(?::\s*[^{]+)?\s*\{\s*$/.test(line),
      );
      expect(opening).toBeGreaterThanOrEqual(start);
      const firstStatement = lines
        .slice(opening + 1)
        .find((line) => line.trim().length > 0)
        ?.trim();
      expect(firstStatement).toBe(
        `if (isLocalDemo()) return ${responseHelper}();`,
      );
    },
  );

  it("uses deterministic no-store responses without request-derived data", async () => {
    const unavailable = localDemoUnavailableResponse();
    expect(unavailable.status).toBe(409);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    await expect(unavailable.json()).resolves.toEqual({
      error: "Unavailable in local tire demo",
      localDemo: true,
    });

    const noContent = localDemoNoContentResponse();
    expect(noContent.status).toBe(204);
    expect(noContent.headers.get("cache-control")).toBe("no-store");
    expect(await noContent.text()).toBe("");

    const nullResponse = localDemoNullResponse();
    expect(nullResponse.status).toBe(200);
    expect(nullResponse.headers.get("cache-control")).toBe("no-store");
    await expect(nullResponse.json()).resolves.toBeNull();
  });
});
