/**
 * CardIQ's supported cross-machine address is the Mac mini's Tailscale
 * MagicDNS name. Supabase's Cloudflare WAF rejects OAuth authorize URLs when
 * their `redirect_to` contains a raw Tailscale address, so requests arriving
 * through IPv4 CGNAT or Tailscale's IPv6 ULA range must be canonicalised before
 * the login page can start OAuth.
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

/** True for Tailscale's fd7a:115c:a1e0::/48 range or mapped CGNAT IPv4. */
export function isTailscaleIpv6Host(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized.startsWith("[fd7a:115c:a1e0:")) return true;

  const mapped = normalized.match(/^\[::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}\]$/);
  if (!mapped) return false;
  const firstTwoIpv4Octets = Number.parseInt(mapped[1], 16);
  return firstTwoIpv4Octets >= 0x6440 && firstTwoIpv4Octets <= 0x647f;
}

export function isRawTailscaleHost(hostname: string): boolean {
  return isTailscaleCgnatHost(hostname) || isTailscaleIpv6Host(hostname);
}

/** Extract a hostname from a Host or X-Forwarded-Host header value. */
export function hostnameFromAuthority(authority: string | null): string | null {
  const firstAuthority = authority?.split(",", 1)[0]?.trim();
  if (
    !firstAuthority ||
    firstAuthority.length > 255 ||
    /[@/\\?#\s\u0000-\u001f\u007f]/.test(firstAuthority)
  ) {
    return null;
  }

  try {
    const parsed = new URL(`http://${firstAuthority}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/") return null;
    return parsed.hostname;
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
  if (!isRawTailscaleHost(requestedHostname)) return null;

  const canonical = new URL(url.toString());
  canonical.hostname = CARDIQ_MAGICDNS_HOST;
  canonical.username = "";
  canonical.password = "";
  return canonical;
}
