import { describe, expect, it } from "vitest";
import { createMemoryPreviewCache } from "./previewCache";

describe("preview cache", () => {
  it("stores signed preview chunks for lookup without durable claim capabilities", async () => {
    const cache = createMemoryPreviewCache();
    await cache.put("preview-a", ["signed-chunk-1", "signed-chunk-2"]);

    await expect(cache.get("preview-a")).resolves.toEqual(["signed-chunk-1", "signed-chunk-2"]);
    expect("claim" in cache).toBe(false);
    expect("transaction" in cache).toBe(false);
  });
});
