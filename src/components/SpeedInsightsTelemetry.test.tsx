import { describe, expect, it } from "vitest";
import { minimizeSpeedInsightEvent } from "./SpeedInsightsTelemetry";

describe("Speed Insights data minimization", () => {
  it("removes query strings and fragments before telemetry leaves the browser", () => {
    expect(
      minimizeSpeedInsightEvent({
        type: "vital",
        url: "https://scanbin.app/scan?code=secret-barcode#result",
        route: "/scan",
      }),
    ).toEqual({
      type: "vital",
      url: "https://scanbin.app/scan",
      route: "/scan",
    });
  });

  it("drops malformed URLs", () => {
    expect(
      minimizeSpeedInsightEvent({
        type: "vital",
        url: "not a URL",
      }),
    ).toBeNull();
  });

  it("drops shared-report URLs so bearer tokens never leave the browser", () => {
    expect(
      minimizeSpeedInsightEvent({
        type: "vital",
        url: "https://scanbin.app/report/opaque-bearer-token",
        route: "/report/[token]",
      }),
    ).toBeNull();
  });
});
