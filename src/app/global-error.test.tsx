import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { postTelemetry } = vi.hoisted(() => ({ postTelemetry: vi.fn() }));
vi.mock("@/shared/telemetry/telemetry", () => ({ postTelemetry }));

import GlobalError from "./global-error";

describe("GlobalError", () => {
  it("reports a sanitized client error and provides a retry action", () => {
    const retry = vi.fn();
    render(<GlobalError error={Object.assign(new Error("secret scan code 012345678905"), { digest: "digest-1" })} unstable_retry={retry} />);

    expect(postTelemetry).toHaveBeenCalledWith("client_error", "digest:digest-1");
    screen.getByRole("button", { name: /try again/i }).click();
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByText(/something went wrong/i)).toBeTruthy();
  });
});
