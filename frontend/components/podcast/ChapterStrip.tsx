"use client";

import { fmtTime, type Candidate, type Chapter } from "@/lib/podcast";

/** Episode overview bar: chapters as segments, candidates as markers. */
export default function ChapterStrip({
  chapters,
  candidates,
  durationMs,
  selectedId,
  onSelect,
}: {
  chapters: Chapter[];
  candidates: Candidate[];
  durationMs: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (!durationMs) return null;
  const pct = (ms: number) => `${Math.max(0, Math.min(100, (ms / durationMs) * 100))}%`;
  return (
    <div className="rounded-lg border border-line bg-surface-raised p-4 shadow-elev-1">
      <div className="flex items-center justify-between">
        <span className="rr-eyebrow">Episode map</span>
        <span className="font-mono text-[11px] text-ink-faint">
          {chapters.length} chapters · {candidates.length} candidates · {fmtTime(durationMs)}
        </span>
      </div>
      <div className="relative mt-3 h-9">
        <div className="absolute inset-x-0 top-0 flex h-5 overflow-hidden rounded-full border border-line bg-surface-overlay">
          {chapters.map((ch, i) => (
            <div
              key={ch.id}
              title={`${fmtTime(ch.start_ms)} · ${ch.title}`}
              style={{ width: pct(ch.end_ms - ch.start_ms) }}
              className={`truncate border-r border-line px-2 font-mono text-[10px] leading-5 text-ink-dim ${i % 2 ? "bg-surface-hover/60" : ""}`}
            >
              {ch.title}
            </div>
          ))}
        </div>
        {candidates.map((c) => (
          <button
            key={c.id}
            type="button"
            title={`${c.custom ? "custom" : `#${c.rank}`} ${c.title}`}
            onClick={() => onSelect(c.id)}
            style={{ left: pct(c.start_ms), width: `max(6px, ${pct(c.end_ms - c.start_ms)})` }}
            className={`absolute bottom-0 h-2.5 rounded-sm ${selectedId === c.id ? "bg-accent" : c.custom ? "bg-ink-faint" : "bg-ink/70 hover:bg-accent"}`}
          />
        ))}
      </div>
    </div>
  );
}
