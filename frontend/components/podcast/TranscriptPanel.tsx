"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Scissors } from "lucide-react";
import { fmtTime, type Sentence } from "@/lib/podcast";

/**
 * The episode transcript (sentence timestamps from the stock transcriber).
 * Click a first and a last sentence to cut a clip by hand.
 */
export default function TranscriptPanel({
  sentences,
  loading,
  highlight,
  onOpen,
  onMakeClip,
}: {
  sentences: Sentence[] | null;
  loading: boolean;
  highlight: { start_ms: number; end_ms: number } | null;
  onOpen: () => void;
  onMakeClip: (start_ms: number, end_ms: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<{ first: number | null; last: number | null }>({ first: null, last: null });
  const { first, last } = sel;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !sentences) onOpen();
  };

  const clear = () => setSel({ first: null, last: null });
  const pick = (index: number) =>
    setSel((prev) => {
      if (prev.first === null || prev.last !== null) return { first: index, last: null };
      if (index < prev.first) return { first: index, last: prev.last };
      return { first: prev.first, last: index };
    });

  const selection = first !== null && last !== null && sentences ? { start_ms: sentences[first].start_ms, end_ms: sentences[last].end_ms } : null;

  return (
    <section className="rounded-lg border border-line bg-surface-raised shadow-elev-1">
      <button type="button" onClick={toggle} className="flex w-full items-center justify-between px-5 py-4 text-left">
        <span className="flex items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4 text-ink-faint" /> : <ChevronRight className="h-4 w-4 text-ink-faint" />}
          <span className="rr-eyebrow">Transcript</span>
          {sentences && <span className="font-mono text-[11px] text-ink-faint">{sentences.length} sentences</span>}
        </span>
        <span className="font-mono text-[11px] text-ink-faint">click a first and a last sentence to cut your own clip</span>
      </button>
      {open && (
        <div className="border-t border-line px-5 py-4">
          {selection && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-2">
              <span className="font-mono text-[11px] text-ink">
                {fmtTime(selection.start_ms)} → {fmtTime(selection.end_ms)} · {((selection.end_ms - selection.start_ms) / 1000).toFixed(0)}s
              </span>
              <button
                type="button"
                onClick={() => {
                  onMakeClip(selection.start_ms, selection.end_ms);
                  clear();
                }}
                className="inline-flex items-center gap-1 rounded-md bg-ink px-2.5 py-1 text-[11px] text-ink-inverse"
              >
                <Scissors className="h-3 w-3" /> Make this a clip
              </button>
              <button type="button" onClick={clear} className="text-[11px] text-ink-dim underline">
                clear
              </button>
            </div>
          )}
          {loading && !sentences && <p className="text-sm text-ink-faint">Loading the transcript…</p>}
          {sentences && sentences.length === 0 && <p className="text-sm text-ink-faint">No transcript yet — the analysis writes it.</p>}
          {sentences && sentences.length > 0 && (
            <ol className="max-h-[420px] space-y-0.5 overflow-y-auto pr-2">
              {sentences.map((s, i) => {
                const inSelection = first !== null && (last === null ? i === first : i >= first && i <= last);
                const inClip = !!highlight && s.start_ms < highlight.end_ms && s.end_ms > highlight.start_ms;
                return (
                  <li
                    key={s.id}
                    onClick={() => pick(i)}
                    className={`flex cursor-pointer gap-3 rounded px-2 py-1 text-sm leading-relaxed ${
                      inSelection ? "bg-accent/15" : inClip ? "bg-ready/10" : "hover:bg-surface-overlay"
                    }`}
                  >
                    <span className="shrink-0 pt-0.5 font-mono text-[10px] text-ink-faint">{fmtTime(s.start_ms)}</span>
                    <span className="text-ink">{s.text}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
