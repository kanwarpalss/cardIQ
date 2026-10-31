// Runs the unlisted-sender check against the real mailbox. Lives apart from the
// pure rules in format-watch.ts because this half does network I/O.
//
// A safety net that fails quietly reads as "nothing to report", so every way
// this can fall short comes back in `error` for the caller to surface.

import type { MailSource } from "./mail-source";
import {
  buildUnlistedSenderQuery,
  findUnlistedSenderCandidates,
  type FormatWatchCandidate,
  type SeenRow,
} from "../parsers/format-watch";

export const MAILBOX_WINDOW_DAYS = 21;
export const MAX_MAILBOX_FETCH = 60;

export type MailboxWatchResult = {
  candidates: FormatWatchCandidate[];
  checked: number;
  error: string | null;
};

export async function runMailboxWatch(
  source: MailSource,
  knownLast4s: Set<string>,
  bankDomains: readonly string[],
): Promise<MailboxWatchResult> {
  const problems: string[] = [];
  const rows: SeenRow[] = [];
  try {
    const ids = await source.search(buildUnlistedSenderQuery(bankDomains, MAILBOX_WINDOW_DAYS));
    if (ids.length > MAX_MAILBOX_FETCH) {
      problems.push(`${ids.length} messages matched; checked only the newest ${MAX_MAILBOX_FETCH}`);
    }
    let failed = 0;
    // The window is short, so reading the end of the list is enough to get the newest.
    for (const id of ids.slice(-MAX_MAILBOX_FETCH)) {
      try {
        const m = await source.fetchMessage(id);
        rows.push({
          gmail_message_id: m.id,
          raw_from: m.from,
          raw_subject: m.subject,
          raw_body: m.textBody,
          internal_date: m.internalDate,
        });
      } catch {
        failed++;
      }
    }
    if (failed > 0) problems.push(`${failed} message(s) could not be read`);
  } catch (e) {
    problems.push(`mailbox search failed: ${(e as Error).message}`);
  }
  try {
    await source.close();
  } catch {
    // The results are already in hand, and the connection dies with the request.
  }
  return {
    candidates: findUnlistedSenderCandidates(rows, knownLast4s, bankDomains),
    checked: rows.length,
    error: problems.length ? problems.join("; ") : null,
  };
}
