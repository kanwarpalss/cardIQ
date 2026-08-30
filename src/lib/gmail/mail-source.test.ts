import { describe, it, expect } from "vitest";
import { toCanonicalId, isPdfAttachment, pickMailSource, GmailApiSource, ImapSource } from "./mail-source";

describe("toCanonicalId — decimal emailId to hex gmail_message_id", () => {
  // The spike's proven conversion (scripts/imap-spike.ts): Gmail's REST API
  // renders X-GM-MSGID in hex, IMAP's emailId reports the same value decimal.
  // Get this wrong and the whole migration either re-downloads years of mail
  // or silently skips everything (Invariant #3).

  it("matches a known Gmail message id pair (from the live spike)", () => {
    // 0x18f2e3a1b4c5d6 as decimal, and back.
    const hex = "18f2e3a1b4c5d6";
    const decimal = BigInt(`0x${hex}`).toString(10);
    expect(toCanonicalId(decimal)).toBe(hex);
  });

  it("handles zero", () => {
    expect(toCanonicalId(0)).toBe("0");
    expect(toCanonicalId("0")).toBe("0");
  });

  it("handles a value whose hex form has a leading zero digit stripped by BigInt (no fixed width assumed)", () => {
    // 10 in decimal is "a" in hex, not "0a" — canonical id must not be
    // zero-padded, since that's what's already stored in gmail_message_id.
    expect(toCanonicalId(10)).toBe("a");
  });

  it("round-trips the max safe 64-bit unsigned value Gmail could plausibly emit", () => {
    const max64 = 18446744073709551615n; // 2^64 - 1
    const hex = toCanonicalId(max64);
    expect(BigInt(`0x${hex}`)).toBe(max64);
  });

  it("accepts number, string, and bigint forms identically", () => {
    expect(toCanonicalId(255)).toBe(toCanonicalId("255"));
    expect(toCanonicalId("255")).toBe(toCanonicalId(255n));
  });

  it("throws on a non-numeric string rather than silently producing a wrong id", () => {
    expect(() => toCanonicalId("not-a-number")).toThrow();
  });
});

describe("isPdfAttachment — PDF-only attachment filter", () => {
  it("accepts application/pdf content type regardless of filename", () => {
    expect(isPdfAttachment({ contentType: "application/pdf", filename: "noext" })).toBe(true);
  });

  it("accepts a .pdf filename even when IKEA mislabels the content type as octet-stream", () => {
    expect(isPdfAttachment({ contentType: "application/octet-stream", filename: "230567312_0.pdf" })).toBe(true);
  });

  it("is case-insensitive on the extension", () => {
    expect(isPdfAttachment({ filename: "Invoice.PDF" })).toBe(true);
  });

  it("rejects a non-PDF attachment", () => {
    expect(isPdfAttachment({ contentType: "image/png", filename: "logo.png" })).toBe(false);
  });

  it("rejects a missing filename and content type", () => {
    expect(isPdfAttachment({})).toBe(false);
  });

  it("rejects a filename that merely contains 'pdf' mid-string", () => {
    expect(isPdfAttachment({ filename: "pdfreport.docx" })).toBe(false);
  });
});

describe("pickMailSource — IMAP wins whenever an app password is on file", () => {
  it("picks ImapSource when both imapUser and imapPass are present, even alongside an OAuth token", () => {
    const src = pickMailSource({
      imapUser: "kp@gmail.com",
      imapPass: "app-password",
      oauthRefreshToken: "refresh-token",
    });
    expect(src).toBeInstanceOf(ImapSource);
  });

  it("falls back to GmailApiSource when only an OAuth token is present", () => {
    const src = pickMailSource({ oauthRefreshToken: "refresh-token" });
    expect(src).toBeInstanceOf(GmailApiSource);
  });

  it("does not pick IMAP with only a username and no password", () => {
    const src = pickMailSource({ imapUser: "kp@gmail.com", oauthRefreshToken: "refresh-token" });
    expect(src).toBeInstanceOf(GmailApiSource);
  });

  it("does not pick IMAP with only a password and no username", () => {
    const src = pickMailSource({ imapPass: "app-password", oauthRefreshToken: "refresh-token" });
    expect(src).toBeInstanceOf(GmailApiSource);
  });

  it("throws no_gmail_credential when nothing is configured", () => {
    expect(() => pickMailSource({})).toThrow(/no_gmail_credential/);
  });
});

describe("ImapSource.fetchMessage — id must come from a prior search()", () => {
  it("throws a clear error for an id search() never returned", async () => {
    const src = new ImapSource("kp@gmail.com", "app-password");
    await expect(src.fetchMessage("deadbeef")).rejects.toThrow(/was not returned by a prior search/);
  });
});
