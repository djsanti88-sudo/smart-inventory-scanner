import { describe, it, expect } from "vitest";
import { buildIdempotencyKey, newId, stableIdempotencyFingerprint } from "@/inventory/idempotency";

describe("buildIdempotencyKey", () => {
  it("includes business, session, event, and operation", () => {
    expect(buildIdempotencyKey("biz", "sess", "evt", "INCREMENT_COUNT")).toBe(
      "biz:sess:evt:INCREMENT_COUNT",
    );
  });

  it("is stable across calls (same inputs -> same key)", () => {
    const a = buildIdempotencyKey("b", "s", "e", "RESOLVE_ALIAS");
    const b = buildIdempotencyKey("b", "s", "e", "RESOLVE_ALIAS");
    expect(a).toBe(b);
  });

  it("differs by operation for the same scan event", () => {
    expect(buildIdempotencyKey("b", "s", "e", "SAVE_SCAN_EVENT")).not.toBe(
      buildIdempotencyKey("b", "s", "e", "INCREMENT_COUNT"),
    );
  });
});

describe("stableIdempotencyFingerprint", () => {
  it("is key-order independent while changing when nested payload content changes", () => {
    const first = stableIdempotencyFingerprint({ name: "Original", nested: { brand: "Falken", codes: ["1", "2"] } });
    const reordered = stableIdempotencyFingerprint({ nested: { codes: ["1", "2"], brand: "Falken" }, name: "Original" });
    const refreshed = stableIdempotencyFingerprint({ nested: { codes: ["1", "2"], brand: "Falken" }, name: "Refreshed" });

    expect(reordered).toBe(first);
    expect(refreshed).not.toBe(first);
  });
});

describe("newId", () => {
  it("uses an injected factory when provided (deterministic tests)", () => {
    let n = 0;
    const factory = () => `id-${++n}`;
    expect(newId(factory)).toBe("id-1");
    expect(newId(factory)).toBe("id-2");
  });

  it("returns a unique value by default", () => {
    expect(newId()).not.toBe(newId());
  });
});
