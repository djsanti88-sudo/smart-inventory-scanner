import "server-only";

export function isLocalDemo(): boolean {
  return process.env.SCANBIN_LOCAL_DEMO === "1";
}
