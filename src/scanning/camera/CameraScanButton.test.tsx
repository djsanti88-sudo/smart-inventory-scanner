import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CameraScanButton } from "@/scanning/camera/CameraScanButton";

afterEach(cleanup);

// Mock the pure camera scan service so this component test targets ONLY the button/overlay wiring
// (open, permission states, detect -> onScan -> close -> refocus), not the detection loop itself
// (that is covered by cameraScanner.test.ts).
const startMock = vi.fn(async () => {});
const stopMock = vi.fn();
let capturedOnDetect: ((raw: string) => void) | null = null;

vi.mock("@/scanning/camera/cameraScanner", () => ({
  createCameraScanner: (_video: HTMLVideoElement, onDetect: (raw: string) => void) => {
    capturedOnDetect = onDetect;
    return { start: startMock, stop: stopMock };
  },
}));

// A global "unhandledrejection" listener lets the test detect a truly-unhandled promise rejection
// (as opposed to one the component code catches itself). If scanner.start() rejects and nothing in
// CameraScanButton catches it, this fires - the exact CRITICAL 1 bug.
let unhandledRejections: unknown[] = [];
function onUnhandledRejection(event: PromiseRejectionEvent) {
  unhandledRejections.push(event.reason);
  event.preventDefault();
}

function mockStream(): MediaStream {
  const track = { stop: vi.fn(), kind: "video" } as unknown as MediaStreamTrack;
  return { getTracks: () => [track] } as unknown as MediaStream;
}

// Same as mockStream(), but also returns the track so the test can assert track.stop() was called.
function mockStreamWithTrack(): { stream: MediaStream; track: MediaStreamTrack } {
  const track = { stop: vi.fn(), kind: "video" } as unknown as MediaStreamTrack;
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}

beforeEach(() => {
  capturedOnDetect = null;
  startMock.mockClear();
  stopMock.mockClear();
  unhandledRejections = [];
  window.addEventListener("unhandledrejection", onUnhandledRejection);
});

afterEach(() => {
  window.removeEventListener("unhandledrejection", onUnhandledRejection);
});

describe("CameraScanButton", () => {
  it("opens the camera overlay, calls onScan with the raw detected value, closes, and refocuses the scan input", async () => {
    const { stream, track } = mockStreamWithTrack();
    const getUserMedia = vi.fn(async () => stream);
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

    // Closing the overlay must release the camera hardware, not just stop the detection loop.
    expect(track.stop).toHaveBeenCalledTimes(1);

    const input = screen.getByLabelText("Scan a code") as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("shows a plain-language message and releases the camera when the detector fails to load (e.g. offline polyfill fetch failure)", async () => {
    const track = { stop: vi.fn(), kind: "video" } as unknown as MediaStreamTrack;
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    });

    startMock.mockRejectedValueOnce(new Error("Failed to load barcode detector"));

    const onScan = vi.fn();
    const user = userEvent.setup();
    render(
      <div>
        <input id="scanner-input" aria-label="Scan a code" />
        <CameraScanButton onScan={onScan} />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: /scan with camera/i }));

    await waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(screen.getByText(/camera scanning could not start/i)).toBeTruthy(),
    );
    // No provider-internal jargon leaks into the UI.
    expect(screen.queryByText(/Failed to load barcode detector/)).toBeNull();
    expect(onScan).not.toHaveBeenCalled();

    // The camera light must not stay on: the stream's track was released.
    expect(track.stop).toHaveBeenCalledTimes(1);

    // The rejection must have been caught by the component, never left unhandled.
    expect(unhandledRejections).toEqual([]);
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

  it("shows a plain-language no-camera message and does not crash when getUserMedia rejects with NotFoundError", async () => {
    const notFoundError = new DOMException("Requested device not found", "NotFoundError");
    const getUserMedia = vi.fn(async () => {
      throw notFoundError;
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

    await waitFor(() => expect(screen.getByText(/no camera is available/i)).toBeTruthy());
    expect(screen.queryByText(/NotFoundError/)).toBeNull();
    expect(onScan).not.toHaveBeenCalled();
    expect(unhandledRejections).toEqual([]);
  });

  it("shows a plain-language no-camera message when navigator.mediaDevices is undefined", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: undefined,
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

    await waitFor(() => expect(screen.getByText(/no camera is available/i)).toBeTruthy());
    expect(onScan).not.toHaveBeenCalled();
    expect(unhandledRejections).toEqual([]);
  });
});
