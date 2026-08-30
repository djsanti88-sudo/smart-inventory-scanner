"use client";

// LOCAL-DEV safety guardrail: when you run the app locally (npm run dev:prod) pointed at PRODUCTION
// Firestore (real cloud, not the emulator), show an unmissable red banner so test scans never silently
// write to real data. It is DEV-ONLY: on a real deployment (NODE_ENV === "production") it never renders,
// because in production using real Firebase IS the intended behavior. The safe `npm run dev` (mock) and
// `npm run dev:emulator` never trigger it. Env is read at render time so it is testable.
import { isCloudBackendEnabled } from "@/services/config/backend";

export function ProdFirebaseBanner() {
  const isDev = process.env.NODE_ENV !== "production"; // false on any real Vercel deployment
  const backend = isCloudBackendEnabled();
  const emulator = process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATOR === "1";
  const allowProd = process.env.NEXT_PUBLIC_FIREBASE_ALLOW_PROD === "1";

  // Only in LOCAL DEV, only when actually connected to real (non-emulator) Firebase.
  if (!isDev || !backend || emulator) return null;

  return (
    <div
      data-testid="prod-firebase-banner"
      role="alert"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-2 bg-red-700 px-4 py-2 text-center text-sm font-semibold text-white"
    >
      <span aria-hidden>⚠</span>
      <span>
        LIVE PRODUCTION FIREBASE (local dev) - every scan writes to the real cloud project.
        {allowProd ? " You opted in with npm run dev:prod." : " This was NOT a deliberate opt-in."}
      </span>
      <span className="opacity-90">Use npm run dev (mock) or npm run dev:emulator for testing.</span>
    </div>
  );
}
