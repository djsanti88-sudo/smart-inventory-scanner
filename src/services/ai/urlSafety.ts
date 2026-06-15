// SSRF guard for any URL the SERVER fetches from untrusted sources (AI citations, search results,
// fallback discovery). Blocks loopback/private/link-local/metadata hosts, non-http(s) protocols, and
// internal hostnames. Pure + unit-testable. NOTE: this is a hostname/IP-literal guard, not full DNS-
// rebinding protection (we fetch public product pages); pair with timeouts + size caps at the fetcher.

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isPrivateOrReservedIpv4(host: string): boolean {
  const p = host.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed -> reject
  const [a, b] = p;
  if (a === 0 || a === 127) return true; // this-host / loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateOrReservedIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")) return true; // link-local / ULA
  if (h.startsWith("::ffff:")) return true; // IPv4-mapped -> treat as reserved (conservative)
  return false;
}

/** True only for a safe, public, http(s) URL the server may fetch. */
export function isSafePublicUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL((raw ?? "").trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal") return false;
  if (host.includes(":")) return !isPrivateOrReservedIpv6(host); // IPv6 literal (Node keeps brackets)
  if (!host.includes(".")) return false; // bare hostname (no TLD) -> internal
  if (isIpv4(host)) return !isPrivateOrReservedIpv4(host);
  return true; // a normal public domain
}

/** Keep only safe public URLs, deduped, capped. */
export function filterSafeUrls(urls: string[], cap = 6): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (!isSafePublicUrl(u)) continue;
    const key = u.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= cap) break;
  }
  return out;
}
