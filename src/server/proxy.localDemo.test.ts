import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "../proxy";

const original = process.env.SCANBIN_LOCAL_DEMO;

afterEach(() => {
  if (original === undefined) delete process.env.SCANBIN_LOCAL_DEMO;
  else process.env.SCANBIN_LOCAL_DEMO = original;
});

describe("local demo API proxy", () => {
  it("uses the static API matcher", () => {
    expect(config).toEqual({ matcher: "/api/:path*" });
  });

  it.each([
    "/api/ai-lookup",
    "/api/local-demo/status",
    "/api/local-demo/manifest/01",
    "/api/local-demo/manifest/30",
  ])("allows only the exact certified endpoint %s", (pathname) => {
    process.env.SCANBIN_LOCAL_DEMO = "1";
    const response = proxy(new NextRequest(`http://localhost${pathname}`));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each([
    "/api/share",
    "/api/account/delete",
    "/api/businesses/provision",
    "/api/resolve-scan",
    "/api/local-demo/manifest/1",
    "/api/local-demo/manifest/00",
    "/api/local-demo/manifest/31",
    "/api/local-demo/manifest/01/extra",
  ])("blocks unsupported or malformed endpoint %s", async (pathname) => {
    process.env.SCANBIN_LOCAL_DEMO = "1";
    const response = proxy(new NextRequest(`http://localhost${pathname}`));
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Unavailable in local tire demo",
      localDemo: true,
    });
  });

  it("passes every request through when local demo is disabled", () => {
    delete process.env.SCANBIN_LOCAL_DEMO;
    const response = proxy(new NextRequest("http://localhost/api/share"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
