import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("Next.js response security headers", () => {
  it("applies the browser hardening headers and CSP to every route", async () => {
    expect(nextConfig.headers).toBeTypeOf("function");
    const rules = await nextConfig.headers!();
    const globalRule = rules.find((rule) => rule.source === "/:path*");
    const headers = Object.fromEntries(
      (globalRule?.headers ?? []).map(({ key, value }) => [key.toLowerCase(), value]),
    );

    expect(headers).toMatchObject({
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(self), microphone=(), geolocation=(), browsing-topics=()",
    });

    const csp = headers["content-security-policy"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' blob: data: https:");
    expect(csp).toContain("connect-src 'self' https:");
    expect(csp).not.toContain("http://localhost:");
    expect(csp).not.toContain("http://127.0.0.1:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/\n|\s{2,}/);
  });
});
