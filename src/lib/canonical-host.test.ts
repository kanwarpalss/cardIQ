import { describe, expect, it } from "vitest";
import {
  CARDIQ_MAGICDNS_HOST,
  canonicalCardiqUrl,
  hostnameFromAuthority,
  isMiniHostAlias,
  isRawTailscaleHost,
  isTailscaleCgnatHost,
  isTailscaleIpv6Host,
  originFromAuthority,
  requestOrigin,
} from "./canonical-host";

describe("isTailscaleCgnatHost", () => {
  it.each([
    "100.64.0.0",
    "100.64.255.255",
    "100.65.0.0",
    "100.81.29.11",
    "100.126.255.255",
    "100.127.255.255",
  ])("accepts Tailscale CGNAT boundary host %s", (hostname) => {
    expect(isTailscaleCgnatHost(hostname)).toBe(true);
  });

  it.each([
    "100.63.255.255",
    "100.128.0.0",
    "99.81.29.11",
    "101.81.29.11",
    "100.81.29",
    "100.81.29.11.example.com",
    "100.64.example.com",
    "100.64.256.1",
    "100.64.1.256",
    "100.64.-1.1",
    "100.64.1.-1",
    "100.64.01.1",
    "100.64.1.001",
    "100.64..1",
    "100.64.NaN.1",
    "100.64.１.1",
    "100.64.0.1:3901",
    "fd7a:115c:a1e0::1",
    "::ffff:100.64.0.1",
    "mac-mini.tail8f99cb.ts.net",
    "localhost",
    "",
  ])("rejects non-Tailscale host %s", (hostname) => {
    expect(isTailscaleCgnatHost(hostname)).toBe(false);
  });
});

describe("hostnameFromAuthority", () => {
  it("extracts a raw Tailscale hostname from a Host header with a port", () => {
    expect(hostnameFromAuthority("100.81.29.11:3901")).toBe("100.81.29.11");
  });

  it("uses the first value in a forwarded-host chain", () => {
    expect(
      hostnameFromAuthority("100.81.29.11:3901, internal-proxy:3000")
    ).toBe("100.81.29.11");
  });

  it.each([null, "", "not a host:bad-port"])(
    "rejects an absent or malformed authority: %s",
    (authority) => {
      expect(hostnameFromAuthority(authority)).toBeNull();
    }
  );

  it.each([
    "user@100.81.29.11:3901",
    "user:pass@100.81.29.11:3901",
    "100.81.29.11:3901@safe.example",
    "100.81.29.11:65536",
    "[::1",
    "100.81.29.11\u0000:3901",
    "x".repeat(10_000),
  ])("rejects a deceptive authority: %j", (authority) => {
    expect(hostnameFromAuthority(authority)).toBeNull();
  });

  it("normalizes alternate IPv4 notation before classifying it", () => {
    const hostname = hostnameFromAuthority("0x64.0x51.0x1d.0xb:3901");
    expect(hostname).toBe("100.81.29.11");
    expect(isTailscaleCgnatHost(hostname!)).toBe(true);
  });

  it("honors the original first forwarded host", () => {
    expect(
      hostnameFromAuthority("safe.example, 100.81.29.11:3901")
    ).toBe("safe.example");
  });
});

describe("originFromAuthority", () => {
  it("builds a full origin including port from a Host header", () => {
    expect(originFromAuthority("mac-mini.tail8f99cb.ts.net:3901", "http")).toBe(
      "http://mac-mini.tail8f99cb.ts.net:3901"
    );
  });

  it("uses the given protocol, not a hardcoded one", () => {
    expect(originFromAuthority("card-iq.vercel.app", "https")).toBe(
      "https://card-iq.vercel.app"
    );
  });

  it.each([null, "", "user@evil.example:3901"])(
    "rejects an absent or deceptive authority: %j",
    (authority) => {
      expect(originFromAuthority(authority, "http")).toBeNull();
    }
  );
});

describe("requestOrigin", () => {
  // The exact bug reproduced 2026-09-03: /auth/callback used request.url's
  // own origin, which under `next start` with no reverse proxy in front of it
  // reflected the server's bind host (localhost) instead of whichever host
  // the browser actually used to sign in — stranding every OAuth return on a
  // dead localhost:3901 regardless of where the login started.
  it("prefers the real browser host over a misleading fallback URL", () => {
    const headers = new Headers({ host: "mac-mini.tail8f99cb.ts.net:3901" });
    const fallbackUrl = new URL("http://localhost:3901/auth/callback");

    expect(requestOrigin(headers, fallbackUrl)).toBe(
      `http://${CARDIQ_MAGICDNS_HOST}:3901`
    );
  });

  it("prefers x-forwarded-host over a plain Host header", () => {
    const headers = new Headers({
      host: "internal-proxy:3000",
      "x-forwarded-host": "card-iq.vercel.app",
      "x-forwarded-proto": "https",
    });
    const fallbackUrl = new URL("http://localhost:3901/auth/callback");

    expect(requestOrigin(headers, fallbackUrl)).toBe("https://card-iq.vercel.app");
  });

  it("falls back to the given URL when no usable header is present", () => {
    const headers = new Headers();
    const fallbackUrl = new URL("http://localhost:3901/auth/callback");

    expect(requestOrigin(headers, fallbackUrl)).toBe("http://localhost:3901");
  });

  it("takes the protocol from x-forwarded-proto, not the fallback URL", () => {
    const headers = new Headers({
      host: "card-iq.vercel.app",
      "x-forwarded-proto": "https",
    });
    const fallbackUrl = new URL("http://localhost:3901/auth/callback");

    expect(requestOrigin(headers, fallbackUrl)).toBe("https://card-iq.vercel.app");
  });
});

describe("raw Tailscale IPv6 detection", () => {
  it.each([
    "[fd7a:115c:a1e0::1]",
    "[fd7a:115c:a1e0:abcd::1]",
    "[::ffff:6440:1]",
    "[::ffff:647f:ffff]",
  ])("accepts Tailscale IPv6 host %s", (hostname) => {
    expect(isTailscaleIpv6Host(hostname)).toBe(true);
    expect(isRawTailscaleHost(hostname)).toBe(true);
  });

  it.each([
    "[fd7a:115c:a1df::1]",
    "[fd7a:115c:a1e1::1]",
    "[::ffff:643f:ffff]",
    "[::ffff:6480:1]",
    "[2001:db8::1]",
  ])("rejects non-Tailscale IPv6 host %s", (hostname) => {
    expect(isTailscaleIpv6Host(hostname)).toBe(false);
  });
});

describe("canonicalCardiqUrl", () => {
  it("replaces only the poisoned host and preserves the complete destination", () => {
    const original = new URL(
      "http://100.81.29.11:3901/login?error=connection&next=%2Forders#retry"
    );

    const canonical = canonicalCardiqUrl(original);

    expect(canonical?.toString()).toBe(
      `http://${CARDIQ_MAGICDNS_HOST}:3901/login?error=connection&next=%2Forders#retry`
    );
    expect(original.hostname).toBe("100.81.29.11");
  });

  it.each([
    "http://localhost:3901/login",
    `http://${CARDIQ_MAGICDNS_HOST}:3901/login`,
    "https://card-iq.vercel.app/login",
    "http://100.64.example.com:3901/login",
    "http://100.64.0.1.example.com:3901/login",
    "http://100.64.0.1@safe.example:3901/login",
    "http://localhost:3901/login?next=http%3A%2F%2F100.64.0.1%3A3128",
  ])("does not redirect a safe origin: %s", (rawUrl) => {
    expect(canonicalCardiqUrl(new URL(rawUrl))).toBeNull();
  });

  it.each([
    "http://[fd7a:115c:a1e0::1]:3901/login",
    "http://[::ffff:100.81.29.11]:3901/login",
  ])("canonicalizes a raw Tailscale IPv6 origin: %s", (rawUrl) => {
    expect(canonicalCardiqUrl(new URL(rawUrl))?.hostname).toBe(
      CARDIQ_MAGICDNS_HOST
    );
  });

  it("never carries URL credentials into the canonical redirect", () => {
    const canonical = canonicalCardiqUrl(
      new URL("http://secret:token@100.81.29.11:3901/login")
    );
    expect(canonical?.username).toBe("");
    expect(canonical?.password).toBe("");
  });

  it("preserves encoded URL details without mutating the original object", () => {
    const raw =
      "https://100.127.255.255:8443/a%2Fb//c?x=one%20two&x=%2F&empty=#part%2Ftwo";
    const original = new URL(raw);

    const canonical = canonicalCardiqUrl(original);

    expect(canonical?.toString()).toBe(
      `https://${CARDIQ_MAGICDNS_HOST}:8443/a%2Fb//c?x=one%20two&x=%2F&empty=#part%2Ftwo`
    );
    expect(canonical).not.toBe(original);
    expect(original.toString()).toBe(raw);
  });

  it("can canonicalise the browser host when Next.js normalises nextUrl", () => {
    const canonical = canonicalCardiqUrl(
      new URL("http://localhost:3901/login?next=%2Forders"),
      "100.81.29.11"
    );

    expect(canonical?.toString()).toBe(
      `http://${CARDIQ_MAGICDNS_HOST}:3901/login?next=%2Forders`
    );
  });

  describe("non-canonical names that still reach the Mac mini", () => {
    // These all serve CardIQ fine. They matter because window.location.origin
    // becomes the OAuth redirect_to, and Supabase matches redirect URLs as
    // literal strings — an unrecognised one silently falls back to the Site
    // URL instead of erroring, stranding the login on localhost.
    it.each(["mac-mini", "mac-mini.local", "MAC-MINI", "Mac-Mini.Local"])(
      "canonicalises %s to the one FQDN",
      (host) => {
        const canonical = canonicalCardiqUrl(
          new URL(`http://${host}:3901/login?next=%2Forders`)
        );

        expect(canonical?.toString()).toBe(
          `http://${CARDIQ_MAGICDNS_HOST}:3901/login?next=%2Forders`
        );
      }
    );

    it("leaves the canonical host alone so it cannot redirect to itself", () => {
      expect(
        canonicalCardiqUrl(new URL(`http://${CARDIQ_MAGICDNS_HOST}:3901/login`))
      ).toBeNull();
      expect(isMiniHostAlias(CARDIQ_MAGICDNS_HOST)).toBe(false);
    });

    it.each(["localhost", "127.0.0.1", "cardiq.vercel.app"])(
      "leaves %s alone so local dev and production are untouched",
      (host) => {
        expect(canonicalCardiqUrl(new URL(`http://${host}:3901/login`))).toBeNull();
      }
    );

    it.each([
      "evil-mac-mini.com",
      "mac-mini.evil.com",
      "mac-mini.local.evil.com",
      "notmac-mini",
      "mac-mini-2",
    ])("does not treat lookalike host %s as the Mac mini", (host) => {
      expect(isMiniHostAlias(host)).toBe(false);
      expect(canonicalCardiqUrl(new URL(`http://${host}/login`))).toBeNull();
    });

    it("canonicalises the alias when Next.js has normalised nextUrl to localhost", () => {
      const canonical = canonicalCardiqUrl(
        new URL("http://localhost:3901/login"),
        "mac-mini"
      );

      expect(canonical?.toString()).toBe(
        `http://${CARDIQ_MAGICDNS_HOST}:3901/login`
      );
    });
  });
});
