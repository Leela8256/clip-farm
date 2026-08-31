/**
 * Podcast Editing Studio — pure logic (no SDK, no React imports) so all of it
 * is unit-tested. This module owns the episode edit model: the instructions a
 * producer builds on top of an untouched recording (cuts, mutes, bleeps,
 * shortened silences), the speakers, chapters, branding assets, audio and look
 * settings, plus the undo history, the cleanup suggestions and the small
 * source↔output time map the player uses for an instant preview.
 *
 * Times are integer milliseconds on the SOURCE timeline unless a name says
 * "out". Nothing here writes anywhere: every helper returns a new value, and
 * lib/studio-engine.ts is the only place that talks to the store.
 */

// --------------------------------------------------------------------- types

export const STUDIO_SCHEMA_VERSION = 1;

export const OPERATION_TYPES = ["cut", "mute", "bleep", "shorten_silence"] as const;
export type EditOperation = (typeof OPERATION_TYPES)[number];

/** One instruction on the source timeline. `enabled: false` = restored (kept on file, not applied). */
export interface Operation {
  id: string;
  type: EditOperation;
  start_ms: number;
  end_ms: number;
  /** shorten_silence: how much of the silence stays. */
  target_ms?: number;
  reason?: string;
  /** "user" or "suggestion:<id>". */
  source?: string;
  enabled: boolean;
}

export interface SpeakerInfo {
  name: string;
  color?: string;
}

export interface Section {
  id: string;
  title: string;
  start_ms: number;
}

export interface MediaAsset {
  path: string;
}

export interface MusicAsset {
  path: string;
  gain_db?: number;
  duck_db?: number;
  fade_ms?: number;
}

export interface LogoAsset {
  path: string;
  corner?: "tl" | "tr" | "bl" | "br";
  height?: number;
  opacity?: number;
}

export interface CardAsset {
  text: string;
  subtitle?: string;
  seconds?: number;
}

export interface Assets {
  intro?: MediaAsset;
  outro?: MediaAsset;
  music?: MusicAsset;
  logo?: LogoAsset;
  title_card?: CardAsset;
  end_card?: CardAsset;
}

export interface AudioSettings {
  noise_reduction: boolean;
  high_pass: boolean;
  compression: boolean;
  master: boolean;
  loudness_lufs: number;
}

export interface CaptionStyle {
  preset: string;
  font: string | null;
  size: number | null;
  position: "top" | "middle" | "bottom";
  color: string | null;
  karaoke: boolean;
  per_speaker_colors: boolean;
}

export interface VisualSettings {
  aspect_ratio: string;
  fit: "fit" | "fill";
  /** "blur" or a #RRGGBB colour. */
  background: string;
  captions: boolean;
  caption_style: CaptionStyle;
}

export type SuggestionMode = "natural" | "balanced" | "tight";

export interface SuggestionChoices {
  mode: SuggestionMode;
  accepted: string[];
  rejected: string[];
}

export interface EditsVersion {
  n: number;
  file: string;
  note?: string;
  created?: number;
}

/** edits/episode-edits.json — the only place a producer's changes live. */
export interface EpisodeEdits {
  schema_version: number;
  version: number;
  updated: number;
  source_duration_ms: number;
  operations: Operation[];
  speakers: Record<string, SpeakerInfo>;
  /** [start_ms, end_ms, speaker id] */
  speaker_map: [number, number, string][];
  sections: Section[];
  assets: Assets;
  audio: AudioSettings;
  visual: VisualSettings;
  extra_aspects: string[];
  title: string;
  suggestions: SuggestionChoices;
  versions: EditsVersion[];
}

export interface StudioWord {
  /** the word */
  w: string;
  /** start ms */
  s: number;
  /** end ms */
  e: number;
  /** confidence 0..1 */
  c?: number;
}

export type Span = [number, number];

/** analysis/studio/timeline.json */
export interface StudioTimeline {
  schema_version: number;
  episode_id: string;
  duration_ms: number;
  model?: string;
  prepared_at?: number;
  words: StudioWord[];
  silences: Span[];
  quiet: Span[];
  low_confidence: Span[];
  sentence_count?: number;
}

/** analysis/studio/waveform.json */
export interface StudioWaveform {
  schema_version: number;
  per_second: number;
  duration_ms: number;
  peaks: number[];
}

export const SUGGESTION_KINDS = [
  "filler",
  "pause",
  "false_start",
  "repeat",
  "dead_air_start",
  "dead_air_end",
  "profanity",
  "quiet",
  "low_confidence",
] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  start_ms: number;
  end_ms: number;
  text?: string;
  action: EditOperation;
  target_ms?: number;
  confidence?: number;
  /** the least aggressive mode that includes it (natural ⊂ balanced ⊂ tight). */
  level: SuggestionMode;
}

/** analysis/studio/suggestions.json */
export interface SuggestionsFile {
  schema_version: number;
  generated_at?: number;
  modes: Record<SuggestionMode, number>;
  suggestions: Suggestion[];
}

/** [source start, source end, output start] */
export type MapSegment = [number, number, number];

export interface CaptionGroup {
  start_ms: number;
  end_ms: number;
  text: string;
  speaker?: string | null;
}

export interface ChapterOut {
  id?: string;
  title: string;
  out_ms: number;
  /** where the chapter starts on the recording (kept for the transcript view). */
  source_ms?: number;
}

/** analysis/studio/prepared-v<version>.json — the full instruction set the renderer follows. */
export interface PreparedSpec {
  schema_version: number;
  version: number;
  episode_id: string;
  source?: string;
  media?: { width?: number; height?: number; fps?: number; duration_ms?: number; has_video?: boolean };
  keep: Span[];
  mutes: Span[];
  bleeps: Span[];
  output_duration_ms: number;
  map: MapSegment[];
  captions?: { groups?: CaptionGroup[]; style?: Partial<CaptionStyle>; speaker_colors?: Record<string, string> };
  chapters?: ChapterOut[];
  assets?: Assets;
  audio?: AudioSettings;
  visual?: VisualSettings;
  range?: Span | null;
  quality?: string;
  warnings?: string[];
}

export interface StudioLoudness {
  integrated_lufs: number;
  true_peak_dbtp: number;
  loudness_range_lu: number;
}

/** exports/studio/v<n>/report.json (also answered on the results lane). */
export interface StudioReport {
  episode_id: string;
  mode: "preview" | "export";
  version: number | null;
  files: Record<string, string>;
  duration_ms: number;
  output_duration_ms?: number;
  width?: number;
  height?: number;
  has_audio?: boolean;
  has_video?: boolean;
  captions?: boolean;
  loudness?: StudioLoudness | null;
  chapters?: ChapterOut[];
  parts?: { n: number; seconds?: number }[];
  warnings: string[];
  rendered_at?: number;
  seconds?: number;
  error?: string;
}

// ------------------------------------------------------------------- helpers

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function ms(value: unknown, fallback = 0): number {
  return Math.round(num(value, fallback));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string").map((v) => v as string) : [];
}

function spanList(value: unknown): Span[] {
  if (!Array.isArray(value)) return [];
  const out: Span[] = [];
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const a = ms(raw[0], -1);
    const b = ms(raw[1], -1);
    if (a < 0 || b <= a) continue;
    out.push([a, b]);
  }
  return out;
}

/** Sort and merge touching/overlapping ranges. */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Span[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// ------------------------------------------------------------ default record

export const DEFAULT_AUDIO: AudioSettings = {
  noise_reduction: true,
  high_pass: true,
  compression: true,
  master: true,
  loudness_lufs: -16,
};

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  preset: "clean",
  font: null,
  size: null,
  position: "bottom",
  color: null,
  karaoke: false,
  per_speaker_colors: false,
};

export const DEFAULT_VISUAL: VisualSettings = {
  aspect_ratio: "16:9",
  fit: "fit",
  background: "blur",
  captions: true,
  caption_style: { ...DEFAULT_CAPTION_STYLE },
};

export const SPEAKER_COLORS = ["#FF4D2E", "#2E7DFF", "#12B886", "#F5A524", "#A855F7", "#EC4899"];

/** A blank edit record for an episode of `durationMs`. */
export function emptyEdits(durationMs = 0, now: number = Date.now()): EpisodeEdits {
  return {
    schema_version: STUDIO_SCHEMA_VERSION,
    version: 1,
    updated: now / 1000,
    source_duration_ms: Math.max(0, Math.round(durationMs)),
    operations: [],
    speakers: {},
    speaker_map: [],
    sections: [],
    assets: {},
    audio: { ...DEFAULT_AUDIO },
    visual: { ...DEFAULT_VISUAL, caption_style: { ...DEFAULT_CAPTION_STYLE } },
    extra_aspects: [],
    title: "",
    suggestions: { mode: "balanced", accepted: [], rejected: [] },
    versions: [],
  };
}

function normalizeOperation(raw: unknown, index: number, durationMs: number): Operation | null {
  const o = asRecord(raw);
  const type = OPERATION_TYPES.includes(o.type as EditOperation) ? (o.type as EditOperation) : null;
  if (!type) return null;
  let start = Math.max(0, ms(o.start_ms, -1));
  let end = ms(o.end_ms, -1);
  if (end <= start) return null;
  if (durationMs > 0) {
    start = Math.min(start, durationMs);
    end = Math.min(end, durationMs);
    if (end <= start) return null;
  }
  const op: Operation = {
    id: str(o.id) || `e${String(index + 1).padStart(3, "0")}`,
    type,
    start_ms: start,
    end_ms: end,
    enabled: bool(o.enabled, true),
  };
  if (type === "shorten_silence") op.target_ms = Math.max(0, ms(o.target_ms, 600));
  if (typeof o.reason === "string" && o.reason) op.reason = o.reason;
  op.source = str(o.source) || "user";
  return op;
}

function normalizeAssets(raw: unknown): Assets {
  const a = asRecord(raw);
  const assets: Assets = {};
  const media = (key: "intro" | "outro") => {
    const v = asRecord(a[key]);
    if (typeof v.path === "string" && v.path) assets[key] = { path: v.path };
  };
  media("intro");
  media("outro");
  const music = asRecord(a.music);
  if (typeof music.path === "string" && music.path) {
    assets.music = {
      path: music.path,
      gain_db: num(music.gain_db, -22),
      duck_db: num(music.duck_db, -12),
      fade_ms: ms(music.fade_ms, 1500),
    };
  }
  const logo = asRecord(a.logo);
  if (typeof logo.path === "string" && logo.path) {
    const corner = str(logo.corner, "tr");
    assets.logo = {
      path: logo.path,
      corner: (["tl", "tr", "bl", "br"].includes(corner) ? corner : "tr") as LogoAsset["corner"],
      height: num(logo.height, 0.1),
      opacity: num(logo.opacity, 0.9),
    };
  }
  const card = (key: "title_card" | "end_card") => {
    const v = asRecord(a[key]);
    if (typeof v.text === "string" && v.text) {
      assets[key] = { text: v.text, subtitle: str(v.subtitle), seconds: num(v.seconds, 3) };
    }
  };
  card("title_card");
  card("end_card");
  return assets;
}

function normalizeSpeakers(raw: unknown): Record<string, SpeakerInfo> {
  const out: Record<string, SpeakerInfo> = {};
  const rec = asRecord(raw);
  let i = 0;
  for (const [id, value] of Object.entries(rec)) {
    if (!id) continue;
    const v = asRecord(value);
    out[id] = { name: str(v.name) || `Speaker ${i + 1}`, color: str(v.color) || SPEAKER_COLORS[i % SPEAKER_COLORS.length] };
    i++;
  }
  return out;
}

function normalizeSpeakerMap(raw: unknown, speakers: Record<string, SpeakerInfo>): [number, number, string][] {
  if (!Array.isArray(raw)) return [];
  const out: [number, number, string][] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 3) continue;
    const a = Math.max(0, ms(item[0], -1));
    const b = ms(item[1], -1);
    const id = str(item[2]);
    if (a < 0 || b <= a || !id) continue;
    if (!speakers[id]) speakers[id] = { name: `Speaker ${Object.keys(speakers).length + 1}`, color: SPEAKER_COLORS[Object.keys(speakers).length % SPEAKER_COLORS.length] };
    out.push([a, b, id]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

/** Read whatever is on file (any vintage, or nonsense) as a valid edit record. */
export function normalizeEdits(raw: unknown, fallbackDurationMs = 0, now: number = Date.now()): EpisodeEdits {
  const r = asRecord(raw);
  const base = emptyEdits(Math.max(ms(r.source_duration_ms), Math.round(Math.max(0, fallbackDurationMs))), now);
  const duration = base.source_duration_ms;
  const operations: Operation[] = [];
  if (Array.isArray(r.operations)) {
    r.operations.forEach((item, i) => {
      const op = normalizeOperation(item, i, duration);
      if (op && !operations.some((o) => o.id === op.id)) operations.push(op);
    });
  }
  const speakers = normalizeSpeakers(r.speakers);
  const speaker_map = normalizeSpeakerMap(r.speaker_map, speakers);
  const sections: Section[] = Array.isArray(r.sections)
    ? r.sections
        .map((item, i) => {
          const s = asRecord(item);
          const start = Math.max(0, ms(s.start_ms, -1));
          if (start < 0) return null;
          return { id: str(s.id) || `sec${String(i + 1).padStart(2, "0")}`, title: str(s.title) || "Chapter", start_ms: start };
        })
        .filter((s): s is Section => s != null)
        .sort((a, b) => a.start_ms - b.start_ms)
    : [];
  const audioRaw = asRecord(r.audio);
  const visualRaw = asRecord(r.visual);
  const styleRaw = asRecord(visualRaw.caption_style);
  const sugRaw = asRecord(r.suggestions);
  const mode = (["natural", "balanced", "tight"] as const).includes(sugRaw.mode as SuggestionMode) ? (sugRaw.mode as SuggestionMode) : "balanced";
  const position = (["top", "middle", "bottom"] as const).includes(styleRaw.position as CaptionStyle["position"])
    ? (styleRaw.position as CaptionStyle["position"])
    : "bottom";
  const versions: EditsVersion[] = [];
  if (Array.isArray(r.versions)) {
    for (const item of r.versions) {
      const v = asRecord(item);
      const n = ms(v.n, 0);
      if (n <= 0) continue;
      const entry: EditsVersion = { n, file: str(v.file) || versionFile(n) };
      if (str(v.note)) entry.note = str(v.note);
      if (num(v.created, 0)) entry.created = num(v.created, 0);
      versions.push(entry);
    }
    versions.sort((a, b) => a.n - b.n);
  }
  return {
    ...base,
    version: Math.max(1, ms(r.version, 1)),
    updated: num(r.updated, base.updated),
    operations,
    speakers,
    speaker_map,
    sections,
    assets: normalizeAssets(r.assets),
    audio: {
      noise_reduction: bool(audioRaw.noise_reduction, DEFAULT_AUDIO.noise_reduction),
      high_pass: bool(audioRaw.high_pass, DEFAULT_AUDIO.high_pass),
      compression: bool(audioRaw.compression, DEFAULT_AUDIO.compression),
      master: bool(audioRaw.master, DEFAULT_AUDIO.master),
      loudness_lufs: num(audioRaw.loudness_lufs, DEFAULT_AUDIO.loudness_lufs),
    },
    visual: {
      aspect_ratio: str(visualRaw.aspect_ratio) || DEFAULT_VISUAL.aspect_ratio,
      fit: visualRaw.fit === "fill" ? "fill" : "fit",
      background: str(visualRaw.background) || DEFAULT_VISUAL.background,
      captions: bool(visualRaw.captions, DEFAULT_VISUAL.captions),
      caption_style: {
        preset: str(styleRaw.preset) || DEFAULT_CAPTION_STYLE.preset,
        font: typeof styleRaw.font === "string" && styleRaw.font ? styleRaw.font : null,
        size: typeof styleRaw.size === "number" && Number.isFinite(styleRaw.size) ? styleRaw.size : null,
        position,
        color: typeof styleRaw.color === "string" && styleRaw.color ? styleRaw.color : null,
        karaoke: bool(styleRaw.karaoke, false),
        per_speaker_colors: bool(styleRaw.per_speaker_colors, false),
      },
    },
    extra_aspects: strList(r.extra_aspects),
    title: str(r.title),
    suggestions: { mode, accepted: strList(sugRaw.accepted), rejected: strList(sugRaw.rejected) },
    versions,
  };
}

/** Tolerant readers for the files the preparation step writes. */
export function normalizeTimeline(raw: unknown): StudioTimeline | null {
  const r = asRecord(raw);
  if (!Array.isArray(r.words)) return null;
  const words: StudioWord[] = [];
  for (const item of r.words) {
    const w = asRecord(item);
    const text = str(w.w);
    const s = ms(w.s, -1);
    const e = ms(w.e, -1);
    if (!text || s < 0 || e < s) continue;
    words.push({ w: text, s, e, c: num(w.c, 1) });
  }
  const last = words[words.length - 1];
  return {
    schema_version: ms(r.schema_version, 1),
    episode_id: str(r.episode_id),
    duration_ms: Math.max(ms(r.duration_ms), last ? last.e : 0),
    model: str(r.model) || undefined,
    prepared_at: num(r.prepared_at, 0) || undefined,
    words,
    silences: spanList(r.silences),
    quiet: spanList(r.quiet),
    low_confidence: spanList(r.low_confidence),
    sentence_count: ms(r.sentence_count, 0) || undefined,
  };
}

export function normalizeWaveform(raw: unknown): StudioWaveform | null {
  const r = asRecord(raw);
  if (!Array.isArray(r.peaks)) return null;
  const peaks = r.peaks.map((p) => Math.max(0, Math.min(1, num(p))));
  return {
    schema_version: ms(r.schema_version, 1),
    per_second: num(r.per_second, 10) || 10,
    duration_ms: ms(r.duration_ms),
    peaks,
  };
}

export function normalizeSuggestions(raw: unknown): Suggestion[] {
  const r = asRecord(raw);
  const list = Array.isArray(r.suggestions) ? r.suggestions : Array.isArray(raw) ? raw : [];
  const out: Suggestion[] = [];
  for (const item of list) {
    const s = asRecord(item);
    const id = str(s.id);
    const start = Math.max(0, ms(s.start_ms, -1));
    const end = ms(s.end_ms, -1);
    if (!id || start < 0 || end <= start) continue;
    const kind = SUGGESTION_KINDS.includes(s.kind as SuggestionKind) ? (s.kind as SuggestionKind) : "filler";
    const action = OPERATION_TYPES.includes(s.action as EditOperation) ? (s.action as EditOperation) : "cut";
    const level = (["natural", "balanced", "tight"] as const).includes(s.level as SuggestionMode) ? (s.level as SuggestionMode) : "balanced";
    const sug: Suggestion = { id, kind, start_ms: start, end_ms: end, action, level, confidence: num(s.confidence, 1) };
    if (typeof s.text === "string" && s.text) sug.text = s.text;
    if (action === "shorten_silence") sug.target_ms = Math.max(0, ms(s.target_ms, 600));
    out.push(sug);
  }
  return out.sort((a, b) => a.start_ms - b.start_ms);
}

export function normalizeSpec(raw: unknown): PreparedSpec | null {
  const r = asRecord(raw);
  if (!Array.isArray(r.map) && !Array.isArray(r.keep)) return null;
  const map: MapSegment[] = Array.isArray(r.map)
    ? r.map
        .filter((seg) => Array.isArray(seg) && seg.length >= 3)
        .map((seg) => [ms((seg as unknown[])[0]), ms((seg as unknown[])[1]), ms((seg as unknown[])[2])] as MapSegment)
        .filter(([a, b]) => b > a)
    : [];
  const keep = spanList(r.keep);
  return {
    schema_version: ms(r.schema_version, 1),
    version: ms(r.version, 1),
    episode_id: str(r.episode_id),
    source: str(r.source) || undefined,
    media: asRecord(r.media) as PreparedSpec["media"],
    keep,
    mutes: spanList(r.mutes),
    bleeps: spanList(r.bleeps),
    output_duration_ms: ms(r.output_duration_ms, map.length ? map[map.length - 1][2] + (map[map.length - 1][1] - map[map.length - 1][0]) : 0),
    map: map.length ? map : mapFromKeep(keep),
    captions: asRecord(r.captions) as PreparedSpec["captions"],
    chapters: Array.isArray(r.chapters)
      ? r.chapters.map((c) => {
          const rec = asRecord(c);
          return { id: str(rec.id) || undefined, title: str(rec.title) || "Chapter", out_ms: ms(rec.out_ms), source_ms: ms(rec.source_ms) || undefined };
        })
      : [],
    assets: normalizeAssets(r.assets),
    range: Array.isArray(r.range) && r.range.length >= 2 ? ([ms(r.range[0]), ms(r.range[1])] as Span) : null,
    quality: str(r.quality) || undefined,
    warnings: strList(r.warnings),
  };
}

export function toStudioReport(raw: unknown): StudioReport {
  const m = asRecord(raw);
  const files: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(m.files))) if (typeof value === "string") files[key] = value;
  const loud = asRecord(m.loudness);
  return {
    episode_id: str(m.episode_id),
    mode: m.mode === "export" ? "export" : "preview",
    version: typeof m.version === "number" ? m.version : null,
    files,
    duration_ms: ms(m.duration_ms, ms(m.output_duration_ms)),
    output_duration_ms: ms(m.output_duration_ms) || undefined,
    width: ms(m.width) || undefined,
    height: ms(m.height) || undefined,
    has_audio: typeof m.has_audio === "boolean" ? m.has_audio : undefined,
    has_video: typeof m.has_video === "boolean" ? m.has_video : undefined,
    captions: typeof m.captions === "boolean" ? m.captions : undefined,
    loudness:
      "integrated_lufs" in loud
        ? { integrated_lufs: num(loud.integrated_lufs), true_peak_dbtp: num(loud.true_peak_dbtp), loudness_range_lu: num(loud.loudness_range_lu) }
        : null,
    chapters: Array.isArray(m.chapters)
      ? m.chapters.map((c) => {
          const rec = asRecord(c);
          return { title: str(rec.title) || "Chapter", out_ms: ms(rec.out_ms) };
        })
      : [],
    parts: Array.isArray(m.parts)
      ? m.parts.map((p, i) => {
          const rec = asRecord(p);
          return { n: ms(rec.n, i + 1), seconds: num(rec.seconds, 0) || undefined };
        })
      : undefined,
    warnings: strList(m.warnings),
    rendered_at: num(m.rendered_at, 0) || undefined,
    seconds: num(m.seconds, 0) || undefined,
    error: typeof m.error === "string" ? m.error : undefined,
  };
}

// ---------------------------------------------------------------- operations

/** The next free operation id ("e001", "e002", …). */
export function nextOperationId(operations: Operation[]): string {
  let max = 0;
  for (const op of operations) {
    const n = Number(/^e(\d+)$/.exec(op.id)?.[1] ?? 0);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `e${String(max + 1).padStart(3, "0")}`;
}

const byStart = (a: Operation, b: Operation) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || a.id.localeCompare(b.id);

export interface NewOperation {
  type: EditOperation;
  start_ms: number;
  end_ms: number;
  target_ms?: number;
  reason?: string;
  source?: string;
  enabled?: boolean;
}

/** Add one instruction. The record's version is untouched — saving bumps it. */
export function addOperation(edits: EpisodeEdits, op: NewOperation): EpisodeEdits {
  const start = Math.max(0, Math.round(Math.min(op.start_ms, op.end_ms)));
  let end = Math.round(Math.max(op.start_ms, op.end_ms));
  if (edits.source_duration_ms > 0) end = Math.min(end, edits.source_duration_ms);
  if (end <= start) return edits;
  const next: Operation = {
    id: nextOperationId(edits.operations),
    type: op.type,
    start_ms: start,
    end_ms: end,
    enabled: op.enabled !== false,
    source: op.source ?? "user",
  };
  if (op.type === "shorten_silence") next.target_ms = Math.max(0, Math.round(op.target_ms ?? 600));
  if (op.reason) next.reason = op.reason;
  return { ...edits, operations: [...edits.operations, next].sort(byStart) };
}

export function updateOperation(edits: EpisodeEdits, id: string, patch: Partial<Omit<Operation, "id">>): EpisodeEdits {
  let touched = false;
  const operations = edits.operations.map((op) => {
    if (op.id !== id) return op;
    touched = true;
    const merged: Operation = { ...op, ...patch, id: op.id };
    const start = Math.max(0, Math.round(Math.min(merged.start_ms, merged.end_ms)));
    const end = Math.round(Math.max(merged.start_ms, merged.end_ms));
    return { ...merged, start_ms: start, end_ms: Math.max(start + 1, end) };
  });
  return touched ? { ...edits, operations: operations.sort(byStart) } : edits;
}

export function removeOperation(edits: EpisodeEdits, id: string): EpisodeEdits {
  const operations = edits.operations.filter((op) => op.id !== id);
  if (operations.length === edits.operations.length) return edits;
  const op = edits.operations.find((o) => o.id === id);
  const suggestionId = op ? suggestionIdOf(op) : null;
  const suggestions = suggestionId
    ? { ...edits.suggestions, accepted: edits.suggestions.accepted.filter((s) => s !== suggestionId) }
    : edits.suggestions;
  return { ...edits, operations, suggestions };
}

/** Restore (enabled: false) or re-apply an instruction without losing it. */
export function toggleOperation(edits: EpisodeEdits, id: string, enabled?: boolean): EpisodeEdits {
  let touched = false;
  const operations = edits.operations.map((op) => {
    if (op.id !== id) return op;
    touched = true;
    return { ...op, enabled: enabled ?? !op.enabled };
  });
  return touched ? { ...edits, operations } : edits;
}

/** Saving: a new version number and a fresh timestamp. */
export function bumpVersion(edits: EpisodeEdits, now: number = Date.now()): EpisodeEdits {
  return { ...edits, version: Math.max(1, Math.round(edits.version)) + 1, updated: now / 1000 };
}

/** The middle piece a shorten_silence removes (null when the gap is already short enough). */
export function silenceCut(op: Operation): Span | null {
  const target = Math.max(300, Math.round(op.target_ms ?? 600));
  const total = op.end_ms - op.start_ms;
  if (total <= target) return null;
  const head = Math.max(150, Math.floor(target / 2));
  const tail = Math.max(150, target - head);
  const start = op.start_ms + head;
  const end = op.end_ms - tail;
  return end > start ? [start, end] : null;
}

/** Every stretch that leaves the episode: enabled cuts plus the middles of shortened silences. */
export function mergedCuts(edits: EpisodeEdits): Span[] {
  const spans: Span[] = [];
  for (const op of edits.operations) {
    if (!op.enabled) continue;
    if (op.type === "cut") spans.push([op.start_ms, op.end_ms]);
    else if (op.type === "shorten_silence") {
      const cut = silenceCut(op);
      if (cut) spans.push(cut);
    }
  }
  return mergeSpans(spans);
}

/** Ranges that stay, in order — the complement of mergedCuts inside the recording. */
export function keepSegments(edits: EpisodeEdits): Span[] {
  const duration = Math.max(0, Math.round(edits.source_duration_ms));
  if (duration <= 0) return [];
  const cuts = mergedCuts(edits);
  const keep: Span[] = [];
  let at = 0;
  for (const [a, b] of cuts) {
    const start = Math.max(0, Math.min(a, duration));
    const end = Math.max(0, Math.min(b, duration));
    if (start > at) keep.push([at, start]);
    at = Math.max(at, end);
  }
  if (at < duration) keep.push([at, duration]);
  return keep.filter(([a, b]) => b > a);
}

/** How long the finished episode runs. */
export function outputDurationMs(edits: EpisodeEdits): number {
  return keepSegments(edits).reduce((total, [a, b]) => total + (b - a), 0);
}

/** Enabled ranges of one kind (mutes and bleeps stay on the source timeline). */
export function operationSpans(edits: EpisodeEdits, type: EditOperation): Span[] {
  return mergeSpans(edits.operations.filter((op) => op.enabled && op.type === type).map((op) => [op.start_ms, op.end_ms] as Span));
}

// ------------------------------------------------------------- timeline map

export interface TimelineMapLite {
  segments: MapSegment[];
  outputDurationMs: number;
  sourceDurationMs: number;
  /** Where a recording position lands in the finished episode (a removed position lands on the next kept moment). */
  sourceToOut(msIn: number): number;
  /** Where a finished-episode position sits in the recording. */
  outToSource(msOut: number): number;
  /** True when this recording position was removed. */
  isCut(msIn: number): boolean;
}

function mapFromKeep(keep: Span[]): MapSegment[] {
  const segments: MapSegment[] = [];
  let out = 0;
  for (const [a, b] of keep) {
    segments.push([a, b, out]);
    out += b - a;
  }
  return segments;
}

function makeMap(segments: MapSegment[], sourceDurationMs: number): TimelineMapLite {
  const segs = segments.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const total = segs.reduce((sum, [a, b]) => sum + (b - a), 0);
  const sourceDuration = Math.max(sourceDurationMs, segs.length ? segs[segs.length - 1][1] : 0);
  return {
    segments: segs,
    outputDurationMs: total,
    sourceDurationMs: sourceDuration,
    sourceToOut(msIn: number) {
      const t = Math.round(msIn);
      if (!segs.length) return 0;
      for (const [a, b, o] of segs) {
        if (t < a) return o;
        if (t < b) return o + (t - a);
      }
      return total;
    },
    outToSource(msOut: number) {
      const t = Math.round(msOut);
      if (!segs.length) return 0;
      if (t <= 0) return segs[0][0];
      for (const [a, b, o] of segs) {
        const len = b - a;
        if (t < o + len) return a + Math.max(0, t - o);
      }
      return segs[segs.length - 1][1];
    },
    isCut(msIn: number) {
      const t = Math.round(msIn);
      return !segs.some(([a, b]) => t >= a && t < b);
    },
  };
}

/**
 * The source↔output map. Built from the prepared instructions when they exist
 * (exact), otherwise from the edit record (a close client-side approximation:
 * the finished file also snaps cuts to word edges).
 */
export function timelineMapLite(source: EpisodeEdits | PreparedSpec | MapSegment[]): TimelineMapLite {
  if (Array.isArray(source)) return makeMap(source, 0);
  if ("map" in source || "keep" in source) {
    const spec = source as PreparedSpec;
    const segments = spec.map?.length ? spec.map : mapFromKeep(spec.keep ?? []);
    return makeMap(segments, spec.media?.duration_ms ?? 0);
  }
  const edits = source as EpisodeEdits;
  return makeMap(mapFromKeep(keepSegments(edits)), edits.source_duration_ms);
}

/**
 * The next recording position that is still in the episode — what the player
 * jumps to when playback runs into a removed stretch.
 */
export function nextKeepEdge(edits: EpisodeEdits, msIn: number): number {
  const t = Math.round(msIn);
  const keep = keepSegments(edits);
  if (!keep.length) return Math.max(0, Math.min(t, Math.max(0, edits.source_duration_ms)));
  for (const [a, b] of keep) {
    if (t < a) return a;
    if (t < b) return t;
  }
  return keep[keep.length - 1][1];
}

// ------------------------------------------------------------------- history

export const HISTORY_LIMIT = 50;

export interface History {
  past: EpisodeEdits[];
  present: EpisodeEdits;
  future: EpisodeEdits[];
}

export function initHistory(edits: EpisodeEdits): History {
  return { past: [], present: edits, future: [] };
}

/** Record a change. The stack keeps the last 50 steps. */
export function pushHistory(history: History, edits: EpisodeEdits): History {
  if (edits === history.present) return history;
  return { past: [...history.past, history.present].slice(-HISTORY_LIMIT), present: edits, future: [] };
}

export const canUndo = (history: History) => history.past.length > 0;
export const canRedo = (history: History) => history.future.length > 0;

export function undo(history: History): History {
  if (!history.past.length) return history;
  const past = history.past.slice(0, -1);
  const present = history.past[history.past.length - 1];
  return { past, present, future: [history.present, ...history.future].slice(0, HISTORY_LIMIT) };
}

export function redo(history: History): History {
  if (!history.future.length) return history;
  const [present, ...future] = history.future;
  return { past: [...history.past, history.present].slice(-HISTORY_LIMIT), present, future };
}

// --------------------------------------------------------------- suggestions

export const SUGGESTION_MODES: SuggestionMode[] = ["natural", "balanced", "tight"];
const MODE_RANK: Record<SuggestionMode, number> = { natural: 0, balanced: 1, tight: 2 };

export const SUGGESTION_LABELS: Record<SuggestionKind, string> = {
  filler: "Filler word",
  pause: "Long pause",
  false_start: "False start",
  repeat: "Repeated line",
  dead_air_start: "Silence before the start",
  dead_air_end: "Silence after the end",
  profanity: "Strong language",
  quiet: "Very quiet stretch",
  low_confidence: "Hard to make out",
};

export const suggestionLabel = (kind: SuggestionKind): string => SUGGESTION_LABELS[kind] ?? "Cleanup";

export const MODE_LABELS: Record<SuggestionMode, string> = {
  natural: "Light touch",
  balanced: "Balanced",
  tight: "Tight",
};

/** Modes nest: natural ⊂ balanced ⊂ tight. */
export function suggestionsForMode(all: Suggestion[], mode: SuggestionMode): Suggestion[] {
  const limit = MODE_RANK[mode] ?? 1;
  return all.filter((s) => (MODE_RANK[s.level] ?? 1) <= limit);
}

export function suggestionCounts(list: Suggestion[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of list) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  return counts;
}

export const suggestionSource = (id: string) => `suggestion:${id}`;

function suggestionIdOf(op: Operation): string | null {
  const src = op.source ?? "";
  return src.startsWith("suggestion:") ? src.slice("suggestion:".length) : null;
}

export type SuggestionState = "accepted" | "rejected" | "open";

export function suggestionState(edits: EpisodeEdits, suggestion: Suggestion | string): SuggestionState {
  const id = typeof suggestion === "string" ? suggestion : suggestion.id;
  if (edits.suggestions.rejected.includes(id)) return "rejected";
  if (edits.suggestions.accepted.includes(id)) return "accepted";
  return edits.operations.some((op) => suggestionIdOf(op) === id) ? "accepted" : "open";
}

/** Turn one suggestion into an instruction (idempotent — accepting twice changes nothing). */
export function applySuggestion(edits: EpisodeEdits, suggestion: Suggestion): EpisodeEdits {
  if (suggestionState(edits, suggestion) === "accepted") return edits;
  const withOp = addOperation(edits, {
    type: suggestion.action,
    start_ms: suggestion.start_ms,
    end_ms: suggestion.end_ms,
    target_ms: suggestion.target_ms,
    reason: suggestion.text ? `${suggestionLabel(suggestion.kind)}: ${suggestion.text}`.slice(0, 120) : suggestionLabel(suggestion.kind),
    source: suggestionSource(suggestion.id),
  });
  if (withOp === edits) return edits;
  return {
    ...withOp,
    suggestions: {
      ...edits.suggestions,
      accepted: [...edits.suggestions.accepted.filter((id) => id !== suggestion.id), suggestion.id],
      rejected: edits.suggestions.rejected.filter((id) => id !== suggestion.id),
    },
  };
}

/** Turn one down: any instruction it created goes away and it stays out of "apply all". */
export function rejectSuggestion(edits: EpisodeEdits, suggestion: Suggestion | string): EpisodeEdits {
  const id = typeof suggestion === "string" ? suggestion : suggestion.id;
  const operations = edits.operations.filter((op) => suggestionIdOf(op) !== id);
  return {
    ...edits,
    operations,
    suggestions: {
      ...edits.suggestions,
      accepted: edits.suggestions.accepted.filter((x) => x !== id),
      rejected: [...edits.suggestions.rejected.filter((x) => x !== id), id],
    },
  };
}

const overlaps = (a: Span, b: Span) => a[0] < b[1] && b[0] < a[1];

/**
 * Accept everything the chosen cleanup level offers, skipping anything already
 * decided or landing on an existing instruction. Running it twice is a no-op.
 */
export function applyAll(edits: EpisodeEdits, list: Suggestion[], mode: SuggestionMode = edits.suggestions.mode): EpisodeEdits {
  let next: EpisodeEdits = { ...edits, suggestions: { ...edits.suggestions, mode } };
  for (const suggestion of suggestionsForMode(list, mode)) {
    if (suggestionState(next, suggestion) !== "open") continue;
    const clash = next.operations.some((op) => op.enabled && overlaps([op.start_ms, op.end_ms], [suggestion.start_ms, suggestion.end_ms]));
    if (clash) continue;
    next = applySuggestion(next, suggestion);
  }
  return next;
}

/** Switch the cleanup level (the accepted/turned-down choices stay). */
export function setSuggestionMode(edits: EpisodeEdits, mode: SuggestionMode): EpisodeEdits {
  return { ...edits, suggestions: { ...edits.suggestions, mode } };
}

// ------------------------------------------------------------------ versions

export const versionFile = (n: number) => `edits/versions/${String(Math.max(1, Math.round(n))).padStart(3, "0")}.json`;

export interface VersionSnapshot {
  edits: EpisodeEdits;
  file: string;
  n: number;
}

/** A named save point: the bumped record plus the file its full copy belongs in. */
export function snapshotVersion(edits: EpisodeEdits, note = "", now: number = Date.now()): VersionSnapshot {
  const n = Math.max(0, ...edits.versions.map((v) => v.n ?? 0)) + 1;
  const file = versionFile(n);
  const bumped = bumpVersion(edits, now);
  return {
    n,
    file,
    edits: { ...bumped, versions: [...edits.versions, { n, file, note: note || undefined, created: now / 1000 }] },
  };
}

// ------------------------------------------------------------------ chapters

/** Chapter markers placed on the finished episode; a chapter whose whole stretch was removed drops out. */
export function chapterListOut(edits: EpisodeEdits, spec?: PreparedSpec | null): ChapterOut[] {
  const map = timelineMapLite(spec ?? edits);
  const sections = [...edits.sections].sort((a, b) => a.start_ms - b.start_ms);
  const duration = Math.max(edits.source_duration_ms, map.sourceDurationMs);
  const out: ChapterOut[] = [];
  sections.forEach((section, i) => {
    const rangeEnd = i + 1 < sections.length ? sections[i + 1].start_ms : duration;
    const firstKept = nextKeepEdge(edits, section.start_ms);
    if (firstKept >= rangeEnd && rangeEnd > section.start_ms) return;
    const at = map.isCut(section.start_ms) ? firstKept : section.start_ms;
    out.push({ id: section.id, title: section.title, out_ms: map.sourceToOut(at), source_ms: section.start_ms });
  });
  return out;
}

export function splitSection(edits: EpisodeEdits, msIn: number, title = "Chapter"): EpisodeEdits {
  const at = Math.max(0, Math.round(msIn));
  const existing = edits.sections.find((s) => Math.abs(s.start_ms - at) <= 250);
  if (existing) {
    return { ...edits, sections: edits.sections.map((s) => (s.id === existing.id ? { ...s, title: title || s.title } : s)) };
  }
  let n = edits.sections.length + 1;
  const ids = new Set(edits.sections.map((s) => s.id));
  while (ids.has(`sec${String(n).padStart(2, "0")}`)) n++;
  const section: Section = { id: `sec${String(n).padStart(2, "0")}`, title: title || "Chapter", start_ms: at };
  return { ...edits, sections: [...edits.sections, section].sort((a, b) => a.start_ms - b.start_ms) };
}

export function removeSection(edits: EpisodeEdits, id: string): EpisodeEdits {
  const sections = edits.sections.filter((s) => s.id !== id);
  return sections.length === edits.sections.length ? edits : { ...edits, sections };
}

// ------------------------------------------------------------------ speakers

function ensureSpeaker(speakers: Record<string, SpeakerInfo>, id: string): Record<string, SpeakerInfo> {
  if (speakers[id]) return speakers;
  const n = Object.keys(speakers).length;
  return { ...speakers, [id]: { name: `Speaker ${n + 1}`, color: SPEAKER_COLORS[n % SPEAKER_COLORS.length] } };
}

/** Mark a stretch as one person talking; overlapping marks are trimmed away. */
export function assignSpeaker(edits: EpisodeEdits, startMs: number, endMs: number, speakerId: string): EpisodeEdits {
  const start = Math.max(0, Math.round(Math.min(startMs, endMs)));
  const end = Math.round(Math.max(startMs, endMs));
  if (end <= start || !speakerId) return edits;
  const ranges: [number, number, string][] = [];
  for (const [a, b, id] of edits.speaker_map) {
    if (b <= start || a >= end) {
      ranges.push([a, b, id]);
      continue;
    }
    if (a < start) ranges.push([a, start, id]);
    if (b > end) ranges.push([end, b, id]);
  }
  ranges.push([start, end, speakerId]);
  ranges.sort((x, y) => x[0] - y[0]);
  const merged: [number, number, string][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && last[2] === range[2] && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range] as [number, number, string]);
  }
  return { ...edits, speakers: ensureSpeaker(edits.speakers, speakerId), speaker_map: merged };
}

export function renameSpeaker(edits: EpisodeEdits, speakerId: string, name: string): EpisodeEdits {
  const clean = name.trim().slice(0, 60);
  if (!speakerId || !clean) return edits;
  const speakers = ensureSpeaker(edits.speakers, speakerId);
  return { ...edits, speakers: { ...speakers, [speakerId]: { ...speakers[speakerId], name: clean } } };
}

export function setSpeakerColor(edits: EpisodeEdits, speakerId: string, color: string): EpisodeEdits {
  if (!speakerId || !color) return edits;
  const speakers = ensureSpeaker(edits.speakers, speakerId);
  return { ...edits, speakers: { ...speakers, [speakerId]: { ...speakers[speakerId], color } } };
}

/** Who is marked as talking at this recording position (null when nobody is). */
export function speakerAt(edits: EpisodeEdits, msIn: number): string | null {
  const t = Math.round(msIn);
  for (const [a, b, id] of edits.speaker_map) if (t >= a && t < b) return id;
  return null;
}

export function speakerName(edits: EpisodeEdits, speakerId: string | null): string {
  if (!speakerId) return "";
  return edits.speakers[speakerId]?.name ?? speakerId;
}

// -------------------------------------------------------------------- search

export interface WordMatch {
  /** index of the first word of the match */
  start: number;
  /** index of the last word of the match */
  end: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .trim();

/** Every place a phrase is said, as word ranges (a trailing partial word still counts). */
export function searchWords(words: StudioWord[], query: string): WordMatch[] {
  const q = normalizeText(query ?? "");
  if (!q || !words.length) return [];
  const starts: number[] = [];
  const wordOf: number[] = [];
  let joined = "";
  words.forEach((word, i) => {
    const token = normalizeText(word.w);
    if (!token) return;
    if (joined) joined += " ";
    starts.push(joined.length);
    for (let k = 0; k < token.length; k++) wordOf[joined.length + k] = i;
    joined += token;
  });
  const startSet = new Set(starts);
  const matches: WordMatch[] = [];
  let at = joined.indexOf(q);
  while (at >= 0) {
    if (startSet.has(at)) {
      let first = -1;
      let last = -1;
      for (let i = at; i < at + q.length; i++) {
        const idx = wordOf[i];
        if (idx == null) continue;
        if (first < 0) first = idx;
        last = idx;
      }
      if (first >= 0) {
        matches.push({
          start: first,
          end: last,
          start_ms: words[first].s,
          end_ms: words[last].e,
          text: words.slice(first, last + 1).map((w) => w.w).join(" "),
        });
      }
    }
    at = joined.indexOf(q, at + 1);
  }
  return matches;
}

// ----------------------------------------------------------------- formatting

/** A plain-language length: "42 sec", "5 min 20 sec", "1 hr 4 min". */
export function fmtDuration(msIn: number): string {
  const total = Math.max(0, Math.round(msIn));
  if (total < 60_000) {
    const seconds = total / 1000;
    const shown = seconds >= 10 || Number.isInteger(seconds) ? Math.round(seconds) : Math.round(seconds * 10) / 10;
    return `${shown} sec`;
  }
  if (total < 3_600_000) {
    const m = Math.floor(total / 60_000);
    const s = Math.round((total - m * 60_000) / 1000);
    return s ? `${m} min ${s} sec` : `${m} min`;
  }
  const h = Math.floor(total / 3_600_000);
  const m = Math.round((total - h * 3_600_000) / 60_000);
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** A running clock stamp for the player and the transcript: 12:04 or 1:12:04. */
export function fmtPosition(msIn: number): string {
  const total = Math.max(0, Math.floor(msIn / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** How much shorter the episode got, in plain words. */
export function trimmedSummary(edits: EpisodeEdits): string {
  const removed = Math.max(0, edits.source_duration_ms - outputDurationMs(edits));
  if (removed <= 0) return "Nothing removed yet";
  return `${fmtDuration(removed)} removed — ${fmtDuration(outputDurationMs(edits))} left`;
}
