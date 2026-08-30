// MailSource — the single seam between "how we fetch email" and "everything
// downstream" (dedup, parsers, cursor logic). Both the bank sync route and
// the orders sync route call ONLY this interface, never googleapis or
// imapflow directly, so a source swap can never accidentally change what a
// parser sees.
//
// Two implementations:
//   GmailApiSource — the existing OAuth/REST path, repackaged (no behaviour
//     change) so it satisfies the same contract as the IMAP path.
//   ImapSource     — new. Gmail app password over IMAP, proven viable by the
//     read-only spike (scripts/imap-spike.ts, Phases 1-2 PASS, 2026-08-22):
//     Gmail's own search syntax works verbatim via X-GM-RAW, and IMAP's
//     emailId converts cleanly to the same hex id already stored in
//     gmail_seen_messages/transactions.gmail_message_id.
//
// `attachments` on NormalizedMessage is deliberately scoped to PDF
// attachments only — the one and only consumer today is the IKEA
// PDF-fallback path in the orders sync route (src/lib/gmail/pdf.ts). Neither
// implementation attempts to enumerate every attachment type.

import { google } from "googleapis";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { makeGmailOAuthClient, extractBody, extractHtml } from "./extract";
import { stripHtml } from "./strip";
import { findPdfAttachments, decodeAttachmentData } from "./pdf";

export interface NormalizedAttachment {
  filename: string;
  mimeType: string;
  getBytes(): Promise<Uint8Array>;
}

export interface NormalizedMessage {
  /** Canonical hex id — identical to the value already stored as gmail_message_id. */
  id: string;
  /** Server-received time, ms epoch. Drives the sync cursor. */
  internalDate: number;
  subject: string;
  from: string;
  /** Raw `Date:` header value, or null if absent. */
  dateHeader: string | null;
  textBody: string;
  htmlBody: string;
  /** Short preview string — a fallback parser signal, not authoritative. */
  snippet: string;
  attachments: NormalizedAttachment[];
}

export interface MailSource {
  /**
   * Lists canonical hex message ids matching a Gmail-syntax query. Cheap — no
   * bodies fetched. `onProgress`, if given, is called with a running count as
   * ids are discovered — a first-time 8-year sync can take a while just to
   * LIST everything, and the sync routes stream this to the UI so it never
   * looks frozen (a past incident this route already fixed once).
   */
  search(query: string, onProgress?: (foundSoFar: number) => void): Promise<string[]>;
  /** Fetches the full normalized message for an id returned by search(). */
  fetchMessage(id: string): Promise<NormalizedMessage>;
  /** Releases any open connection. No-op for the stateless REST client. */
  close(): Promise<void>;
}

// ─── GmailApiSource ─────────────────────────────────────────────────────────

export class GmailApiSource implements MailSource {
  private gmail: ReturnType<typeof google.gmail>;

  constructor(refreshToken: string) {
    const auth = makeGmailOAuthClient();
    auth.setCredentials({ refresh_token: refreshToken });
    this.gmail = google.gmail({ version: "v1", auth });
  }

  async search(query: string, onProgress?: (foundSoFar: number) => void): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: 100,
        pageToken,
      });
      for (const m of res.data.messages || []) if (m.id) ids.push(m.id);
      pageToken = res.data.nextPageToken ?? undefined;
      onProgress?.(ids.length);
    } while (pageToken);
    return ids;
  }

  async fetchMessage(id: string): Promise<NormalizedMessage> {
    const full = await this.gmail.users.messages.get({ userId: "me", id, format: "full" });
    const headers = full.data.payload?.headers || [];
    const h = (name: string) => headers.find((x) => x.name?.toLowerCase() === name)?.value ?? "";

    const pdfs = findPdfAttachments(full.data.payload);
    const attachments: NormalizedAttachment[] = pdfs.map((p) => ({
      filename: p.filename,
      mimeType: p.mimeType,
      getBytes: async () => {
        const att = await this.gmail.users.messages.attachments.get({
          userId: "me",
          messageId: id,
          id: p.attachmentId,
        });
        return decodeAttachmentData(att.data.data);
      },
    }));

    return {
      id,
      internalDate: parseInt(full.data.internalDate ?? "0", 10),
      subject: h("subject"),
      from: h("from"),
      dateHeader: h("date") || null,
      textBody: extractBody(full.data.payload),
      htmlBody: extractHtml(full.data.payload),
      snippet: full.data.snippet || "",
      attachments,
    };
  }

  async close(): Promise<void> {
    // Stateless REST client — nothing to release.
  }
}

// ─── ImapSource ─────────────────────────────────────────────────────────────

/**
 * Gmail's REST API renders X-GM-MSGID in hex; IMAP's own `emailId` reports
 * the SAME 64-bit value in decimal. This is the exact conversion the spike
 * proved 40/40 against live `gmail_seen_messages` rows — the dedupe key that
 * makes the whole migration safe (no reingest of 10k+ emails).
 */
export function toCanonicalId(emailId: string | number | bigint): string {
  return BigInt(emailId).toString(16);
}

/** Pulled out so the PDF-only attachment filter is unit-testable without a live IMAP client. */
export function isPdfAttachment(a: { contentType?: string; filename?: string }): boolean {
  return a.contentType === "application/pdf" || /\.pdf$/i.test(a.filename || "");
}

const ALL_MAIL = "[Gmail]/All Mail";

export class ImapSource implements MailSource {
  private client: ImapFlow;
  private connected = false;
  /** Populated by search(); fetchMessage() needs the UID search() already resolved. */
  private idToUid = new Map<string, number>();

  constructor(user: string, pass: string) {
    this.client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: { user, pass },
      logger: false,
    });
  }

  private async ensureConnected() {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
  }

  async search(query: string, onProgress?: (foundSoFar: number) => void): Promise<string[]> {
    await this.ensureConnected();
    const lock = await this.client.getMailboxLock(ALL_MAIL);
    try {
      const uids = await this.client.search({ gmailraw: query }, { uid: true });
      if (!uids || uids.length === 0) return [];

      const ids: string[] = [];
      for await (const msg of this.client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
        if (msg.emailId == null) continue;
        const canonical = toCanonicalId(msg.emailId);
        this.idToUid.set(canonical, msg.uid);
        ids.push(canonical);
        // Envelope fetch is one round-trip per message — report progress every
        // 50 the same way the old REST pagination did per 100-message page, so
        // a large first sync never LOOKS frozen during listing.
        if (ids.length % 50 === 0) onProgress?.(ids.length);
      }
      onProgress?.(ids.length);
      return ids;
    } finally {
      lock.release();
    }
  }

  async fetchMessage(id: string): Promise<NormalizedMessage> {
    // Checked BEFORE connecting: a caller programming error (fetching an id
    // search() never returned) should fail immediately, not after a network
    // round-trip to Gmail.
    const uid = this.idToUid.get(id);
    if (uid == null) {
      throw new Error(`ImapSource.fetchMessage: id ${id} was not returned by a prior search()`);
    }

    await this.ensureConnected();
    const lock = await this.client.getMailboxLock(ALL_MAIL);
    let raw: Awaited<ReturnType<ImapFlow["fetchOne"]>>;
    try {
      raw = await this.client.fetchOne(
        uid,
        { uid: true, source: true, internalDate: true },
        { uid: true }
      );
    } finally {
      lock.release();
    }
    if (!raw || !raw.source) {
      throw new Error(`ImapSource.fetchMessage: no message source returned for uid ${uid}`);
    }

    const parsed = await simpleParser(raw.source);
    const text = parsed.text ?? (typeof parsed.html === "string" ? stripHtml(parsed.html) : "");
    const html = typeof parsed.html === "string" ? parsed.html : "";

    const attachments: NormalizedAttachment[] = (parsed.attachments || [])
      .filter(isPdfAttachment)
      .map((a) => ({
        filename: a.filename || "",
        mimeType: a.contentType || "",
        getBytes: async () => new Uint8Array(a.content),
      }));

    return {
      id,
      internalDate: raw.internalDate ? new Date(raw.internalDate).getTime() : Date.now(),
      subject: parsed.subject || "",
      from: parsed.from?.text || "",
      dateHeader: parsed.date ? parsed.date.toUTCString() : null,
      textBody: text,
      htmlBody: html,
      // mailparser doesn't produce Gmail's server-generated snippet — approximate
      // from the plain-text body. Used only as a fallback parser signal, never
      // authoritative, so this is not a parity risk worth a heavier fix.
      snippet: text.slice(0, 200),
      attachments,
    };
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.logout();
      this.connected = false;
    }
  }
}

// ─── source selection ───────────────────────────────────────────────────────

export type MailCredentials = {
  imapUser?: string | null;
  imapPass?: string | null;
  oauthRefreshToken?: string | null;
};

/**
 * IMAP wins whenever an app password is on file — it's the whole point of
 * this migration (app passwords don't expire; OAuth refresh tokens die every
 * 7 days in Google's "Testing" publishing status). Falls back to the OAuth
 * path so nothing breaks for an account mid-migration.
 *
 * This fallback is a deliberate bridge, not a permanent branch: it exists
 * only until every account has an app password saved. Migration Phase 6
 * (tracked in SPEC.md, deliberately deferred — not a fixed calendar date,
 * since this is a single-user app and the real trigger is "KP confirmed the
 * app password works") removes GmailApiSource, makeGmailOAuthClient, and the
 * /login Google button entirely. Don't build new features on the OAuth path.
 */
export function pickMailSource(creds: MailCredentials): MailSource {
  if (creds.imapUser && creds.imapPass) {
    return new ImapSource(creds.imapUser, creds.imapPass);
  }
  if (creds.oauthRefreshToken) {
    return new GmailApiSource(creds.oauthRefreshToken);
  }
  throw new Error("no_gmail_credential");
}
