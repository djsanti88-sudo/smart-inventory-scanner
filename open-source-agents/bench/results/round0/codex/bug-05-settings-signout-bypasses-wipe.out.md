# Defect

The Settings button bypasses the application's sign-out protocol. Unlike the Nav path, it neither awaits `prepareSignOut()` nor asks for confirmation when work remains, and it never calls `resetForSignOut()` before ending the auth session.

Concrete scenario: user A has an unsynced scan queue and tenant data in the Zustand store/local persistence, then signs out from Settings on a shared browser. The auth session ends immediately; queued work can be abandoned without warning, while A's in-memory/persisted tenant state remains available to the next session until some later code happens to replace it. Every sign-out entry point must use the same drain/confirm/reset flow rather than calling the low-level auth `signOut()` directly.
