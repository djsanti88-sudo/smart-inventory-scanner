import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { isSpeedInsightsDisabled, minimizeSpeedInsightEvent, SpeedInsightsTelemetry } from "./SpeedInsightsTelemetry";

vi.mock("@vercel/speed-insights/next", () => ({ SpeedInsights: () => <div data-testid="speed-insights" /> }));

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

describe("Speed Insights local certification opt-out", () => {
  it("only disables telemetry for the explicit local certification value", () => {
    expect(isSpeedInsightsDisabled("1")).toBe(true);
    expect(isSpeedInsightsDisabled("0")).toBe(false);
    expect(isSpeedInsightsDisabled(undefined)).toBe(false);
  });

  it("does not render the external telemetry SDK when disabled", () => {
    vi.stubEnv("NEXT_PUBLIC_DISABLE_TELEMETRY", "1");
    render(<SpeedInsightsTelemetry />);
    expect(screen.queryByTestId("speed-insights")).toBeNull();
    vi.unstubAllEnvs();
  });
});
