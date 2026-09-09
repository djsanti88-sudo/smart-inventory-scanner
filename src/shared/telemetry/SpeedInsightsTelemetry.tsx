"use client";

import { SpeedInsights } from "@vercel/speed-insights/next";

type SpeedInsightEvent = {
  type: "vital";
  url: string;
  route?: string;
};

export function minimizeSpeedInsightEvent(
  event: SpeedInsightEvent,
): SpeedInsightEvent | null {
  try {
    const url = new URL(event.url);
    // Shared-report path segments are bearer credentials for the unauthenticated report API.
    // Do not emit any metric for those pages, even if the SDK has not yet derived a route template.
    if (url.pathname.startsWith("/report/")) return null;
    return {
      ...event,
      // Never send query strings or fragments, which may contain scanned codes or filters.
      url: `${url.origin}${url.pathname}`,
    };
  } catch {
    return null;
  }
}

export function isSpeedInsightsDisabled(value = process.env.NEXT_PUBLIC_DISABLE_TELEMETRY): boolean {
  return value === "1";
}

export function SpeedInsightsTelemetry() {
  // Local corpus certification has a strict no-external-egress contract. This opt-out is deliberately
  // explicit and preserves normal Preview/production telemetry by default.
  if (isSpeedInsightsDisabled()) return null;
  return (
    <SpeedInsights
      sampleRate={0.1}
      beforeSend={minimizeSpeedInsightEvent}
    />
  );
}
