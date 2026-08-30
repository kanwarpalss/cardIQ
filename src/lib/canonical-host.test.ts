import { describe, expect, it } from "vitest";
import {
  CARDIQ_MAGICDNS_HOST,
  canonicalCardiqUrl,
  hostnameFromAuthority,
  isRawTailscaleHost,
  isTailscaleCgnatHost,
  isTailscaleIpv6Host,
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
    "100.64.0.1:3128",
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
    expect(hostnameFromAuthority("100.81.29.11:3128")).toBe("100.81.29.11");
  });

  it("uses the first value in a forwarded-host chain", () => {
    expect(
      hostnameFromAuthority("100.81.29.11:3128, internal-proxy:3000")
    ).toBe("100.81.29.11");
  });

  it.each([null, "", "not a host:bad-port"])(
    "rejects an absent or malformed authority: %s",
    (authority) => {
      expect(hostnameFromAuthority(authority)).toBeNull();
    }
  );

  it.each([
    "user@100.81.29.11:3128",
    "user:pass@100.81.29.11:3128",
    "100.81.29.11:3128@safe.example",
    "100.81.29.11:65536",
    "[::1",
    "100.81.29.11\u0000:3128",
    "x".repeat(10_000),
  ])("rejects a deceptive authority: %j", (authority) => {
    expect(hostnameFromAuthority(authority)).toBeNull();
  });

  it("normalizes alternate IPv4 notation before classifying it", () => {
    const hostname = hostnameFromAuthority("0x64.0x51.0x1d.0xb:3128");
    expect(hostname).toBe("100.81.29.11");
    expect(isTailscaleCgnatHost(hostname!)).toBe(true);
  });

  it("honors the original first forwarded host", () => {
    expect(
      hostnameFromAuthority("safe.example, 100.81.29.11:3128")
    ).toBe("safe.example");
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
      "http://100.81.29.11:3128/login?error=connection&next=%2Forders#retry"
    );

    const canonical = canonicalCardiqUrl(original);

    expect(canonical?.toString()).toBe(
      `http://${CARDIQ_MAGICDNS_HOST}:3128/login?error=connection&next=%2Forders#retry`
    );
    expect(original.hostname).toBe("100.81.29.11");
  });

  it.each([
    "http://localhost:3128/login",
    `http://${CARDIQ_MAGICDNS_HOST}:3128/login`,
    "https://card-iq.vercel.app/login",
    "http://100.64.example.com:3128/login",
    "http://100.64.0.1.example.com:3128/login",
    "http://100.64.0.1@safe.example:3128/login",
    "http://localhost:3128/login?next=http%3A%2F%2F100.64.0.1%3A3128",
  ])("does not redirect a safe origin: %s", (rawUrl) => {
    expect(canonicalCardiqUrl(new URL(rawUrl))).toBeNull();
  });

  it.each([
    "http://[fd7a:115c:a1e0::1]:3128/login",
    "http://[::ffff:100.81.29.11]:3128/login",
  ])("canonicalizes a raw Tailscale IPv6 origin: %s", (rawUrl) => {
    expect(canonicalCardiqUrl(new URL(rawUrl))?.hostname).toBe(
      CARDIQ_MAGICDNS_HOST
    );
  });

  it("never carries URL credentials into the canonical redirect", () => {
    const canonical = canonicalCardiqUrl(
      new URL("http://secret:token@100.81.29.11:3128/login")
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
      new URL("http://localhost:3128/login?next=%2Forders"),
      "100.81.29.11"
    );

    expect(canonical?.toString()).toBe(
      `http://${CARDIQ_MAGICDNS_HOST}:3128/login?next=%2Forders`
    );
  });
});
