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
  /** Ideas the producer looked at and left alone (review-only ones can only be marked, never applied). */
  reviewed: string[];
}

/**
 * A word the producer respelled. `word_id` is "w" + the word's index in
 * analysis/studio/timeline.json (that file never changes after preparation).
 * Corrections change what is written on screen and in the captions — never the
 * timing and never the sound.
 */
export interface Correction {
  word_id: string;
  text: string;
  original: string;
}

export interface EditsVersion {
  n: number;
  file: string;
  note?: string;
  created?: number;
}

/**
 * edits/episode-edits.json — the only place a producer's changes live.
 *
 * `version` is the monotonic revision of THIS record: every successful save
 * moves it on by one, and every render/prepared file is keyed by the number it
 * was made from (that is how the studio knows a preview is stale). Named save
 * points are a different thing: `versions[]` lists immutable full copies under
 * `edits/versions/NNN.json`, which are never rewritten.
 */
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
  /** Applied brand template ({id, revision, hash, resolved}). Absent in older files. */
  brand?: Record<string, unknown> | null;
  /** Respelled words (display + captions only). Absent in older files. */
  corrections: Correction[];
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
/** Bumped by the aligner when word timing improves; older timelines should offer a refresh. */
export const CURRENT_ALIGN_VERSION = 2;

export interface StudioTimeline {
  schema_version: number;
  align_version?: number;
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

/** "review" = the studio only points the stretch out; it never edits by itself. */
export type SuggestionAction = EditOperation | "review";

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  start_ms: number;
  end_ms: number;
  text?: string;
  action: SuggestionAction;
  target_ms?: number;
  confidence?: number;
  /** the least aggressive mode that includes it (natural ⊂ balanced ⊂ tight). */
  level: SuggestionMode;
  /** Listen and decide only: never applied by "apply all", no Apply button. */
  review_only?: boolean;
}

/** analysis/studio/suggestions.json */
export interface SuggestionsFile {
  schema_version: number;
  generated_at?: number;
  modes: Record<SuggestionMode, number>;
  suggestions: Suggestion[];
  /** The language the recording was transcribed in ("en", "en-US", "de", …). */
  language?: string | null;
  /** Kinds that could not be looked for in this language (filler, profanity outside English). */
  unsupported?: string[];
}

/** What `normalizeSuggestionsFile` hands back: the list plus what the file says about it. */
export interface SuggestionsData {
  suggestions: Suggestion[];
  language: string | null;
  unsupported: SuggestionKind[];
  modes: Record<SuggestionMode, number> | null;
  generated_at?: number;
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
  /** Milliseconds of intro/title-card before the edit timeline in this file. */
  lead_ms?: number;
  /** The render's measured quality block (tier, dimensions, fps, crf, …). */
  quality?: Record<string, unknown> | null;
  cached?: boolean;
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
    suggestions: { mode: "balanced", accepted: [], rejected: [], reviewed: [] },
    versions: [],
    corrections: [],
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
    suggestions: { mode, accepted: strList(sugRaw.accepted), rejected: strList(sugRaw.rejected), reviewed: strList(sugRaw.reviewed) },
    versions,
    corrections: normalizeCorrections(r.corrections),
    brand: r.brand && typeof r.brand === "object" ? (r.brand as Record<string, unknown>) : undefined,
  };
}

/** Respellings on file, any vintage; anything without a word id or new text drops out. */
export function normalizeCorrections(raw: unknown): Correction[] {
  if (!Array.isArray(raw)) return [];
  const out: Correction[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const c = asRecord(item);
    const word_id = str(c.word_id);
    const text = str(c.text).trim();
    if (!/^w\d+$/.test(word_id) || !text || seen.has(word_id)) continue;
    seen.add(word_id);
    out.push({ word_id, text: text.slice(0, 80), original: str(c.original) });
  }
  return out.sort((a, b) => wordIndex(a.word_id) - wordIndex(b.word_id));
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
    align_version: ms(r.align_version, 1),
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

/**
 * Kinds that are only ever pointed out, never acted on by the studio: a
 * stretch the transcriber could barely make out must not be silenced behind
 * the producer's back, whatever an older file says it wanted.
 */
export const REVIEW_ONLY_KINDS: SuggestionKind[] = ["low_confidence"];

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
    const reviewOnly = s.review_only === true || s.action === "review" || REVIEW_ONLY_KINDS.includes(kind);
    const action: SuggestionAction = reviewOnly
      ? "review"
      : OPERATION_TYPES.includes(s.action as EditOperation)
        ? (s.action as EditOperation)
        : "cut";
    const level = (["natural", "balanced", "tight"] as const).includes(s.level as SuggestionMode) ? (s.level as SuggestionMode) : "balanced";
    const sug: Suggestion = { id, kind, start_ms: start, end_ms: end, action, level, confidence: num(s.confidence, 1) };
    if (reviewOnly) sug.review_only = true;
    if (typeof s.text === "string" && s.text) sug.text = s.text;
    if (action === "shorten_silence") sug.target_ms = Math.max(0, ms(s.target_ms, 600));
    out.push(sug);
  }
  return out.sort((a, b) => a.start_ms - b.start_ms);
}

/** The whole cleanup file: the ideas plus the language they were found in. */
export function normalizeSuggestionsFile(raw: unknown): SuggestionsData {
  const r = asRecord(raw);
  const language = str(r.language).trim() || null;
  const unsupported = strList(r.unsupported).filter((k): k is SuggestionKind => SUGGESTION_KINDS.includes(k as SuggestionKind));
  const modesRaw = asRecord(r.modes);
  const modes = Object.keys(modesRaw).length
    ? { natural: ms(modesRaw.natural), balanced: ms(modesRaw.balanced), tight: ms(modesRaw.tight) }
    : null;
  return {
    suggestions: normalizeSuggestions(raw),
    language,
    unsupported: unsupported.length ? unsupported : language && !isEnglish(language) ? [...LANGUAGE_ONLY_KINDS] : [],
    modes,
    generated_at: num(r.generated_at, 0) || undefined,
  };
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
    quality: m.quality && typeof m.quality === "object" ? (m.quality as Record<string, unknown>) : null,
    cached: m.cached === true,
    lead_ms: ms(m.lead_ms) || undefined,
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

/** Kinds that can only be looked for in English (word lists); see `unsupported` in the cleanup file. */
export const LANGUAGE_ONLY_KINDS: SuggestionKind[] = ["filler", "profanity"];

/** "en", "en-US", "eng" → English. Anything else (or nothing recorded) is treated as not English. */
export function isEnglish(language: string | null | undefined): boolean {
  const tag = (language ?? "").trim().toLowerCase();
  return tag.startsWith("en");
}

/** Listen-and-decide only: no Apply button, never touched by "apply all". */
export const isReviewOnly = (suggestion: Suggestion): boolean => suggestion.review_only === true || suggestion.action === "review";

/** Ideas the producer has ticked off (review-only ones are marked, not applied). */
export function isReviewed(edits: EpisodeEdits, suggestion: Suggestion | string): boolean {
  const id = typeof suggestion === "string" ? suggestion : suggestion.id;
  return (edits.suggestions.reviewed ?? []).includes(id);
}

export function markReviewed(edits: EpisodeEdits, suggestion: Suggestion | string, reviewed = true): EpisodeEdits {
  const id = typeof suggestion === "string" ? suggestion : suggestion.id;
  if (!id) return edits;
  const current = edits.suggestions.reviewed ?? [];
  if (current.includes(id) === reviewed) return edits;
  const next = reviewed ? [...current, id] : current.filter((x) => x !== id);
  return { ...edits, suggestions: { ...edits.suggestions, reviewed: next } };
}

/** How much shorter the episode gets if this idea is taken. */
export function suggestionTimeSavedMs(suggestion: Suggestion): number {
  const span = Math.max(0, suggestion.end_ms - suggestion.start_ms);
  if (isReviewOnly(suggestion)) return 0;
  if (suggestion.action === "shorten_silence") return Math.max(0, span - Math.max(0, suggestion.target_ms ?? 600));
  if (suggestion.action === "cut") return span;
  return 0;
}

/** Total time a list of ideas would save (used for the panel's headline). */
export const suggestionsTimeSavedMs = (list: Suggestion[]): number => list.reduce((total, s) => total + suggestionTimeSavedMs(s), 0);

/** True when the idea lands on a stretch the producer has already edited. */
export function suggestionConflict(edits: EpisodeEdits, suggestion: Suggestion): boolean {
  if (isReviewOnly(suggestion)) return false;
  const span: Span = [suggestion.start_ms, suggestion.end_ms];
  return edits.operations.some(
    (op) => op.enabled && suggestionIdOf(op) !== suggestion.id && overlaps([op.start_ms, op.end_ms], span)
  );
}

/** Turn one suggestion into an instruction (idempotent — accepting twice changes nothing). */
export function applySuggestion(edits: EpisodeEdits, suggestion: Suggestion): EpisodeEdits {
  if (isReviewOnly(suggestion)) return edits;
  if (suggestionState(edits, suggestion) === "accepted") return edits;
  const withOp = addOperation(edits, {
    type: suggestion.action as EditOperation,
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

/** What "apply all" actually did — every idea it saw is counted exactly once. */
export interface ApplyAllResult {
  edits: EpisodeEdits;
  applied: number;
  skipped_conflict: number;
  already_accepted: number;
  rejected: number;
  review_only: number;
  /** The ideas that were skipped because they land on an existing edit. */
  conflicts: string[];
  /** How much shorter the episode got. */
  saved_ms: number;
}

/**
 * Accept everything the chosen cleanup level offers, skipping anything already
 * decided, anything that only wants a listen, and anything landing on an
 * existing instruction. Running it twice applies nothing the second time.
 */
export function applyAll(edits: EpisodeEdits, list: Suggestion[], mode: SuggestionMode = edits.suggestions.mode): ApplyAllResult {
  let next: EpisodeEdits = { ...edits, suggestions: { ...edits.suggestions, mode } };
  const result: ApplyAllResult = {
    edits: next,
    applied: 0,
    skipped_conflict: 0,
    already_accepted: 0,
    rejected: 0,
    review_only: 0,
    conflicts: [],
    saved_ms: 0,
  };
  for (const suggestion of suggestionsForMode(list, mode)) {
    if (isReviewOnly(suggestion)) {
      result.review_only++;
      continue;
    }
    const state = suggestionState(next, suggestion);
    if (state === "rejected") {
      result.rejected++;
      continue;
    }
    if (state === "accepted") {
      result.already_accepted++;
      continue;
    }
    if (suggestionConflict(next, suggestion)) {
      result.skipped_conflict++;
      result.conflicts.push(suggestion.id);
      continue;
    }
    const applied = applySuggestion(next, suggestion);
    if (applied === next) {
      result.skipped_conflict++;
      result.conflicts.push(suggestion.id);
      continue;
    }
    next = applied;
    result.applied++;
    result.saved_ms += suggestionTimeSavedMs(suggestion);
  }
  result.edits = next;
  return result;
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

// --------------------------------------------------------------- playback clock

/**
 * Which timeline the player in the canvas is actually running on.
 *
 *   source         the untouched recording (media ms == source ms)
 *   rough_preview  the whole episode as edited (media ms == output ms)
 *   range_preview  one stretch of the edited episode, rendered on its own, so
 *                  the file starts at 0 while the stretch starts at
 *                  `rangeOutStartMs` on the finished timeline.
 *
 * The transcript, the waveform and every edit ALWAYS speak source ms; the
 * canvas converts on the way in and on the way out, so the playhead, the
 * highlighted word and the caption overlay agree however much was cut.
 */
export type ClockMode = "source" | "rough_preview" | "range_preview";

export interface PlaybackClock {
  mode: ClockMode;
  /** [source start, source end, output start] — exact when it came from the prepared instructions. */
  map: MapSegment[] | null;
  /** Where the previewed stretch begins on the finished episode (0 unless range_preview). */
  rangeOutStartMs: number;
  /** Where it ends, when a range was asked for. */
  rangeOutEndMs: number | null;
  /** True when the map was worked out in the browser instead of read from the prepared file. */
  approximate: boolean;
  sourceDurationMs: number;
  outputDurationMs: number;
}

const segmentsOf = (map: MapSegment[] | null | undefined): MapSegment[] =>
  (map ?? []).filter((seg) => Array.isArray(seg) && seg.length >= 3 && seg[1] > seg[0]).sort((a, b) => a[0] - b[0]);

const mapOutputDuration = (segs: MapSegment[]): number =>
  segs.length ? Math.max(...segs.map(([a, b, o]) => o + (b - a))) : 0;

/**
 * The clock for the player. The prepared instructions are used when they were
 * made from the record as it stands now; otherwise the browser works the map
 * out from the edits, which lands within a word of the finished file and is
 * flagged `approximate` so the screen can say "roughly".
 */
export function clockFromSpec(
  spec: PreparedSpec | null | undefined,
  edits: EpisodeEdits,
  mode: ClockMode,
  range?: Span | null
): PlaybackClock {
  const usable = spec && spec.version === edits.version && ((spec.map?.length ?? 0) > 0 || (spec.keep?.length ?? 0) > 0) ? spec : null;
  const segs = usable
    ? segmentsOf(usable.map?.length ? usable.map : mapFromKeep(usable.keep ?? []))
    : segmentsOf(mapFromKeep(keepSegments(edits)));
  const outputDurationMs = mapOutputDuration(segs);
  const sourceDurationMs = Math.max(
    Math.round(edits.source_duration_ms || 0),
    Math.round(usable?.media?.duration_ms ?? 0),
    segs.length ? segs[segs.length - 1][1] : 0
  );
  const a = range ? Math.max(0, Math.round(Math.min(range[0], range[1]))) : 0;
  const b = range ? Math.round(Math.max(range[0], range[1])) : null;
  return {
    mode,
    map: segs,
    rangeOutStartMs: mode === "range_preview" ? a : 0,
    rangeOutEndMs: mode === "range_preview" && b != null ? b : null,
    approximate: !usable,
    sourceDurationMs,
    outputDurationMs,
  };
}

/** A source-time clock for the untouched recording (no preview running). */
export function sourceClock(edits: EpisodeEdits): PlaybackClock {
  return clockFromSpec(null, edits, "source");
}

/** Where a finished-episode position sits on the recording. */
export function outputToSource(map: MapSegment[] | null | undefined, outMs: number): number {
  const segs = segmentsOf(map);
  const t = Math.round(outMs);
  if (!segs.length) return Math.max(0, t);
  if (t <= segs[0][2]) return segs[0][0];
  for (const [a, b, o] of segs) {
    const len = b - a;
    if (t < o + len) return a + Math.max(0, t - o);
  }
  return segs[segs.length - 1][1];
}

/**
 * Where a recording position lands in the finished episode. A position inside
 * a removed stretch has no output time of its own, so it reports the next kept
 * moment's output time — the same place playback continues from.
 */
export function sourceToOutput(map: MapSegment[] | null | undefined, srcMs: number): number {
  const segs = segmentsOf(map);
  const t = Math.round(srcMs);
  if (!segs.length) return 0;
  for (const [a, b, o] of segs) {
    if (t < a) return o;
    if (t < b) return o + (t - a);
  }
  return mapOutputDuration(segs);
}

/** True when this recording position was removed by the edits behind the map. */
export function isCutOnMap(map: MapSegment[] | null | undefined, srcMs: number): boolean {
  const segs = segmentsOf(map);
  if (!segs.length) return false;
  const t = Math.round(srcMs);
  return !segs.some(([a, b]) => t >= a && t < b);
}

/** The next recording position that is still in the episode (itself, when it is kept). */
export function nextKeptSource(map: MapSegment[] | null | undefined, srcMs: number): number {
  const segs = segmentsOf(map);
  const t = Math.round(srcMs);
  if (!segs.length) return Math.max(0, t);
  for (const [a, b] of segs) {
    if (t < a) return a;
    if (t < b) return t;
  }
  return segs[segs.length - 1][1];
}

/** Player position → recording position. */
export function mediaToSource(clock: PlaybackClock, mediaMs: number): number {
  const t = Math.round(mediaMs);
  if (clock.mode === "source") return Math.max(0, clock.sourceDurationMs ? Math.min(t, clock.sourceDurationMs) : t);
  const out = clock.mode === "range_preview" ? t + clock.rangeOutStartMs : t;
  return outputToSource(clock.map, out);
}

/**
 * Recording position → player position, or null when this moment is not in
 * what the player is showing (it was cut, or it sits outside the previewed
 * stretch). Callers that must land somewhere use `nextKeptSource` first.
 */
export function sourceToMedia(clock: PlaybackClock, sourceMs: number): number | null {
  const t = Math.round(sourceMs);
  if (clock.mode === "source") return Math.max(0, clock.sourceDurationMs ? Math.min(t, clock.sourceDurationMs) : t);
  if (isCutOnMap(clock.map, t)) return null;
  const out = sourceToOutput(clock.map, t);
  if (clock.mode !== "range_preview") return out;
  if (out < clock.rangeOutStartMs) return null;
  if (clock.rangeOutEndMs != null && out > clock.rangeOutEndMs) return null;
  return out - clock.rangeOutStartMs;
}

/** How long the player's own file runs, for the scrubber's end stop. */
export function clockMediaDurationMs(clock: PlaybackClock): number {
  if (clock.mode === "source") return clock.sourceDurationMs;
  if (clock.mode === "range_preview") {
    const end = clock.rangeOutEndMs ?? clock.outputDurationMs;
    return Math.max(0, Math.min(end, clock.outputDurationMs) - clock.rangeOutStartMs);
  }
  return clock.outputDurationMs;
}

// ---------------------------------------------------------------- corrections

/** The id of the word at `index` in the prepared timeline. */
export const wordId = (index: number): string => `w${Math.max(0, Math.round(index))}`;

/** The index behind a word id ("w42" → 42); -1 when it is not one. */
export function wordIndex(id: string): number {
  const m = /^w(\d+)$/.exec(id ?? "");
  return m ? Number(m[1]) : -1;
}

/** A word as the transcript and the captions show it. */
export interface DisplayWord extends StudioWord {
  id: string;
  index: number;
  /** the original spelling, when the producer changed it */
  original?: string;
}

const correctionIndex = (corrections: Correction[]): Map<string, Correction> =>
  new Map((corrections ?? []).map((c) => [c.word_id, c]));

/**
 * Respell a word. Nothing about the timing or the sound changes: the same
 * moment of the recording simply reads differently on screen and in captions.
 */
export function addCorrection(edits: EpisodeEdits, wordIdOrIndex: string | number, text: string, original: string): EpisodeEdits {
  const id = typeof wordIdOrIndex === "number" ? wordId(wordIdOrIndex) : wordIdOrIndex;
  const clean = (text ?? "").trim().slice(0, 80);
  if (wordIndex(id) < 0) return edits;
  const list = edits.corrections ?? [];
  const existing = list.find((c) => c.word_id === id);
  const was = existing?.original ?? original ?? "";
  if (!clean || clean === was) return removeCorrection(edits, id);
  if (existing && existing.text === clean) return edits;
  const next = [...list.filter((c) => c.word_id !== id), { word_id: id, text: clean, original: was }].sort(
    (a, b) => wordIndex(a.word_id) - wordIndex(b.word_id)
  );
  return { ...edits, corrections: next };
}

/** Put the original spelling back. */
export function removeCorrection(edits: EpisodeEdits, wordIdOrIndex: string | number): EpisodeEdits {
  const id = typeof wordIdOrIndex === "number" ? wordId(wordIdOrIndex) : wordIdOrIndex;
  const list = edits.corrections ?? [];
  const next = list.filter((c) => c.word_id !== id);
  return next.length === list.length ? edits : { ...edits, corrections: next };
}

/** The words as they read now — corrected spellings applied, timings untouched. */
export function correctedWord(words: StudioWord[], corrections: Correction[]): DisplayWord[] {
  const index = correctionIndex(corrections);
  return (words ?? []).map((word, i) => {
    const id = wordId(i);
    const fix = index.get(id);
    const display: DisplayWord = { ...word, id, index: i };
    if (fix && fix.text && fix.text !== word.w) {
      display.w = fix.text;
      display.original = fix.original || word.w;
    }
    return display;
  });
}

/** One word as it reads now (null when the index is not in the transcript). */
export function correctedWordAt(words: StudioWord[], corrections: Correction[], index: number): DisplayWord | null {
  const word = (words ?? [])[index];
  if (!word) return null;
  const fix = correctionIndex(corrections).get(wordId(index));
  const display: DisplayWord = { ...word, id: wordId(index), index };
  if (fix && fix.text && fix.text !== word.w) {
    display.w = fix.text;
    display.original = fix.original || word.w;
  }
  return display;
}

/** The words joined into text, respellings included (what the captions carry). */
export const correctedText = (words: StudioWord[], corrections: Correction[]): string =>
  correctedWord(words, corrections)
    .map((w) => w.w)
    .join(" ");

// ------------------------------------------------------------------ snapping

/**
 * Nudge a moment onto the nearest edge between spoken words, so a drag never
 * lands in the middle of a word. A moment inside a word always moves to that
 * word's own edge; otherwise the nearest edge within `toleranceMs` wins.
 */
export function snapToWordGap(msIn: number, words: StudioWord[], toleranceMs = 120): number {
  const t = Math.round(msIn);
  if (!words?.length) return Math.max(0, t);
  let best = t;
  let bestGap = toleranceMs + 1;
  for (const word of words) {
    if (t > word.s && t < word.e) return t - word.s <= word.e - t ? word.s : word.e;
    for (const edge of [word.s, word.e]) {
      const gap = Math.abs(edge - t);
      if (gap < bestGap) {
        bestGap = gap;
        best = edge;
      }
    }
    if (word.s > t + toleranceMs) break;
  }
  return bestGap <= toleranceMs ? best : Math.max(0, t);
}

/** Widen a stretch to whole words, so a cut never clips the start or end of one. */
export function safeWordSpan(span: Span, words: StudioWord[]): Span {
  let [start, end] = span;
  for (const word of words ?? []) {
    if (word.e <= start || word.s >= end) continue;
    if (start > word.s && start < word.e) start = word.s;
    if (end > word.s && end < word.e) end = word.e;
  }
  return [Math.round(start), Math.round(end)];
}

// ------------------------------------------------------- restoring a save point

/** Everything a save point holds: the producer's work, not the bookkeeping. */
const CONTENT_KEYS = [
  "source_duration_ms",
  "operations",
  "speakers",
  "speaker_map",
  "sections",
  "assets",
  "audio",
  "visual",
  "extra_aspects",
  "title",
  "suggestions",
  "corrections",
] as const;

/**
 * A fingerprint of the producer's work, ignoring the revision number and the
 * timestamp the save itself moves on. Two records with the same fingerprint
 * hold the same edit, which is how the studio knows whether what is on screen
 * is what reached the file.
 */
export function editsSignature(edits: EpisodeEdits): string {
  const content: Record<string, unknown> = {};
  for (const key of CONTENT_KEYS) content[key] = (edits as unknown as Record<string, unknown>)[key];
  return JSON.stringify(content);
}

export interface RestoreOptions {
  /** the save point's number, for the note ("restored v3") */
  n?: number;
  note?: string;
  now?: number;
}

/**
 * Go back to a save point. The current record keeps rolling forward: the
 * snapshot's work becomes the new current work on the NEXT revision, and the
 * restore is itself listed as a save point. Nothing on file is rewritten.
 */
export function restoreVersion(current: EpisodeEdits, snapshot: EpisodeEdits, options: RestoreOptions = {}): EpisodeEdits {
  const now = options.now ?? Date.now();
  const from = options.n ?? snapshot.version;
  const nextN = Math.max(0, ...current.versions.map((v) => v.n ?? 0)) + 1;
  const restored: EpisodeEdits = { ...current };
  for (const key of CONTENT_KEYS) {
    (restored as unknown as Record<string, unknown>)[key] = structuredCopy((snapshot as unknown as Record<string, unknown>)[key]);
  }
  restored.suggestions = {
    mode: snapshot.suggestions?.mode ?? current.suggestions.mode,
    accepted: [...(snapshot.suggestions?.accepted ?? [])],
    rejected: [...(snapshot.suggestions?.rejected ?? [])],
    reviewed: [...(snapshot.suggestions?.reviewed ?? [])],
  };
  restored.corrections = [...(snapshot.corrections ?? [])];
  restored.version = Math.max(1, Math.round(current.version)) + 1;
  restored.updated = now / 1000;
  restored.schema_version = STUDIO_SCHEMA_VERSION;
  restored.versions = [
    ...current.versions,
    { n: nextN, file: versionFile(nextN), note: options.note || `restored v${from}`, created: now / 1000 },
  ];
  return restored;
}

function structuredCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => structuredCopy(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = structuredCopy(v);
    return out as unknown as T;
  }
  return value;
}

/** A one-line description of a save point for the "open" preview. */
export function describeVersion(entry: EditsVersion, snapshot?: EpisodeEdits | null): string {
  const parts: string[] = [];
  if (entry.note) parts.push(entry.note);
  if (snapshot) {
    const ops = snapshot.operations.filter((op) => op.enabled).length;
    parts.push(`${ops} ${ops === 1 ? "change" : "changes"}`);
    parts.push(fmtDuration(outputDurationMs(snapshot)));
  }
  return parts.join(" · ");
}

// ----------------------------------------------------------- editing proposal

/**
 * A reversible edit proposal. The producer says what they want ("cut the
 * sponsor talk and tighten the setup"); the studio asks the writing assistant
 * to point at TRANSCRIPT LINES — never at times — and turns the answer into a
 * list of suggested cuts that lives in its own file. Nothing is applied until
 * the producer says so, and everything applied can be taken back one by one.
 */
export const PROPOSAL_SCHEMA_VERSION = 1;
export const PROPOSAL_CATEGORIES = ["setup", "retake", "repetition", "pause", "tangent", "other"] as const;
export type ProposalCategory = (typeof PROPOSAL_CATEGORIES)[number];
export type ProposalAction = "cut" | "shorten_silence";
export type ProposalStatus = "open" | "applied" | "rejected";

/** Applied without asking twice only when the assistant is sure and the reason is a named one. */
export const PROPOSAL_SAFE_CONFIDENCE = 0.7;

export interface ProposalItem {
  id: string;
  action: ProposalAction;
  start_ms: number;
  end_ms: number;
  target_ms?: number;
  reason: string;
  category: ProposalCategory;
  confidence: number;
  saved_ms: number;
  status: ProposalStatus;
  /** the transcript lines it came from, for the "show me" control */
  sentences?: [number, number];
}

export interface ProposalDrop {
  ref: string;
  reason: string;
}

export interface ProposalTotals {
  original_ms: number;
  proposed_ms: number;
  removed_ms: number;
}

/** edits/proposals/p<NN>.json — never mixed into episode-edits.json. */
export interface EditProposal {
  schema_version: number;
  id: string;
  prompt: string;
  mode: SuggestionMode;
  created: number;
  items: ProposalItem[];
  dropped: ProposalDrop[];
  totals: ProposalTotals;
  notes?: string;
  target_minutes?: number;
}

/** A transcript line as the proposal talks about it (analysis/transcript.json order). */
export interface ProposalSentence {
  text: string;
  start_ms: number;
  end_ms: number;
}

/** The bit of the SDK Question the proposal builder uses (keeps this module SDK-free). */
export interface ProposalQuestionLike {
  role: string;
  expectJson: boolean;
  addInstruction(title: string, text: string): void;
  addContext(context: string): void;
  addGoal(goal: string): void;
  addQuestion(text: string): void;
}

const PROPOSAL_CONTEXT_CHARS = 12_000;

const PROPOSAL_ROLE =
  "You are the editing assistant of a podcast studio. A producer tells you what they want the episode to become; " +
  "you read the numbered transcript lines and answer with the stretches you would remove, as strict JSON. You never " +
  "invent content, you never touch anything the producer said to keep, and you point at line ids — never at times.";

const PROPOSAL_MODE_RULES: Record<SuggestionMode, string> = {
  natural:
    "Light touch: only remove what is plainly dead weight — false starts, restarts of the same sentence, dead air. " +
    "When in doubt, leave it in. Confidence below 0.7 for anything arguable.",
  balanced:
    "Balanced: remove false starts, repeated points, long pauses and clear tangents, while keeping every story, " +
    "answer and joke intact. Leave the conversation sounding natural.",
  tight:
    "Tight: cut hard for pace — setup chatter, repetition, tangents and slow patches all go — but never remove a " +
    "point that is not made again elsewhere, and never cut mid-sentence.",
};

const fmtStampMs = (msIn: number): string => {
  const total = Math.max(0, Math.floor(msIn / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/** The numbered lines the assistant reads: `[s12] [3:04 - 3:11] text`. */
export function proposalLines(sentences: ProposalSentence[]): string {
  return sentences
    .map((s, i) => `[s${i}] [${fmtStampMs(s.start_ms)} - ${fmtStampMs(s.end_ms)}] ${(s.text ?? "").trim()}`)
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

export interface ProposalInput {
  goal: string;
  sentences: ProposalSentence[];
  mode: SuggestionMode;
  /** how long the episode runs now, so the assistant can aim at a length */
  durationMs?: number;
}

/**
 * Build the question that asks for an edit proposal. `factory` is either a
 * fresh question object or something that makes one, so this stays testable
 * without the SDK.
 */
export function buildProposalQuestion<Q extends ProposalQuestionLike>(factory: Q | (() => Q), input: ProposalInput): Q {
  const q = typeof factory === "function" ? (factory as () => Q)() : factory;
  q.role = PROPOSAL_ROLE;
  q.expectJson = true;
  q.addInstruction(
    "Answer",
    'Return ONE strict JSON object: {"items": [{"sentences": [startIdx, endIdx], "action": "cut" | "shorten_silence", ' +
      '"reason": string, "category": "setup" | "retake" | "repetition" | "pause" | "tangent" | "other", "confidence": 0..1}], ' +
      '"target_minutes": number | null, "notes": string}. An item may point at part of a line instead with ' +
      '"words": {"sentence": idx, "from": n, "to": n} (word positions inside that line, counting from 0). No prose ' +
      "around the JSON, no markdown fence, no extra keys."
  );
  q.addInstruction(
    "Ids, never times",
    "Every item refers to the numbered lines above by their index (the number in [s12]). NEVER return timestamps, " +
      "seconds or clock stamps — they are worked out by the studio. Ranges are inclusive: [4, 7] means lines 4 to 7. " +
      "Only use line numbers that appear in the transcript you were given."
  );
  q.addInstruction(
    "What to keep",
    "Respect anything the producer said to keep, word for word. Never cut through the middle of a sentence that " +
      "carries a point; never remove the only place something is explained; never remove an answer while leaving its " +
      "question. Cutting an introduction, a sponsor read or a tangent is fine when the producer asked for it."
  );
  q.addInstruction("Reasons", "Every item carries a short plain reason a producer would accept (\"repeats the point from line 12\"). Be honest with confidence: 1 is certain, 0.5 is a judgement call.");
  q.addInstruction("How aggressive", PROPOSAL_MODE_RULES[input.mode] ?? PROPOSAL_MODE_RULES.balanced);
  if (input.durationMs && input.durationMs > 0) {
    q.addInstruction("Length", `The episode currently runs ${fmtDuration(input.durationMs)}. If the producer asked for a length, aim at it and report it as target_minutes.`);
  }
  q.addGoal(`What the producer wants: ${(input.goal ?? "").trim()}`);
  const lines = proposalLines(input.sentences ?? []);
  for (let i = 0; i < lines.length; i += PROPOSAL_CONTEXT_CHARS) {
    q.addContext("Transcript" + (i ? " (continued)" : "") + ":\n" + lines.slice(i, i + PROPOSAL_CONTEXT_CHARS));
  }
  q.addQuestion((input.goal ?? "").trim() || "Suggest the edits for this episode.");
  return q;
}

export interface ValidateContext {
  sentences: ProposalSentence[];
  words: StudioWord[];
  edits: EpisodeEdits;
  durationMs?: number;
  id?: string;
  prompt?: string;
  mode?: SuggestionMode;
  now?: number;
}

interface Resolved {
  action: ProposalAction;
  start_ms: number;
  end_ms: number;
  target_ms?: number;
  reason: string;
  category: ProposalCategory;
  confidence: number;
  sentences?: [number, number];
}

/**
 * Turn what the assistant answered into an edit proposal that can be trusted:
 * line ids become times from the transcript, times are kept inside the
 * recording and off the middle of a word, overlapping suggestions become one,
 * and anything landing on an edit the producer already made is dropped with a
 * reason instead of quietly changing their work.
 */
export function validateProposal(raw: unknown, ctx: ValidateContext): EditProposal {
  const r = asRecord(raw);
  const now = ctx.now ?? Date.now();
  const sentences = ctx.sentences ?? [];
  const words = ctx.words ?? [];
  const duration = Math.max(0, Math.round(ctx.durationMs ?? ctx.edits.source_duration_ms ?? 0));
  const dropped: ProposalDrop[] = [];
  const resolved: Resolved[] = [];
  const items = Array.isArray(r.items) ? r.items : [];

  items.forEach((entry, i) => {
    const it = asRecord(entry);
    const ref = `item ${i + 1}`;
    const action: ProposalAction = it.action === "shorten_silence" ? "shorten_silence" : "cut";
    const category = PROPOSAL_CATEGORIES.includes(it.category as ProposalCategory) ? (it.category as ProposalCategory) : "other";
    const reason = str(it.reason).trim().slice(0, 200) || "Suggested by the editing assistant";
    const confidence = Math.max(0, Math.min(1, num(it.confidence, 0.5)));
    let span: Span | null = null;
    let lines: [number, number] | undefined;

    const wordsRef = asRecord(it.words);
    if (Object.keys(wordsRef).length && "sentence" in wordsRef) {
      const idx = Math.round(num(wordsRef.sentence, -1));
      const sentence = sentences[idx];
      if (!sentence) {
        dropped.push({ ref, reason: `line s${idx} is not in this transcript` });
        return;
      }
      const inside = words
        .map((w, wi) => ({ w, wi }))
        .filter(({ w }) => w.e > sentence.start_ms && w.s < sentence.end_ms);
      if (!inside.length) {
        dropped.push({ ref, reason: `no words line up with line s${idx}` });
        return;
      }
      const from = Math.max(0, Math.min(inside.length - 1, Math.round(num(wordsRef.from, 0))));
      const to = Math.max(from, Math.min(inside.length - 1, Math.round(num(wordsRef.to, from))));
      span = [inside[from].w.s, inside[to].w.e];
      lines = [idx, idx];
    } else {
      const list = Array.isArray(it.sentences) ? it.sentences : typeof it.sentences === "number" ? [it.sentences, it.sentences] : null;
      if (!list || !list.length) {
        dropped.push({ ref, reason: "it did not say which lines to remove" });
        return;
      }
      const a = Math.round(num(list[0], -1));
      const b = Math.round(num(list.length > 1 ? list[1] : list[0], a));
      const first = sentences[Math.min(a, b)];
      const last = sentences[Math.max(a, b)];
      if (!first || !last) {
        dropped.push({ ref, reason: `lines s${a}–s${b} are not in this transcript` });
        return;
      }
      span = [first.start_ms, last.end_ms];
      lines = [Math.min(a, b), Math.max(a, b)];
    }

    let [start, end] = safeWordSpan([Math.round(span[0]), Math.round(span[1])], words);
    start = Math.max(0, start);
    end = duration > 0 ? Math.min(end, duration) : end;
    if (end <= start) {
      dropped.push({ ref, reason: "that stretch is empty once it is lined up with the recording" });
      return;
    }
    const item: Resolved = { action, start_ms: start, end_ms: end, reason, category, confidence };
    if (lines) item.sentences = lines;
    if (action === "shorten_silence") item.target_ms = Math.max(0, ms(it.target_ms, 600));
    resolved.push(item);
  });

  // Overlapping suggestions become one instruction (the earliest reason wins, the lowest confidence sticks).
  resolved.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const merged: Resolved[] = [];
  for (const item of resolved) {
    const last = merged[merged.length - 1];
    // Only genuinely overlapping suggestions become one; two cuts that merely
    // touch stay separate so each keeps its own reason and can be taken alone.
    if (last && last.action === item.action && item.start_ms < last.end_ms) {
      last.end_ms = Math.max(last.end_ms, item.end_ms);
      last.confidence = Math.min(last.confidence, item.confidence);
      if (last.sentences && item.sentences) last.sentences = [Math.min(last.sentences[0], item.sentences[0]), Math.max(last.sentences[1], item.sentences[1])];
      if (last.category !== item.category) last.category = last.category === "other" ? item.category : last.category;
      continue;
    }
    merged.push({ ...item });
  }

  const out: ProposalItem[] = [];
  merged.forEach((item) => {
    const clash = ctx.edits.operations.find((op) => op.enabled && overlaps([op.start_ms, op.end_ms], [item.start_ms, item.end_ms]));
    const ref = `${fmtPosition(item.start_ms)}–${fmtPosition(item.end_ms)}`;
    if (clash) {
      dropped.push({ ref, reason: "overlaps an edit you already made" });
      return;
    }
    const id = `i${String(out.length + 1).padStart(2, "0")}`;
    out.push({
      id,
      action: item.action,
      start_ms: item.start_ms,
      end_ms: item.end_ms,
      ...(item.target_ms != null ? { target_ms: item.target_ms } : {}),
      reason: item.reason,
      category: item.category,
      confidence: item.confidence,
      saved_ms: proposalItemSavedMs(item),
      status: "open",
      ...(item.sentences ? { sentences: item.sentences } : {}),
    });
  });

  const proposal: EditProposal = {
    schema_version: PROPOSAL_SCHEMA_VERSION,
    id: ctx.id || "p01",
    prompt: (ctx.prompt ?? "").trim(),
    mode: ctx.mode ?? ctx.edits.suggestions.mode,
    created: now / 1000,
    items: out,
    dropped,
    totals: proposalTotals(ctx.edits, out),
  };
  const notes = str(r.notes).trim();
  if (notes) proposal.notes = notes.slice(0, 400);
  const target = num(r.target_minutes, 0);
  if (target > 0) proposal.target_minutes = Math.round(target * 10) / 10;
  return proposal;
}

function proposalItemSavedMs(item: { action: ProposalAction; start_ms: number; end_ms: number; target_ms?: number }): number {
  const span = Math.max(0, item.end_ms - item.start_ms);
  if (item.action === "shorten_silence") return Math.max(0, span - Math.max(0, item.target_ms ?? 600));
  return span;
}

/** How long the episode runs now and how long it would run if the open items were taken. */
export function proposalTotals(edits: EpisodeEdits, items: ProposalItem[]): ProposalTotals {
  const original = outputDurationMs(edits);
  const removed = items.filter((i) => i.status !== "rejected").reduce((total, i) => total + Math.max(0, i.saved_ms), 0);
  return { original_ms: original, proposed_ms: Math.max(0, original - removed), removed_ms: removed };
}

/** Tolerant reader for a proposal on file. */
export function normalizeProposal(raw: unknown): EditProposal | null {
  const r = asRecord(raw);
  if (!Array.isArray(r.items) && !str(r.id)) return null;
  const items: ProposalItem[] = [];
  for (const entry of Array.isArray(r.items) ? r.items : []) {
    const it = asRecord(entry);
    const start = Math.max(0, ms(it.start_ms, -1));
    const end = ms(it.end_ms, -1);
    if (start < 0 || end <= start) continue;
    const action: ProposalAction = it.action === "shorten_silence" ? "shorten_silence" : "cut";
    const status: ProposalStatus = it.status === "applied" ? "applied" : it.status === "rejected" ? "rejected" : "open";
    const item: ProposalItem = {
      id: str(it.id) || `i${String(items.length + 1).padStart(2, "0")}`,
      action,
      start_ms: start,
      end_ms: end,
      reason: str(it.reason) || "Suggested by the editing assistant",
      category: PROPOSAL_CATEGORIES.includes(it.category as ProposalCategory) ? (it.category as ProposalCategory) : "other",
      confidence: Math.max(0, Math.min(1, num(it.confidence, 0.5))),
      saved_ms: ms(it.saved_ms, 0),
      status,
    };
    if (action === "shorten_silence") item.target_ms = Math.max(0, ms(it.target_ms, 600));
    if (!item.saved_ms) item.saved_ms = proposalItemSavedMs(item);
    if (Array.isArray(it.sentences) && it.sentences.length >= 2) item.sentences = [ms(it.sentences[0]), ms(it.sentences[1])];
    items.push(item);
  }
  const totals = asRecord(r.totals);
  const dropped: ProposalDrop[] = Array.isArray(r.dropped)
    ? r.dropped.map((d) => {
        const rec = asRecord(d);
        return { ref: str(rec.ref), reason: str(rec.reason) };
      })
    : [];
  const mode = (["natural", "balanced", "tight"] as const).includes(r.mode as SuggestionMode) ? (r.mode as SuggestionMode) : "balanced";
  const proposal: EditProposal = {
    schema_version: ms(r.schema_version, PROPOSAL_SCHEMA_VERSION),
    id: str(r.id) || "p01",
    prompt: str(r.prompt),
    mode,
    created: num(r.created, 0),
    items,
    dropped,
    totals: {
      original_ms: ms(totals.original_ms, 0),
      proposed_ms: ms(totals.proposed_ms, 0),
      removed_ms: ms(totals.removed_ms, 0),
    },
  };
  if (str(r.notes)) proposal.notes = str(r.notes);
  if (num(r.target_minutes, 0) > 0) proposal.target_minutes = num(r.target_minutes, 0);
  return proposal;
}

/** The instruction one proposed edit becomes, so it can be taken back on its own. */
export const proposalSource = (proposalId: string, itemId: string): string => `proposal:${proposalId}/${itemId}`;

/** Certain enough, and for a reason with a name, to be taken in one go. */
export const isSafeProposalItem = (item: ProposalItem): boolean => item.confidence >= PROPOSAL_SAFE_CONFIDENCE && item.category !== "other";

/** True when the suggested stretch now lands on an edit the producer already has. */
export function proposalItemConflict(edits: EpisodeEdits, item: ProposalItem, proposalId?: string): boolean {
  const src = proposalId ? proposalSource(proposalId, item.id) : null;
  return edits.operations.some(
    (op) => op.enabled && op.source !== src && overlaps([op.start_ms, op.end_ms], [item.start_ms, item.end_ms])
  );
}

export interface ProposalApplyResult {
  edits: EpisodeEdits;
  proposal: EditProposal;
  applied: number;
  skipped_conflict: number;
}

const withItems = (proposal: EditProposal, items: ProposalItem[], edits: EpisodeEdits): EditProposal => ({
  ...proposal,
  items,
  totals: proposalTotals(edits, items),
});

/** Take one suggested edit. It becomes an ordinary instruction the producer can restore. */
export function applyProposalItem(edits: EpisodeEdits, proposal: EditProposal, itemId: string): ProposalApplyResult {
  const item = proposal.items.find((i) => i.id === itemId);
  if (!item || item.status === "applied") return { edits, proposal, applied: 0, skipped_conflict: 0 };
  const next = addOperation(edits, {
    type: item.action,
    start_ms: item.start_ms,
    end_ms: item.end_ms,
    target_ms: item.target_ms,
    reason: item.reason,
    source: proposalSource(proposal.id, item.id),
  });
  if (next === edits) return { edits, proposal, applied: 0, skipped_conflict: 0 };
  const items = proposal.items.map((i) => (i.id === itemId ? { ...i, status: "applied" as ProposalStatus } : i));
  return { edits: next, proposal: withItems(proposal, items, next), applied: 1, skipped_conflict: 0 };
}

/** Turn one down: any instruction it made goes away and it stops counting. */
export function rejectProposalItem(edits: EpisodeEdits, proposal: EditProposal, itemId: string): ProposalApplyResult {
  const src = proposalSource(proposal.id, itemId);
  const operations = edits.operations.filter((op) => op.source !== src);
  const nextEdits = operations.length === edits.operations.length ? edits : { ...edits, operations };
  const items = proposal.items.map((i) => (i.id === itemId ? { ...i, status: "rejected" as ProposalStatus } : i));
  return { edits: nextEdits, proposal: withItems(proposal, items, nextEdits), applied: 0, skipped_conflict: 0 };
}

/** Take everything the assistant is sure about, leaving the judgement calls open. */
export function applySafeProposalItems(edits: EpisodeEdits, proposal: EditProposal): ProposalApplyResult {
  let nextEdits = edits;
  let items = proposal.items;
  let applied = 0;
  let skipped = 0;
  for (const item of proposal.items) {
    if (item.status !== "open" || !isSafeProposalItem(item)) continue;
    if (proposalItemConflict(nextEdits, item, proposal.id)) {
      skipped++;
      continue;
    }
    const step = applyProposalItem(nextEdits, { ...proposal, items }, item.id);
    if (step.applied) {
      nextEdits = step.edits;
      items = step.proposal.items;
      applied++;
    }
  }
  return { edits: nextEdits, proposal: withItems(proposal, items, nextEdits), applied, skipped_conflict: skipped };
}

/** Throw the whole proposal away: every instruction it made is removed. */
export function discardProposal(edits: EpisodeEdits, proposalId: string): EpisodeEdits {
  const prefix = `proposal:${proposalId}/`;
  const operations = edits.operations.filter((op) => !(op.source ?? "").startsWith(prefix));
  return operations.length === edits.operations.length ? edits : { ...edits, operations };
}

/** Which proposal item made this instruction, when one did. */
export function proposalRefOf(op: Operation): { proposal: string; item: string } | null {
  const src = op.source ?? "";
  if (!src.startsWith("proposal:")) return null;
  const [proposal, item] = src.slice("proposal:".length).split("/");
  return proposal && item ? { proposal, item } : null;
}

/**
 * "Listen with context": the stretch to play so the producer hears what is
 * around a suggested edit — a couple of seconds before it and after it, on the
 * recording's own clock.
 */
export function listenWindow(span: { start_ms: number; end_ms: number }, durationMs = 0, padMs = 2_000): Span {
  const start = Math.max(0, Math.round(span.start_ms) - padMs);
  const end = Math.round(span.end_ms) + padMs;
  return [start, durationMs > 0 ? Math.min(end, durationMs) : end];
}
