export function register() {
  if (
    process.env.SCANBIN_LOCAL_DEMO === "1" &&
    globalThis.__SCANBIN_LOCAL_DEMO_EGRESS_GUARD__ !== 1
  ) {
    console.error("Local demo egress guard attestation failed: start through the local-demo launcher.");
    process.exit(1);
  }
}
