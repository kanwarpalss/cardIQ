import { describe, expect, it, vi } from "vitest";
import { simpleParser } from "mailparser";
import { parseTxnEmailWithFallback } from "../parsers/registry";

const messageId = "1a178bdfcc61dcce";
const receivedAt = new Date("2026-10-26T15:04:39Z");
const subject = "Transaction alert on Axis Bank Credit Card";
const body =
  "26-10-2026 Dear Customer, Here's the summary of your Axis Bank Credit Card transaction: " +
  "Transaction amount (INR):\xa0 INR\xa0 114580 Merchant name: INDIGO AIRL " +
  "Axis Bank Credit Card No.: XX4455 Date and time: 26-10-2026 20:34:36 IST " +
  "Available limit (INR): 330549.52 Total credit limit (INR): 1217000";

// Recreate the stored alert's undecodable separator bytes in a MIME fixture.
// Mock only the IMAP transport: MIME decoding, normalization, and both parser
// paths below are real, so skipping normalization must break this test.
function mime(rawBody: string, rawSubject = subject): Buffer {
  return Buffer.from([
    "From: Axis Bank Alerts <alerts@axis.bank.in>",
    `Subject: ${rawSubject}`,
    "Date: Mon, 26 Oct 2026 20:34:38 +0530",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    rawBody,
  ].join("\r\n"), "latin1");
}

const transport = vi.hoisted((): { source: Buffer } => ({ source: Buffer.alloc(0) }));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    async connect() {}
    async getMailboxLock() { return { release() {} }; }
    async search() { return [7]; }
    async *fetch() {
      yield { uid: 7, emailId: BigInt("0x1a178bdfcc61dcce").toString() };
    }
    async fetchOne() { return { source: transport.source, internalDate: receivedAt }; }
    async logout() {}
  },
}));

import { ImapSource } from "./mail-source";

async function ingest(rawBody: string, rawSubject = subject) {
  transport.source = mime(rawBody, rawSubject);
  const source = new ImapSource("fixture@example.com", "unused");
  try {
    expect(await source.search("fixture")).toEqual([messageId]);
    const message = await source.fetchMessage(messageId);
    const parsed = parseTxnEmailWithFallback(
      message.from, message.subject, message.textBody, message.snippet, new Set(["4455"]),
    );
    return { message, parsed };
  } finally {
    await source.close();
  }
}

describe("Axis IndiGo alert through IMAP decoding and transaction parsing", () => {
  it("recovers the real 114580 charge instead of silently losing a seen email", async () => {
    const decoded = await simpleParser(mime(body));
    expect(decoded.text).toContain("(INR):\ufffd INR\ufffd 114580");
    const { message, parsed } = await ingest(body);
    expect(message.textBody).not.toContain("\ufffd");
    expect(message.internalDate).toBe(receivedAt.getTime());
    expect(parsed).toMatchObject({
      amount_inr: 114580, card_last4: "4455", merchant_raw: "INDIGO AIRL", txn_type: "debit",
    });
    expect(parsed?.low_confidence).toBeUndefined();
  });

  it.each(["", "0", "."])("never uses the credit limit when the amount is %j", async (amount) => {
    expect((await ingest(body.replace("114580", amount))).parsed).toBeNull();
  });

  it("keeps foreign spend separate from the available INR limit", async () => {
    const { parsed } = await ingest(body.replace("(INR):\xa0 INR\xa0 114580", "(USD):\xa0 USD\xa0 114.58"));
    expect(parsed).toMatchObject({ amount_inr: 0, currency: "USD", amount_original: 114.58 });
  });

  it("does not turn a declined attempt into a charge", async () => {
    const { parsed } = await ingest(
      "Transaction attempt for INR\xa0 5107.25 on your Axis Bank Credit Card no. XX4455 has been declined.",
      "Transaction declined for Transaction alert on Axis Bank Credit Card no. XX4455",
    );
    expect(parsed).toBeNull();
  });
});
