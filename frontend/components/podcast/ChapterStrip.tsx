"use client";

import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { fmtTime, type Candidate, type Chapter } from "@/lib/podcast";

/**
 * The episode map: a scrubbable timeline. Chapters are alternating-tone
 * segments (full title on hover), clips are pills placed by their range
 * (the selected one in the accent colour), and a playhead follows the
 * preview. Clicking the bar seeks, clicking a pill selects that clip.
 */
export default function ChapterStrip({
  chapters,
  candidates,
  durationMs,
  selectedId,
  onSelect,
  currentMs = 0,
  onSeek,
}: {
  chapters: Chapter[];
  candidates: Candidate[];
  durationMs: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** where the preview is playing, in episode milliseconds */
  currentMs?: number;
  /** the producer clicked / scrubbed to this episode time */
  onSeek?: (ms: number) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  if (!durationMs) return null;

  const clamp = (ms: number) => Math.max(0, Math.min(durationMs, ms));
  const pct = (ms: number) => `${(clamp(ms) / durationMs) * 100}%`;
  const msAt = (e: MouseEvent<HTMLElement>) => {
    const el = bar.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return clamp(((e.clientX - r.left) / Math.max(1, r.width)) * durationMs);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!onSeek || e.target !== e.currentTarget) return;
    const step = e.shiftKey ? 30_000 : 5_000;
    const next =
      e.key === "ArrowLeft" ? currentMs - step : e.key === "ArrowRight" ? currentMs + step : e.key === "Home" ? 0 : e.key === "End" ? durationMs : null;
    if (next === null) return;
    e.preventDefault();
    onSeek(clamp(next));
  };

  const shown = hoverMs ?? clamp(currentMs);
  const moments = candidates.length;

  return (
    <div className="rr-card rr-enter px-4 pb-3 pt-2.5">
      <div className="flex items-center justify-between gap-3 text-xs text-ink-faint">
        <span>
          {chapters.length ? `${chapters.length} chapter${chapters.length === 1 ? "" : "s"} · ` : ""}
          {moments} {moments === 1 ? "clip" : "clips"}
        </span>
        <span className="font-mono text-[11px] tabular-nums">
          <span className={hoverMs != null ? "text-ink" : "text-ink-dim"}>{fmtTime(shown)}</span> / {fmtTime(durationMs)}
        </span>
      </div>

      <div
        ref={bar}
        role="slider"
        tabIndex={0}
        aria-label="Episode timeline"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationMs / 1000)}
        aria-valuenow={Math.round(clamp(currentMs) / 1000)}
        aria-valuetext={fmtTime(currentMs)}
        onKeyDown={onKey}
        onClick={(e) => onSeek?.(msAt(e))}
        onMouseMove={(e) => setHoverMs(msAt(e))}
        onMouseLeave={() => setHoverMs(null)}
        className={`relative mt-2 h-12 select-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${onSeek ? "cursor-pointer" : ""}`}
      >
        {/* chapters */}
        <div className="absolute inset-0 flex overflow-hidden rounded-md border border-line bg-surface-overlay">
          {chapters.map((ch, i) => (
            <div
              key={ch.id}
              title={`${ch.title} · ${fmtTime(ch.start_ms)} – ${fmtTime(ch.end_ms)}`}
              style={{ width: pct(ch.end_ms - ch.start_ms) }}
              className={`h-full min-w-0 shrink-0 truncate px-2 pt-1 text-[11px] font-medium leading-4 text-ink-dim transition-colors hover:bg-surface-hover ${
                i % 2 ? "bg-surface-raised" : ""
              }`}
            >
              {ch.title}
            </div>
          ))}
        </div>

        {/* clip markers */}
        {candidates.map((c) => {
          const active = c.id === selectedId;
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={active}
              title={`${c.custom ? "Your cut" : `#${c.rank}`} · ${c.title} · ${fmtTime(c.start_ms)} – ${fmtTime(c.end_ms)}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(c.id);
              }}
              style={{ left: pct(c.start_ms), width: `max(8px, ${pct(c.end_ms - c.start_ms)})` }}
              className={`absolute bottom-1.5 h-3.5 rounded-full border transition-transform duration-150 hover:scale-y-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                active
                  ? "z-20 border-accent bg-accent shadow-glow-accent"
                  : c.custom
                  ? "z-10 border-ink-faint bg-ink-faint hover:bg-ink-dim"
                  : "z-10 border-ink/70 bg-ink/70 hover:border-accent hover:bg-accent"
              }`}
            />
          );
        })}

        {/* hover scrub line */}
        {hoverMs != null && onSeek && <span className="pointer-events-none absolute inset-y-0 z-20 w-px bg-ink/40" style={{ left: pct(hoverMs) }} />}

        {/* playhead */}
        <span className="pointer-events-none absolute -top-1 bottom-0 z-30 w-0.5 -translate-x-1/2 bg-accent transition-[left] duration-150 ease-linear" style={{ left: pct(currentMs) }}>
          <span className="absolute -left-[3px] -top-0.5 h-2 w-2 rounded-full bg-accent" />
        </span>
      </div>
    </div>
  );
}
