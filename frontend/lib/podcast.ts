/**
 * Pure types and helpers for the podcast clip studio — the shapes the
 * RocketRide nodes write into projects/<episode>/ and the UI reads back.
 * No SDK imports here so everything stays unit-testable.
 */

export type PipeKind = "analysis" | "preview" | "export";

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
  preview?: ClipRender;
  export?: ClipRender;
}

export interface Project {
  episode_id: string;
  title?: string;
  source: string;
  created?: number;
  updated?: number;
  settings: ProjectSettings;
  media?: ProjectMedia;
  analysis?: ProjectAnalysis;
  clips?: Record<string, ProjectClip>;
}

export interface Scores {
  hook: number;
  clarity: number;
  standalone: number;
}

export interface Candidate {
  id: string;
  rank: number;
  title: string;
  hook: string;
  reason: string;
  quote: string;
  text?: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  score: number;
  scores: Scores;
  custom?: boolean;
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
  captions?: boolean;
  tighten_pauses?: boolean;
  remove_fillers?: boolean;
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
  has_audio: boolean;
  has_video: boolean;
  width: number;
  height: number;
  loudness?: Loudness | null;
  rendered_at: number;
  seconds: number;
  error?: string;
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
 * The node manifest inside a response_answers result. The answers lane carries
 * every answer written along the path (the LLM's raw per-part answers too), so
 * the manifest is the last payload that names the project.
 */
export function pickManifest(result: unknown): Record<string, unknown> | null {
  const r = asRecord(result);
  const items = Array.isArray(r.answers) ? r.answers : [];
  const parsed = items.map((item) => {
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
  for (let i = parsed.length - 1; i >= 0; i--) {
    const rec = asRecord(parsed[i]);
    if (typeof rec.project === "string") return rec;
  }
  const last = parsed[parsed.length - 1];
  return last && typeof last === "object" ? (last as Record<string, unknown>) : null;
}

export function toCandidate(raw: unknown, index = 0): Candidate {
  const c = asRecord(raw);
  const s = asRecord(c.scores);
  const scores = { hook: num(s.hook, 5), clarity: num(s.clarity, 5), standalone: num(s.standalone, 5) };
  const start_ms = num(c.start_ms);
  const end_ms = num(c.end_ms);
  return {
    id: String(c.id ?? `c${String(index + 1).padStart(2, "0")}`),
    rank: num(c.rank, index + 1),
    title: String(c.title ?? `Clip ${index + 1}`),
    hook: String(c.hook ?? ""),
    reason: String(c.reason ?? ""),
    quote: String(c.quote ?? ""),
    text: typeof c.text === "string" ? c.text : undefined,
    start_ms,
    end_ms,
    duration_ms: num(c.duration_ms, end_ms - start_ms),
    score: num(c.score, overallScore(scores)),
    scores,
  };
}

export function overallScore(scores: Scores): number {
  return Math.round((scores.hook * 0.4 + scores.standalone * 0.3 + scores.clarity * 0.3) * 100) / 100;
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
    has_audio: Boolean(r.has_audio),
    has_video: Boolean(r.has_video),
    width: num(r.width),
    height: num(r.height),
    loudness: loud
      ? { integrated_lufs: num(loud.integrated_lufs), true_peak_dbtp: num(loud.true_peak_dbtp), loudness_range_lu: num(loud.loudness_range_lu) }
      : null,
    rendered_at: num(r.rendered_at),
    seconds: num(r.seconds),
    error: typeof r.error === "string" ? r.error : undefined,
  };
}

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

export function fmtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
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
  { key: "transcribe", label: "Transcribe on the engine" },
  { key: "score", label: "Claude scores the moments" },
  { key: "ready", label: "Candidates ready" },
];

/** Which analysis step an engine status event belongs to (-1 = failed). */
export function analysisStep(evt: StatusEvent | null | undefined): number {
  if (!evt) return 0;
  if (evt.stage === "error") return -1;
  if (evt.node === "podcast_ingest") return evt.stage === "probing" || evt.stage === "splitting" ? 0 : 1;
  if (evt.node === "podcast_segment") return 2;
  if (evt.node === "podcast_refine") return evt.stage === "analyzed" ? 3 : 2;
  return 0;
}

export function describeStatus(evt: StatusEvent | null | undefined): string {
  if (!evt) return "Waiting for the engine";
  const n = (k: string) => (typeof evt[k] === "number" ? (evt[k] as number) : undefined);
  if (evt.stage === "error") return `Failed: ${evt.message ?? "unknown error"}`;
  switch (`${evt.node}:${evt.stage}`) {
    case "podcast_ingest:probing":
      return "Reading the recording";
    case "podcast_ingest:splitting":
      return "Cutting the audio into pieces for the transcriber";
    case "podcast_ingest:transcribing":
      if (n("pieces") && n("piece") != null) {
        const resumed = n("resumed") ? ` (${n("resumed")} kept from the previous run)` : "";
        return `Transcribing · piece ${n("piece")} of ${n("pieces")}${resumed}`;
      }
      return `Transcribing ${n("pieces") ?? ""} pieces`.trim();
    case "podcast_ingest:streaming":
    case "podcast_ingest:streamed":
      return "Streaming the video";
    case "podcast_segment:transcribed":
      return `Transcript ready · ${n("sentences") ?? "?"} sentences`;
    case "podcast_segment:scoring":
      return n("parts") && n("parts")! > 1 ? `Claude is scoring part ${n("part")} of ${n("parts")}` : "Claude is scoring the moments";
    case "podcast_refine:analyzed":
      return `${n("candidates") ?? 0} candidates ready${n("seconds") ? ` in ${Math.round(n("seconds")!)}s` : ""}`;
    case "podcast_prepare_clip:preparing":
      return "Locating the clip in the recording";
    case "podcast_prepare_clip:aligning":
      return "Aligning word timestamps";
    case "podcast_prepare_clip:prepared":
      return `Clip planned · ${n("words") ?? 0} words, ${n("cuts") ?? 0} cuts`;
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

export function scoreTone(score: number): string {
  if (score >= 8) return "text-ready";
  if (score >= 6.5) return "text-processing";
  return "text-ink-faint";
}
