import { describe, it, expect } from "vitest";
import { isSafePublicUrl, filterSafeUrls } from "@/services/ai/urlSafety";

describe("isSafePublicUrl (SSRF guard)", () => {
  it("allows normal public http(s) product URLs", () => {
    expect(isSafePublicUrl("https://www.faire.com/product/p_uxqrb39cyu")).toBe(true);
    expect(isSafePublicUrl("http://www.amazon.com/dp/B000")).toBe(true);
  });

  it("blocks non-http(s) protocols", () => {
    expect(isSafePublicUrl("file:///etc/passwd")).toBe(false);
    expect(isSafePublicUrl("javascript:alert(1)")).toBe(false);
    expect(isSafePublicUrl("ftp://example.com/x")).toBe(false);
    expect(isSafePublicUrl("not a url")).toBe(false);
  });

  it("blocks loopback / localhost / internal hostnames", () => {
    expect(isSafePublicUrl("http://localhost/x")).toBe(false);
    expect(isSafePublicUrl("http://api.localhost/x")).toBe(false);
    expect(isSafePublicUrl("http://printer.local/x")).toBe(false);
    expect(isSafePublicUrl("http://service.internal/x")).toBe(false);
    expect(isSafePublicUrl("http://metadata.google.internal/x")).toBe(false);
    expect(isSafePublicUrl("http://intranet/x")).toBe(false); // bare host, no TLD
  });

  it("blocks private / loopback / link-local / metadata IPv4", () => {
    for (const u of [
      "http://127.0.0.1/x",
      "http://10.0.0.5/x",
      "http://192.168.1.1/x",
      "http://172.16.4.4/x",
      "http://169.254.169.254/latest/meta-data", // cloud metadata
      "http://0.0.0.0/x",
    ]) {
      expect(isSafePublicUrl(u), u).toBe(false);
    }
  });

  it("allows a public IPv4", () => {
    expect(isSafePublicUrl("http://8.8.8.8/x")).toBe(true);
  });

  it("blocks IPv6 loopback / link-local", () => {
    expect(isSafePublicUrl("http://[::1]/x")).toBe(false);
    expect(isSafePublicUrl("http://[fe80::1]/x")).toBe(false);
  });

  it("filterSafeUrls dedupes, drops unsafe, and caps", () => {
    const out = filterSafeUrls(
      ["https://a.com/1", "https://a.com/1", "http://127.0.0.1/x", "https://b.com/2", "file:///x", "https://c.com/3"],
      2,
    );
    expect(out).toEqual(["https://a.com/1", "https://b.com/2"]);
  });
});
