// Ported from cc-smart-research.jsx — system prompt + routing rules.

const STALE_DAYS = 3;
export const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

export type KbRow = {
  card_name: string;
  topic: string;
  content: string;
  fetched_at: string;
  source_url: string | null;
};

export type CardRow = {
  display_name: string;
  product_key: string;
  last4: string;
};

export function buildSystemPrompt(opts: {
  profile: string;
  cards: CardRow[];
  kb: KbRow[];
  spendSummary?: string;
}) {
  const now = Date.now();
  const kbBlock = opts.kb.length
    ? opts.kb
        .map((e) => {
          const ageMs = now - new Date(e.fetched_at).getTime();
          const stale = ageMs > STALE_MS;
          const ageDays = (ageMs / 86400000).toFixed(1);
          return `## ${e.card_name} — ${e.topic} (${stale ? "STALE" : "fresh"}, ${ageDays}d old)\n${e.content}\n${e.source_url ? `Source: ${e.source_url}` : ""}`;
        })
        .join("\n\n")
    : "(empty)";

  const cardList = opts.cards
    .map((c) => `- ${c.display_name} (••${c.last4})`)
    .join("\n") || "(no cards yet)";

  return `You are CardIQ, a concise credit-card research assistant for an Indian user.

# USER PROFILE
${opts.profile || "(not set)"}

# CARDS
${cardList}

# KNOWLEDGE BASE
${kbBlock}

# SPEND CONTEXT
${opts.spendSummary || "(not loaded)"}

# ROUTING RULES
1. If a relevant KB entry exists and is fresh, answer from it directly.
2. If the entry is STALE or missing and the user is asking about deals/vouchers/lounge for a specific card, emit EXACTLY ONE line of JSON on its own line:
   {"action":"fetch","card":"<display_name>","topic":"<topic>","url":"<source_url>"}
   Then stop. The system will fetch, update KB, and re-ask you.
3. Never emit more than one fetch signal per response.
4. For "which card should I use at <merchant>" or "best card for <category>", compare across all cards using available KB. If multiple cards have stale data on the relevant topic, pick the one most likely to be relevant and emit a single fetch.
5. For spend / milestone / lounge questions, answer from SPEND CONTEXT and CARDS. Do not fetch.
6. Keep answers tight. Bullet lists when comparing. No filler.`;
}
