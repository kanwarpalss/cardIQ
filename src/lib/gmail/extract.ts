// Gmail message-body extraction — shared by the bank sync route and the
// orders sync route so both decode/strip emails identically (ARCH-04).
//
// Moved verbatim out of /api/gmail/sync/route.ts on 2026-07-11 when the
// orders sync was added. Behaviour is unchanged: extractBody returns the
// HTML-stripped plain text the bank parsers were built against.

import { google } from "googleapis";
import { stripHtml } from "./strip";

// Re-exported so existing importers (`@/lib/gmail/extract`) keep working; the
// canonical implementation now lives in ./strip (googleapis-free, so parsers
// can use it too).
export { stripHtml };

export function makeGmailOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
}

export function base64Decode(str: string): string {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

export function extractBody(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return base64Decode(payload.body.data);
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return stripHtml(base64Decode(payload.body.data));
  }
  if (payload.body?.data) {
    const decoded = base64Decode(payload.body.data);
    return decoded.includes("<") ? stripHtml(decoded) : decoded;
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) return base64Decode(part.body.data);
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) return stripHtml(base64Decode(part.body.data));
    }
    for (const part of payload.parts) {
      const body = extractBody(part);
      if (body) return body;
    }
  }
  return "";
}

/**
 * Raw (un-stripped) HTML body, for parsers that need document structure.
 * Order emails put the reliable anchors (item rows, restaurant names) in
 * HTML attributes that stripHtml erases — e.g. BigBasket item names live in
 * /pd/ product links, Swiggy restaurant names in the only bold <p> of the
 * ORDER JOURNEY block. Returns "" when the message has no HTML part.
 */
export function extractHtml(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return base64Decode(payload.body.data);
  }
  if (payload.body?.data && !payload.parts) {
    const decoded = base64Decode(payload.body.data);
    return decoded.includes("<") ? decoded : "";
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const html = extractHtml(part);
      if (html) return html;
    }
  }
  return "";
}
