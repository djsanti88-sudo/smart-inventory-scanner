"use client";

// Runtime safety guard: when the app is connected to PRODUCTION Firestore (real cloud, not the
// emulator), show an unmissable red banner on every protected page. Every scan in this mode writes to
// the real project, so it must never happen silently. The safe `npm run dev` (mock) and
// `npm run dev:emulator` never trigger this. Reaching production requires the deliberate
// `npm run dev:prod`, which also sets NEXT_PUBLIC_FIREBASE_ALLOW_PROD=1.
//
// NEXT_PUBLIC_* are inlined at build/serve time, so this evaluates per environment with no runtime cost.
const BACKEND = process.env.NEXT_PUBLIC_FIREBASE_BACKEND === "1";
const EMULATOR = process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATOR === "1";
const ALLOW_PROD = process.env.NEXT_PUBLIC_FIREBASE_ALLOW_PROD === "1";
const IS_PROD_FIREBASE = BACKEND && !EMULATOR;

export function ProdFirebaseBanner() {
  if (!IS_PROD_FIREBASE) return null;
  return (
    <div
      data-testid="prod-firebase-banner"
      role="alert"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-2 bg-red-700 px-4 py-2 text-center text-sm font-semibold text-white"
    >
      <span aria-hidden>⚠</span>
      <span>
        LIVE PRODUCTION FIREBASE - every scan writes to the real cloud project.
        {ALLOW_PROD ? " You opted in with npm run dev:prod." : " This was NOT a deliberate opt-in."}
      </span>
      <span className="opacity-90">Use npm run dev (mock) or npm run dev:emulator for testing.</span>
    </div>
  );
}
