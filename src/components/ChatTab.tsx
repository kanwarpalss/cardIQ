"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";

type Usage = { input_tokens: number; output_tokens: number; cost_usd: number };
type Msg = { role: "user" | "assistant"; content: string; usage?: Usage };

export default function ChatTab() {
  const [history, setHistory] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send() {
    if (!input.trim() || busy) return;
    setErr(null);
    const message = input.trim();
    setInput("");
    setHistory((h) => [...h, { role: "user", content: message }]);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, history }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "request failed");
      setHistory((h) => [...h, { role: "assistant", content: json.text, usage: json.usage }]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full flex flex-col max-w-3xl mx-auto p-6">
      <div className="flex-1 overflow-y-auto space-y-4 pb-4">
        {history.length === 0 && (
          <p className="opacity-50 text-sm">
            Ask anything: best card for a merchant, current month spend, lounge availability, deals…
          </p>
        )}
        {history.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-gold" : "opacity-90"}>
            <div className="text-xs opacity-50 mb-1">{m.role === "user" ? "you" : "cardiq"}</div>
            {m.role === "assistant" ? (
              <>
                <div className="prose prose-invert prose-sm max-w-none
                  prose-p:my-1 prose-ul:my-1 prose-li:my-0.5
                  prose-headings:text-gold prose-strong:text-white
                  prose-code:text-gold prose-code:bg-panel prose-code:px-1 prose-code:rounded">
                  <ReactMarkdown>{m.content}</ReactMarkdown>
                </div>
                {m.usage && (
                  <div className="text-xs opacity-30 mt-1">
                    ↳ {m.usage.input_tokens.toLocaleString()} in · {m.usage.output_tokens.toLocaleString()} out · ${m.usage.cost_usd.toFixed(4)}
                  </div>
                )}
              </>
            ) : (
              <div className="whitespace-pre-wrap">{m.content}</div>
            )}
          </div>
        ))}
        {busy && <div className="opacity-50 text-sm">…thinking</div>}
        {err && <div className="text-red-400 text-sm">Error: {err}</div>}
      </div>
      <div className="border-t border-line pt-3 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Ask CardIQ…"
          className="flex-1 bg-panel border border-line rounded px-3 py-2 outline-none focus:border-gold"
        />
        <button
          onClick={send}
          disabled={busy}
          className="bg-gold text-ink px-4 rounded font-medium disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
