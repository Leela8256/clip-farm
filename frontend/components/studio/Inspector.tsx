"use client";

import { useRef, useState, type ReactNode } from "react";
import { Check, Download, Film, Loader2, Music, Play, Save, Sparkles, Trash2, TriangleAlert, Upload, X } from "lucide-react";
import {
  MODE_LABELS,
  SUGGESTION_MODES,
  fmtDuration,
  fmtPosition,
  type AudioSettings,
  type EditsVersion,
  type CaptionStyle,
  type EpisodeEdits,
  type StudioReport,
  type SuggestionMode,
  type VisualSettings,
} from "@/lib/studio";
import { CAPTION_GALLERY } from "@/lib/brand";
import type { BrandTemplate } from "./brand";
import { qualityLine, type RenderQuality } from "./helpers";

export type JobKind = "rough" | "range" | "export";

/** How big the finished episode is made. */
export type ExportSize = "720" | "1080" | "source";

export interface DownloadLink {
  label: string;
  url: string;
  name: string;
}

/** The saved caption looks, minus "no captions" — that is the toggle above them. */
const CAPTION_PRESETS: [string, string][] = CAPTION_GALLERY.filter((c) => c.id !== "none").map((c) => [c.id, c.label]);
const POSITIONS = ["bottom", "middle", "top"];
const EXTRA_ASPECTS: [string, string][] = [
  ["9:16", "Tall (phones)"],
  ["4:5", "Portrait"],
  ["1:1", "Square"],
];
const EXPORT_SIZES: [ExportSize, string][] = [
  ["720", "720p — smaller file"],
  ["1080", "1080p — full HD"],
  ["source", "As sharp as the recording"],
];
const MODE_HINTS: Record<SuggestionMode, string> = {
  natural: "Only the obvious slips",
  balanced: "A tidy, natural-sounding episode",
  tight: "As lean as it gets",
};
const ASSETS: { kind: "intro" | "outro" | "music" | "logo"; label: string; accept: string }[] = [
  { kind: "intro", label: "Opening clip", accept: "video/*" },
  { kind: "outro", label: "Closing clip", accept: "video/*" },
  { kind: "music", label: "Background music", accept: "audio/*" },
  { kind: "logo", label: "Logo", accept: "image/*" },
];

function Section({ title, hint, children, open }: { title: string; hint?: string; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="border-b border-line last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2.5 text-sm font-semibold text-ink marker:hidden hover:bg-surface-overlay">
        <span className="font-display text-[16px] tracking-[-0.01em]">{title}</span>
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

const KEYS: [string, string][] = [
  ["Delete", "remove"],
  ["M", "silence"],
  ["B", "bleep"],
  ["U", "undo"],
  ["⇧U", "redo"],
  ["Space", "play"],
  ["/", "find"],
];

/**
 * Everything about the episode, in the order it gets made:
 *
 *   Edit             what you have changed, who is speaking, chapters, save points
 *   Clean up         the tidying we found, and an edit drafted from your own words
 *   Sound            how the finished episode sounds
 *   Finish           branding, captions, cards and the shapes to make
 *   Preview & export watch it back, then make the finished files
 */
export default function Inspector({
  edits,
  suggestionCount,
  applySummary,
  dirty,
  saving,
  busy,
  progress,
  reports,
  quality,
  links,
  onPatch,
  onPatchAudio,
  onPatchVisual,
  onPatchCaptions,
  onMode,
  onApplyAll,
  onSaveVersion,
  onOpenVersion,
  onUpload,
  onRemoveAsset,
  onRun,
  onSeek,
  onRenameSpeaker,
  onRemoveSection,
  uploading,
  cleanup,
  brands,
  brandsLoading,
  brandNote,
  onApplyBrand,
  exportSize,
  onExportSize,
  exportSizeReady,
}: {
  edits: EpisodeEdits;
  suggestionCount: number;
  /** what the last "apply all" actually did */
  applySummary: string;
  dirty: boolean;
  saving: boolean;
  busy: JobKind | null;
  progress: string;
  reports: Partial<Record<JobKind, StudioReport>>;
  /** how the version on screen actually came out, measured from the file */
  quality: RenderQuality | null;
  links: DownloadLink[];
  onPatch: (patch: Partial<EpisodeEdits>) => void;
  onPatchAudio: (patch: Partial<AudioSettings>) => void;
  onPatchVisual: (patch: Partial<VisualSettings>) => void;
  onPatchCaptions: (patch: Partial<CaptionStyle>) => void;
  onMode: (mode: SuggestionMode) => void;
  onApplyAll: () => void;
  onSaveVersion: (note: string) => void;
  onOpenVersion: (version: EditsVersion) => void;
  onUpload: (kind: "intro" | "outro" | "music" | "logo", file: File) => void;
  onRemoveAsset: (kind: "intro" | "outro" | "music" | "logo") => void;
  onRun: (kind: JobKind) => void;
  onSeek: (ms: number) => void;
  onRenameSpeaker: (speakerId: string, name: string) => void;
  onRemoveSection: (id: string) => void;
  uploading: string | null;
  /** the suggestions and the drafted edit, shown inside Clean up */
  cleanup?: ReactNode;
  brands: BrandTemplate[];
  brandsLoading: boolean;
  /** what applying a brand just did */
  brandNote: string;
  onApplyBrand: (template: BrandTemplate) => void;
  exportSize: ExportSize;
  onExportSize: (size: ExportSize) => void;
  /** false while the size choice cannot reach the render — then it is not offered as if it could */
  exportSizeReady: boolean;
}) {
  const [note, setNote] = useState("");
  const [brandId, setBrandId] = useState("");
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const mode = edits.suggestions?.mode ?? "balanced";
  const audio = edits.audio;
  const visual = edits.visual;
  const style = visual.caption_style;
  const assets = edits.assets ?? {};
  const music = assets.music;
  const report = reports.export ?? reports.range ?? reports.rough;
  const warnings = report?.warnings ?? [];
  const shape = qualityLine(quality);

  const live = edits.operations.filter((op) => op.enabled !== false);
  const count = (type: string) => live.filter((op) => op.type === type).length;
  const changes = [
    [count("cut"), "removed"],
    [count("mute"), "silenced"],
    [count("bleep"), "bleeped"],
    [count("shorten_silence"), "shortened"],
    [(edits.corrections ?? []).length, "respelled"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(" · ");

  // whatever look this episode was saved with stays on the list, old word or new
  const presets = CAPTION_PRESETS.some(([value]) => value === style.preset)
    ? CAPTION_PRESETS
    : [[style.preset, style.preset.replace(/[-_]/g, " ")] as [string, string], ...CAPTION_PRESETS];

  const speakers = Object.entries(edits.speakers ?? {});
  const sections = [...(edits.sections ?? [])].sort((a, b) => a.start_ms - b.start_ms);
  const fileName = (path?: string) => (path ? path.split("/").pop() ?? path : "");

  return (
    <div className="rr-card overflow-hidden">
      <Section title="Edit with AI" hint={suggestionCount ? `${suggestionCount} ideas` : "describe the episode you want"} open>
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
        {applySummary ? <p className="text-[11px] text-ink-dim">{applySummary}</p> : null}
        {cleanup}
      </Section>

      <Section title="Edit" hint={changes || "nothing changed yet"} open>
        <p className="text-[11px] text-ink-faint">
          Your recording is never touched — every change here can be put back, one at a time or all at once.
        </p>

        {speakers.length ? (
          <div className="rr-field">
            <span className="rr-label">Who is speaking</span>
            <div className="space-y-1.5">
              {speakers.map(([speakerId, info]) => (
                <div key={speakerId} className="flex items-center gap-2">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: info.color ?? "var(--rr-accent)" }} />
                  <input
                    className="rr-input rr-input-sm"
                    value={info.name}
                    aria-label={`Name for ${info.name}`}
                    onChange={(e) => onRenameSpeaker(speakerId, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="rr-field">
          <span className="rr-label">Chapters</span>
          {sections.length ? (
            <div className="space-y-1">
              {sections.map((section) => (
                <div key={section.id} className="flex items-center gap-1.5">
                  <button type="button" className="rr-mono shrink-0 text-ink-faint hover:text-ink" onClick={() => onSeek(section.start_ms)}>
                    {fmtPosition(section.start_ms)}
                  </button>
                  <input
                    className="rr-input rr-input-sm"
                    value={section.title}
                    aria-label={`Chapter name at ${fmtPosition(section.start_ms)}`}
                    onChange={(e) =>
                      onPatch({ sections: sections.map((s) => (s.id === section.id ? { ...s, title: e.target.value } : s)) })
                    }
                  />
                  <button
                    type="button"
                    className="rr-btn rr-btn-ghost rr-btn-icon h-7 w-7 shrink-0"
                    aria-label={`Remove the chapter ${section.title}`}
                    onClick={() => onRemoveSection(section.id)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-ink-faint">Mark a chapter from any line in the transcript.</p>
          )}
        </div>

        <div className="rr-field">
          <span className="rr-label">Saved versions {dirty ? "· unsaved changes" : "· all saved"}</span>
          <div className="flex gap-2">
            <input
              className="rr-input rr-input-sm"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What changed?"
              aria-label="Note for this save point"
            />
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
            <>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {edits.versions.map((v) => (
                  <button
                    key={v.n}
                    type="button"
                    className="rr-chip"
                    onClick={() => onOpenVersion(v)}
                    title={`${v.note || "Saved"} · ${new Date((v.created ?? 0) * 1000).toLocaleString()} — open it`}
                  >
                    v{v.n}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-ink-faint">Open one to see it — or go back to it.</p>
            </>
          ) : (
            <p className="text-[11px] text-ink-faint">Everything saves as you go. Keep a version you can return to.</p>
          )}
        </div>

        <details className="text-[11px] text-ink-faint">
          <summary className="cursor-pointer select-none">Keyboard shortcuts</summary>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {KEYS.map(([key, what]) => (
              <span key={key}>
                <span className="rr-kbd">{key}</span> {what}
              </span>
            ))}
          </p>
        </details>
      </Section>

      <Section title="Sound">
        <Toggle label="Reduce background noise" on={audio.noise_reduction} onChange={(on) => onPatchAudio({ noise_reduction: on })} />
        <Toggle label="Remove rumble" on={audio.high_pass} onChange={(on) => onPatchAudio({ high_pass: on })} hint="Cuts the low hum from desks and traffic" />
        <Toggle label="Even out the levels" on={audio.compression} onChange={(on) => onPatchAudio({ compression: on })} hint="Quiet talkers come up, loud moments come down" />
        <Toggle label="Match podcast loudness" on={audio.master} onChange={(on) => onPatchAudio({ master: on })} hint="The standard −16 loudness podcast apps expect" />
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
        ) : (
          <p className="text-[11px] text-ink-faint">Add background music under Finish to set its level and how far it drops under speech.</p>
        )}
      </Section>

      <Section title="Finish">
        <div className="rr-field">
          <span className="rr-label">Brand</span>
          <div className="flex gap-2">
            <select
              className="rr-select rr-select-sm"
              value={brandId}
              aria-label="Brand to apply"
              disabled={brandsLoading || !brands.length}
              onChange={(e) => setBrandId(e.target.value)}
            >
              <option value="">{brandsLoading ? "Looking for your brands…" : brands.length ? "Choose a brand" : "No brands saved yet"}</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.default ? " (default)" : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="rr-btn rr-btn-sm shrink-0"
              disabled={!brandId}
              onClick={() => {
                const picked = brands.find((b) => b.id === brandId);
                if (picked) onApplyBrand(picked);
              }}
            >
              <Check className="h-3.5 w-3.5" /> Apply
            </button>
          </div>
          <p className="text-[11px] text-ink-faint">
            {brandNote || "A brand fills in the blanks — anything you set yourself is left exactly as it is."}
          </p>
        </div>

        <label className="rr-field">
          <span className="rr-label">Episode title</span>
          <input
            className="rr-input rr-input-sm"
            value={edits.title ?? ""}
            onChange={(e) => onPatch({ title: e.target.value })}
            placeholder="Episode 12 — The Interview"
          />
        </label>

        <div className="rr-field">
          <span className="rr-label">Captions</span>
          <Toggle label="Show captions" on={visual.captions} onChange={(on) => onPatchVisual({ captions: on })} />
          <div className="grid grid-cols-2 gap-2">
            <label className="rr-field">
              <span className="rr-label">Style</span>
              <select className="rr-select rr-select-sm" value={style.preset} onChange={(e) => onPatchCaptions({ preset: e.target.value })}>
                {presets.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="rr-field">
              <span className="rr-label">Position</span>
              <select
                className="rr-select rr-select-sm"
                value={style.position}
                onChange={(e) => onPatchCaptions({ position: e.target.value as CaptionStyle["position"] })}
              >
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
        </div>

        {ASSETS.map(({ kind, label, accept }) => {
          const held = assets[kind];
          return (
            <div key={kind} className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-xs text-ink-dim">{label}</span>
              {held?.path ? (
                <span className="rr-chip max-w-[160px] cursor-default truncate" title={fileName(held.path)}>
                  {kind === "music" ? <Music className="h-3 w-3" /> : <Film className="h-3 w-3" />}
                  <span className="truncate">{fileName(held.path)}</span>
                  <button
                    type="button"
                    aria-label={`Remove the ${label.toLowerCase()}`}
                    onClick={() => onRemoveAsset(kind)}
                    className="text-ink-faint hover:text-danger"
                  >
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
                    onPatch({
                      extra_aspects: on ? (edits.extra_aspects ?? []).filter((a) => a !== value) : [...(edits.extra_aspects ?? []), value],
                    })
                  }
                >
                  + {label}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-ink-faint">Extra shapes are made alongside the widescreen episode when you export.</p>
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

      <Section title="Preview & export" open>
        <div className="grid gap-2">
          <button type="button" className="rr-btn rr-btn-sm" disabled={!!busy} onClick={() => onRun("rough")}>
            {busy === "rough" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Standard preview
          </button>
          <button type="button" className="rr-btn rr-btn-sm" disabled={!!busy} onClick={() => onRun("range")}>
            {busy === "range" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Preview selected section
          </button>
        </div>
        <p className="text-[11px] text-ink-faint">
          A standard preview is the whole episode with your cuts, captions and branding — the sound is finished on export. A section preview is the
          real thing around where you are, sound and all.
        </p>

        <label className="rr-field">
          <span className="rr-label">Export size</span>
          <select
            className="rr-select rr-select-sm"
            value={exportSize}
            disabled={!exportSizeReady}
            onChange={(e) => onExportSize(e.target.value as ExportSize)}
          >
            {EXPORT_SIZES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {!exportSizeReady ? <span className="text-[11px] text-ink-faint">Episodes are exported at 1080p.</span> : null}
        </label>

        <button type="button" className="rr-btn rr-btn-accent rr-btn-sm w-full" disabled={!!busy} onClick={() => onRun("export")}>
          {busy === "export" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Export the full episode
        </button>

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
            {shape ? <p>{shape}</p> : null}
            {quality?.mastered === false ? <p>The sound is finished when you export.</p> : null}
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
