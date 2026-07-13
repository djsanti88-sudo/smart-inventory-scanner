import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CameraScanButton } from "@/components/CameraScanButton";

afterEach(cleanup);

// Mock the pure camera scan service so this component test targets ONLY the button/overlay wiring
// (open, permission states, detect -> onScan -> close -> refocus), not the detection loop itself
// (that is covered by cameraScanner.test.ts).
const startMock = vi.fn(async () => {});
const stopMock = vi.fn();
let capturedOnDetect: ((raw: string) => void) | null = null;

vi.mock("@/services/camera/cameraScanner", () => ({
  createCameraScanner: (_video: HTMLVideoElement, onDetect: (raw: string) => void) => {
    capturedOnDetect = onDetect;
    return { start: startMock, stop: stopMock };
  },
}));

function mockStream(): MediaStream {
  const track = { stop: vi.fn(), kind: "video" } as unknown as MediaStreamTrack;
  return { getTracks: () => [track] } as unknown as MediaStream;
}

beforeEach(() => {
  capturedOnDetect = null;
  startMock.mockClear();
  stopMock.mockClear();
});

describe("CameraScanButton", () => {
  it("opens the camera overlay, calls onScan with the raw detected value, closes, and refocuses the scan input", async () => {
    const getUserMedia = vi.fn(async () => mockStream());
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    });

    const onScan = vi.fn();
    const user = userEvent.setup();
    render(
      <div>
        <input id="scanner-input" aria-label="Scan a code" />
        <CameraScanButton onScan={onScan} />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: /scan with camera/i }));

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: "environment" } }));
    await waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
    expect(capturedOnDetect).not.toBeNull();

    act(() => {
      capturedOnDetect!("6419440485331");
    });

    expect(onScan).toHaveBeenCalledWith("6419440485331");
    expect(stopMock).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const input = screen.getByLabelText("Scan a code") as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("shows a plain-language message and does not crash when camera permission is denied", async () => {
    const deniedError = new DOMException("Permission denied", "NotAllowedError");
    const getUserMedia = vi.fn(async () => {
      throw deniedError;
    });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    });

    const onScan = vi.fn();
    const user = userEvent.setup();
    render(
      <div>
        <input id="scanner-input" aria-label="Scan a code" />
        <CameraScanButton onScan={onScan} />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: /scan with camera/i }));

    await waitFor(() => expect(screen.getByText(/camera access was denied/i)).toBeTruthy());
    expect(screen.queryByText(/NotAllowedError/)).toBeNull();
    expect(onScan).not.toHaveBeenCalled();
  });
});
