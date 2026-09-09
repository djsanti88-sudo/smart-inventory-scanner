"use client";

import { useEffect, useRef, useState } from "react";
import type { ScanEvent } from "@/types";
import { createCameraScanner } from "@/scanning/camera/cameraScanner";

// Camera scan entry point. Opens an overlay with a live <video> preview, wires the pure
// createCameraScanner detection service to it, and on detect calls the SAME onScan(raw) callback
// the keyboard/hardware-scanner path uses (ScannerInput) - camera detections go through one shared
// scan path, never a separate one. Multi-trade copy: talks about "products", not any one trade.

export interface CameraScanButtonProps {
  onScan: (raw: string) => ScanEvent | null;
  // Element id to refocus after the overlay closes (defaults to the app's scan input id).
  refocusTargetId?: string;
}

type CameraState = "idle" | "opening" | "streaming" | "denied" | "unavailable" | "start-failed";

export function CameraScanButton({ onScan, refocusTargetId = "scanner-input" }: CameraScanButtonProps) {
  const [state, setState] = useState<CameraState>("idle");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scannerRef = useRef<ReturnType<typeof createCameraScanner> | null>(null);

  function refocusScanInput() {
    const el = document.getElementById(refocusTargetId);
    if (el instanceof HTMLElement) el.focus();
  }

  function stopCamera() {
    scannerRef.current?.stop();
    scannerRef.current = null;
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
  }

  function closeOverlay() {
    stopCamera();
    setState("idle");
    refocusScanInput();
  }

  async function openOverlay() {
    setState("opening");
    try {
      const mediaDevices = navigator.mediaDevices;
      if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") {
        setState("unavailable");
        return;
      }
      const stream = await mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      setState("streaming");
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setState("denied");
      } else {
        setState("unavailable");
      }
    }
  }

  // Once the overlay is streaming and the <video> element is mounted, attach the stream and start
  // the detection loop.
  useEffect(() => {
    if (state !== "streaming") return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;

    video.srcObject = stream;
    // Some environments (jsdom, certain browsers) either don't implement play() or return a
    // non-promise; guard both so a play() rejection/absence never blocks starting the scanner.
    try {
      void video.play()?.catch(() => {});
    } catch {
      // ignore - autoPlay attribute covers real browsers
    }

    const scanner = createCameraScanner(video, (raw) => {
      onScan(raw);
      closeOverlay();
    });
    scannerRef.current = scanner;
    let cancelled = false;
    scanner.start().catch(() => {
      if (cancelled) return;
      // The detector failed to load (e.g. offline, polyfill chunk 404). Release the camera so the
      // hardware light does not stay on, then show a plain-language error state. The scanner's own
      // stop() is safe to call even though start() never finished.
      stopCamera();
      setState("start-failed");
    });

    return () => {
      cancelled = true;
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Ensure the camera is released if the component unmounts while the overlay is open.
  useEffect(() => {
    return () => stopCamera();
  }, []);

  const isOpen = state !== "idle";

  return (
    <div>
      <button
        type="button"
        data-testid="camera-scan-button"
        onClick={() => void openOverlay()}
        className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
      >
        Scan with camera
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Scan with camera"
          data-testid="camera-scan-overlay"
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/80 p-4"
        >
          <div className="flex w-full max-w-lg flex-col items-center gap-3 rounded-lg bg-white p-4">
            {state === "opening" && <p className="text-base text-zinc-700">Opening camera...</p>}

            {state === "denied" && (
              <p className="text-base text-red-700" data-testid="camera-denied-message">
                Camera access was denied. Allow camera access in your browser settings to scan with the
                camera, or use the keyboard scanner input instead.
              </p>
            )}

            {state === "unavailable" && (
              <p className="text-base text-red-700" data-testid="camera-unavailable-message">
                No camera is available on this device. Use the keyboard scanner input instead.
              </p>
            )}

            {state === "start-failed" && (
              <p className="text-base text-red-700" data-testid="camera-start-failed-message">
                Camera scanning could not start. You can still scan with a hardware scanner or type
                the code.
              </p>
            )}

            {state === "streaming" && (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                ref={videoRef}
                data-testid="camera-scan-video"
                autoPlay
                playsInline
                muted
                className="max-h-[60vh] w-full rounded-md bg-black"
              />
            )}

            <button
              type="button"
              data-testid="camera-scan-cancel"
              onClick={closeOverlay}
              className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
