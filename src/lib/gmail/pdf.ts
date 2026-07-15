// PDF-attachment plumbing for the orders pipeline.
//
// Some merchants (IKEA, and likely others) put NO line items in the email body —
// the items live only in a PDF invoice attached to the message. This module
// finds those attachments, extracts their text (via `unpdf`, a serverless-safe
// pdf.js wrapper with no native deps), and routes the text to a per-merchant PDF
// parser.
//
// COST GATE: attachment download + PDF text-extraction is far heavier than a
// body regex, so the sync only reaches for it when the BODY yielded no items AND
// the sender is one we have a PDF parser for. `parseOrderFromPdfs` enforces the
// second half of that gate (returns null before downloading anything for a
// sender we can't parse); the caller enforces the first half.

import { extractText, getDocumentProxy } from "unpdf";
import { type ParsedOrder } from "../parsers/orders/types";
import { isIkeaSender, parseIkeaPdf } from "../parsers/orders/ikea";

export type PdfAttachment = {
  filename: string;
  attachmentId: string;
  mimeType: string;
  size: number;
};

/**
 * Every PDF attachment in a Gmail payload. IKEA sends its invoices as
 * `application/octet-stream` with a `.pdf` filename, so we match on EITHER the
 * mime type OR a `.pdf` extension.
 */
export function findPdfAttachments(payload: unknown): PdfAttachment[] {
  const out: PdfAttachment[] = [];
  function walk(part: any) {
    if (!part || typeof part !== "object") return;
    const filename: string = part.filename || "";
    const isPdf = /\.pdf$/i.test(filename) || part.mimeType === "application/pdf";
    if (part.body?.attachmentId && isPdf) {
      out.push({
        filename,
        attachmentId: part.body.attachmentId,
        mimeType: part.mimeType ?? "",
        size: part.body.size ?? 0,
      });
    }
    if (Array.isArray(part.parts)) part.parts.forEach(walk);
  }
  walk(payload);
  return out;
}

/** Extract the full text layer of a PDF. Throws on an unreadable/encrypted PDF. */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

/**
 * Download each PDF attachment (via the injected `download` fn), extract its
 * text, run the merchant's PDF parser, and return the RICHEST result (most
 * items) — so the delivery-T&C PDF that sits alongside the real invoice is
 * naturally ignored.
 *
 * GATED: returns null WITHOUT downloading anything unless we have a PDF parser
 * for this sender. Today that's IKEA only; add more senders here as their
 * layouts are verified. A single malformed PDF never breaks the run — it's
 * logged and skipped (DEBUG-01: no silent swallow).
 */
export async function parseOrderFromPdfs(
  from: string,
  pdfs: PdfAttachment[],
  download: (attachmentId: string) => Promise<Uint8Array>,
  // Injectable for tests; defaults to the real unpdf extractor in production.
  extract: (data: Uint8Array) => Promise<string> = extractPdfText
): Promise<ParsedOrder | null> {
  if (!isIkeaSender(from)) return null;
  if (pdfs.length === 0) return null;

  let best: ParsedOrder | null = null;
  for (const p of pdfs) {
    try {
      const data = await download(p.attachmentId);
      const text = await extract(data);
      const parsed = parseIkeaPdf(text);
      if (parsed && parsed.items.length > (best?.items.length ?? 0)) best = parsed;
    } catch (e) {
      console.error(`[orders/pdf] extract failed for "${p.filename}":`, (e as Error).message);
    }
  }
  return best;
}

/** Decode a Gmail attachment's base64url `data` field into bytes. */
export function decodeAttachmentData(data: string | null | undefined): Uint8Array {
  return new Uint8Array(
    Buffer.from((data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64")
  );
}
