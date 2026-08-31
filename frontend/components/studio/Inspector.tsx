"use client";

import { useRef, useState, type ReactNode } from "react";
import { Download, Film, Loader2, Music, Play, Save, Sparkles, Trash2, TriangleAlert, Upload } from "lucide-react";
import {
  MODE_LABELS,
  SUGGESTION_MODES,
  fmtDuration,
  type AudioSettings,
  type CaptionStyle,
  type EpisodeEdits,
  type StudioReport,
  type SuggestionMode,
  type VisualSettings,
} from "@/lib/studio";

export type JobKind = "rough" | "range" | "export";

export interface DownloadLink {
  label: string;
  url: string;
  name: string;
}

const CAPTION_PRESETS = ["clean", "classic", "bold", "outline", "minimal"];
const POSITIONS = ["bottom", "middle", "top"];
const EXTRA_ASPECTS: [string, string][] = [
  ["9:16", "Tall (phones)"],
  ["4:5", "Portrait"],
  ["1:1", "Square"],
];
const MODE_HINTS: Record<SuggestionMode, string> = {
  natural: "Only the obvious slips",
  balanced: "A tidy, natural-sounding episode",
  tight: "As lean as it gets",
};
const ASSETS: { kind: "intro" | "outro" | "music" | "logo"; label: string; accept: string }[] = [
  { kind: "intro", label: "Intro clip", accept: "video/*" },
  { kind: "outro", label: "Outro clip", accept: "video/*" },
  { kind: "music", label: "Background music", accept: "audio/*" },
  { kind: "logo", label: "Logo", accept: "image/*" },
];

function Section({ title, hint, children, open }: { title: string; hint?: string; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="border-b border-line last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2.5 text-sm font-semibold text-ink marker:hidden hover:bg-surface-overlay">
        <span>{title}</span>
        {hint ? <span className="text-[11px] font-normal text-ink-faint">{hint}</span> : null}
      </summary>
      <div className="space-y-3 px-3.5 pb-4 pt-1">{children}</div>
    </details>
  );
}

function Toggle({ label, on, onChange, hint }: { label: string; on: boolean; onChange: (on: boolean) => void; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-sm">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[color:var(--rr-accent)]" />
      <span className="min-w-0">
        <span className="text-ink">{label}</span>
        {hint ? <span className="block text-[11px] leading-tight text-ink-faint">{hint}</span> : null}
      </span>
    </label>
  );
}

/** Everything about how the finished episode sounds, looks and leaves the building. */
export default function Inspector({
  edits,
  suggestionCount,
  dirty,
  saving,
  busy,
  progress,
  reports,
  links,
  onPatch,
  onPatchAudio,
  onPatchVisual,
  onPatchCaptions,
  onMode,
  onApplyAll,
  onSaveVersion,
  onUpload,
  onRemoveAsset,
  onRun,
  uploading,
}: {
  edits: EpisodeEdits;
  suggestionCount: number;
  dirty: boolean;
  saving: boolean;
  busy: JobKind | null;
  progress: string;
  reports: Partial<Record<JobKind, StudioReport>>;
  links: DownloadLink[];
  onPatch: (patch: Partial<EpisodeEdits>) => void;
  onPatchAudio: (patch: Partial<AudioSettings>) => void;
  onPatchVisual: (patch: Partial<VisualSettings>) => void;
  onPatchCaptions: (patch: Partial<CaptionStyle>) => void;
  onMode: (mode: SuggestionMode) => void;
  onApplyAll: () => void;
  onSaveVersion: (note: string) => void;
  onUpload: (kind: "intro" | "outro" | "music" | "logo", file: File) => void;
  onRemoveAsset: (kind: "intro" | "outro" | "music" | "logo") => void;
  onRun: (kind: JobKind) => void;
  uploading: string | null;
}) {
  const [note, setNote] = useState("");
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const mode = edits.suggestions?.mode ?? "balanced";
  const audio = edits.audio;
  const visual = edits.visual;
  const style = visual.caption_style;
  const assets = edits.assets ?? {};
  const music = assets.music;
  const report = reports.export ?? reports.range ?? reports.rough;
  const warnings = report?.warnings ?? [];

  const fileName = (path?: string) => (path ? path.split("/").pop() ?? path : "");

  return (
    <div className="rr-card overflow-hidden">
      <Section title="Cleanup" hint={`${suggestionCount} to look at`} open>
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTION_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className="rr-chip capitalize"
              data-active={mode === m}
              title={`${MODE_LABELS[m]} — ${MODE_HINTS[m]}`}
              onClick={() => onMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-ink-faint">{MODE_HINTS[mode]}. Nothing is applied until you say so.</p>
        <button type="button" className="rr-btn rr-btn-sm w-full" onClick={onApplyAll} disabled={!suggestionCount}>
          <Sparkles className="h-3.5 w-3.5" /> Apply all {suggestionCount} suggestions
        </button>
      </Section>

      <Section title="Audio finishing">
        <Toggle label="Reduce background noise" on={audio.noise_reduction} onChange={(on) => onPatchAudio({ noise_reduction: on })} />
        <Toggle label="Remove rumble" on={audio.high_pass} onChange={(on) => onPatchAudio({ high_pass: on })} hint="Cuts the low hum from desks and traffic" />
        <Toggle label="Even out the levels" on={audio.compression} onChange={(on) => onPatchAudio({ compression: on })} />
        <Toggle label="Match podcast loudness" on={audio.master} onChange={(on) => onPatchAudio({ master: on })} hint="The standard −16 loudness for podcast apps" />
      </Section>

      <Section title="Look">
        <div className="rr-field">
          <span className="rr-label">Shape</span>
          <div className="flex flex-wrap gap-1.5">
            <span className="rr-chip rr-chip-accent">16:9 widescreen</span>
            {EXTRA_ASPECTS.map(([value, label]) => {
              const on = (edits.extra_aspects ?? []).includes(value);
              return (
                <button
                  key={value}
                  type="button"
                  className="rr-chip"
                  data-active={on}
                  onClick={() =>
                    onPatch({ extra_aspects: on ? (edits.extra_aspects ?? []).filter((a) => a !== value) : [...(edits.extra_aspects ?? []), value] })
                  }
                >
                  + {label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex gap-1.5">
          {(["fit", "fill"] as const).map((f) => (
            <button key={f} type="button" className="rr-chip capitalize" data-active={visual.fit === f} onClick={() => onPatchVisual({ fit: f })}>
              {f === "fit" ? "Show the whole picture" : "Fill the frame"}
            </button>
          ))}
        </div>
        <div className="rr-field">
          <span className="rr-label">Behind the picture</span>
          <div className="flex items-center gap-2">
            <button type="button" className="rr-chip" data-active={visual.background === "blur"} onClick={() => onPatchVisual({ background: "blur" })}>
              Blurred
            </button>
            <input
              type="color"
              aria-label="Background colour"
              value={visual.background?.startsWith("#") ? visual.background : "#16130F"}
              onChange={(e) => onPatchVisual({ background: e.target.value })}
              className="h-8 w-10 cursor-pointer rounded-sm border border-line-strong bg-transparent"
            />
          </div>
        </div>
      </Section>

      <Section title="Captions">
        <Toggle label="Show captions" on={visual.captions} onChange={(on) => onPatchVisual({ captions: on })} />
        <div className="grid grid-cols-2 gap-2">
          <label className="rr-field">
            <span className="rr-label">Style</span>
            <select className="rr-select rr-select-sm" value={style.preset} onChange={(e) => onPatchCaptions({ preset: e.target.value })}>
              {CAPTION_PRESETS.map((p) => (
                <option key={p} value={p} className="capitalize">
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="rr-field">
            <span className="rr-label">Position</span>
            <select className="rr-select rr-select-sm" value={style.position} onChange={(e) => onPatchCaptions({ position: e.target.value as CaptionStyle["position"] })}>
              {POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="rr-field">
            <span className="rr-label">Size</span>
            <input
              type="number"
              min={10}
              max={80}
              className="rr-input rr-input-sm"
              value={style.size ?? 24}
              onChange={(e) => onPatchCaptions({ size: Number(e.target.value) })}
            />
          </label>
          <label className="rr-field">
            <span className="rr-label">Colour</span>
            <input
              type="color"
              className="h-8 w-full cursor-pointer rounded-sm border border-line-strong bg-transparent"
              value={style.color ?? "#FFFFFF"}
              onChange={(e) => onPatchCaptions({ color: e.target.value })}
            />
          </label>
        </div>
        <Toggle label="Highlight each word as it is said" on={style.karaoke} onChange={(on) => onPatchCaptions({ karaoke: on })} />
        <Toggle label="A colour per voice" on={style.per_speaker_colors} onChange={(on) => onPatchCaptions({ per_speaker_colors: on })} />
      </Section>

      <Section title="Branding">
        <label className="rr-field">
          <span className="rr-label">Episode title</span>
          <input className="rr-input rr-input-sm" value={edits.title ?? ""} onChange={(e) => onPatch({ title: e.target.value })} placeholder="Episode 12 — The Interview" />
        </label>
        {ASSETS.map(({ kind, label, accept }) => {
          const held = assets[kind];
          return (
            <div key={kind} className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-xs text-ink-dim">{label}</span>
              {held?.path ? (
                <span className="rr-chip max-w-[160px] cursor-default truncate" title={fileName(held.path)}>
                  {kind === "music" ? <Music className="h-3 w-3" /> : <Film className="h-3 w-3" />}
                  <span className="truncate">{fileName(held.path)}</span>
                  <button type="button" aria-label={`Remove the ${label.toLowerCase()}`} onClick={() => onRemoveAsset(kind)} className="text-ink-faint hover:text-danger">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              ) : (
                <button type="button" className="rr-btn rr-btn-sm" disabled={uploading === kind} onClick={() => fileRefs.current[kind]?.click()}>
                  {uploading === kind ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Add
                </button>
              )}
              <input
                ref={(el) => {
                  fileRefs.current[kind] = el;
                }}
                type="file"
                accept={accept}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) onUpload(kind, file);
                }}
              />
            </div>
          );
        })}
        {music?.path ? (
          <div className="grid grid-cols-2 gap-2">
            <label className="rr-field">
              <span className="rr-label">Music level</span>
              <input
                type="range"
                min={-40}
                max={-6}
                value={music.gain_db ?? -22}
                onChange={(e) => onPatch({ assets: { ...assets, music: { ...music, gain_db: Number(e.target.value) } } })}
                className="accent-[color:var(--rr-accent)]"
              />
            </label>
            <label className="rr-field">
              <span className="rr-label">Duck under speech</span>
              <input
                type="range"
                min={-24}
                max={0}
                value={music.duck_db ?? -12}
                onChange={(e) => onPatch({ assets: { ...assets, music: { ...music, duck_db: Number(e.target.value) } } })}
                className="accent-[color:var(--rr-accent)]"
              />
            </label>
          </div>
        ) : null}
        <label className="rr-field">
          <span className="rr-label">Opening card</span>
          <input
            className="rr-input rr-input-sm"
            value={assets.title_card?.text ?? ""}
            placeholder="Text on the opening card"
            onChange={(e) => onPatch({ assets: { ...assets, title_card: { ...(assets.title_card ?? { seconds: 3 }), text: e.target.value } } })}
          />
        </label>
        <label className="rr-field">
          <span className="rr-label">Closing card</span>
          <input
            className="rr-input rr-input-sm"
            value={assets.end_card?.text ?? ""}
            placeholder="Thanks for listening"
            onChange={(e) => onPatch({ assets: { ...assets, end_card: { ...(assets.end_card ?? { seconds: 3 }), text: e.target.value } } })}
          />
        </label>
      </Section>

      <Section title="Save & versions" hint={dirty ? "unsaved changes" : "all saved"}>
        <div className="flex gap-2">
          <input className="rr-input rr-input-sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed?" aria-label="Note for this version" />
          <button
            type="button"
            className="rr-btn rr-btn-primary rr-btn-sm shrink-0"
            disabled={saving}
            onClick={() => {
              onSaveVersion(note.trim());
              setNote("");
            }}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save version
          </button>
        </div>
        {edits.versions?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {edits.versions.map((v) => (
              <span key={v.n} className="rr-chip cursor-default" title={`${v.note ?? "Saved"} · ${new Date((v.created ?? 0) * 1000).toLocaleString()}`}>
                v{v.n}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-ink-faint">Your work is kept as you go. Save a version to mark a point you can come back to.</p>
        )}
      </Section>

      <Section title="Preview & export" open>
        <div className="grid gap-2">
          <button type="button" className="rr-btn rr-btn-sm" disabled={!!busy} onClick={() => onRun("rough")}>
            {busy === "rough" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Quick preview
          </button>
          <button type="button" className="rr-btn rr-btn-sm" disabled={!!busy} onClick={() => onRun("range")}>
            {busy === "range" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Preview this part
          </button>
          <button type="button" className="rr-btn rr-btn-accent rr-btn-sm" disabled={!!busy} onClick={() => onRun("export")}>
            {busy === "export" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Export episode
          </button>
        </div>
        {busy ? (
          <div className="space-y-1.5">
            <div className="rr-progress" data-indeterminate="true">
              <i />
            </div>
            <p className="text-[11px] text-ink-dim">{progress || "Getting started…"}</p>
          </div>
        ) : null}
        {report ? (
          <div className="space-y-1.5 rounded-sm border border-line bg-surface-overlay px-2.5 py-2 text-[11px] text-ink-dim">
            <p>
              Length {fmtDuration(report.duration_ms ?? 0)}
              {report.loudness ? ` · loudness ${report.loudness.integrated_lufs.toFixed(1)}`.replace("-", "−") : ""}
              {report.seconds ? ` · made in ${Math.round(report.seconds)}s` : ""}
            </p>
            {Object.keys(report.files ?? {}).length ? <p>{Object.keys(report.files).length} files ready</p> : null}
            {warnings.map((w: string, i: number) => (
              <p key={i} className="flex items-start gap-1.5 text-processing">
                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" /> {w}
              </p>
            ))}
          </div>
        ) : null}
        {links.length ? (
          <div className="flex flex-wrap gap-1.5">
            {links.map((l) => (
              <a key={l.url} href={l.url} download={l.name} target="_blank" rel="noreferrer" className="rr-chip">
                <Download className="h-3 w-3" /> {l.label}
              </a>
            ))}
          </div>
        ) : null}
      </Section>
    </div>
  );
}
