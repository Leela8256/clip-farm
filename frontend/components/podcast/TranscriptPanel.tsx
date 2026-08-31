"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, LocateFixed, Scissors, Search, X } from "lucide-react";
import { fmtTime, type Sentence } from "@/lib/podcast";

function scrollToSentence(root: HTMLElement | null, index: number) {
  root?.querySelector<HTMLElement>(`[data-i="${index}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
}

const SKELETON_WIDTHS = [92, 100, 84, 96, 70, 88];

/**
 * The episode transcript as flowing text. Click a sentence to seek there;
 * click a first and a last sentence to cut a clip by hand.
 */
export default function TranscriptPanel({
  sentences,
  loading,
  highlight,
  onOpen,
  onMakeClip,
  onSeek,
}: {
  sentences: Sentence[] | null;
  loading: boolean;
  highlight: { start_ms: number; end_ms: number } | null;
  onOpen: () => void;
  onMakeClip: (start_ms: number, end_ms: number) => void;
  onSeek?: (ms: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<{ first: number | null; last: number | null }>({ first: null, last: null });
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingJump = useRef(false);
  const { first, last } = sel;

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q || !sentences) return [];
    const out: number[] = [];
    sentences.forEach((s, i) => {
      if (s.text.toLowerCase().includes(q)) out.push(i);
    });
    return out;
  }, [q, sentences]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const current = matches.length ? matches[matchIdx % matches.length] : null;
  const highlightIdx = useMemo(() => (highlight && sentences ? sentences.findIndex((s) => s.start_ms < highlight.end_ms && s.end_ms > highlight.start_ms) : -1), [highlight, sentences]);

  // the current search match scrolls into view as you type or press Enter
  useEffect(() => {
    if (current != null) scrollToSentence(listRef.current, current);
  }, [current]);

  // "Jump to the selected clip" pressed while the transcript was still closed or loading
  useEffect(() => {
    if (!pendingJump.current || !open || highlightIdx < 0) return;
    pendingJump.current = false;
    scrollToSentence(listRef.current, highlightIdx);
  }, [open, highlightIdx]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !sentences) onOpen();
  };

  const jump = () => {
    if (open && highlightIdx >= 0) {
      scrollToSentence(listRef.current, highlightIdx);
      return;
    }
    pendingJump.current = true;
    if (!open) toggle();
  };

  const clear = () => setSel({ first: null, last: null });
  const pick = (index: number) =>
    setSel((prev) => {
      if (prev.first === null || prev.last !== null) return { first: index, last: null };
      if (index < prev.first) return { first: index, last: prev.last };
      return { first: prev.first, last: index };
    });

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setQuery("");
      setMatchIdx(0);
      return;
    }
    if (e.key !== "Enter" || !matches.length) return;
    e.preventDefault();
    const n = matches.length;
    setMatchIdx((i) => ((e.shiftKey ? i - 1 : i + 1) + n) % n);
  };

  const selection = first !== null && last !== null && sentences ? { start_ms: sentences[first].start_ms, end_ms: sentences[last].end_ms } : null;
  const picking = first !== null && last === null;
  const hasText = !!sentences && sentences.length > 0;

  return (
    <section className="rr-card rr-enter">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-4">
        <h3 className="flex items-center">
          <button type="button" onClick={toggle} aria-expanded={open} className="rr-h3 flex items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            {open ? <ChevronDown className="h-4 w-4 text-ink-faint" /> : <ChevronRight className="h-4 w-4 text-ink-faint" />}
            Transcript
          </button>
        </h3>
        {sentences && <span className="text-xs text-ink-faint">{sentences.length} sentences</span>}
        {open && picking && <span className="rr-enter text-xs font-medium text-accent">Now click where the clip should end</span>}
        <span className="flex-1" />
        {open && hasText && (
          <label className="flex items-center">
            <span className="relative flex items-center">
              <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-ink-faint" />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setMatchIdx(0);
                }}
                onKeyDown={onSearchKey}
                placeholder="Search the transcript"
                aria-label="Search the transcript"
                className="rr-input rr-input-sm w-52"
                style={{ paddingLeft: "2rem" }}
              />
            </span>
            {q && (
              <span className="ml-2 whitespace-nowrap font-mono text-[11px] text-ink-faint">
                {matches.length ? `${matchIdx % matches.length + 1} of ${matches.length} match${matches.length === 1 ? "" : "es"}` : "no matches"}
              </span>
            )}
          </label>
        )}
        {highlight && (
          <button type="button" onClick={jump} className="rr-btn rr-btn-ghost rr-btn-sm">
            <LocateFixed className="h-3.5 w-3.5" /> Jump to the selected clip
          </button>
        )}
        <button type="button" onClick={toggle} className={`rr-btn rr-btn-sm ${open ? "rr-btn-ghost" : ""}`}>
          {open ? "Hide" : "Open transcript"}
        </button>
      </div>

      {open && (
        <div className="border-t border-line px-5 py-4">
          {loading && !sentences && (
            <div className="space-y-2.5" aria-busy="true">
              {SKELETON_WIDTHS.map((w, i) => (
                <div key={i} className="rr-skeleton h-4" style={{ width: `${w}%` }} />
              ))}
            </div>
          )}
          {sentences && sentences.length === 0 && <p className="text-sm text-ink-faint">No transcript yet — it appears once the analysis finishes.</p>}
          {hasText && sentences && (
            <div ref={listRef} className="relative max-h-[480px] overflow-y-auto pr-2">
              <p className="text-[15px] leading-7 text-ink">
                {sentences.map((s, i) => {
                  const inSelection = first !== null && (last === null ? i === first : i >= first && i <= last);
                  const inClip = !!highlight && s.start_ms < highlight.end_ms && s.end_ms > highlight.start_ms;
                  const isMatch = matchSet.has(i);
                  const tint = inSelection
                    ? "bg-accent/20 text-ink"
                    : i === current
                      ? "bg-processing/40 text-ink"
                      : isMatch
                        ? "bg-processing/15 text-ink"
                        : inClip
                          ? "bg-accent/10 hover:bg-accent/20"
                          : q
                            ? "text-ink-faint hover:bg-surface-hover"
                            : "hover:bg-surface-hover";
                  return (
                    <Fragment key={s.id}>
                      <span
                        data-i={i}
                        onClick={() => {
                          onSeek?.(s.start_ms);
                          pick(i);
                        }}
                        className={`group relative cursor-pointer rounded-[4px] px-0.5 transition-colors ${tint}`}
                      >
                        {s.text}
                        <span aria-hidden className="pointer-events-none absolute -top-4 left-0 z-10 hidden select-none rounded bg-ink px-1 font-mono text-[10px] leading-4 text-ink-inverse group-hover:block">
                          {fmtTime(s.start_ms)}
                        </span>
                      </span>{" "}
                    </Fragment>
                  );
                })}
              </p>
              {first !== null && (
                <div className="pointer-events-none sticky bottom-2 mt-3 flex justify-center">
                  <div className="rr-enter pointer-events-auto flex items-center gap-2 rounded-full border border-line bg-surface-raised py-1 pl-3 pr-1 text-xs text-ink shadow-elev-2">
                    {selection ? (
                      <>
                        <span className="font-mono text-[11px]">
                          {fmtTime(selection.start_ms)} → {fmtTime(selection.end_ms)} · {((selection.end_ms - selection.start_ms) / 1000).toFixed(0)} s
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            onMakeClip(selection.start_ms, selection.end_ms);
                            clear();
                          }}
                          className="rr-btn rr-btn-primary rr-btn-sm"
                        >
                          <Scissors className="h-3.5 w-3.5" /> Make this a clip
                        </button>
                      </>
                    ) : (
                      <span>
                        <span className="font-mono text-[11px]">start {fmtTime(sentences[first].start_ms)}</span> · pick the end
                      </span>
                    )}
                    <button type="button" onClick={clear} aria-label="Cancel" className="inline-flex h-7 w-7 items-center justify-center rounded-full text-ink-dim transition-colors hover:bg-surface-overlay hover:text-ink">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
