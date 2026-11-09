// Points blogs the daily job reads through their public RSS feeds.
//
// Why blogs at all: a BANK's transfer bonus ("HDFC → Accor +30%") is often
// announced only on the bank's portal and picked up by blogs — it may never
// reach KP's inbox. Feeds give a title + one-paragraph summary per post, which
// is enough for the free filter and the AI reader; the full article is never
// downloaded. Deals found here are labelled "from a blog, unverified".
//
// Checked 9 Nov 2026: all four return valid RSS to a plain request.
// TechnoFino answers 403 to automated readers, so it is left out.

export type Feed = { name: string; url: string };

export const FEEDS: Feed[] = [
  { name: "CardExpert", url: "https://www.cardexpert.in/feed/" },
  { name: "Live From A Lounge", url: "https://www.livefromalounge.com/feed/" },
  { name: "The MileLion", url: "https://milelion.com/feed/" },
  { name: "LoyaltyLobby", url: "https://loyaltylobby.com/feed/" },
];

export type FeedItem = {
  title: string;
  link: string;
  /** ISO timestamp, or null when the item's date is missing or unreadable. */
  published: string | null;
  /** Plain-text summary (HTML stripped), possibly empty. */
  summary: string;
};

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

/** Decode the HTML entities feeds actually use: named, &#8217; and &#x2019;. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  if (!m) return "";
  let v = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
  if (cdata) v = cdata[1];
  return v;
}

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, " ");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Parse an RSS 2.0 document into items. Tolerant by design: an item missing
 * a title or link is skipped (it can't be shown or de-duplicated), a bad
 * date becomes null, and anything that isn't RSS yields [] — never a throw,
 * so one broken feed can't stop the others.
 */
export function parseRss(xml: string): FeedItem[] {
  if (typeof xml !== "string") return [];
  const out: FeedItem[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const title = squash(stripHtml(decodeEntities(tag(block, "title"))));
    const link = squash(decodeEntities(tag(block, "link")));
    if (!title || !/^https?:\/\//i.test(link)) continue;
    const raw = tag(block, "pubDate");
    const t = raw ? Date.parse(raw) : NaN;
    out.push({
      title,
      link,
      published: Number.isFinite(t) ? new Date(t).toISOString() : null,
      // Decode before stripping: some feeds entity-encode their HTML (&lt;p&gt;).
      summary: squash(stripHtml(decodeEntities(tag(block, "description")))),
    });
  }
  return out;
}
