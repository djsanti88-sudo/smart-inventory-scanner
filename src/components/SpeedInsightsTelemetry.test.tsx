import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { speedInsightsSdk } = vi.hoisted(() => ({
  speedInsightsSdk: vi.fn(() => <div data-testid="speed-insights-sdk" />),
}));
vi.mock("@vercel/speed-insights/next", () => ({ SpeedInsights: speedInsightsSdk }));

import { SpeedInsightsTelemetry, minimizeSpeedInsightEvent } from "./SpeedInsightsTelemetry";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("Speed Insights data minimization", () => {
  it("does not render the Speed Insights SDK in the local tire demo", () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    render(<SpeedInsightsTelemetry />);
    expect(speedInsightsSdk).not.toHaveBeenCalled();
    expect(screen.queryByTestId("speed-insights-sdk")).toBeNull();
  });

  it("keeps Speed Insights available outside the local tire demo", () => {
    render(<SpeedInsightsTelemetry />);
    expect(speedInsightsSdk).toHaveBeenCalledOnce();
  });
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
