"use client";

import { useRef, useState } from "react";
import { Loader2, SendHorizonal } from "lucide-react";
import type { ChatMessage as Msg } from "@/lib/types";
import ChatMessage from "@/components/chat/ChatMessage";

export default function ChatPanel({
  history,
  onSend,
}: {
  history: Msg[];
  onSend: (message: string) => Promise<string>;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const send = async () => {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    try {
      await onSend(message);
    } finally {
      setBusy(false);
      requestAnimationFrame(() =>
        scrollRef.current?.scrollTo({ top: 99999, behavior: "smooth" })
      );
    }
  };

  return (
    <div className="flex h-[420px] flex-col rounded-xl border border-line bg-surface-raised">
      <div className="border-b border-line px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-ink-faint">
        Editor chat
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {history.length === 0 && (
          <div className="space-y-2 text-xs text-ink-faint">
            <p>Try:</p>
            <p className="rounded-lg bg-surface-overlay px-3 py-2">
              &ldquo;Cut the part where I talked about pricing&rdquo;
            </p>
            <p className="rounded-lg bg-surface-overlay px-3 py-2">
              &ldquo;Remove the stumble around 12 minutes in&rdquo;
            </p>
            <p className="rounded-lg bg-surface-overlay px-3 py-2">
              &ldquo;List all the cuts you&apos;ve made so far&rdquo;
            </p>
          </div>
        )}
        {history.map((m, i) => (
          <ChatMessage key={i} msg={m} />
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-ink-faint">
            <Loader2 className="h-3 w-3 animate-spin" /> Editing…
          </div>
        )}
      </div>

      <div className="flex items-end gap-2 border-t border-line p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder="Describe an edit…"
          className="flex-1 resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
        <button
          onClick={send}
          disabled={busy || !input.trim()}
          className="rounded-lg bg-accent p-2.5 text-white transition-colors hover:bg-accent-dim disabled:opacity-40"
          aria-label="Send"
        >
          <SendHorizonal className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

