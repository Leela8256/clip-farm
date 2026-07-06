"use client";

import { AlertTriangle, Bot, User } from "lucide-react";
import type { ChatMessage as Msg } from "@/lib/types";

/**
 * Detects a raw backend error dumped into an assistant turn (e.g. an unhandled
 * LLM exception with a stack location and JSON body). Users should never see a
 * server path or a raw traceback in the chat, so we surface a clean, on-brand
 * message instead of the leaked internals.
 */
function looksLikeErrorDump(content: string): boolean {
  return /^\s*(LLM error|Exception|Traceback|Error code:|\{['"]type['"]:\s*['"]error['"])/i.test(
    content
  );
}

/**
 * A single chat turn bubble. User turns align right on the raised hover
 * surface; assistant turns align left in the overlay surface, prefixed with a
 * small bot glyph so the editor agent's replies read distinctly from your own.
 * Both stay monochrome — the accent is reserved for the waveform/playhead.
 */
export default function ChatMessage({ msg }: { msg: Msg }) {
  const isUser = msg.role === "user";
  const isError = !isUser && looksLikeErrorDump(msg.content);

  if (isError) {
    return (
      <div className="flex items-start gap-2">
        <div
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-danger/40 bg-danger/15 text-danger"
          aria-hidden
        >
          <AlertTriangle className="h-3.5 w-3.5" />
        </div>
        <div className="max-w-[85%] rounded-lg border border-danger/40 bg-danger/15 px-3 py-2 text-sm leading-relaxed text-danger">
          The editor couldn&apos;t complete that edit. Please try again in a moment.
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-start gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <div
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line ${
          isUser ? "bg-surface-hover text-ink-dim" : "bg-surface-overlay text-ink-dim"
        }`}
        aria-hidden
      >
        {isUser ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
      </div>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm leading-relaxed ${
          isUser ? "bg-surface-hover text-ink" : "bg-surface-overlay text-ink"
        }`}
      >
        {msg.content}
      </div>
    </div>
  );
}
