/**
 * Gap Detector: Identifies when a card hasn't had a transaction in 35+ days.
 * This is a strong signal of a parsing bug rather than no spending.
 *
 * When a gap is detected:
 * 1. Re-fetch emails from that card's senders (last 45 days)
 * 2. Re-run all parser rules on them
 * 3. Log any emails that should have parsed (for debugging)
 * 4. Alert user if significant discrepancy found
 */

import { createClient } from "@/lib/supabase/server";
import { google } from "googleapis";
import { decrypt } from "@/lib/crypto";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { tryAllParsers } from "@/lib/parsers/registry";

const GAP_THRESHOLD_DAYS = 35;
const LOOKBACK_DAYS = 45;

interface GapAlert {
  card_id: string;
  card_last4: string;
  last_txn_date: Date | null;
  days_since_last_txn: number;
  emails_checked: number;
  emails_should_have_parsed: number;
  discrepancies: Array<{
    subject: string;
    from: string;
    date: string;
    reason: string;
  }>;
}

/**
 * Check all cards for 35+ day gaps and re-validate parsing rules.
 * Returns alerts for any cards with suspicious gaps.
 */
export async function detectParsingGaps(userId: string): Promise<GapAlert[]> {
  const supabase = createClient();
  const alerts: GapAlert[] = [];

  // Get all cards for this user
  const { data: cards } = await supabase
    .from("cards")
    .select("id, last4, issuer")
    .eq("user_id", userId);

  if (!cards || cards.length === 0) return alerts;

  // Get all distinct senders across all cards
  const allSenders = new Set<string>();
  for (const spec of Object.values(CARD_REGISTRY)) {
    spec.gmail.senders.forEach((s) => allSenders.add(s));
  }

  // Get Gmail credentials
  const { data: settings } = await supabase
    .from("user_settings")
    .select("google_refresh_token_encrypted")
    .eq("user_id", userId)
    .single();

  if (!settings?.google_refresh_token_encrypted) {
    console.warn("No Gmail token for gap detection");
    return alerts;
  }

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: decrypt(settings.google_refresh_token_encrypted) });
  const gmail = google.gmail({ version: "v1", auth });

  // Check each card
  for (const card of cards) {
    const { data: lastTxn } = await supabase
      .from("transactions")
      .select("txn_at")
      .eq("card_id", card.id)
      .order("txn_at", { ascending: false })
      .limit(1)
      .single();

    const lastTxnDate = lastTxn?.txn_at ? new Date(lastTxn.txn_at) : null;
    const daysSinceLastTxn = lastTxnDate
      ? Math.floor((Date.now() - lastTxnDate.getTime()) / (86400 * 1000))
      : 999; // No transactions ever

    if (daysSinceLastTxn < GAP_THRESHOLD_DAYS) {
      continue; // Card has recent activity, no alert needed
    }

    // Gap detected! Re-validate parsing for this card's senders
    const alert: GapAlert = {
      card_id: card.id,
      card_last4: card.last4,
      last_txn_date: lastTxnDate,
      days_since_last_txn: daysSinceLastTxn,
      emails_checked: 0,
      emails_should_have_parsed: 0,
      discrepancies: [],
    };

    // Build query for this card's issuer senders
    const issuerSenders = [...allSenders]
      .filter((sender) => {
        // Match senders for this card's issuer
        const lowerSender = sender.toLowerCase();
        const lowerIssuer = card.issuer.toLowerCase();
        return (
          lowerSender.includes(lowerIssuer.split(" ")[0]) || // First word of issuer
          lowerIssuer.includes(lowerSender.split(".")[0]) // First part of domain
        );
      });

    if (issuerSenders.length === 0) {
      console.warn(`No senders matched for card issuer: ${card.issuer}`);
      continue;
    }

    const fromClause = issuerSenders.map((s) => `from:${s}`).join(" OR ");
    const afterSeconds = Math.floor(
      (Date.now() - LOOKBACK_DAYS * 86400 * 1000) / 1000
    );
    const query = `(${fromClause}) after:${afterSeconds}`;

    try {
      // Fetch recent emails for this card's senders
      const emails: Array<{ id: string; subject: string; from: string; date: string; body: string }> = [];
      let pageToken: string | undefined;

      do {
        const listRes = await gmail.users.messages.list({
          userId: "me",
          q: query,
          maxResults: 100,
          pageToken,
        });

        for (const m of listRes.data.messages || []) {
          if (!m.id) continue;
          try {
            const full = await gmail.users.messages.get({
              userId: "me",
              id: m.id,
              format: "full",
            });
            const headers = full.data.payload?.headers || [];
            emails.push({
              id: m.id,
              subject: headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "",
              from: headers.find((h) => h.name?.toLowerCase() === "from")?.value || "",
              date: headers.find((h) => h.name?.toLowerCase() === "date")?.value || "",
              body: extractEmailBody(full.data.payload),
            });
          } catch (e) {
            console.error(`Failed to fetch email ${m.id}:`, e);
          }
        }

        pageToken = listRes.data.nextPageToken ?? undefined;
      } while (pageToken);

      alert.emails_checked = emails.length;

      // Re-parse each email to find discrepancies
      for (const email of emails) {
        const parsed = tryAllParsers(email.subject, email.body);
        if (parsed && parsed.card_last4 === card.last4) {
          // This email should have been a transaction for this card
          // Check if it's already in the DB
          const { data: existing } = await supabase
            .from("transactions")
            .select("id")
            .eq("user_id", userId)
            .eq("gmail_message_id", email.id)
            .single();

          if (!existing) {
            alert.emails_should_have_parsed++;
            alert.discrepancies.push({
              subject: email.subject,
              from: email.from,
              date: email.date,
              reason: "Parsed successfully but missing from DB",
            });
          }
        }
      }

      if (alert.discrepancies.length > 0) {
        alerts.push(alert);
      }
    } catch (e) {
      console.error(`Gap detection error for card ${card.last4}:`, e);
    }
  }

  return alerts;
}

function extractEmailBody(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf-8");
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf-8");
      }
    }
  }
  return "";
}
