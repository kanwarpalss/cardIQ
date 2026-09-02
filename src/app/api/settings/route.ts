import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { encrypt } from "@/lib/crypto";

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json()) as {
    anthropic_key?: string;
    profile_text?: string;
    gmail_user?: string;
    gmail_app_password?: string;
  };

  const update: Record<string, unknown> = {
    user_id: user.id,
    updated_at: new Date().toISOString(),
  };
  if (typeof body.profile_text === "string") update.profile_text = body.profile_text;
  if (body.anthropic_key) update.anthropic_key_encrypted = encrypt(body.anthropic_key);
  if (typeof body.gmail_user === "string") update.gmail_user = body.gmail_user.trim() || null;
  // App passwords are shown to KP as 16 chars with spaces (Google's display
  // format) — strip whitespace before encrypting so a pasted "abcd efgh ijkl
  // mnop" and "abcdefghijklmnop" are the same credential.
  if (body.gmail_app_password) {
    update.gmail_app_password_encrypted = encrypt(body.gmail_app_password.replace(/\s+/g, ""));
  }

  const { error } = await supabase.from("user_settings").upsert(update, { onConflict: "user_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
