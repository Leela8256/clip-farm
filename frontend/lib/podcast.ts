/**
 * Pure types and helpers for the podcast clip studio — the shapes the
 * RocketRide nodes write into projects/<episode>/ and the UI reads back.
 * No SDK imports here so everything stays unit-testable.
 */

import type { Compliance, EditVersion } from "./director";
import type { CaptionStyle, ResolvedBrand } from "./brand";
import { DIRECTOR_WEIGHTS, SCORE_WEIGHTS, weightedScore } from "./refine";

export type PipeKind = "analysis" | "preview" | "export" | "chat" | "director" | "director-full" | "index" | "search" | "visual";

export interface ProjectSettings {
  goal: string;
  clip_count: number;
  min_seconds: number;
  max_seconds: number;
}

export interface ProjectMedia {
  duration_ms: number;
  width: number;
  height: number;
  fps: number;
  has_video: boolean;
}

export interface ProjectAnalysis {
  status?: "analyzing" | "analyzed" | string;
  candidates?: number;
  proposed?: number;
  chapters?: number;
  sentences?: number;
  parts?: number;
  started_at?: number;
  analyzed_at?: number;
}

export interface ProjectIndex {
  status?: "indexed" | "indexing" | "failed" | string;
  passages?: number;
  indexed_at?: number;
  error?: string;
}

export interface ProjectVisual {
  status?: "scanned" | "scanning" | "failed" | string;
  people?: number;
  scenes?: number;
  frames?: number;
  scanned_at?: number;
  error?: string;
}

export interface ProjectRequestSummary {
  prompt?: string;
  summary?: string;
  delivered?: number;
  requested?: number;
  answered_at?: number;
}

export interface ClipRender {
  files: Record<string, string>;
  duration_ms?: number;
  rendered_at?: number;
}

export interface ProjectClip {
  title?: string;
  start_ms?: number;
  end_ms?: number;
  candidate?: string | null;
  request_id?: string | null;
  version?: number | null;
  preview?: ClipRender;
  export?: ClipRender;
}

export interface Project {
  episode_id: string;
  title?: string;
  /** phase 3: the name the producer gave it (the file name is what it falls back to) */
  display_title?: string;
  /** phase 3: put away in the library — hidden unless the producer asks for archived ones */
  archived?: boolean;
  /** phase 3: the id of the brand look its clips start from */
  brand_template?: string;
  source: string;
  created?: number;
  updated?: number;
  settings: ProjectSettings;
  media?: ProjectMedia;
  analysis?: ProjectAnalysis;
  index?: ProjectIndex;
  visual?: ProjectVisual;
  requests?: Record<string, ProjectRequestSummary>;
  clips?: Record<string, ProjectClip>;
}

export interface Scores {
  hook: number;
  clarity: number;
  standalone: number;
  prompt_match?: number;
  energy?: number;
}

export interface Candidate {
  id: string;
  rank: number;
  title: string;
  hook: string;
  reason: string;
  quote: string;
  text?: string;
  takeaway?: string;
  speaker?: string | null;
  speaker_evidence?: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  score: number;
  scores: Scores;
  custom?: boolean;
  request_id?: string | null;
  compliance?: Compliance | null;
}

export interface Chapter {
  id: string;
  title: string;
  start_ms: number;
  end_ms: number;
}

export interface Sentence {
  id: number;
  text: string;
  start_ms: number;
  end_ms: number;
}

export interface StatusEvent {
  node: string;
  stage: string;
  time?: number;
  episode_id?: string;
  message?: string;
  [key: string]: unknown;
}

export interface ClipEdit {
  start_ms?: number;
  end_ms?: number;
  title?: string;
  /** schema 1: boolean; schema 2: a caption preset name or "off" */
  captions?: boolean | string;
  caption_preset?: string;
  tighten_pauses?: boolean;
  remove_fillers?: boolean;
  filler_policy?: string;
  silence_policy?: string;
  layouts?: string;
  duration_seconds?: number;
  duration_mode?: string;
  disabled_cuts?: string[];
  /** phase 2: auto | solo_follow | stacked_two | screen_share | full_frame | original */
  layout_mode?: string;
  /** phase 2: the tracked person to follow (p1, p2, …) */
  subject?: string | null;
  /** phase 3: the shape the vertical render is made in — 9:16 (default), 4:5, 1:1 */
  aspect?: string;
  /** phase 3: the caption look as an object (string presets keep working through `captions`) */
  caption_style?: CaptionStyle;
  /** phase 3: the brand snapshot the render must use (never a reference to a template) */
  brand?: ResolvedBrand;
  versions?: EditVersion[];
  active_version?: number | null;
}

export interface ClipEdits {
  schema_version: number;
  clips: Record<string, ClipEdit>;
}

export interface Loudness {
  integrated_lufs: number;
  true_peak_dbtp: number;
  loudness_range_lu: number;
}

export interface RenderReport {
  clip_id: string;
  mode: "preview" | "export";
  title?: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  files: Record<string, string>;
  layouts: string[];
  captions: boolean;
  caption_preset?: string;
  has_audio: boolean;
  has_video: boolean;
  width: number;
  height: number;
  loudness?: Loudness | null;
  compliance?: Compliance | null;
  layout?: LayoutSummary | null;
  /** Measured render quality block (tier, dimensions, fps, crf …). */
  quality?: Record<string, unknown> | null;
  cached?: boolean;
  version?: number | null;
  rendered_at: number;
  seconds: number;
  error?: string;
}

export interface LayoutSegment {
  start_ms: number;
  end_ms: number;
  layout: string;
  subjects: string[];
  reason?: string;
}

export interface LayoutPerson {
  id: string;
  coverage: number;
  first_ms?: number;
  last_ms?: number;
  mean_center?: [number, number];
  mean_face_h?: number;
}

export interface LayoutMetrics {
  people?: number;
  frames_sampled?: number;
  faces_detected_pct?: number;
  speaker_visible_pct?: number | null;
  speaking_confident_pct?: number;
  layout_changes?: number;
  max_pan_widths_per_s?: number;
  face_cut_violations?: number;
  face_checks?: number;
  smooth?: boolean;
}

/** What podcast_render reports about the visual director's plan for a clip. */
export interface LayoutSummary {
  mode?: string;
  subject_override?: string | null;
  applied?: boolean;
  segments: LayoutSegment[];
  people: LayoutPerson[];
  thumbnails: Record<string, string>;
  speaking?: { start_ms: number; end_ms: number; track: string; confidence: number }[];
  metrics: LayoutMetrics;
  method?: string;
  error?: string | null;
}

export interface AnalysisManifest {
  project: string;
  episode_id: string;
  candidates: Candidate[];
  chapters: Chapter[];
  proposed?: number;
  parts?: number;
  seconds?: number;
  error?: string;
}

export const projectRoot = (episodeId: string) => `projects/${episodeId}`;

export function safeName(name: string): string {
  const base = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return base || "upload.mp4";
}

/** A readable, unique folder name for a new episode: <file stem>-<timestamp>. */
export function episodeIdFor(fileName: string, now: number = Date.now()): string {
  const stem =
    fileName
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "episode";
  return `${stem}-${now.toString(36)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/**
 * Every payload the answers lane carried, oldest first: the node manifests and
 * the LLM's own answers (which the browser refines itself — see lib/refine.ts).
 */
export function answerPayloads(result: unknown): unknown[] {
  const r = asRecord(result);
  const items = Array.isArray(r.answers) ? r.answers : [];
  return items.map((item) => {
    const rec = asRecord(item);
    let value: unknown = "answer" in rec ? rec.answer : item;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        /* keep the string */
      }
    }
    return value;
  });
}

/**
 * The node manifest inside a response_answers result. The answers lane carries
 * every answer written along the path (the LLM's raw per-part answers too), so
 * the manifest is the last payload that names the project.
 */
export function pickManifest(result: unknown): Record<string, unknown> | null {
  const parsed = answerPayloads(result);
  for (let i = parsed.length - 1; i >= 0; i--) {
    const rec = asRecord(parsed[i]);
    if (typeof rec.project === "string") return rec;
  }
  const last = parsed[parsed.length - 1];
  return last && typeof last === "object" ? (last as Record<string, unknown>) : null;
}

/** The first JSON object the LLM answered with (director-chat pipe: parse / revise). */
export function firstJsonAnswer(result: unknown): Record<string, unknown> | null {
  for (const value of answerPayloads(result)) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return null;
}

export function toCandidate(raw: unknown, index = 0): Candidate {
  const c = asRecord(raw);
  const s = asRecord(c.scores);
  const scores: Scores = { hook: num(s.hook, 5), clarity: num(s.clarity, 5), standalone: num(s.standalone, 5) };
  if (s.prompt_match != null) scores.prompt_match = num(s.prompt_match, 5);
  if (s.energy != null) scores.energy = num(s.energy, 5);
  const start_ms = num(c.start_ms);
  const end_ms = num(c.end_ms);
  const compliance = c.compliance && typeof c.compliance === "object" ? (c.compliance as Compliance) : null;
  return {
    id: String(c.id ?? `c${String(index + 1).padStart(2, "0")}`),
    rank: num(c.rank, index + 1),
    title: String(c.title ?? `Clip ${index + 1}`),
    hook: String(c.hook ?? ""),
    reason: String(c.reason ?? ""),
    quote: String(c.quote ?? ""),
    text: typeof c.text === "string" ? c.text : undefined,
    takeaway: typeof c.takeaway === "string" && c.takeaway ? c.takeaway : undefined,
    speaker: typeof c.speaker === "string" && c.speaker ? c.speaker : null,
    speaker_evidence: typeof c.speaker_evidence === "string" ? c.speaker_evidence : undefined,
    start_ms,
    end_ms,
    duration_ms: num(c.duration_ms, end_ms - start_ms),
    score: num(c.score, overallScore(scores)),
    scores,
    request_id: typeof c.request_id === "string" ? c.request_id : null,
    compliance,
  };
}

/** The weighted score behind a candidate: the directed rubric when the model scored the prompt match, else the analysis one (weights: lib/refine.ts). */
export function overallScore(scores: Scores): number {
  return weightedScore(scores, scores.prompt_match != null ? DIRECTOR_WEIGHTS : SCORE_WEIGHTS);
}

export function toCandidates(doc: unknown): Candidate[] {
  const d = asRecord(doc);
  const list = Array.isArray(d.candidates) ? d.candidates : [];
  return list.map((c, i) => toCandidate(c, i));
}

export function toChapters(doc: unknown): Chapter[] {
  const d = asRecord(doc);
  const list = Array.isArray(d.chapters) ? d.chapters : [];
  return list.map((raw, i) => {
    const c = asRecord(raw);
    return { id: String(c.id ?? `ch${i + 1}`), title: String(c.title ?? ""), start_ms: num(c.start_ms), end_ms: num(c.end_ms) };
  });
}

export function toSentences(doc: unknown): Sentence[] {
  const d = asRecord(doc);
  const list = Array.isArray(d.sentences) ? d.sentences : [];
  return list.map((raw, i) => {
    const s = asRecord(raw);
    return { id: num(s.id, i), text: String(s.text ?? ""), start_ms: num(s.start_ms), end_ms: num(s.end_ms) };
  });
}

export function toReport(raw: unknown): RenderReport {
  const r = asRecord(raw);
  const files = asRecord(r.files);
  const loud = r.loudness ? asRecord(r.loudness) : null;
  return {
    clip_id: String(r.clip_id ?? ""),
    mode: r.mode === "export" ? "export" : "preview",
    title: typeof r.title === "string" ? r.title : undefined,
    start_ms: num(r.start_ms),
    end_ms: num(r.end_ms),
    duration_ms: num(r.duration_ms),
    files: Object.fromEntries(Object.entries(files).filter(([, v]) => typeof v === "string")) as Record<string, string>,
    layouts: Array.isArray(r.layouts) ? r.layouts.map(String) : [],
    captions: Boolean(r.captions),
    caption_preset: typeof r.caption_preset === "string" ? r.caption_preset : undefined,
    has_audio: Boolean(r.has_audio),
    has_video: Boolean(r.has_video),
    width: num(r.width),
    height: num(r.height),
    loudness: loud
      ? { integrated_lufs: num(loud.integrated_lufs), true_peak_dbtp: num(loud.true_peak_dbtp), loudness_range_lu: num(loud.loudness_range_lu) }
      : null,
    compliance: r.compliance && typeof r.compliance === "object" ? (r.compliance as Compliance) : null,
    layout: toLayoutSummary(r.layout),
    quality: r.quality && typeof r.quality === "object" ? (r.quality as Record<string, unknown>) : null,
    cached: r.cached === true,
    version: typeof r.version === "number" ? r.version : null,
    rendered_at: num(r.rendered_at),
    seconds: num(r.seconds),
    error: typeof r.error === "string" ? r.error : undefined,
  };
}

export function toLayoutSummary(raw: unknown): LayoutSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const l = asRecord(raw);
  const segments = (Array.isArray(l.segments) ? l.segments : []).map((s) => {
    const seg = asRecord(s);
    return { start_ms: num(seg.start_ms), end_ms: num(seg.end_ms), layout: String(seg.layout ?? "full_frame"), subjects: Array.isArray(seg.subjects) ? seg.subjects.map(String) : [], reason: typeof seg.reason === "string" ? seg.reason : undefined };
  });
  const people = (Array.isArray(l.people) ? l.people : []).map((p) => {
    const rec = asRecord(p);
    const center = Array.isArray(rec.mean_center) ? rec.mean_center : null;
    return { id: String(rec.id ?? ""), coverage: num(rec.coverage), first_ms: num(rec.first_ms), last_ms: num(rec.last_ms), mean_center: center ? ([num(center[0]), num(center[1])] as [number, number]) : undefined, mean_face_h: num(rec.mean_face_h) };
  });
  const thumbs = asRecord(l.thumbnails);
  return {
    mode: typeof l.mode === "string" ? l.mode : undefined,
    subject_override: typeof l.subject_override === "string" ? l.subject_override : null,
    applied: Boolean(l.applied),
    segments,
    people,
    thumbnails: Object.fromEntries(Object.entries(thumbs).filter(([, v]) => typeof v === "string")) as Record<string, string>,
    speaking: Array.isArray(l.speaking) ? (l.speaking as LayoutSummary["speaking"]) : [],
    metrics: asRecord(l.metrics) as LayoutMetrics,
    method: typeof l.method === "string" ? l.method : undefined,
    error: typeof l.error === "string" ? l.error : null,
  };
}

export const LAYOUT_LABELS: Record<string, string> = {
  solo_follow: "solo follow",
  stacked_two: "two-person stacked",
  side_by_side: "side by side",
  screen_share: "screen share + speaker",
  full_frame: "full frame",
  fixed_crop: "fixed crop",
  original: "original",
};

export const LAYOUT_MODES: { value: string; label: string }[] = [
  { value: "auto", label: "auto (follow the speaker)" },
  { value: "solo_follow", label: "solo follow" },
  { value: "stacked_two", label: "two-person stacked" },
  { value: "screen_share", label: "screen share + speaker" },
  { value: "full_frame", label: "full frame on blur" },
  { value: "original", label: "original (no reframe)" },
];

/** A clip built by hand from the transcript (not one of Claude's candidates). */
export function customCandidate(start_ms: number, end_ms: number, title?: string): Candidate {
  const id = `x${Math.round(start_ms / 1000)}-${Math.round(end_ms / 1000)}`;
  const scores = { hook: 0, clarity: 0, standalone: 0 };
  return {
    id,
    rank: 0,
    title: title || `Custom clip ${fmtTime(start_ms)}–${fmtTime(end_ms)}`,
    hook: "",
    reason: "Picked by hand from the transcript.",
    quote: "",
    start_ms,
    end_ms,
    duration_ms: end_ms - start_ms,
    score: 0,
    scores,
    custom: true,
  };
}

/** The boundaries a clip will render with: saved edit over the candidate's own. */
export function effectiveRange(cand: Candidate, edit?: ClipEdit | null): { start_ms: number; end_ms: number } {
  return { start_ms: edit?.start_ms ?? cand.start_ms, end_ms: edit?.end_ms ?? cand.end_ms };
}

/** The file a preview player should show: the first rendered layout (vertical, then wide), else the audio-only render. */
export function previewFile(report: RenderReport | null | undefined): { path: string; layout: "vertical" | "wide" | "audio" } | null {
  if (!report) return null;
  for (const layout of ["vertical", "wide", "audio"] as const) {
    const path = report.files[layout];
    if (path) return { path, layout };
  }
  return null;
}

/** The caption preset an edit asks for (schema 1 booleans map to classic / off). */
export function captionPresetOf(edit: ClipEdit | null | undefined, fallback = "classic"): string {
  if (!edit) return fallback;
  if (typeof edit.caption_preset === "string") return edit.caption_preset;
  if (typeof edit.captions === "string") return edit.captions;
  if (edit.captions === false) return "off";
  return fallback;
}

export function fmtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Whole-second transcript stamp (truncated, like the nodes' fmt_timestamp): the format the LLM reads and returns. */
export function fmtStamp(ms: number): string {
  return fmtTime(Math.floor(Math.max(0, ms) / 1000) * 1000);
}

export function fmtClock(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function fmtSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

export const ANALYSIS_STEPS: { key: string; label: string }[] = [
  { key: "read", label: "Read the recording" },
  { key: "transcribe", label: "Transcribe" },
  { key: "score", label: "Score the moments" },
  { key: "ready", label: "Moments ready" },
];

/** Which analysis step a status event belongs to (-1 = failed). */
const NODE_ALIASES: Record<string, string> = {
  media_io: "podcast_ingest",
  speaker_framing: "podcast_layout",
  media_render: "podcast_render",
};

/** The stage switch keys on the historical node names; new generic nodes map onto them. */
function canonicalNode(evt: StatusEvent): string {
  const node = String(evt.node ?? "");
  const mapped = NODE_ALIASES[node] ?? node;
  // speaker_framing covers both old vision nodes; scan-mode stages belonged to podcast_visual
  if (mapped === "podcast_layout" && ["people", "scenes", "scanned"].includes(String(evt.stage))) return "podcast_visual";
  return mapped;
}

export function analysisStep(evt: StatusEvent | null | undefined): number {
  if (!evt) return 0;
  if (evt.stage === "error") return -1;
  const node = canonicalNode(evt);
  if (node === "podcast_ingest") return evt.stage === "probing" || evt.stage === "splitting" ? 0 : 1;
  if (node === "podcast_segment") return 2;
  if (node === "podcast_refine") return evt.stage === "analyzed" ? 3 : 2;
  return 0;
}

export function describeStatus(evt: StatusEvent | null | undefined): string {
  if (!evt) return "Getting ready";
  const n = (k: string) => (typeof evt[k] === "number" ? (evt[k] as number) : undefined);
  if (evt.stage === "error") return `Failed: ${evt.message ?? "unknown error"}`;
  switch (`${canonicalNode(evt)}:${evt.stage}`) {
    case "podcast_ingest:probing":
      return "Reading the recording";
    case "podcast_ingest:splitting":
      return "Cutting the audio into pieces";
    case "podcast_ingest:transcribing":
      if (n("pieces") && n("piece") != null) {
        const resumed = n("resumed") ? ` (${n("resumed")} kept from the previous run)` : "";
        return `Transcribing · piece ${n("piece")} of ${n("pieces")}${resumed}`;
      }
      return `Transcribing ${n("pieces") ?? ""} pieces`.trim();
    case "podcast_segment:transcribed":
      return `Transcript ready · ${n("sentences") ?? "?"} sentences`;
    case "podcast_segment:scoring":
      return n("parts") && n("parts")! > 1 ? `Scoring part ${n("part")} of ${n("parts")}` : "Scoring the moments";
    case "podcast_segment:indexing":
      return n("passages") ? `Preparing transcript search · ${n("passages")} passages` : "Preparing transcript search";
    case "podcast_segment:indexed":
      return `Transcript search ready · ${n("passages") ?? 0} passages`;
    // the selection step: written by the browser itself now (lib/refine.ts), under the name every stored status.json already carries
    case "podcast_refine:analyzed":
      return `${n("candidates") ?? 0} candidates ready${n("seconds") ? ` in ${Math.round(n("seconds")!)}s` : ""}`;
    case "podcast_refine:directed":
      return `${n("candidates") ?? 0} of ${n("proposed") ?? 0} proposals met the request${n("seconds") ? ` in ${Math.round(n("seconds")!)}s` : ""}`;
    case "podcast_prepare_clip:preparing":
      return "Locating the clip in the recording";
    case "podcast_prepare_clip:aligning":
      return "Aligning word timestamps";
    case "podcast_prepare_clip:prepared":
      return `Clip planned · ${n("words") ?? 0} words, ${n("cuts") ?? 0} cuts${n("muted") ? `, ${n("muted")} muted` : ""}${evt.fit_met === false ? " · target not reached" : ""}`;
    case "podcast_prepare_clip:slicing":
      return "Preparing frames for the visual director";
    case "podcast_layout:tracking":
      return `Tracking people in ${n("frames") ?? 0} frames`;
    case "podcast_layout:planned":
      return `Layout planned · ${n("people") ?? 0} ${n("people") === 1 ? "person" : "people"}, ${n("segments") ?? 1} segment${n("segments") === 1 ? "" : "s"}`;
    case "podcast_ingest:streaming":
    case "podcast_ingest:streamed":
      return "Reading the video frames";
    case "podcast_visual:people":
      return `Clustering the people on screen (${n("frames") ?? 0} frames)`;
    case "podcast_visual:scenes":
      return "Detecting shot changes";
    case "podcast_visual:scanned":
      return `Visual scan ready · ${n("people") ?? 0} people, ${n("scenes") ?? 0} scenes`;
    case "podcast_render:rendering":
      return evt.mode === "export" ? "Rendering the export" : "Rendering the preview";
    case "podcast_render:encoding":
      return `Encoding ${String(evt.layout ?? "")} video`;
    case "podcast_render:rendered":
      return `Rendered${n("seconds") ? ` in ${Math.round(n("seconds")!)}s` : ""}`;
    default:
      return `${evt.node}: ${evt.stage}`;
  }
}

export const GOAL_PRESETS: { label: string; text: string }[] = [
  { label: "Educational", text: "Educational moments: clear explanations, concrete takeaways, the 'now I get it' beats. Calm, confident tone." },
  { label: "Funny", text: "Funny moments: banter, punchlines, self-aware jokes that land without context. Playful tone, 20–45 seconds." },
  { label: "Hot takes", text: "Strong opinions and contrarian takes that will start a discussion. Punchy, 30–60 seconds." },
  { label: "Product promo", text: "Moments that promote the product discussed: concrete results, customer wins, demos in plain language. 30–75 seconds." },
];

export const DIRECTOR_PRESETS: { label: string; text: string }[] = [
  {
    label: "Three 42s clips",
    text: "Create three 42-second clips where the guest explains the main idea of the episode. Start with a surprising statement, remove filler words, avoid profanity, use yellow captions, and end with a complete takeaway.",
  },
  { label: "Exact 30s hook", text: "One clip of exactly 30 seconds with the strongest hook in the episode, tighten the pauses, classic captions, vertical." },
  { label: "Under a minute, no ads", text: "Two clips under a minute about the most controversial opinion, skip the sponsor reads, keep the pauses natural." },
];

export function scoreTone(score: number): string {
  if (score >= 8) return "text-ready";
  if (score >= 6.5) return "text-processing";
  return "text-ink-faint";
}

// ------------------------------------------------------------ titles & runs

/**
 * A readable title from a file name or a stored title: the extension goes,
 * `_` and `-` become spaces, every word gets a capital (words that already
 * carry one — EP12, AI, iPhone — are left alone).
 */
export function prettyTitle(fileOrTitle: string | null | undefined): string {
  const raw = String(fileOrTitle ?? "").trim();
  const ext = raw.match(/\.([A-Za-z0-9]{2,4})$/);
  const stem = ext && /[A-Za-z]/.test(ext[1]) ? raw.slice(0, -ext[0].length) : raw;
  const words = stem.replace(/[_-]+/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return "Untitled episode";
  return words.map((w) => (/[A-Z]/.test(w) ? w : w.replace(/[a-z]/, (c) => c.toUpperCase()))).join(" ");
}

export type RunStatus = "analysing" | "ready" | "failed" | "new";

export interface RunSummary {
  status: RunStatus;
  /** e.g. "ready · 8 moments · 2 directed · 1 export" (zero counts are left out) */
  label: string;
  moments: number;
  directed: number;
  exports: number;
  previews: number;
}

/** An analysis still marked "analyzing" after this long was interrupted (runs take minutes, not hours). */
export const STALE_ANALYSIS_S = 3 * 3600;

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** What a project's run amounts to, from project.json alone. `now` is in seconds (like `created`). */
export function runSummary(project: Project | null | undefined, now: number = Date.now() / 1000): RunSummary {
  const rendered = (r?: ClipRender) => !!r && Object.keys(r.files ?? {}).length > 0;
  const clips = Object.values(project?.clips ?? {});
  const previews = clips.filter((c) => rendered(c.preview)).length;
  const exports = clips.filter((c) => rendered(c.export)).length;
  const directed = Object.values(project?.requests ?? {}).reduce((n, r) => n + (r.delivered ?? 0), 0);
  const moments = project?.analysis?.candidates ?? 0;
  const s = project?.analysis?.status;
  const startedAt = project?.analysis?.started_at ?? project?.created ?? now;
  let status: RunStatus = "new";
  if (s === "analyzed") status = "ready";
  else if (s === "analyzing") status = now - startedAt > STALE_ANALYSIS_S ? "failed" : "analysing";
  else if (s === "failed" || s === "error") status = "failed";
  const label =
    status === "ready"
      ? ["ready", plural(moments, "moment"), directed ? `${directed} directed` : "", exports ? plural(exports, "export") : ""].filter(Boolean).join(" · ")
      : status;
  return { status, label, moments, directed, exports, previews };
}

/** describeStatus() for the producer's eyes: the same progress, without naming the machinery. */
export function friendlyStatus(evt: StatusEvent | null | undefined): string {
  if (!evt) return "Getting ready";
  const text = describeStatus(evt);
  if (text === `${evt.node}: ${evt.stage}`) {
    const stage = String(evt.stage).replace(/[_-]+/g, " ").trim();
    return stage ? stage[0].toUpperCase() + stage.slice(1) : "Working";
  }
  const indexing = text.match(/^Indexing (?:(\d+) )?transcript passages$/);
  if (indexing) return indexing[1] ? `Preparing transcript search · ${indexing[1]} passages` : "Preparing transcript search";
  return text
    .replace(/^Waiting for the engine$/, "Getting ready")
    .replace(/^Claude is scoring/, "Scoring")
    .replace(/ for the transcriber$/, "")
    .replace(/^Transcript index ready/, "Transcript search ready")
    .replace(/^Streaming the video to the frame grabber$/, "Reading the video frames");
}
