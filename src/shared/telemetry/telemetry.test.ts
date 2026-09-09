import { describe, expect, it, vi } from "vitest";
import { postTelemetry } from "./telemetry";

describe("postTelemetry", () => {
  it("posts only an allowed event and bounded detail without surfacing fetch failures", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"));

    await expect(postTelemetry("client_error", "x".repeat(250))).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/telemetry", expect.objectContaining({
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "client_error", detail: "x".repeat(200) }),
    }));

    fetchMock.mockRestore();
  });

  it("does not send values outside the client event allowlist", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await postTelemetry("not_an_event" as "client_error");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});
