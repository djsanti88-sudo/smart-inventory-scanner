"use client";

import { useEffect } from "react";
import { postTelemetry } from "@/shared/telemetry/telemetry";

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    // Do not transmit an exception message or stack: both can contain scan/customer data.
    void postTelemetry("client_error", error.digest ? `digest:${error.digest}` : "unhandled_client_error");
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main>
          <h1>Something went wrong</h1>
          <p>Your scans are still saved on this device. Try again to continue.</p>
          <button type="button" onClick={unstable_retry}>Try again</button>
        </main>
      </body>
    </html>
  );
}
