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
 *
 * It also owns three things the studio cannot get wrong:
 *   - loading fail-closed (a file that could not be READ is never mistaken for
 *     a file that is not there, so nothing writes over the producer's work);
 *   - a one-at-a-time save queue (rapid changes collapse into one newest save,
 *     saves never land out of order, and "saved" means exactly this work is on
 *     file);
 *   - the reversible editing proposal, which asks the writing assistant
 *     through the stock director-chat pipeline and lands in its own file under
 *     edits/proposals/ — never inside episode-edits.json.
 */

import { RocketRideClient, Question } from "rocketride";
import preparePipe from "./pipelines/podcast-studio-prepare.json";
import previewPipe from "./pipelines/podcast-studio-preview.json";
import exportPipe from "./pipelines/podcast-studio-export.json";
import chatPipe from "./pipelines/director-chat.json";
import {
  deleteFile,
  getClient,
  listDir,
  mediaUrl,
  readJsonOr,
  readJsonStrict,
  startRun,
  uploadFile,
  writeJson,
  type ProgressHandler,
} from "./engine";
import { firstJsonAnswer, pickManifest, projectRoot, safeName, toSentences, type PipeKind, type StatusEvent } from "./podcast";
import {
  buildProposalQuestion,
  editsSignature,
  emptyEdits,
  normalizeEdits,
  normalizeProposal,
  normalizeSpec,
  normalizeSuggestionsFile,
  normalizeTimeline,
  normalizeWaveform,
  restoreVersion,
  snapshotVersion,
  bumpVersion,
  toStudioReport,
  validateProposal,
  versionFile,
  type EditProposal,
  type EpisodeEdits,
  type PreparedSpec,
  type StudioReport,
  type StudioTimeline,
  type StudioWaveform,
  type Suggestion,
  type SuggestionKind,
  type SuggestionMode,
} from "./studio";

/**
 * The three studio jobs. They live beside lib/engine.ts's own pipeline names
 * (PipeKind) rather than inside them, so nothing there had to change; the run
 * tracker takes the same names through startStudioRun below.
 */
export type StudioPipeKind = "studio-prepare" | "studio-preview" | "studio-export" | "studio-proposal";

type UseOptions = NonNullable<Parameters<RocketRideClient["use"]>[0]>;
type PipelineConfig = NonNullable<UseOptions["pipeline"]>;

const PIPES: Record<StudioPipeKind, unknown> = {
  "studio-prepare": preparePipe,
  "studio-preview": previewPipe,
  "studio-export": exportPipe,
  // The editing proposal is a plain question to the writing assistant — the
  // same stock chat pipeline the Prompt Director parses prompts with.
  "studio-proposal": chatPipe,
};

// ------------------------------------------------------------------ store paths

export const studioRoot = (episodeId: string) => `${projectRoot(episodeId)}/analysis/studio`;
export const editsPath = (episodeId: string) => `${projectRoot(episodeId)}/edits/episode-edits.json`;
export const timelinePath = (episodeId: string) => `${studioRoot(episodeId)}/timeline.json`;
export const waveformPath = (episodeId: string) => `${studioRoot(episodeId)}/waveform.json`;
export const suggestionsPath = (episodeId: string) => `${studioRoot(episodeId)}/suggestions.json`;
export const specPath = (episodeId: string, version: number) => `${studioRoot(episodeId)}/prepared-v${version}.json`;
export const assetsRoot = (episodeId: string) => `${projectRoot(episodeId)}/assets`;
export const versionPath = (episodeId: string, n: number) => `${projectRoot(episodeId)}/${versionFile(n)}`;
export const proposalsRoot = (episodeId: string) => `${projectRoot(episodeId)}/edits/proposals`;
export const proposalPath = (episodeId: string, id: string) => `${proposalsRoot(episodeId)}/${id}.json`;
export const transcriptPath = (episodeId: string) => `${projectRoot(episodeId)}/analysis/transcript.json`;

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
  /**
   * How good the preview has to be. "standard" = the whole episode at a
   * watchable size; "range" = the chosen stretch as it will really sound and
   * look. The older names keep working: "rough" is the whole episode (an alias
   * of standard) and "full" is the chosen stretch.
   */
  quality: "rough" | "full" | "standard" | "range";
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

/** How big the finished episode is made: 720p, 1080p, or as big as the recording is. */
export interface ExportOptions {
  size?: "720" | "1080" | "source";
}

/**
 * Render the finished episode: video, audio, captions, chapters and the
 * summary. `options.size` asks for the picture size (1080 when nothing is
 * said); it travels as its own context line so an older engine simply ignores
 * it.
 */
export async function runStudioExport(episodeId: string, onProgress?: ProgressHandler, options?: ExportOptions): Promise<StudioReport> {
  const context = [`project: ${projectRoot(episodeId)}`, "studio: export"];
  if (options?.size) context.push(`size: ${options.size}`);
  const result = await runStudioQuestion("studio-export", context, "export the episode", onProgress);
  const report = toStudioReport(pickManifest(result) ?? {});
  // the render node no longer writes the project's studio registry — stamp it here (best effort)
  if (!report.error && report.version != null && Object.keys(report.files ?? {}).length) {
    try {
      const root = projectRoot(episodeId);
      const project = await readJsonOr<Record<string, unknown> | null>(`${root}/project.json`, null);
      if (project) {
        const studio = ((project.studio as Record<string, unknown>) ??= {});
        studio[String(report.version)] = { files: report.files, duration_ms: report.duration_ms, rendered_at: Date.now() / 1000 };
        await writeJson(`${root}/project.json`, project);
      }
    } catch {
      /* derivable — never fail the export over the stamp */
    }
  }
  return report;
}

// ------------------------------------------------------------------- reading

/** How one file came back: there, not there yet, or the read went wrong. */
export interface FileLoad<T> {
  data: T | null;
  /** the read failed — the file may well hold real work, so nothing may be written over it */
  failed: boolean;
  /** the file is genuinely not there yet */
  missing: boolean;
  error?: string;
}

export type StudioFileKey = "timeline" | "waveform" | "suggestions" | "edits" | "project";

export interface StudioData {
  timeline: StudioTimeline | null;
  waveform: StudioWaveform | null;
  suggestions: Suggestion[];
  /** the language the recording was transcribed in, when it was recorded */
  language: string | null;
  /** cleanup kinds that cannot be looked for in that language */
  unsupported: SuggestionKind[];
  /**
   * The producer's edit record — null when the file is not there yet OR when
   * reading it failed. `files.edits.failed` tells the two apart: on a failure
   * the screen must show a retry and must NOT start a blank record.
   */
  edits: EpisodeEdits | null;
  /** a blank record for this recording, ready to use when `files.edits.missing` */
  blank: EpisodeEdits;
  durationMs: number;
  files: Record<StudioFileKey, FileLoad<unknown>>;
  /** any file failed to load */
  failed: boolean;
  failedFiles: StudioFileKey[];
  error: string | null;
}

async function loadFile(path: string): Promise<FileLoad<unknown>> {
  const read = await readJsonStrict<unknown>(path);
  if (read.ok) return { data: read.value, failed: false, missing: false };
  return { data: null, failed: !read.missing, missing: read.missing, error: read.error || undefined };
}

/**
 * Everything the studio opens with. A file that is not there yet comes back
 * empty; a file that could not be read comes back FAILED, and the caller must
 * leave it alone — the old behaviour treated a dropped connection as an empty
 * account and the next autosave wrote over the producer's work.
 */
export async function loadStudio(episodeId: string): Promise<StudioData> {
  const [timelineFile, waveformFile, suggestionsFile, editsFile] = await Promise.all([
    loadFile(timelinePath(episodeId)),
    loadFile(waveformPath(episodeId)),
    loadFile(suggestionsPath(episodeId)),
    loadFile(editsPath(episodeId)),
  ]);
  const timeline = normalizeTimeline(timelineFile.data);
  const waveform = normalizeWaveform(waveformFile.data);
  let duration = timeline?.duration_ms ?? waveform?.duration_ms ?? 0;
  let projectFile: FileLoad<unknown> = { data: null, failed: false, missing: true };
  if (!duration) {
    projectFile = await loadFile(`${projectRoot(episodeId)}/project.json`);
    const project = projectFile.data as { media?: { duration_ms?: number } } | null;
    duration = project?.media?.duration_ms ?? 0;
  }
  const cleanup = normalizeSuggestionsFile(suggestionsFile.data);
  const files: Record<StudioFileKey, FileLoad<unknown>> = {
    timeline: timelineFile,
    waveform: waveformFile,
    suggestions: suggestionsFile,
    edits: editsFile,
    project: projectFile,
  };
  const failedFiles = (Object.keys(files) as StudioFileKey[]).filter((key) => files[key].failed);
  return {
    timeline,
    waveform,
    suggestions: cleanup.suggestions,
    language: cleanup.language,
    unsupported: cleanup.unsupported,
    edits: editsFile.data ? normalizeEdits(editsFile.data, duration) : null,
    blank: emptyEdits(duration),
    durationMs: duration,
    files,
    failed: failedFiles.length > 0,
    failedFiles,
    error: failedFiles.map((key) => files[key].error).find((e) => !!e) ?? null,
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
  /** false when the record already carries its new revision (restoring a save point). */
  bump?: boolean;
}

/** Where the writes actually go; tests put their own in with `setStudioWriter`. */
type Writer = (path: string, value: unknown) => Promise<void>;
let writer: Writer = writeJson;

/** Test seam: swap the file writer (pass null to put the real one back). */
export function setStudioWriter(fn: Writer | null): void {
  writer = fn ?? writeJson;
}

/**
 * Write the record once. The recording is never touched: this file is the
 * whole edit. Every write moves the revision on a number, so renders stay
 * keyed to what they were made from.
 */
async function writeEdits(episodeId: string, edits: EpisodeEdits, options: SaveOptions = {}): Promise<EpisodeEdits> {
  const root = projectRoot(episodeId);
  if (options.snapshot) {
    const snap = snapshotVersion(edits, options.note ?? "");
    await writer(`${root}/${snap.file}`, snap.edits);
    await writer(editsPath(episodeId), snap.edits);
    return snap.edits;
  }
  const next = options.bump === false ? { ...edits, updated: Date.now() / 1000 } : bumpVersion(edits);
  await writer(editsPath(episodeId), next);
  return next;
}

/** What the screen shows next to the title: saving, saved, or something went wrong. */
export interface SaveState {
  saving: boolean;
  /** a newer change is waiting for the current write to finish */
  queued: boolean;
  /** the record as it reached the file */
  saved: EpisodeEdits | null;
  /** fingerprint of the work that reached the file (see editsSignature) */
  savedSignature: string | null;
  savedAt: number | null;
  error: string | null;
}

interface PendingSave {
  edits: EpisodeEdits;
  options: SaveOptions;
  waiting: { resolve: (edits: EpisodeEdits) => void; reject: (error: unknown) => void }[];
}

const IDLE: SaveState = { saving: false, queued: false, saved: null, savedSignature: null, savedAt: null, error: null };

const saveStates = new Map<string, SaveState>();
const saveListeners = new Map<string, Set<() => void>>();
const pendingSaves = new Map<string, PendingSave>();
const savingNow = new Set<string>();

export const getSaveState = (episodeId: string): SaveState => saveStates.get(episodeId) ?? IDLE;

export function subscribeSave(episodeId: string, fn: () => void): () => void {
  let set = saveListeners.get(episodeId);
  if (!set) {
    set = new Set();
    saveListeners.set(episodeId, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
  };
}

function patchSaveState(episodeId: string, patch: Partial<SaveState>): void {
  saveStates.set(episodeId, { ...getSaveState(episodeId), ...patch });
  saveListeners.get(episodeId)?.forEach((fn) => fn());
}

/**
 * True when exactly this work is on file. It compares the producer's changes,
 * not the revision number, so the moment anything on screen differs from what
 * was written the editor is honestly "unsaved" again — including while a save
 * is still in the air.
 */
export function isSaved(episodeId: string, edits: EpisodeEdits | null): boolean {
  const state = getSaveState(episodeId);
  if (!edits || !state.savedSignature) return false;
  return state.savedSignature === editsSignature(edits);
}

/** Forget an episode's save state (leaving the studio, and between tests). */
export function resetSaveState(episodeId?: string): void {
  if (episodeId) {
    saveStates.delete(episodeId);
    pendingSaves.delete(episodeId);
    return;
  }
  saveStates.clear();
  pendingSaves.clear();
}

async function drainSaves(episodeId: string): Promise<void> {
  if (savingNow.has(episodeId)) return;
  savingNow.add(episodeId);
  try {
    for (;;) {
      const job = pendingSaves.get(episodeId);
      if (!job) break;
      pendingSaves.delete(episodeId);
      patchSaveState(episodeId, { saving: true, queued: false, error: null });
      try {
        const saved = await writeEdits(episodeId, job.edits, job.options);
        patchSaveState(episodeId, {
          saved,
          savedSignature: editsSignature(saved),
          savedAt: Date.now(),
          error: null,
          queued: pendingSaves.has(episodeId),
        });
        job.waiting.forEach((w) => w.resolve(saved));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Nothing about "saved" moves: the work on screen is still unsaved.
        patchSaveState(episodeId, { error: message, queued: pendingSaves.has(episodeId) });
        job.waiting.forEach((w) => w.reject(e));
      }
    }
  } finally {
    savingNow.delete(episodeId);
    patchSaveState(episodeId, { saving: false, queued: pendingSaves.has(episodeId) });
  }
}

/**
 * Save the producer's changes, one write at a time. While a save is in the
 * air, further changes do not queue up behind each other: they collapse into
 * one pending save of the NEWEST state, and everyone waiting is answered with
 * the record that actually reached the file. Two saves can never land out of
 * order, so a slow first write cannot overwrite a faster second one.
 */
export function saveEpisodeEdits(episodeId: string, edits: EpisodeEdits, options: SaveOptions = {}): Promise<EpisodeEdits> {
  return new Promise<EpisodeEdits>((resolve, reject) => {
    const previous = pendingSaves.get(episodeId);
    // A pending snapshot must still be taken even if a plain save overtakes it.
    const merged: SaveOptions = previous?.options.snapshot && !options.snapshot ? { ...previous.options, ...options, snapshot: true } : options;
    pendingSaves.set(episodeId, {
      edits,
      options: merged,
      waiting: [...(previous?.waiting ?? []), { resolve, reject }],
    });
    patchSaveState(episodeId, { queued: savingNow.has(episodeId) });
    void drainSaves(episodeId);
  });
}

/** Wait for everything queued for this episode to finish (used on the way out and in tests). */
export async function flushSaves(episodeId: string): Promise<void> {
  while (savingNow.has(episodeId) || pendingSaves.has(episodeId)) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ------------------------------------------------------------------ save points

/** Read one numbered save point. null = there is no such file; a failed read throws. */
export async function loadVersion(episodeId: string, n: number): Promise<EpisodeEdits | null> {
  const read = await readJsonStrict<unknown>(versionPath(episodeId, n));
  if (read.ok) return normalizeEdits(read.value);
  if (read.missing) return null;
  throw new Error(read.error || "That save point could not be opened.");
}

/**
 * Go back to a save point: the old work becomes the current work on the next
 * revision, listed as a save point of its own. The historical files are never
 * rewritten — going back is itself a step forward.
 */
export async function restoreEpisodeVersion(episodeId: string, current: EpisodeEdits, n: number): Promise<EpisodeEdits> {
  const snapshot = await loadVersion(episodeId, n);
  if (!snapshot) throw new Error("That save point is no longer on file.");
  const restored = restoreVersion(current, snapshot, { n });
  const entry = restored.versions[restored.versions.length - 1];
  await writer(`${projectRoot(episodeId)}/${entry.file}`, restored);
  return saveEpisodeEdits(episodeId, restored, { bump: false });
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

// ------------------------------------------------------------ edit proposals

/** The next free proposal name ("p01", "p02", …). */
export async function nextProposalId(episodeId: string): Promise<string> {
  const entries = await listDir(proposalsRoot(episodeId));
  let max = 0;
  for (const entry of entries) {
    const n = Number(/^p(\d+)\.json$/.exec(entry.name ?? "")?.[1] ?? 0);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `p${String(max + 1).padStart(2, "0")}`;
}

/** Every proposal on file for this episode, newest first. */
export async function listProposals(episodeId: string): Promise<EditProposal[]> {
  const entries = await listDir(proposalsRoot(episodeId));
  const names = entries.map((e) => e.name ?? "").filter((name) => /^p\d+\.json$/.test(name));
  const list = await Promise.all(names.map((name) => readJsonOr<unknown>(`${proposalsRoot(episodeId)}/${name}`, null)));
  return list
    .map((raw) => normalizeProposal(raw))
    .filter((p): p is EditProposal => p != null)
    .sort((a, b) => b.created - a.created || b.id.localeCompare(a.id));
}

export async function loadProposal(episodeId: string, id: string): Promise<EditProposal | null> {
  return normalizeProposal(await readJsonOr<unknown>(proposalPath(episodeId, id), null));
}

/** Keep a proposal's state (what was taken, what was turned down) next to the edits, never inside them. */
export async function saveProposal(episodeId: string, proposal: EditProposal): Promise<EditProposal> {
  await writer(proposalPath(episodeId, proposal.id), proposal);
  return proposal;
}

export async function deleteProposal(episodeId: string, id: string): Promise<void> {
  await deleteFile(proposalPath(episodeId, id));
}

/** What the proposal is worked out against; anything left out is read from the project. */
export interface ProposalContext {
  sentences?: { text: string; start_ms: number; end_ms: number }[];
  words?: StudioTimeline["words"];
  edits?: EpisodeEdits;
  durationMs?: number;
}

/**
 * Ask the writing assistant for an edit proposal and turn the answer into a
 * list of suggested cuts on file. The producer's edit record is NOT touched:
 * a proposal is a separate document until they take something from it.
 */
export async function runProposal(
  episodeId: string,
  goal: string,
  mode: SuggestionMode,
  ctx: ProposalContext = {},
  onProgress?: ProgressHandler
): Promise<EditProposal> {
  let sentences = ctx.sentences;
  let words = ctx.words;
  let edits = ctx.edits;
  let durationMs = ctx.durationMs;
  if (!sentences) sentences = toSentences(await readJsonOr<unknown>(transcriptPath(episodeId), null));
  if (!words || !edits || !durationMs) {
    const data = await loadStudio(episodeId);
    if (data.files.edits.failed || data.files.timeline.failed) {
      throw new Error("The episode could not be read just now. Check the connection and try again.");
    }
    words = words ?? data.timeline?.words ?? [];
    edits = edits ?? data.edits ?? data.blank;
    durationMs = durationMs ?? data.durationMs;
  }
  if (!sentences.length) throw new Error("This episode has no transcript to work from yet.");

  const question = new Question();
  buildProposalQuestion(question as unknown as Parameters<typeof buildProposalQuestion>[0], {
    goal,
    sentences,
    mode,
    durationMs: durationMs || edits.source_duration_ms,
  });
  const client = await getClient();
  const { token } = await client.use({ pipeline: PIPES["studio-proposal"] as PipelineConfig, useExisting: true });
  const result = await client.chat({
    token,
    question,
    onSSE: async (type, data) => {
      if (type === "podcast" && onProgress) onProgress(data as unknown as StatusEvent);
    },
  });
  const raw = firstJsonAnswer(result);
  if (!raw) throw new Error("The assistant did not come back with a proposal.");
  if (typeof raw.error === "string" && raw.error) throw new Error(raw.error);
  const id = await nextProposalId(episodeId);
  const proposal = validateProposal(raw, {
    sentences,
    words,
    edits,
    durationMs,
    id,
    prompt: goal,
    mode,
  });
  await saveProposal(episodeId, proposal);
  return proposal;
}
