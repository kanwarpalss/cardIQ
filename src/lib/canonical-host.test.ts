import { describe, expect, it } from "vitest";
import {
  CARDIQ_MAGICDNS_HOST,
  canonicalCardiqUrl,
  hostnameFromAuthority,
  isTailscaleCgnatHost,
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
    "http://[::ffff:6440:1]:3128/login",
    "http://100.64.0.1.example.com:3128/login",
    "http://100.64.0.1@safe.example:3128/login",
    "http://localhost:3128/login?next=http%3A%2F%2F100.64.0.1%3A3128",
  ])("does not redirect a safe origin: %s", (rawUrl) => {
    expect(canonicalCardiqUrl(new URL(rawUrl))).toBeNull();
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
