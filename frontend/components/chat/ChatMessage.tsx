"use client";

import { Bot, User } from "lucide-react";
import type { ChatMessage as Msg } from "@/lib/types";

/**
 * A single chat turn bubble. User turns align right with the accent tint;
 * assistant turns align left in the overlay surface, prefixed with a small
 * bot glyph so the editor agent's replies read distinctly from your own.
 */
export default function ChatMessage({ msg }: { msg: Msg }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex items-start gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <div
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
          isUser ? "bg-accent/15 text-accent" : "bg-surface-overlay text-ink-dim"
        }`}
        aria-hidden
      >
        {isUser ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
      </div>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-relaxed ${
          isUser ? "bg-accent/15 text-ink" : "bg-surface-overlay text-ink"
        }`}
      >
        {msg.content}
      </div>
    </div>
  );
}
