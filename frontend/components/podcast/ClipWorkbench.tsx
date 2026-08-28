"use client";

import { useRef } from "react";
import { Download, ExternalLink, Loader2, Play, RotateCcw, Save, Volume2 } from "lucide-react";
import { describeStatus, fmtClock, fmtSeconds, fmtTime, type Candidate, type ClipEdit, type RenderReport, type StatusEvent } from "@/lib/podcast";
import type { AudioProof } from "@/lib/engine";
import SoundTools from "./SoundTools";

export interface ExportLink {
  label: string;
  url: string;
  name: string;
}

const NUDGES: { label: string; ms: number }[] = [
  { label: "−1s", ms: -1000 },
  { label: "−0.2", ms: -200 },
  { label: "+0.2", ms: 200 },
  { label: "+1s", ms: 1000 },
];

function Nudge({ value, onChange, min, max }: { value: number; onChange: (ms: number) => void; min: number; max: number }) {
  return (
    <div className="flex items-center gap-1">
      {NUDGES.slice(0, 2).map((n) => (
        <button key={n.label} type="button" onClick={() => onChange(Math.max(min, value + n.ms))} className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-dim hover:border-accent hover:text-accent">
          {n.label}
        </button>
      ))}
      <span className="min-w-[64px] text-center font-mono text-xs text-ink">{fmtClock(value)}</span>
      {NUDGES.slice(2).map((n) => (
        <button key={n.label} type="button" onClick={() => onChange(Math.min(max, value + n.ms))} className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-dim hover:border-accent hover:text-accent">
          {n.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-dim">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-[var(--rr-accent)]" />
      {label}
    </label>
  );
}

/**
 * The selected clip: plays instantly from the raw source (media fragment), then
 * the rendered preview once it exists; boundary/title/caption edits; preview and
 * export with live engine progress; download links for the export.
 */
export default function ClipWorkbench({
  cand,
  edit,
  range,
  dirty,
  durationMs,
  sourceUrl,
  previewUrl,
  previewReport,
  exportReport,
  exportLinks,
  clipText,
  audioProof,
  busy,
  events,
  error,
  onEdit,
  onSave,
  onReset,
  onPreview,
  onExport,
}: {
  cand: Candidate;
  edit: ClipEdit;
  range: { start_ms: number; end_ms: number };
  dirty: boolean;
  durationMs: number;
  sourceUrl: string | null;
  previewUrl: string | null;
  previewReport: RenderReport | null;
  exportReport: RenderReport | null;
  exportLinks: ExportLink[];
  clipText: string | null;
  audioProof: AudioProof | null | undefined;
  busy: "preview" | "export" | null;
  events: StatusEvent[];
  error: string | null;
  onEdit: (patch: ClipEdit) => void;
  onSave: () => void;
  onReset: () => void;
  onPreview: () => void;
  onExport: () => void;
}) {
  const latest = events[events.length - 1] ?? null;
  const showingPreview = !!previewUrl && !dirty;
  const fragmentUrl = sourceUrl ? `${sourceUrl}#t=${(range.start_ms / 1000).toFixed(2)},${(range.end_ms / 1000).toFixed(2)}` : null;
  const report = showingPreview ? previewReport : null;
  const videoRef = useRef<HTMLVideoElement>(null);

  // Inside the click handler (a user gesture), so every browser allows audible playback.
  const unmuteAndPlay = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = false;
    v.defaultMuted = false;
    v.volume = 1;
    void v.play().catch(() => {});
  };

  return (
    <div className="rounded-lg border border-line bg-surface-raised p-4 shadow-elev-1">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="rr-eyebrow">{cand.custom ? "Custom clip" : `Candidate #${cand.rank}`}</span>
          <h2 className="rr-h2 mt-1">{edit.title ?? cand.title}</h2>
          <p className="font-mono text-[11px] text-ink-faint">
            {fmtTime(range.start_ms)} → {fmtTime(range.end_ms)} · {fmtSeconds(range.end_ms - range.start_ms)}
          </p>
        </div>
      </div>

      <div className={`relative mt-4 overflow-hidden rounded-md bg-ink ${showingPreview ? "aspect-[9/16] max-h-[520px]" : "aspect-video"}`}>
        {showingPreview ? (
          <video
            key={previewUrl}
            ref={videoRef}
            controls
            playsInline
            preload="metadata"
            src={previewUrl ?? undefined}
            onPlay={(e) => {
              e.currentTarget.muted = false;
              if (e.currentTarget.volume === 0) e.currentTarget.volume = 1;
            }}
            className="h-full w-full object-contain"
          />
        ) : fragmentUrl ? (
          <video
            key={fragmentUrl}
            ref={videoRef}
            controls
            playsInline
            preload="metadata"
            src={fragmentUrl}
            onPlay={(e) => {
              e.currentTarget.muted = false;
              if (e.currentTarget.volume === 0) e.currentTarget.volume = 1;
            }}
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-ink-inverse/70">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}
        <span className="absolute left-3 top-3 rounded-full bg-surface-raised/90 px-2 py-0.5 font-mono text-[11px] text-ink">
          {showingPreview ? "rendered preview" : "raw source · this range"}
        </span>
      </div>
      <p className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-ink-dim">
        <Volume2 className="h-3 w-3 text-accent" />
        {report
          ? report.has_audio
            ? `sound on · AAC stereo${report.loudness ? ` · ${report.loudness.integrated_lufs} LUFS` : ""}${report.captions ? " · captions burned in" : ""}`
            : "this render has no audio track"
          : "playing the original recording with its sound; render a preview to hear the mastered audio and see captions"}
      </p>
      <SoundTools proof={showingPreview ? audioProof : undefined} onUnmutePlay={unmuteAndPlay} />

      <div className="mt-4 space-y-3 rounded-md border border-line bg-surface-overlay p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="rr-eyebrow">Start</span>
          <Nudge value={range.start_ms} min={0} max={range.end_ms - 3000} onChange={(ms) => onEdit({ start_ms: ms })} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="rr-eyebrow">End</span>
          <Nudge value={range.end_ms} min={range.start_ms + 3000} max={durationMs || range.end_ms + 60_000} onChange={(ms) => onEdit({ end_ms: ms })} />
        </div>
        <input
          value={edit.title ?? cand.title}
          onChange={(e) => onEdit({ title: e.target.value })}
          className="w-full rounded-md border border-line bg-surface-raised px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
          aria-label="Clip title"
        />
        <div className="flex flex-wrap gap-4">
          <Toggle label="Captions" checked={edit.captions ?? true} onChange={(v) => onEdit({ captions: v })} />
          <Toggle label="Tighten pauses" checked={edit.tighten_pauses ?? true} onChange={(v) => onEdit({ tighten_pauses: v })} />
          <Toggle label="Remove fillers" checked={edit.remove_fillers ?? true} onChange={(v) => onEdit({ remove_fillers: v })} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={onSave} disabled={!dirty} className="inline-flex items-center gap-1 rounded-md bg-ink px-2.5 py-1 text-[11px] text-ink-inverse disabled:opacity-40">
            <Save className="h-3 w-3" /> Save edits
          </button>
          <button type="button" onClick={onReset} className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-dim hover:border-accent hover:text-accent">
            <RotateCcw className="h-3 w-3" /> Reset to Claude&apos;s pick
          </button>
        </div>
        <p className="text-[11px] leading-relaxed text-ink-faint">
          Edits are non-destructive: they are saved to edits/clip-edits.json in your store and applied when the clip renders.
        </p>
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={onPreview}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md bg-ink px-3 py-1.5 text-xs font-semibold text-ink-inverse shadow-glow-accent disabled:opacity-40 disabled:shadow-none"
        >
          {busy === "preview" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 text-accent" />}
          Render preview
        </button>
        <button
          type="button"
          onClick={onExport}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:border-accent hover:text-accent disabled:opacity-40"
        >
          {busy === "export" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          Export 9:16 + 16:9 + captions
        </button>
      </div>
      {(busy || latest) && (
        <p className="mt-2 font-mono text-[11px] text-ink-dim">
          {busy ? `${busy === "preview" ? "preview" : "export"} · ${describeStatus(latest)}` : describeStatus(latest)}
        </p>
      )}
      {error && <p className="mt-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[11px] text-danger">{error}</p>}

      {exportReport && exportLinks.length > 0 && (
        <div className="mt-4 rounded-md border border-line p-3">
          <div className="flex items-center justify-between">
            <span className="rr-eyebrow">Export</span>
            <span className="font-mono text-[11px] text-ink-faint">
              {exportReport.width}×{exportReport.height} · {fmtSeconds(exportReport.duration_ms)}
              {exportReport.loudness ? ` · ${exportReport.loudness.integrated_lufs} LUFS` : ""}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {exportLinks.map((l) => (
              <a
                key={l.label}
                href={l.url}
                download={l.name}
                className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-ink transition-colors hover:border-accent hover:text-accent"
              >
                <Download className="h-3 w-3" /> {l.label}
              </a>
            ))}
            {exportLinks[0] && (
              <a href={exportLinks[0].url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-ink-dim hover:border-accent hover:text-accent">
                <ExternalLink className="h-3 w-3" /> Open in new tab
              </a>
            )}
          </div>
        </div>
      )}

      {clipText && (
        <div className="mt-4">
          <span className="rr-eyebrow">Clip transcript</span>
          <p className="mt-1 text-xs leading-relaxed text-ink-dim">{clipText}</p>
        </div>
      )}
      {!clipText && cand.quote && (
        <div className="mt-4">
          <span className="rr-eyebrow">Opens with</span>
          <p className="mt-1 text-xs leading-relaxed text-ink-dim">&ldquo;{cand.quote}&rdquo;</p>
        </div>
      )}
    </div>
  );
}
