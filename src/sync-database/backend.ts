// Which durable backend the app is wired to, in one place.
//
// `NEXT_PUBLIC_FIREBASE_BACKEND === "1"` was compared literally in six unrelated files - the scan
// store's backend selection, the history page, the session detail page, the production banner, the
// selected-business helper and the role/persistence resolver. Each one re-derived the same runtime
// fact, and the name of the provider ("FIREBASE") was spelled into layers that only care *whether a
// cloud backend exists at all*, not which vendor supplies it.
//
// Reads stay at CALL time, never module load: several suites set and delete this variable between
// test cases and depend on the next call observing the change. (Next.js still inlines the literal
// at build time for client bundles - the literal simply lives here now instead of in six files.)
//
// The environment variable keeps its current name on purpose: renaming it is a deployment change
// (Vercel project env, .env files, docs) and belongs to the infrastructure migration, not to this
// cleanup. Application code should stop naming the vendor; the variable can follow later.

/**
 * True when the app is running against the cloud backend (today: Firebase/Firestore, cloud or
 * emulator) rather than the local in-memory mock. This is the same signal the scan store uses to
 * choose its SyncTarget implementation.
 */
export function isCloudBackendEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FIREBASE_BACKEND === "1";
}
