"use client";

import { useState } from "react";
import { Clapperboard, Clock, Type } from "lucide-react";
import { fmtClock, fmtTime, type Candidate } from "@/lib/podcast";

export type SourceMode = "clip" | "transcript" | "time";

export const SOURCE_MODES: { value: SourceMode; label: string; hint: string; Icon: typeof Clapperboard }[] = [
  { value: "clip", label: "A clip you already have", hint: "Anything found or directed for this recording", Icon: Clapperboard },
  { value: "transcript", label: "A moment in the transcript", hint: "Click the first and last sentence", Icon: Type },
  { value: "time", label: "A stretch of time", hint: "Type the start and the end", Icon: Clock },
];

/** "4:32.5", "1:04:32" or plain seconds → ms (null when it cannot be read). */
export function parseClock(text: string): number | null {
  const parts = text.trim().split(":");
  if (!parts.length || parts.some((p) => !/^\d+(\.\d+)?$/.test(p.trim()))) return null;
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + Number(p);
  return Math.round(seconds * 1000);
}

function ClockInput({ value, label, max, onChange }: { value: number; label: string; max: number; onChange: (ms: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const ms = parseClock(draft);
    if (ms != null) onChange(Math.max(0, Math.min(max, ms)));
    setDraft(null);
  };
  return (
    <label className="rr-field">
      <span className="rr-label">{label}</span>
      <input
        value={draft ?? fmtClock(value)}
        onFocus={(e) => {
          setDraft(fmtClock(value));
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
        className="rr-input rr-input-sm w-[96px] text-center font-mono"
        inputMode="decimal"
      />
    </label>
  );
}

/**
 * What is being re-shaped: a clip that already exists, a moment picked out of
 * the transcript, or a stretch of the recording by the clock.
 */
export default function SourcePicker({
  mode,
  onMode,
  clips,
  clipId,
  onClip,
  range,
  onRange,
  durationMs,
  loading,
}: {
  mode: SourceMode;
  onMode: (mode: SourceMode) => void;
  clips: Candidate[];
  clipId: string | null;
  onClip: (id: string) => void;
  range: { start_ms: number; end_ms: number };
  onRange: (range: { start_ms: number; end_ms: number }) => void;
  durationMs: number;
  loading: boolean;
}) {
  const max = durationMs || 6 * 3600_000;
  return (
    <section className="rr-card p-4">
      <h2 className="rr-h3">What should we re-shape?</h2>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {SOURCE_MODES.map((m) => (
          <button key={m.value} type="button" onClick={() => onMode(m.value)} data-active={mode === m.value} className="rr-chip" title={m.hint}>
            <m.Icon className="h-3.5 w-3.5" /> {m.label}
          </button>
        ))}
      </div>

      {mode === "clip" && (
        <div className="mt-3">
          {loading ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="rr-skeleton h-9" />
              ))}
            </div>
          ) : clips.length === 0 ? (
            <p className="rounded-md border border-dashed border-line-strong px-4 py-6 text-center text-sm text-ink-faint">
              No clips for this recording yet. Pick a moment in the transcript instead, or make some clips first.
            </p>
          ) : (
            <ul className="max-h-[280px] space-y-1 overflow-y-auto pr-1">
              {clips.map((c) => {
                const active = c.id === clipId;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => onClip(c.id)}
                      aria-pressed={active}
                      className={`flex w-full items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                        active ? "border-accent bg-accent/[0.06]" : "border-line hover:border-line-strong"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{c.title}</span>
                      <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                        {fmtTime(c.start_ms)} · {Math.round(c.duration_ms / 1000)}s
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {mode === "time" && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <ClockInput value={range.start_ms} label="From" max={max} onChange={(ms) => onRange({ start_ms: ms, end_ms: Math.max(ms + 3000, range.end_ms) })} />
          <ClockInput value={range.end_ms} label="To" max={max} onChange={(ms) => onRange({ start_ms: Math.min(range.start_ms, ms - 3000), end_ms: ms })} />
          <span className="pb-2 font-mono text-[11px] text-ink-faint">{Math.max(0, Math.round((range.end_ms - range.start_ms) / 1000))}s</span>
        </div>
      )}

      {mode === "transcript" && <p className="mt-3 text-sm text-ink-dim">Click the sentence it should start on, then the one it should end on.</p>}
    </section>
  );
}
