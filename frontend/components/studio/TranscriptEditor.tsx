"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Flag, RotateCcw, Scissors, Search, UserRound, VolumeX, Volume2 } from "lucide-react";
import { fmtPosition, type EditOperation, type EpisodeEdits } from "@/lib/studio";
import { rowAt, type EditorRow, type EditorWord, type Marks } from "./helpers";

const OVERSCAN = 900;
const MAX_ROWS = 200;
const CHIP_H = 26;
const SECTION_H = 34;

export interface Range {
  start_ms: number;
  end_ms: number;
}

const estimate = (row: EditorRow) => 10 + Math.max(1, Math.ceil(row.text.length / 62)) * 26;

/**
 * The episode as text — the main way to edit it. Select words the way you would
 * in a document, then remove, silence or bleep them. Nothing is thrown away:
 * removed words stay on the page with a line through them.
 */
export default function TranscriptEditor({
  rows,
  words,
  marks,
  edits,
  currentMs,
  onSeek,
  onAction,
  onUndoOperation,
  onAssignSpeaker,
  onRenameSpeaker,
  onAddSection,
  onSelection,
}: {
  rows: EditorRow[];
  words: EditorWord[];
  marks: Marks;
  edits: EpisodeEdits;
  currentMs: number;
  onSeek: (ms: number) => void;
  onAction: (type: EditOperation, range: Range) => void;
  onUndoOperation: (id: string) => void;
  onAssignSpeaker: (range: Range, speakerId: string | null) => void;
  onRenameSpeaker: (id: string, name: string) => void;
  onAddSection: (ms: number, hint: string) => void;
  onSelection: (range: Range | null) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [head, setHead] = useState<number | null>(null);
  const dragging = useRef(false);
  const moved = useRef(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(800);
  const [query, setQuery] = useState("");
  const [matchAt, setMatchAt] = useState(0);
  const [follow, setFollow] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  /* ---- geometry (windowed rendering keeps thousands of lines smooth) ---- */

  const sectionRow = useMemo(() => {
    const map = new Map<number, { id: string; title: string }>();
    for (const s of edits.sections ?? []) {
      const i = rowAt(rows, s.start_ms);
      if (i >= 0) map.set(i, { id: s.id, title: s.title });
    }
    return map;
  }, [edits.sections, rows]);

  const speakerRow = useMemo(() => {
    const map = new Map<number, string>();
    for (const [start, , id] of edits.speaker_map ?? []) {
      const i = rowAt(rows, start);
      if (i >= 0 && !map.has(i)) map.set(i, id);
    }
    return map;
  }, [edits.speaker_map, rows]);

  const offsets = useMemo(() => {
    const out = new Array<number>(rows.length + 1);
    let y = 0;
    for (let i = 0; i < rows.length; i++) {
      out[i] = y;
      y += estimate(rows[i]) + (sectionRow.has(i) ? SECTION_H : 0) + (speakerRow.has(i) ? CHIP_H : 0);
    }
    out[rows.length] = y;
    return out;
  }, [rows, sectionRow, speakerRow]);

  const total = offsets[rows.length] ?? 0;

  const first = useMemo(() => {
    let lo = 0;
    let hi = rows.length - 1;
    const target = Math.max(0, scrollTop - OVERSCAN);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= target) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }, [offsets, rows.length, scrollTop]);

  const last = useMemo(() => {
    const bottom = scrollTop + viewport + OVERSCAN;
    let i = first;
    while (i < rows.length && offsets[i] < bottom && i - first < MAX_ROWS) i++;
    return Math.min(rows.length, Math.max(i, first + 1));
  }, [first, offsets, rows.length, scrollTop, viewport]);

  const frame = useRef(0);
  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = scrollRef.current;
      if (!el) return;
      setScrollTop(el.scrollTop);
      setViewport(el.clientHeight);
    });
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const timer = setTimeout(() => setViewport(el.clientHeight), 0);
    return () => clearTimeout(timer);
  }, []);

  const scrollToRow = useCallback(
    (i: number) => {
      const el = scrollRef.current;
      if (!el || i < 0 || i >= offsets.length) return;
      el.scrollTop = Math.max(0, offsets[i] - el.clientHeight / 3);
      setScrollTop(el.scrollTop);
    },
    [offsets]
  );

  const playingRow = rowAt(rows, currentMs);

  // follow the playhead only when it has left the visible part of the page
  useEffect(() => {
    if (!follow || playingRow < 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const y = offsets[playingRow] ?? 0;
    if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - 60) {
      const timer = setTimeout(() => scrollToRow(playingRow), 0);
      return () => clearTimeout(timer);
    }
  }, [follow, playingRow, offsets, scrollToRow]);

  /* ---- selection ---- */

  const selection: Range | null = useMemo(() => {
    if (anchor == null || head == null || !words.length) return null;
    const lo = Math.min(anchor, head);
    const hi = Math.max(anchor, head);
    return { start_ms: words[lo].s, end_ms: words[hi].e };
  }, [anchor, head, words]);

  const selectionKey = selection ? `${selection.start_ms}:${selection.end_ms}` : "";
  useEffect(() => {
    const timer = setTimeout(() => onSelection(selectionKey ? { start_ms: Number(selectionKey.split(":")[0]), end_ms: Number(selectionKey.split(":")[1]) } : null), 0);
    return () => clearTimeout(timer);
  }, [selectionKey, onSelection]);

  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const startAt = (i: number, shift: boolean) => {
    moved.current = shift;
    dragging.current = true;
    if (shift && anchor != null) setHead(i);
    else {
      setAnchor(i);
      setHead(i);
    }
  };

  const extendTo = (i: number) => {
    if (!dragging.current) return;
    moved.current = true;
    setHead(i);
  };

  const releaseAt = (word: EditorWord) => {
    if (!moved.current) {
      onSeek(word.s);
      setAnchor(word.i);
      setHead(word.i);
    }
    dragging.current = false;
  };

  const clear = useCallback(() => {
    setAnchor(null);
    setHead(null);
  }, []);

  /* ---- search ---- */

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: number[] = [];
    for (const row of rows) if (row.text.toLowerCase().includes(q)) out.push(row.i);
    return out;
  }, [query, rows]);

  const jump = (delta: number) => {
    if (!matches.length) return;
    const next = (matchAt + delta + matches.length) % matches.length;
    setMatchAt(next);
    scrollToRow(matches[next]);
    onSeek(rows[matches[next]].start_ms);
  };

  /* ---- keyboard ---- */

  const keys = useRef({ selection, onAction, clear });
  useEffect(() => {
    keys.current = { selection, onAction, clear };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName ?? "";
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!t?.isContentEditable;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = keys.current;
      if (e.key === "Escape") {
        k.clear();
        return;
      }
      if (!k.selection) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        k.onAction("cut", k.selection);
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        k.onAction("mute", k.selection);
      } else if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        k.onAction("bleep", k.selection);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---- render ---- */

  const speakers = edits.speakers ?? {};
  const speakerIds = Object.keys(speakers);
  const q = query.trim().toLowerCase();

  const word = (w: EditorWord) => {
    const mark = marks.byWord.get(w.i);
    const inSelection = anchor != null && head != null && w.i >= Math.min(anchor, head) && w.i <= Math.max(anchor, head);
    const playing = currentMs >= w.s && currentMs < w.e;
    const hit = q.length > 1 && w.text.toLowerCase().includes(q);
    const classes = [
      "cursor-text rounded-[3px] px-[1px]",
      mark?.cut || mark?.tight ? "text-ink-faint line-through decoration-danger/70" : "",
      mark?.mute ? "underline decoration-processing decoration-2 underline-offset-2" : "",
      mark?.bleep ? "underline decoration-[#7C3AED] decoration-2 underline-offset-2" : "",
      inSelection ? "bg-accent/25" : hit ? "bg-processing/25" : "",
      playing ? "bg-ink text-ink-inverse" : "",
    ].join(" ");
    return (
      <span
        key={w.i}
        data-i={w.i}
        onMouseDown={(e) => startAt(w.i, e.shiftKey)}
        onMouseEnter={() => extendTo(w.i)}
        onMouseUp={() => releaseAt(w)}
        title={fmtPosition(w.s)}
        className={classes}
      >
        {w.text}{" "}
      </span>
    );
  };

  const visible = rows.slice(first, last);

  return (
    <section className="rr-card rr-enter flex min-h-[420px] flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setMatchAt(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                jump(e.shiftKey ? -1 : 1);
              }
              if (e.key === "Escape") setQuery("");
            }}
            placeholder="Find in the episode  (/)"
            aria-label="Find in the episode"
            className="rr-input rr-input-sm pl-8"
          />
        </div>
        {q.length > 1 ? (
          <span className="rr-mono text-ink-faint">
            {matches.length ? `${matchAt + 1} of ${matches.length}` : "no matches"}
          </span>
        ) : null}
        <button type="button" className="rr-chip" data-active={follow} onClick={() => setFollow((f) => !f)} title="Scroll the text along with the playhead">
          Follow along
        </button>
      </header>

      {selection ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-surface-overlay px-3 py-2">
          <span className="rr-mono mr-1 text-ink-dim">
            {fmtPosition(selection.start_ms)} – {fmtPosition(selection.end_ms)}
          </span>
          <button type="button" className="rr-btn rr-btn-sm" onClick={() => onAction("cut", selection)} title="Delete">
            <Scissors className="h-3.5 w-3.5" /> Remove
          </button>
          <button type="button" className="rr-btn rr-btn-sm" onClick={() => onAction("mute", selection)} title="M">
            <VolumeX className="h-3.5 w-3.5" /> Silence
          </button>
          <button type="button" className="rr-btn rr-btn-sm" onClick={() => onAction("bleep", selection)} title="B">
            <Volume2 className="h-3.5 w-3.5" /> Bleep
          </button>
          <select
            className="rr-select rr-select-sm w-auto"
            value=""
            aria-label="Who is speaking here"
            onChange={(e) => {
              if (!e.target.value) return;
              onAssignSpeaker(selection, e.target.value);
              e.currentTarget.value = "";
            }}
          >
            <option value="">Who is speaking…</option>
            {speakerIds.map((sid) => (
              <option key={sid} value={sid}>
                {speakers[sid]?.name ?? sid}
              </option>
            ))}
            <option value="new">Add a new voice</option>
          </select>
          <button type="button" className="rr-btn rr-btn-ghost rr-btn-sm" onClick={() => onSeek(selection.start_ms)}>
            Play from here
          </button>
          <button type="button" className="rr-btn rr-btn-ghost rr-btn-sm ml-auto" onClick={clear}>
            Clear
          </button>
        </div>
      ) : null}

      <div ref={scrollRef} onScroll={onScroll} className="relative max-h-[62vh] min-h-[360px] flex-1 overflow-y-auto px-4 py-3 leading-[1.9]">
        {!rows.length ? (
          <p className="py-10 text-center text-sm text-ink-faint">There is no transcript for this episode yet.</p>
        ) : (
          <>
            <div style={{ height: offsets[first] }} />
            {visible.map((row) => {
              const section = sectionRow.get(row.i);
              const speakerId = speakerRow.get(row.i);
              const speaker = speakerId ? speakers[speakerId] : null;
              return (
                <div key={row.i} className={`group relative -mx-2 rounded-sm px-2 ${row.i === playingRow ? "bg-accent/5" : ""}`}>
                  {section ? (
                    <div className="mb-1 flex items-center gap-1.5 border-t border-line pt-2 text-xs font-semibold uppercase tracking-wide text-ink-dim">
                      <Flag className="h-3 w-3 text-accent" /> {section.title}
                    </div>
                  ) : null}
                  {speaker && speakerId ? (
                    <div className="flex items-center gap-1.5 py-0.5">
                      <button
                        type="button"
                        onClick={() => {
                          setRenaming(speakerId);
                          setRenameDraft(speaker.name);
                        }}
                        className="rr-chip h-6 text-xs"
                        style={{ borderColor: speaker.color, color: speaker.color }}
                        title="Rename this voice"
                      >
                        <UserRound className="h-3 w-3" /> {speaker.name}
                      </button>
                      {renaming === speakerId ? (
                        <input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => setRenaming(null)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && renameDraft.trim()) {
                              onRenameSpeaker(speakerId, renameDraft.trim());
                              setRenaming(null);
                            }
                            if (e.key === "Escape") setRenaming(null);
                          }}
                          aria-label="Name this voice"
                          className="rr-input rr-input-sm w-40"
                        />
                      ) : null}
                    </div>
                  ) : null}
                  <p className="text-[0.95rem]">
                    <button
                      type="button"
                      onClick={() => onAddSection(row.start_ms, row.text)}
                      title="Add chapter here"
                      className="mr-1 align-middle text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <Flag className="inline h-3 w-3" />
                    </button>
                    {row.words.map((w) => {
                      const op = marks.starts.get(w.i);
                      return (
                        <span key={w.i}>
                          {op ? (
                            <button
                              type="button"
                              onClick={() => onUndoOperation(op.id)}
                              title={op.type === "cut" ? "Bring this back" : "Undo this change"}
                              className="mr-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full border border-line-strong align-middle text-ink-faint hover:border-accent hover:text-accent"
                            >
                              <RotateCcw className="h-2.5 w-2.5" />
                            </button>
                          ) : null}
                          {word(w)}
                        </span>
                      );
                    })}
                  </p>
                </div>
              );
            })}
            <div style={{ height: Math.max(0, total - (offsets[last] ?? total)) }} />
          </>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-3 border-t border-line px-3 py-1.5 text-[11px] text-ink-faint">
        <span>Drag across words to select · shift-click to extend</span>
        <span className="ml-auto flex items-center gap-1">
          <span className="rr-kbd">Delete</span> remove
          <span className="rr-kbd ml-1">M</span> silence
          <span className="rr-kbd ml-1">B</span> bleep
        </span>
      </footer>
    </section>
  );
}
