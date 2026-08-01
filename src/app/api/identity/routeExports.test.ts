import { describe, expect, it } from "vitest";
import * as applyRoute from "./apply/route";
import * as previewRoute from "./preview/route";
import * as reviewsRoute from "./reviews/route";

describe("Next identity route entrypoints", () => {
  it("exports only supported HTTP handlers from App Router route modules", () => {
    expect(Object.keys(previewRoute).sort()).toEqual(["POST"]);
    expect(Object.keys(applyRoute).sort()).toEqual(["POST"]);
    expect(Object.keys(reviewsRoute).sort()).toEqual(["GET", "POST"]);
  });
});
