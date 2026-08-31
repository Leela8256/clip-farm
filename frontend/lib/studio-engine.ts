/**
 * The studio's calls to the engine — the only studio module that touches the
 * SDK (lib/studio.ts stays pure). It mirrors lib/engine.ts: the shared client
 * and the store helpers come from there, the three studio pipelines are
 * registered here from their JSON mirrors of .rocketride/*.pipe, and one chat
 * question runs a job with live progress on the 'podcast' channel.
 *
 * Pipelines (mirrors of .rocketride/*.pipe):
 *   podcast-studio-prepare   the episode's words, sound shape and cleanup ideas
 *   podcast-studio-preview   a quick look at the episode as edited
 *   podcast-studio-export    the finished video, audio, captions and chapters
 *
 * The question's context lines pick the job: `project: projects/<id>` plus
 * `studio: init | preview | export`, with `range:` and `quality:` for previews.
 */

import { RocketRideClient, Question } from "rocketride";
import preparePipe from "./pipelines/podcast-studio-prepare.json";
import previewPipe from "./pipelines/podcast-studio-preview.json";
import exportPipe from "./pipelines/podcast-studio-export.json";
import { getClient, mediaUrl, readJsonOr, startRun, uploadFile, writeJson, type ProgressHandler } from "./engine";
import { pickManifest, projectRoot, safeName, type PipeKind, type StatusEvent } from "./podcast";
import {
  emptyEdits,
  normalizeEdits,
  normalizeSpec,
  normalizeSuggestions,
  normalizeTimeline,
  normalizeWaveform,
  snapshotVersion,
  bumpVersion,
  toStudioReport,
  type EpisodeEdits,
  type PreparedSpec,
  type StudioReport,
  type StudioTimeline,
  type StudioWaveform,
  type Suggestion,
} from "./studio";

/**
 * The three studio jobs. They live beside lib/engine.ts's own pipeline names
 * (PipeKind) rather than inside them, so nothing there had to change; the run
 * tracker takes the same names through startStudioRun below.
 */
export type StudioPipeKind = "studio-prepare" | "studio-preview" | "studio-export";

type UseOptions = NonNullable<Parameters<RocketRideClient["use"]>[0]>;
type PipelineConfig = NonNullable<UseOptions["pipeline"]>;

const PIPES: Record<StudioPipeKind, unknown> = {
  "studio-prepare": preparePipe,
  "studio-preview": previewPipe,
  "studio-export": exportPipe,
};

// ------------------------------------------------------------------ store paths

export const studioRoot = (episodeId: string) => `${projectRoot(episodeId)}/analysis/studio`;
export const editsPath = (episodeId: string) => `${projectRoot(episodeId)}/edits/episode-edits.json`;
export const timelinePath = (episodeId: string) => `${studioRoot(episodeId)}/timeline.json`;
export const waveformPath = (episodeId: string) => `${studioRoot(episodeId)}/waveform.json`;
export const suggestionsPath = (episodeId: string) => `${studioRoot(episodeId)}/suggestions.json`;
export const specPath = (episodeId: string, version: number) => `${studioRoot(episodeId)}/prepared-v${version}.json`;
export const assetsRoot = (episodeId: string) => `${projectRoot(episodeId)}/assets`;

// -------------------------------------------------------------------- runs

async function runStudioQuestion(kind: StudioPipeKind, context: string[], text: string, onProgress?: ProgressHandler): Promise<unknown> {
  const client = await getClient();
  const { token } = await client.use({ pipeline: PIPES[kind] as PipelineConfig, useExisting: true });
  const question = new Question();
  question.addContext(context.join("\n"));
  question.addQuestion(text || "go");
  // Jobs are never retried: a retry would run the whole thing twice.
  return client.chat({
    token,
    question,
    onSSE: async (type, data) => {
      if (type === "podcast" && onProgress) onProgress(data as unknown as StatusEvent);
    },
  });
}

export interface StudioInitResult {
  ok: boolean;
  words?: number;
  suggestions?: number;
  duration_ms?: number;
  seconds?: number;
  error?: string;
}

/**
 * First step for an episode: line the words up with the recording, measure the
 * sound shape and collect the cleanup ideas.
 */
export async function runStudioInit(episodeId: string, onProgress?: ProgressHandler): Promise<StudioInitResult> {
  const result = await runStudioQuestion("studio-prepare", [`project: ${projectRoot(episodeId)}`, "studio: init"], "prepare the episode", onProgress);
  const m = pickManifest(result) ?? {};
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  if (typeof m.error === "string" && m.error) return { ok: false, error: m.error };
  return {
    ok: true,
    words: n(m.words),
    suggestions: n(m.suggestions),
    duration_ms: n(m.duration_ms),
    seconds: n(m.seconds),
  };
}

export interface PreviewOptions {
  /** [start, end] on the finished-episode timeline, for a close look at one stretch. */
  range?: [number, number];
  /** "rough" = the whole episode, quickly; "full" = the real thing for the chosen stretch. */
  quality: "rough" | "full";
}

/** Build a preview of the episode as edited. */
export async function runStudioPreview(episodeId: string, options: PreviewOptions, onProgress?: ProgressHandler): Promise<StudioReport> {
  const context = [`project: ${projectRoot(episodeId)}`, "studio: preview", `quality: ${options.quality}`];
  if (options.range) {
    const [a, b] = options.range;
    context.push(`range: ${Math.max(0, Math.round(Math.min(a, b)))}-${Math.round(Math.max(a, b))}`);
  }
  const result = await runStudioQuestion("studio-preview", context, "preview the episode", onProgress);
  return toStudioReport(pickManifest(result) ?? {});
}

/** Render the finished episode: video, audio, captions, chapters and the summary. */
export async function runStudioExport(episodeId: string, onProgress?: ProgressHandler): Promise<StudioReport> {
  const result = await runStudioQuestion("studio-export", [`project: ${projectRoot(episodeId)}`, "studio: export"], "export the episode", onProgress);
  return toStudioReport(pickManifest(result) ?? {});
}

// ------------------------------------------------------------------- reading

export interface StudioData {
  timeline: StudioTimeline | null;
  waveform: StudioWaveform | null;
  suggestions: Suggestion[];
  edits: EpisodeEdits;
}

/** Everything the studio opens with. Anything missing comes back empty, never as a failure. */
export async function loadStudio(episodeId: string): Promise<StudioData> {
  const [timelineRaw, waveformRaw, suggestionsRaw, editsRaw] = await Promise.all([
    readJsonOr<unknown>(timelinePath(episodeId), null),
    readJsonOr<unknown>(waveformPath(episodeId), null),
    readJsonOr<unknown>(suggestionsPath(episodeId), null),
    readJsonOr<unknown>(editsPath(episodeId), null),
  ]);
  const timeline = normalizeTimeline(timelineRaw);
  const waveform = normalizeWaveform(waveformRaw);
  let duration = timeline?.duration_ms ?? waveform?.duration_ms ?? 0;
  if (!duration) {
    const project = await readJsonOr<{ media?: { duration_ms?: number } } | null>(`${projectRoot(episodeId)}/project.json`, null);
    duration = project?.media?.duration_ms ?? 0;
  }
  return {
    timeline,
    waveform,
    suggestions: normalizeSuggestions(suggestionsRaw),
    edits: editsRaw ? normalizeEdits(editsRaw, duration) : emptyEdits(duration),
  };
}

/** The prepared instructions for a rendered version, when they are on file. */
export async function loadPreparedSpec(episodeId: string, version: number): Promise<PreparedSpec | null> {
  return normalizeSpec(await readJsonOr<unknown>(specPath(episodeId, version), null));
}

// ------------------------------------------------------------------- writing

export interface SaveOptions {
  /** Also keep a full copy as a numbered save point. */
  snapshot?: boolean;
  note?: string;
}

/**
 * Save the producer's changes. The recording is never touched: this file is
 * the whole edit. Saving always moves the record on a number so renders stay
 * keyed to what they were made from.
 */
export async function saveEpisodeEdits(episodeId: string, edits: EpisodeEdits, options: SaveOptions = {}): Promise<EpisodeEdits> {
  const root = projectRoot(episodeId);
  if (options.snapshot) {
    const snap = snapshotVersion(edits, options.note ?? "");
    await writeJson(`${root}/${snap.file}`, snap.edits);
    await writeJson(editsPath(episodeId), snap.edits);
    return snap.edits;
  }
  const next = bumpVersion(edits);
  await writeJson(editsPath(episodeId), next);
  return next;
}

// ------------------------------------------------------------------- assets

export type AssetKind = "intro" | "outro" | "music" | "logo";

const DEFAULT_EXT: Record<AssetKind, string> = { intro: "mp4", outro: "mp4", music: "mp3", logo: "png" };

/** Put a piece of branding next to the episode and hand back where it landed. */
export async function uploadAsset(
  episodeId: string,
  kind: AssetKind,
  file: File,
  onProgress?: (sent: number, total: number) => void
): Promise<string> {
  const name = safeName(file.name || `${kind}.${DEFAULT_EXT[kind]}`);
  const ext = (name.includes(".") ? name.split(".").pop() : "") || DEFAULT_EXT[kind];
  const path = `${assetsRoot(episodeId)}/${kind}.${ext.toLowerCase()}`;
  await uploadFile(path, file, onProgress);
  return path;
}

/** A URL the browser can play or download; `version` keeps a re-rendered file from showing the old one. */
export function studioFileUrl(path: string, version: string | number = ""): Promise<string> {
  return mediaUrl(path, version);
}

// --------------------------------------------------------------- background runs

/** The key a studio job's progress is tracked under (see getRun / subscribeRun in lib/engine). */
export const studioRunKey = (episodeId: string, kind: StudioPipeKind) => `${episodeId}/studio/${kind}`;

/**
 * Start a studio job that outlives the screen that started it, on the same
 * tracker the rest of the app uses. The tracker labels a run with lib/engine's
 * own job names, which the studio's three are not part of, so the label is
 * passed through as-is.
 */
export function startStudioRun<T>(episodeId: string, kind: StudioPipeKind, job: (onProgress: ProgressHandler) => Promise<T>): string {
  return startRun(studioRunKey(episodeId, kind), kind as unknown as PipeKind, job);
}
