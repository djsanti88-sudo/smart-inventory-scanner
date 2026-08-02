export function register() {
  const marker = (globalThis as typeof globalThis & {
    __SCANBIN_LOCAL_DEMO_EGRESS_GUARD__?: number;
  }).__SCANBIN_LOCAL_DEMO_EGRESS_GUARD__;
  if (
    process.env.SCANBIN_LOCAL_DEMO === "1" &&
    marker !== 1
  ) {
    throw new Error("Local demo egress guard attestation failed: start through the local-demo launcher.");
  }
}
