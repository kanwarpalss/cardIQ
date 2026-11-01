import { describe, expect, it, vi } from "vitest";
import { parseTxnEmailWithFallback } from "../parsers/registry";

const transport = vi.hoisted(() => ({ source: Buffer.alloc(0) }));
const id = "1a19582613fb0173";
const receivedAt = new Date("2026-11-01T05:08:27Z");
vi.mock("imapflow", () => ({
  ImapFlow: class {
    async connect() {}
    async getMailboxLock() { return { release() {} }; }
    async search() { return [7]; }
    async *fetch() { yield { uid: 7, emailId: BigInt(`0x${id}`).toString() }; }
    async fetchOne() { return { source: transport.source, internalDate: receivedAt }; }
    async logout() {}
  },
}));
import { ImapSource } from "./mail-source";

describe("HSBC HTML alerts through real MIME decoding and transaction parsing", () => {
  it.each([
    ["INR 214.98", "PYU*SNABBIT", { amount_inr: 214.98 }],
    ["USD 1.00", "FACEBK *PAYMENT", { amount_inr: 0, currency: "USD", amount_original: 1 }],
  ] as const)("captures %s without using the available INR balance", async (money, merchant, expected) => {
    // Only transport is mocked. This exercises the actual HTML-only email
    // decoding/normalization seam used by the running Gmail sync.
    transport.source = Buffer.from([
      "From: HSBC <hsbc@hsbc.bank.in>",
      "To: fixture@example.com",
      "Subject: Credit Card Transaction Alert",
      "Date: Sun, 1 Nov 2026 05:08:27 +0000",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      `<p>Your HSBC Credit Card xx4502 was used for a transaction of ${money} at ${merchant} on 01/11/26.</p><p>Available limit: INR 66082.02<br>Amount due: INR 33917.98</p>`,
    ].join("\r\n"), "utf8");
    const source = new ImapSource("fixture@example.com", "unused");
    try {
      expect(await source.search("from:hsbc.bank.in")).toEqual([id]);
      const message = await source.fetchMessage(id);
      expect(message.internalDate).toBe(receivedAt.getTime());
      expect(message.id).toBe(id);
      const parsed = parseTxnEmailWithFallback(message.from, message.subject, message.textBody, message.snippet, new Set(["4502"]));
      expect(parsed).toMatchObject({ ...expected, card_last4: "4502", merchant_raw: merchant, txn_type: "debit" });
      expect(parsed?.low_confidence).toBeUndefined();
    } finally {
      await source.close();
    }
  });
});
