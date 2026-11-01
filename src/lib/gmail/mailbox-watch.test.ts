import { describe, it, expect, vi } from "vitest";
import { runMailboxWatch, MAX_MAILBOX_FETCH } from "./mailbox-watch";
import type { MailSource, NormalizedMessage } from "./mail-source";

const banks = ["hsbc.bank.in"];
const known = new Set(["4502"]);

const message = (id: string, from: string): NormalizedMessage => ({
  id,
  internalDate: 1793000000000,
  subject: "Card update",
  from,
  dateHeader: null,
  textBody: "Your HSBC Credit Card xx4502 was used at SHOP.",
  htmlBody: "",
  snippet: "",
  attachments: [],
});

function source(overrides: Partial<MailSource> = {}): MailSource {
  return {
    search: vi.fn(async () => ["a"]),
    fetchMessage: vi.fn(async (id: string) => message(id, "hsbc@alerts.hsbcindia.com")),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("runMailboxWatch", () => {
  it("reports alert-shaped mail from a sender the sync doesn't search", async () => {
    const out = await runMailboxWatch(source(), known, banks);
    expect(out.error).toBeNull();
    expect(out.checked).toBe(1);
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].sender).toBe("hsbc@alerts.hsbcindia.com");
  });

  // A safety net that fails quietly looks exactly like "nothing to report".
  it("reports a search failure rather than an empty result", async () => {
    const s = source({ search: vi.fn(async () => { throw new Error("imap down"); }) });
    const out = await runMailboxWatch(s, known, banks);
    expect(out.error).toMatch(/imap down/);
    expect(out.candidates).toEqual([]);
    expect(s.close).toHaveBeenCalled();
  });

  it("reports a failed message fetch and still checks the rest", async () => {
    const s = source({
      search: vi.fn(async () => ["bad", "good"]),
      fetchMessage: vi.fn(async (id: string) => {
        if (id === "bad") throw new Error("fetch broke");
        return message(id, "hsbc@alerts.hsbcindia.com");
      }),
    });
    const out = await runMailboxWatch(s, known, banks);
    expect(out.error).toMatch(/1 message/);
    expect(out.candidates).toHaveLength(1);
  });

  it("says so when it hits the fetch limit, and reads the newest mail", async () => {
    const ids = Array.from({ length: MAX_MAILBOX_FETCH + 5 }, (_, i) => `m${i}`);
    const fetchMessage = vi.fn(async (id: string) => message(id, "hsbc@hsbc.bank.in"));
    const out = await runMailboxWatch(source({ search: vi.fn(async () => ids), fetchMessage }), known, banks);
    expect(out.error).toMatch(/only the newest/);
    expect(fetchMessage).toHaveBeenCalledTimes(MAX_MAILBOX_FETCH);
    expect(fetchMessage).toHaveBeenCalledWith(`m${MAX_MAILBOX_FETCH + 4}`);
  });

  it("survives a failure while closing the connection", async () => {
    const out = await runMailboxWatch(source({ close: vi.fn(async () => { throw new Error("bye"); }) }), known, banks);
    expect(out.candidates).toHaveLength(1);
  });
});
