import { describe, expect, it } from "vitest";
import { sanitizeCustomerReason } from "./decodeFallback";

describe("sanitizeCustomerReason", () => {
  it("keeps safe, useful customer copy", () => {
    expect(sanitizeCustomerReason("No match was found in the shared corpus or web evidence."))
      .toBe("No match was found in the shared corpus or web evidence.");
  });

  it("replaces empty and internal diagnostic reasons", () => {
    expect(sanitizeCustomerReason("")).toContain("Could not confirm");
    expect(sanitizeCustomerReason("gpt_decode: no_api_key")).toContain("Could not confirm");
    expect(sanitizeCustomerReason("tire-corpus internal miss")).toContain("Could not confirm");
  });

  it("uses context-specific safe copy", () => {
    expect(sanitizeCustomerReason("", { status: "offline" })).toBe("Offline. Saved locally; AI was not called.");
    expect(sanitizeCustomerReason("no_api_key", { status: "missing_keys" })).toContain("not configured");
  });
});
