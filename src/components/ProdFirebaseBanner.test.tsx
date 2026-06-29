import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ProdFirebaseBanner } from "@/components/ProdFirebaseBanner";

// The banner is a LOCAL-DEV guardrail (warns when dev is pointed at real Firebase). It must NEVER render
// on a real deployment, where using real Firebase is the intended behavior.

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("ProdFirebaseBanner (dev-only guardrail)", () => {
  it("does NOT render on a real production deployment, even with real Firebase", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_BACKEND", "1");
    render(<ProdFirebaseBanner />);
    expect(screen.queryByTestId("prod-firebase-banner")).toBeNull();
  });

  it("renders in LOCAL DEV when pointed at real Firebase (the guardrail)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_BACKEND", "1");
    render(<ProdFirebaseBanner />);
    expect(screen.queryByTestId("prod-firebase-banner")).not.toBeNull();
  });

  it("does NOT render with the emulator (safe local mode)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_BACKEND", "1");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_USE_EMULATOR", "1");
    render(<ProdFirebaseBanner />);
    expect(screen.queryByTestId("prod-firebase-banner")).toBeNull();
  });
});
