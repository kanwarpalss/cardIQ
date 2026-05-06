import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";
import { buildSystemPrompt, type KbRow, type CardRow } from "@/lib/router";
import { getCardSpec } from "@/lib/cards/registry";

const MODEL = "claude-sonnet-4-6";

export async function POST(req: Request) {
  const { message, history } = (await req.json()) as {
    message: string;
    history: { role: "user" | "assistant"; content: string }[];
  };

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [{ data: settings }, { data: cardsRaw }, { data: kbRaw }] = await Promise.all([
    supabase.from("user_settings").select("*").eq("user_id", user.id).single(),
    supabase.from("cards").select("id, product_key, nickname, last4").eq("user_id", user.id),
    supabase
      .from("kb_entries")
      .select("topic, content, fetched_at, source_url, card_id")
      .eq("user_id", user.id),
  ]);

  if (!settings?.anthropic_key_encrypted) {
    return NextResponse.json({ error: "anthropic_key_missing" }, { status: 400 });
  }

  const cards: CardRow[] = (cardsRaw || []).map((c) => ({
    display_name: c.nickname || getCardSpec(c.product_key)?.display_name || c.product_key,
    product_key: c.product_key,
    last4: c.last4,
  }));

  const cardById = new Map((cardsRaw || []).map((c) => [c.id, c]));
  const kb: KbRow[] = (kbRaw || []).map((e) => {
    const card = cardById.get(e.card_id);
    const spec = card ? getCardSpec(card.product_key) : null;
    return {
      card_name: card?.nickname || spec?.display_name || "?",
      topic: e.topic,
      content: e.content,
      fetched_at: e.fetched_at,
      source_url: e.source_url,
    };
  });

  const system = buildSystemPrompt({
    profile: settings.profile_text || "",
    cards,
    kb,
  });

  const anthropic = new Anthropic({ apiKey: decrypt(settings.anthropic_key_encrypted) });

  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: message },
  ];

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages,
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const input_tokens = resp.usage.input_tokens;
  const output_tokens = resp.usage.output_tokens;
  const cost_usd = (input_tokens * 3 + output_tokens * 15) / 1_000_000;

  return NextResponse.json({ text, usage: { input_tokens, output_tokens, cost_usd } });
}
