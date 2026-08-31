"use client";

import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  ExternalLink,
  Loader2,
  MessageSquare,
  Pencil,
  Play,
  RotateCcw,
  Save,
  Sparkles,
  UserRound,
} from "lucide-react";
import { CAPTION_PRESETS, DURATION_MODES, FILLER_POLICIES, SILENCE_POLICIES, complianceBadges, type ClipPlan, type Compliance, type EditVersion, type RequestSpec } from "@/lib/director";
import { LAYOUT_LABELS, LAYOUT_MODES, captionPresetOf, describeStatus, fmtClock, fmtSeconds, fmtTime, previewFile, type Candidate, type ClipEdit, type RenderReport, type StatusEvent } from "@/lib/podcast";
import type { AudioProof } from "@/lib/engine";
import ComplianceBadges from "./ComplianceBadges";
import SoundTools from "./SoundTools";

export interface ExportLink {
  label: string;
  url: string;
  name: string;
}

const MIN_CLIP_MS = 3000;
const SLIDER_PAD_MS = 30_000;
const SLIDER_STEP_MS = 100;

const LAYOUT_TONE: Record<string, string> = {
  solo_follow: "bg-accent",
  stacked_two: "bg-ready",
  side_by_side: "bg-ready",
  screen_share: "bg-processing",
  full_frame: "bg-ink-faint",
  fixed_crop: "bg-ink-dim",
  original: "bg-line-strong",
};

const DURATION_CHIPS: { value: string; label: string; hint: string }[] = DURATION_MODES.map((m) => ({
  value: m,
  label: m === "maximum" ? "max" : m,
  hint: m === "natural" ? "About this long" : m === "strict" ? "Exactly this long" : "At most this long",
}));

const NUDGES: { ms: number; label: string; Icon: typeof ChevronLeft }[] = [
  { ms: -1000, label: "−1 s", Icon: ChevronsLeft },
  { ms: -200, label: "−0.2 s", Icon: ChevronLeft },
  { ms: 200, label: "+0.2 s", Icon: ChevronRight },
  { ms: 1000, label: "+1 s", Icon: ChevronsRight },
];

/* Two overlapping native sliders: the inputs are transparent and ignore the
   pointer, only their thumbs catch it, so both handles stay draggable. */
const RANGE_CSS = `
.cw-range { position: absolute; left: 0; right: 0; top: 50%; height: 18px; margin: -9px 0 0; width: 100%; -webkit-appearance: none; appearance: none; background: transparent; pointer-events: none; outline: none; }
.cw-range::-webkit-slider-runnable-track { height: 18px; background: transparent; }
.cw-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; pointer-events: auto; width: 18px; height: 18px; border-radius: 999px; background: var(--rr-surface-1); border: 2px solid var(--rr-text); box-shadow: 0 1px 4px rgba(22,19,15,0.25); cursor: grab; }
.cw-range::-moz-range-track { background: transparent; }
.cw-range::-moz-range-thumb { pointer-events: auto; width: 14px; height: 14px; border-radius: 999px; background: var(--rr-surface-1); border: 2px solid var(--rr-text); cursor: grab; }
.cw-range:active::-webkit-slider-thumb, .cw-range:active::-moz-range-thumb { border-color: var(--rr-accent); cursor: grabbing; }
.cw-range:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px var(--rr-focus-ring); }
.cw-range:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 3px var(--rr-focus-ring); }
`;

/** "4:32.5", "1:04:32", or plain seconds → ms (null when unreadable). */
function parseClock(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.some((p) => !/^\d+(\.\d+)?$/.test(p.trim()))) return null;
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + Number(p);
  return Math.round(seconds * 1000);
}

const fmtLufs = (value: number) => `${value.toFixed(1).replace("-", "−")} LUFS`;

/** The progress line while a render runs; unknown stages fall back to something plain. */
function statusLine(evt: StatusEvent | null): string {
  if (!evt) return "Starting…";
  const text = describeStatus(evt);
  if (!text.endsWith(`: ${evt.stage}`)) return text;
  return typeof evt.message === "string" && evt.message ? evt.message : "Working…";
}

function TitleEditor({ value, onCommit }: { value: string; onCommit: (title: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    setDraft(null);
  };
  if (draft !== null) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(null);
        }}
        className="rr-input mt-1 font-semibold"
        aria-label="Clip title"
      />
    );
  }
  return (
    <button type="button" onClick={() => setDraft(value)} className="group mt-1 flex w-full items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" title="Rename this clip">
      <h2 className="rr-h3 min-w-0 truncate">{value}</h2>
      <Pencil className="h-3.5 w-3.5 shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  );
}

function TimeInput({ value, min, max, label, onChange }: { value: number; min: number; max: number; label: string; onChange: (ms: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const ms = parseClock(draft);
    if (ms != null) onChange(Math.max(min, Math.min(max, ms)));
    setDraft(null);
  };
  return (
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
      className="rr-input rr-input-sm w-[70px] px-1 text-center font-mono text-[12px]"
      aria-label={`${label} time`}
      inputMode="decimal"
    />
  );
}

function Boundary({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (ms: number) => void }) {
  const nudge = (ms: number) => onChange(Math.max(min, Math.min(max, value + ms)));
  const button = (n: (typeof NUDGES)[number]) => (
    <button
      key={n.label}
      type="button"
      onClick={() => nudge(n.ms)}
      title={n.label}
      aria-label={`${label} ${n.label}`}
      className="flex h-[26px] w-[22px] shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface-overlay hover:text-ink active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <n.Icon className="h-3.5 w-3.5" />
    </button>
  );
  return (
    <div className="rr-field">
      <span className="rr-label">{label}</span>
      <div className="flex items-center gap-0.5">
        {NUDGES.slice(0, 2).map(button)}
        <TimeInput value={value} min={min} max={max} label={label} onChange={onChange} />
        {NUDGES.slice(2).map(button)}
      </div>
    </div>
  );
}

function DualRange({
  min,
  max,
  start,
  end,
  original,
  onStart,
  onEnd,
}: {
  min: number;
  max: number;
  start: number;
  end: number;
  original: { start_ms: number; end_ms: number };
  onStart: (ms: number) => void;
  onEnd: (ms: number) => void;
}) {
  const span = Math.max(1, max - min);
  const left = (ms: number) => `${((Math.max(min, ms) - min) / span) * 100}%`;
  const width = (a: number, b: number) => `${(Math.max(0, Math.min(max, b) - Math.max(min, a)) / span) * 100}%`;
  return (
    <div className="relative h-8">
      <style>{RANGE_CSS}</style>
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-surface-overlay" />
      <div className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-ink/10" style={{ left: left(original.start_ms), width: width(original.start_ms, original.end_ms) }} title="The range as found" />
      <div className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent" style={{ left: left(start), width: width(start, end) }} />
      <input type="range" className="cw-range" min={min} max={max} step={SLIDER_STEP_MS} value={start} onChange={(e) => onStart(Number(e.target.value))} aria-label="Start handle" />
      <input type="range" className="cw-range" min={min} max={max} step={SLIDER_STEP_MS} value={end} onChange={(e) => onEnd(Number(e.target.value))} aria-label="End handle" />
    </div>
  );
}

function Disclosure({ label, count, extra, children }: { label: string; count?: number; extra?: ReactNode; children: ReactNode }) {
  return (
    <details className="group rounded-md border border-line">
      <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3 py-2 text-[13px] text-ink-dim transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
        <span className="font-medium">{label}</span>
        {count != null && <span className="rr-kbd">{count}</span>}
        {extra && (
          <span
            className="ml-auto flex items-center gap-1"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            {extra}
          </span>
        )}
      </summary>
      <div className="border-t border-line px-3 py-2.5">{children}</div>
    </details>
  );
}

/**
 * The selected clip: a phone-framed player (the rendered preview once it
 * exists, else the range straight from the recording), the layout timeline
 * and the people on screen, boundary and cleanup edits, the planned cuts with
 * per-cut restore, versions, conversational revisions, preview and export.
 */
export default function ClipWorkbench({
  cand,
  spec,
  edit,
  baseEdit,
  range,
  dirty,
  durationMs,
  sourceUrl,
  previewUrl,
  previewReport,
  exportReport,
  exportLinks,
  plan,
  compliance,
  thumbUrls,
  audioProof,
  busy,
  events,
  error,
  revising,
  revisionNote,
  onEdit,
  onSave,
  onReset,
  onPreview,
  onExport,
  onUseVersion,
  onRevise,
  onTime,
  currentMs,
  onSeek,
}: {
  cand: Candidate;
  spec: RequestSpec | null;
  /** the effective edit (active version overlaid) */
  edit: ClipEdit;
  /** the stored edit record (versions live here) */
  baseEdit: ClipEdit;
  range: { start_ms: number; end_ms: number };
  dirty: boolean;
  durationMs: number;
  sourceUrl: string | null;
  previewUrl: string | null;
  previewReport: RenderReport | null;
  exportReport: RenderReport | null;
  exportLinks: ExportLink[];
  plan: ClipPlan | null;
  compliance: Compliance | null;
  /** face thumbnails of the people on screen, by person id */
  thumbUrls: Record<string, string>;
  audioProof: AudioProof | null | undefined;
  busy: "preview" | "export" | null;
  events: StatusEvent[];
  error: string | null;
  revising: boolean;
  revisionNote: string | null;
  onEdit: (patch: ClipEdit) => void;
  onSave: () => void;
  onReset: () => void;
  onPreview: () => void;
  onExport: () => void;
  onUseVersion: (n: number | null) => void;
  onRevise: (instruction: string) => void;
  /** the player's position in clip-relative ms, about four times a second while it plays */
  onTime?: (ms: number) => void;
  /** seek the player to this clip-relative position when it changes from outside */
  currentMs?: number;
  /** the user moved the player (a layout segment, the scrub bar) — clip-relative ms */
  onSeek?: (ms: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastEmit = useRef(0);
  const prevRange = useRef({ start_ms: range.start_ms, end_ms: range.end_ms });
  const toSeconds = useRef<(ms: number) => number>((ms) => ms / 1000);
  const [instruction, setInstruction] = useState("");
  const [playheadMs, setPlayheadMs] = useState(0);

  const showingPreview = !!previewUrl && !dirty;
  const latest = events[events.length - 1] ?? null;
  const report = showingPreview ? previewReport : null;
  const previewKind = previewFile(previewReport)?.layout ?? "vertical";
  const videoSrc = showingPreview ? previewUrl : sourceUrl;
  const clipMs = range.end_ms - range.start_ms;
  const maxMs = durationMs || Math.max(cand.end_ms, range.end_ms) + 60_000;
  const toVideoSeconds = (ms: number) => (showingPreview ? ms : range.start_ms + ms) / 1000;
  const toClipMs = (seconds: number) => Math.max(0, Math.round(seconds * 1000 - (showingPreview ? 0 : range.start_ms)));

  const versions: EditVersion[] = baseEdit.versions ?? [];
  const activeVersion = baseEdit.active_version ?? null;
  const preset = captionPresetOf(edit, spec?.caption_preset ?? "classic");
  const fillers = edit.filler_policy ?? (edit.remove_fillers === false ? "keep" : spec?.filler_policy ?? "smart");
  const silences = edit.silence_policy ?? (edit.tighten_pauses === false ? "keep" : spec?.silence_policy ?? "tighten");
  const target = edit.duration_seconds ?? spec?.duration.target_seconds ?? null;
  const mode = edit.duration_mode ?? spec?.duration.mode ?? "natural";
  const disabled = new Set(edit.disabled_cuts ?? []);
  const badges = complianceBadges(compliance, spec);
  const layoutInfo = previewReport?.layout ?? null;
  const segments = layoutInfo?.segments ?? [];
  const people = layoutInfo?.people ?? [];
  const layoutMode = edit.layout_mode ?? "auto";
  const subject = edit.subject ?? null;
  const cuts = plan?.cuts ?? [];
  const restoredCount = cuts.filter((c) => disabled.has(c.id)).length;
  const fitActions = compliance?.fit?.actions ?? [];
  const warnings = compliance?.warnings ?? [];
  const hasDetails = badges.length > 0 || fitActions.length > 0 || warnings.length > 0 || !!plan?.transcript || !!cand.quote;

  const timelineTotal = Math.max(1, segments[segments.length - 1]?.end_ms ?? 0);
  const activeSegment = segments.find((s) => playheadMs >= s.start_ms && playheadMs < s.end_ms) ?? null;
  const onScreen = new Set(activeSegment?.subjects ?? []);
  const metrics = layoutInfo?.metrics;
  const metricParts: string[] = [];
  if (metrics?.people != null) metricParts.push(`${metrics.people} ${metrics.people === 1 ? "person" : "people"}`);
  if (metrics?.speaker_visible_pct != null) metricParts.push(`speaker visible ${metrics.speaker_visible_pct}%`);
  if (metrics?.smooth != null) metricParts.push(metrics.smooth ? "smooth" : "fast pans");

  const sliderMin = Math.max(0, Math.min(cand.start_ms, range.start_ms) - SLIDER_PAD_MS);
  const sliderMax = Math.min(maxMs, Math.max(cand.end_ms, range.end_ms) + SLIDER_PAD_MS);
  const setStart = (ms: number) => onEdit({ start_ms: Math.max(0, Math.min(ms, range.end_ms - MIN_CLIP_MS)) });
  const setEnd = (ms: number) => onEdit({ end_ms: Math.min(maxMs, Math.max(ms, range.start_ms + MIN_CLIP_MS)) });

  const eyebrow = cand.custom ? "Custom clip" : cand.request_id ? `Directed clip · ${cand.request_id}` : `Candidate #${cand.rank}`;
  const pill = `${showingPreview ? `preview${previewKind === "wide" ? " · 16:9" : previewKind === "audio" ? " · audio" : ""}` : "source"} · ${fmtSeconds(showingPreview && previewReport ? previewReport.duration_ms : clipMs)}`;

  // The conversion depends on what is playing; the seek effect below only
  // reacts to currentMs, so it reads the latest conversion through a ref.
  useEffect(() => {
    toSeconds.current = toVideoSeconds;
  });

  useEffect(() => {
    if (currentMs == null) return;
    const v = videoRef.current;
    if (!v) return;
    const seconds = toSeconds.current(currentMs);
    if (Math.abs(v.currentTime - seconds) > 0.4) v.currentTime = seconds;
  }, [currentMs]);

  // Moving a boundary scrubs the recording to it (while paused), so the
  // handles double as a frame picker.
  useEffect(() => {
    const prev = prevRange.current;
    prevRange.current = { start_ms: range.start_ms, end_ms: range.end_ms };
    const v = videoRef.current;
    if (!v || showingPreview || !v.paused) return;
    if (range.start_ms !== prev.start_ms) v.currentTime = range.start_ms / 1000;
    else if (range.end_ms !== prev.end_ms) v.currentTime = range.end_ms / 1000;
  }, [range.start_ms, range.end_ms, showingPreview]);

  const handleTime = (e: SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    if (!showingPreview && !v.paused && v.currentTime >= range.end_ms / 1000) {
      v.pause();
      v.currentTime = range.end_ms / 1000;
    }
    const ms = toClipMs(v.currentTime);
    setPlayheadMs(ms);
    const now = performance.now();
    if (onTime && now - lastEmit.current >= 200) {
      lastEmit.current = now;
      onTime(ms);
    }
  };

  const handlePlay = (e: SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    v.muted = false;
    if (v.volume === 0) v.volume = 1;
    if (!showingPreview && (v.currentTime >= range.end_ms / 1000 - 0.1 || v.currentTime < range.start_ms / 1000 - 0.1)) v.currentTime = range.start_ms / 1000;
  };

  const handleLoaded = (e: SyntheticEvent<HTMLVideoElement>) => {
    if (!showingPreview) e.currentTarget.currentTime = range.start_ms / 1000;
    setPlayheadMs(0);
  };

  const handleSeeked = (e: SyntheticEvent<HTMLVideoElement>) => {
    const ms = toClipMs(e.currentTarget.currentTime);
    setPlayheadMs(ms);
    onSeek?.(ms);
  };

  const seekTo = (ms: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = toVideoSeconds(ms);
    void v.play().catch(() => {});
    onSeek?.(ms);
  };

  // Inside a click handler (a user gesture), so every browser allows audible playback.
  const unmuteAndPlay = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = false;
    v.defaultMuted = false;
    v.volume = 1;
    void v.play().catch(() => {});
  };

  const toggleCut = (id: string) => {
    const next = new Set(disabled);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onEdit({ disabled_cuts: Array.from(next).sort() });
  };

  const follow = (id: string) => {
    if (subject === id) onEdit({ subject: null });
    else onEdit({ subject: id, layout_mode: layoutMode === "solo_follow" ? "solo_follow" : "auto" });
  };

  const submitInstruction = () => {
    const text = instruction.trim();
    if (!text || revising || !plan) return;
    onRevise(text);
    setInstruction("");
  };

  return (
    <div className="rr-card rr-enter relative">
      {/* 1 · header */}
      <header className="px-4 pt-4">
        <span className="rr-eyebrow">{eyebrow}</span>
        <TitleEditor key={cand.id} value={edit.title ?? cand.title} onCommit={(title) => onEdit({ title })} />
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="font-mono text-[11px] text-ink-faint">
            {fmtTime(range.start_ms)} → {fmtTime(range.end_ms)} · {fmtSeconds(clipMs)}
          </span>
          {versions.length > 0 && (
            <span className="flex flex-wrap items-center gap-1">
              <button type="button" onClick={() => onUseVersion(null)} data-active={activeVersion == null} className="rr-chip h-6 px-2 text-[11px]" title="The clip as found">
                original
              </button>
              {versions.map((v) => (
                <button
                  key={v.n}
                  type="button"
                  onClick={() => onUseVersion(v.n)}
                  data-active={activeVersion === v.n}
                  className="rr-chip h-6 px-2 font-mono text-[11px]"
                  title={[v.note ?? v.source, v.start_ms != null ? `${fmtTime(v.start_ms)}${v.end_ms != null ? ` → ${fmtTime(v.end_ms)}` : ""}` : null].filter(Boolean).join(" · ") || `version ${v.n}`}
                >
                  v{v.n}
                </button>
              ))}
            </span>
          )}
        </div>
      </header>

      {/* 2 · phone frame, layout timeline, people */}
      <section className="px-4 pt-4">
        {/* the frame follows the picture: a phone for vertical previews, a wide screen for the raw source / 16:9 renders */}
        <div className={`mx-auto w-full transition-[max-width] duration-200 ${showingPreview && previewKind === "vertical" ? "max-w-[292px]" : "max-w-full"}`}>
          <div className={`relative overflow-hidden rounded-xl bg-ink p-1.5 shadow-elev-2 ${showingPreview && previewKind === "vertical" ? "aspect-[9/16] max-h-[520px]" : "aspect-video"}`}>
            <div className="relative h-full w-full overflow-hidden rounded-[22px] bg-black">
              {videoSrc ? (
                <video
                  key={showingPreview ? `preview:${videoSrc}` : `source:${videoSrc}`}
                  ref={videoRef}
                  controls
                  playsInline
                  preload="metadata"
                  src={videoSrc}
                  onPlay={handlePlay}
                  onTimeUpdate={handleTime}
                  onSeeked={handleSeeked}
                  onLoadedMetadata={handleLoaded}
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="rr-skeleton h-full w-full rounded-none" />
              )}
            </div>
            <span className="absolute left-1/2 top-3 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/55 px-2 py-0.5 font-mono text-[10px] text-white/90 backdrop-blur-sm">{pill}</span>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="rr-label">Framing</span>
          <div className="w-52">
            <select
              value={layoutMode}
              onChange={(e) => onEdit({ layout_mode: e.target.value, subject: e.target.value === "auto" || e.target.value === "solo_follow" ? subject : null })}
              className="rr-select rr-select-sm"
              aria-label="Layout"
            >
              {LAYOUT_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {segments.length > 0 && (
          <div className="mt-2.5">
            <div className="relative flex h-3 w-full overflow-hidden rounded-full bg-surface-overlay">
              {segments.map((seg, i) => {
                const active = seg === activeSegment;
                const label = LAYOUT_LABELS[seg.layout] ?? seg.layout;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => seekTo(seg.start_ms)}
                    style={{ width: `${((seg.end_ms - seg.start_ms) / timelineTotal) * 100}%` }}
                    title={`${fmtClock(seg.start_ms)}–${fmtClock(seg.end_ms)} · ${label}${seg.subjects.length ? " · " + seg.subjects.join(" + ") : ""}${seg.reason ? " · " + seg.reason : ""}`}
                    aria-label={`Play from ${fmtClock(seg.start_ms)} (${label})`}
                    className={`${LAYOUT_TONE[seg.layout] ?? "bg-ink-faint"} border-r border-surface-raised transition-opacity last:border-r-0 ${active ? "opacity-100" : "opacity-45 hover:opacity-80"}`}
                  />
                );
              })}
              <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-ink" style={{ left: `${Math.min(100, (playheadMs / timelineTotal) * 100)}%` }} />
            </div>
            <div className="mt-1.5 flex items-baseline justify-between gap-3 font-mono text-[11px]">
              <span className="min-w-0 truncate text-ink-dim">
                {activeSegment ? `${LAYOUT_LABELS[activeSegment.layout] ?? activeSegment.layout}${activeSegment.subjects.length ? ` · ${activeSegment.subjects.join(" + ")}` : ""}` : `${segments.length} layout ${segments.length === 1 ? "segment" : "segments"}`}
              </span>
              {metricParts.length > 0 && <span className="shrink-0 text-ink-faint">{metricParts.join(" · ")}</span>}
            </div>
          </div>
        )}

        {people.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => onEdit({ subject: null })} data-active={subject == null} className="rr-chip" title="Follow whoever is speaking">
              auto
            </button>
            {people.map((p) => {
              const following = subject === p.id;
              const visible = onScreen.has(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => follow(p.id)}
                  aria-pressed={following}
                  title={`${following ? "Following" : "Follow"} ${p.id} · on screen ${Math.round(p.coverage * 100)}% of the clip`}
                  className={`flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-[12px] transition-colors active:scale-[0.98] ${
                    following ? "border-accent bg-accent/10 text-accent" : "border-line text-ink-dim hover:border-line-strong hover:text-ink"
                  }`}
                >
                  <span className={`flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-surface-overlay transition-shadow ${visible ? "ring-2 ring-accent ring-offset-1 ring-offset-surface-raised" : ""}`}>
                    {thumbUrls[p.id] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumbUrls[p.id]} alt={p.id} className="h-full w-full object-cover" />
                    ) : (
                      <UserRound className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <span className="font-mono text-[11px]">{p.id}</span>
                  <span className="font-mono text-[11px] text-ink-faint">{Math.round(p.coverage * 100)}%</span>
                </button>
              );
            })}
          </div>
        )}

        {layoutInfo && people.length === 0 && segments.length === 0 && (
          <p className="mt-2 font-mono text-[11px] text-ink-faint" title={layoutInfo.error ?? undefined}>
            {layoutInfo.error ? "Layout failed · rendered full frame" : "No face found · rendered full frame"}
          </p>
        )}
      </section>

      {/* 3 · sound */}
      <section className="px-4 pt-3">
        <SoundTools proof={showingPreview ? audioProof : undefined} report={report} onUnmutePlay={unmuteAndPlay} />
      </section>

      {/* 4 · range */}
      <section className="px-4 pt-4">
        <div className="flex items-baseline justify-between">
          <span className="rr-label">Range</span>
          <span className="font-mono text-[12px] text-ink">{(clipMs / 1000).toFixed(1)} s</span>
        </div>
        <DualRange min={sliderMin} max={sliderMax} start={range.start_ms} end={range.end_ms} original={{ start_ms: cand.start_ms, end_ms: cand.end_ms }} onStart={setStart} onEnd={setEnd} />
        <div className="grid grid-cols-2 gap-3">
          <Boundary label="Start" value={range.start_ms} min={0} max={range.end_ms - MIN_CLIP_MS} onChange={setStart} />
          <Boundary label="End" value={range.end_ms} min={range.start_ms + MIN_CLIP_MS} max={maxMs} onChange={setEnd} />
        </div>
      </section>

      {/* 5 · cleanup */}
      <section className="px-4 pt-4">
        <div className="grid grid-cols-2 gap-x-3 gap-y-3">
          <div className="rr-field">
            <span className="rr-label">Fillers</span>
            <select value={fillers} onChange={(e) => onEdit({ filler_policy: e.target.value, remove_fillers: e.target.value !== "keep" })} className="rr-select rr-select-sm" aria-label="Fillers">
              {FILLER_POLICIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="rr-field">
            <span className="rr-label">Pauses</span>
            <select value={silences} onChange={(e) => onEdit({ silence_policy: e.target.value, tighten_pauses: e.target.value === "tighten" })} className="rr-select rr-select-sm" aria-label="Pauses">
              {SILENCE_POLICIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="rr-field">
            <span className="rr-label">Captions</span>
            <select value={preset} onChange={(e) => onEdit({ caption_preset: e.target.value, captions: e.target.value })} className="rr-select rr-select-sm" aria-label="Captions">
              {CAPTION_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="rr-field col-span-2">
            <span className="rr-label">Length</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <button type="button" onClick={() => onEdit({ duration_seconds: undefined })} data-active={target == null} className="rr-chip" title="Keep the range as it is">
                as is
              </button>
              {DURATION_CHIPS.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => onEdit({ duration_mode: m.value, duration_seconds: target ?? Math.round(clipMs / 1000) })}
                  data-active={target != null && mode === m.value}
                  className="rr-chip"
                  title={m.hint}
                >
                  {m.label}
                </button>
              ))}
              {target != null && (
                <span className="ml-auto flex items-center gap-1">
                  <input
                    type="number"
                    min={5}
                    max={600}
                    value={target}
                    onChange={(e) => onEdit({ duration_seconds: e.target.value ? Number(e.target.value) : undefined })}
                    className="rr-input rr-input-sm w-[72px] text-right font-mono"
                    aria-label="Target length in seconds"
                  />
                  <span className="text-[12px] text-ink-faint">s</span>
                </span>
              )}
            </div>
          </div>
        </div>

        {cuts.length > 0 && (
          <div className="mt-3">
            <Disclosure
              label="Planned edits"
              count={cuts.length}
              extra={
                restoredCount > 0 ? (
                  <button type="button" onClick={() => onEdit({ disabled_cuts: [] })} className="rr-btn rr-btn-ghost rr-btn-sm h-6 px-2 text-[11px]">
                    Apply all
                  </button>
                ) : (
                  <button type="button" onClick={() => onEdit({ disabled_cuts: cuts.map((c) => c.id) })} className="rr-btn rr-btn-ghost rr-btn-sm h-6 px-2 text-[11px]">
                    Restore all
                  </button>
                )
              }
            >
              <ul className="max-h-40 space-y-1 overflow-y-auto">
                {cuts.map((c) => {
                  const off = disabled.has(c.id);
                  return (
                    <li key={c.id} className="flex items-center gap-2 text-[12px]">
                      <button
                        type="button"
                        onClick={() => toggleCut(c.id)}
                        title={off ? "Apply this edit again" : "Keep this instead"}
                        className={`w-[64px] shrink-0 rounded-full border px-2 py-0.5 font-mono text-[11px] leading-4 transition-colors ${
                          off ? "border-line text-ink-faint line-through" : c.action === "keep" ? "border-line text-ink-faint" : "border-accent/40 bg-accent/10 text-accent"
                        }`}
                      >
                        {off ? "restored" : c.action}
                      </button>
                      <span className="min-w-0 truncate text-ink">{c.kind === "filler" ? `“${c.word}”` : "pause"}</span>
                      <span
                        className="ml-auto shrink-0 font-mono text-[11px] text-ink-faint"
                        title={[c.reason, c.restored_for_fit ? "kept for the target length" : null].filter(Boolean).join(" · ") || undefined}
                      >
                        {fmtClock(c.start_ms)} · {((c.end_ms - c.start_ms) / 1000).toFixed(2)}s
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Disclosure>
          </div>
        )}

        <div className="mt-3 flex items-center justify-end gap-1.5">
          <button type="button" onClick={onReset} className="rr-btn rr-btn-ghost rr-btn-sm" title="Back to the clip as found">
            <RotateCcw className="h-3.5 w-3.5" /> Reset
          </button>
          <button type="button" onClick={onSave} disabled={!dirty} className={`rr-btn rr-btn-sm ${dirty ? "rr-btn-primary" : ""}`} title="Edits are non-destructive">
            <Save className="h-3.5 w-3.5" /> Save
          </button>
        </div>
      </section>

      {/* 6 · details */}
      {hasDetails && (
        <section className="px-4 pt-3">
          <Disclosure label="Details" count={badges.length || undefined}>
            <ComplianceBadges badges={badges} />
            {fitActions.map((a, i) => (
              <p key={`fit-${i}`} className={`font-mono text-[11px] text-ink-dim ${i === 0 && badges.length ? "mt-2" : "mt-1"}`}>
                fit · {a}
              </p>
            ))}
            {warnings.map((w, i) => (
              <p key={`warn-${i}`} className="mt-1.5 flex items-start gap-1.5 text-[12px] text-processing">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {w}
              </p>
            ))}
            {plan?.transcript ? (
              <p className={`max-h-40 overflow-y-auto text-[12px] leading-5 text-ink-dim ${badges.length || fitActions.length || warnings.length ? "mt-2.5" : ""}`}>{plan.transcript}</p>
            ) : cand.quote ? (
              <div className={`text-[12px] leading-5 text-ink-dim ${badges.length || fitActions.length || warnings.length ? "mt-2.5" : ""}`}>
                <p>&ldquo;{cand.quote}&rdquo;</p>
                {cand.takeaway && <p className="mt-1 text-ink-faint">ends: &ldquo;{cand.takeaway}&rdquo;</p>}
              </div>
            ) : null}
          </Disclosure>
        </section>
      )}

      {/* 7 · ask for a change */}
      <section className="px-4 pt-4">
        <div className="flex gap-1.5">
          <input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitInstruction();
            }}
            disabled={revising || !plan}
            placeholder={plan ? "Ask for a change · make the opening stronger, a shorter version…" : "Render a preview first, then ask for changes"}
            className="rr-input rr-input-sm min-w-0 flex-1"
            aria-label="Ask for a change"
          />
          <button type="button" onClick={submitInstruction} disabled={revising || !plan || !instruction.trim()} className="rr-btn rr-btn-sm shrink-0">
            {revising ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />} Revise
          </button>
        </div>
        {revisionNote && (
          <p className="rr-enter mt-2 flex items-start gap-1.5 rounded-md bg-surface-overlay px-2.5 py-1.5 text-[12px] leading-5 text-ink-dim">
            <Sparkles className="mt-1 h-3 w-3 shrink-0 text-accent" /> {revisionNote}
          </p>
        )}
      </section>

      {/* 8 · actions */}
      <footer className="sticky bottom-0 z-10 mt-4 rounded-b-lg border-t border-line bg-surface-raised/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onPreview} disabled={busy !== null} className="rr-btn rr-btn-primary" title="Render a preview (R)">
            {busy === "preview" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 text-accent" />}
            Render preview
          </button>
          <button type="button" onClick={onExport} disabled={busy !== null} className="rr-btn" title="Export 9:16 + 16:9 with captions">
            {busy === "export" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Export
          </button>
        </div>
        {busy && (
          <div className="mt-2.5">
            <p className="truncate text-[12px] text-ink-dim">{statusLine(latest)}</p>
            <div className="rr-progress mt-1.5" data-indeterminate="true">
              <i />
            </div>
          </div>
        )}
        {error && <p className="mt-2 rounded-md bg-danger/10 px-2.5 py-1.5 text-[12px] leading-5 text-danger">{error}</p>}
        {exportLinks.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {exportLinks.map((l) => (
              <a key={l.label} href={l.url} download={l.name} className="rr-chip" title={`Download ${l.name}`}>
                <Download className="h-3.5 w-3.5" /> {l.label}
              </a>
            ))}
            <a href={exportLinks[0].url} target="_blank" rel="noreferrer" className="rr-chip px-2" title="Open in a new tab" aria-label="Open in a new tab">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            {exportReport && (
              <span className="ml-auto font-mono text-[11px] text-ink-faint">
                {exportReport.width}×{exportReport.height} · {fmtSeconds(exportReport.duration_ms)}
                {exportReport.loudness ? ` · ${fmtLufs(exportReport.loudness.integrated_lufs)}` : ""}
              </span>
            )}
          </div>
        )}
      </footer>
    </div>
  );
}
