export function describeBlockedBrowserRequest(method, url) {
  const parsed = new URL(url);
  return { method, hostname: parsed.hostname, pathname: parsed.pathname };
}
