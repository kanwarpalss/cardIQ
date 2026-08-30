/**
 * CardIQ's supported cross-machine address is the Mac mini's Tailscale
 * MagicDNS name. Supabase's Cloudflare WAF rejects OAuth authorize URLs when
 * their `redirect_to` contains a raw Tailscale CGNAT address (100.64.0.0/10),
 * so requests arriving through one of those addresses must be canonicalised
 * before the login page can start OAuth.
 */
export const CARDIQ_MAGICDNS_HOST = "mac-mini.tail8f99cb.ts.net";

/** True only for dotted-decimal IPv4 hosts inside 100.64.0.0/10. */
export function isTailscaleCgnatHost(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4) return false;

  const values = octets.map((octet) => {
    if (!/^(0|[1-9]\d{0,2})$/.test(octet)) return Number.NaN;
    const value = Number(octet);
    return value <= 255 ? value : Number.NaN;
  });

  return (
    values.every(Number.isFinite) &&
    values[0] === 100 &&
    values[1] >= 64 &&
    values[1] <= 127
  );
}

/** Extract a hostname from a Host or X-Forwarded-Host header value. */
export function hostnameFromAuthority(authority: string | null): string | null {
  const firstAuthority = authority?.split(",", 1)[0]?.trim();
  if (!firstAuthority) return null;

  try {
    return new URL(`http://${firstAuthority}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Return the safe MagicDNS equivalent of a raw Tailscale URL. All other URLs
 * return null so callers can continue without redirecting.
 */
export function canonicalCardiqUrl(
  url: URL,
  requestedHostname = url.hostname
): URL | null {
  if (!isTailscaleCgnatHost(requestedHostname)) return null;

  const canonical = new URL(url.toString());
  canonical.hostname = CARDIQ_MAGICDNS_HOST;
  return canonical;
}
