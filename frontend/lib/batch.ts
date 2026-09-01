/**
 * One request, many recordings.
 *
 * The producer writes a single sentence, ticks a few recordings and gets the
 * same kind of clips out of each of them. The sentence is understood ONCE
 * (that is one call to the writing assistant, not one per recording); after
 * that every recording gets its own request file and its own director run, two
 * at a time, and keeps its own clips. Nothing is shared between recordings but
 * the words the producer typed.
 *
 * The run is written down as it happens — `library/batches/<id>.json` after
 * every state change — so closing the tab does not lose it: reopening a batch
 * reconciles what actually happened by reading each recording's request file,
 * and carries on with whatever never started.
 *
 * The look chosen in the batch (brand template, captions, framing) is not a
 * decoration either: it is written into each recording's clip edits as the
 * clips arrive, so the clips are already styled when the producer opens them.
 */

import {
  listDirStrict,
  readJsonStrict,
  runSearch,
  saveJsonQueued,
  createRequest as engineCreateRequest,
  runDirector as engineRunDirector,
  runParse as engineRunParse,
  type DirectorResult,
  type ParsedPrompt,
  type SearchHit,
  type StrictList,
  type StrictRead,
} from "./engine";
import { normalizeSpec, type DirectorRequest, type RequestSpec } from "./director";
import { projectRoot, toSentences, type ClipEdit, type ClipEdits, type Project, type Sentence, type StatusEvent } from "./podcast";
import {
  galleryIdOf,
  legacyPresetOf,
  loadTemplate,
  resolveBrand,
  resolveCaptionStyle,
  type BrandTemplate,
  type CaptionStyle,
} from "./brand";

// ------------------------------------------------------------------- shapes

export const BATCHES_ROOT = "library/batches";
export const batchPath = (id: string) => `${BATCHES_ROOT}/${id}.json`;
export const BATCH_SCHEMA_VERSION = 1;
/** Two recordings at a time: enough to keep the engine busy, few enough to stay responsive. */
export const BATCH_CONCURRENCY = 2;

export type BatchStatus = "queued" | "running" | "done" | "failed";

export interface BatchProject {
  id: string;
  status: BatchStatus;
  request_id?: string;
  /** clips the director delivered */
  delivered?: number;
  error?: string;
}

export interface BatchOptions {
  count?: number;
  duration_s?: number;
  /** brand template id */
  template?: string;
  caption_style?: CaptionStyle | string;
  layout_mode?: string;
}

export interface Batch {
  schema_version: number;
  id: string;
  prompt: string;
  /** the understood request, shared by every recording in the run */
  spec: RequestSpec | null;
  options: BatchOptions;
  created: number;
  updated: number;
  concurrency: number;
  projects: BatchProject[];
  /** the run itself could not start (the sentence was not understood) */
  error?: string;
}

export interface BatchRequest {
  prompt: string;
  projects: string[];
  options?: BatchOptions;
}

export type BatchListener = (batch: Batch) => void;

// ---------------------------------------------------------------- store seam

export interface BatchIo {
  list: (path: string) => Promise<StrictList>;
  read: <T>(path: string) => Promise<StrictRead<T>>;
  save: (key: string, path: string, value: unknown) => Promise<void>;
  parse: (prompt: string, onProgress?: (evt: StatusEvent) => void) => Promise<ParsedPrompt>;
  createRequest: (episodeId: string, parsed: ParsedPrompt) => Promise<DirectorRequest>;
  runDirector: (
    episodeId: string,
    request: DirectorRequest,
    useIndex: boolean,
    sentences: Sentence[],
    onProgress?: (evt: StatusEvent) => void
  ) => Promise<DirectorResult>;
  loadTemplate: (id: string) => Promise<BrandTemplate | null>;
  search: (ids: string[], query: string, limit: number) => Promise<SearchHit[]>;
}

const REAL_IO: BatchIo = {
  list: listDirStrict,
  read: readJsonStrict,
  save: saveJsonQueued,
  parse: engineRunParse,
  createRequest: engineCreateRequest,
  runDirector: engineRunDirector,
  loadTemplate,
  search: (ids, query, limit) => runSearch(ids, query, limit),
};

let io: BatchIo = { ...REAL_IO };

/** Test seam: swap the store and the jobs a batch runs (null puts the real ones back). */
export function setBatchIo(patch: Partial<BatchIo> | null): void {
  io = patch ? { ...REAL_IO, ...patch } : { ...REAL_IO };
}

// ------------------------------------------------------------- normalisation

const num = (value: unknown, fallback: number): number => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
};

const STATUSES: BatchStatus[] = ["queued", "running", "done", "failed"];

/** A batch file as it can be trusted; anything unrecognisable comes back null. */
export function normalizeBatch(raw: unknown, fallbackId = ""): Batch | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = (typeof r.id === "string" ? r.id : fallbackId).trim();
  if (!id) return null;
  const now = Date.now() / 1000;
  const created = num(r.created, now);
  const rawOptions = (r.options ?? {}) as Record<string, unknown>;
  const options: BatchOptions = {};
  if (rawOptions.count != null) options.count = Math.max(1, Math.round(num(rawOptions.count, 3)));
  if (rawOptions.duration_s != null) options.duration_s = Math.max(1, Math.round(num(rawOptions.duration_s, 45)));
  if (typeof rawOptions.template === "string" && rawOptions.template) options.template = rawOptions.template;
  if (typeof rawOptions.layout_mode === "string" && rawOptions.layout_mode) options.layout_mode = rawOptions.layout_mode;
  if (rawOptions.caption_style && (typeof rawOptions.caption_style === "string" || typeof rawOptions.caption_style === "object")) {
    options.caption_style = rawOptions.caption_style as CaptionStyle | string;
  }
  const projects = (Array.isArray(r.projects) ? r.projects : [])
    .map((entry) => {
      const p = (entry ?? {}) as Record<string, unknown>;
      const pid = typeof p.id === "string" ? p.id : "";
      if (!pid) return null;
      const status = STATUSES.includes(p.status as BatchStatus) ? (p.status as BatchStatus) : "queued";
      const out: BatchProject = { id: pid, status };
      if (typeof p.request_id === "string" && p.request_id) out.request_id = p.request_id;
      if (p.delivered != null) out.delivered = Math.max(0, Math.round(num(p.delivered, 0)));
      if (typeof p.error === "string" && p.error) out.error = p.error;
      return out;
    })
    .filter((p): p is BatchProject => !!p);
  const batch: Batch = {
    schema_version: Math.max(1, Math.round(num(r.schema_version, BATCH_SCHEMA_VERSION))),
    id,
    prompt: typeof r.prompt === "string" ? r.prompt : "",
    spec: r.spec && typeof r.spec === "object" ? normalizeSpec(r.spec) : null,
    options,
    created,
    updated: num(r.updated, created),
    concurrency: Math.max(1, Math.round(num(r.concurrency, BATCH_CONCURRENCY))),
    projects,
  };
  if (typeof r.error === "string" && r.error) batch.error = r.error;
  return batch;
}

export interface BatchProgress {
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  /** clips delivered so far, across every recording */
  delivered: number;
  finished: boolean;
  /** 0…1 */
  fraction: number;
}

/** Where a run has got to, for a progress bar and a sentence under it. */
export function batchProgress(batch: Batch | null | undefined): BatchProgress {
  const projects = batch?.projects ?? [];
  const count = (status: BatchStatus) => projects.filter((p) => p.status === status).length;
  const done = count("done");
  const failed = count("failed");
  const total = projects.length;
  return {
    total,
    queued: count("queued"),
    running: count("running"),
    done,
    failed,
    delivered: projects.reduce((n, p) => n + (p.delivered ?? 0), 0),
    finished: total > 0 && done + failed === total,
    fraction: total ? (done + failed) / total : 0,
  };
}

// -------------------------------------------------------------- live batches

const live = new Map<string, Batch>();
const listeners = new Map<string, Set<BatchListener>>();

export const getBatch = (id: string): Batch | undefined => live.get(id);

export function subscribeBatch(id: string, fn: BatchListener): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
  };
}

/** Forget the in-memory copies (leaving the screen, and between tests). */
export function resetBatches(): void {
  live.clear();
}

/**
 * Every state change is written down before anything else happens, so a batch
 * that is interrupted can always be picked up again. The queued writer makes
 * the rapid ones collapse into one newest write per batch.
 */
async function persist(batch: Batch, notify?: BatchListener): Promise<Batch> {
  batch.updated = Date.now() / 1000;
  live.set(batch.id, batch);
  const snapshot = { ...batch, projects: batch.projects.map((p) => ({ ...p })) };
  listeners.get(batch.id)?.forEach((fn) => fn(snapshot));
  notify?.(snapshot);
  await io.save(`batch:${batch.id}`, batchPath(batch.id), batch);
  return batch;
}

export function batchIdFor(now: number = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `b${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ------------------------------------------------------------------ the work

/** The producer's own choices win over whatever the assistant read into the sentence. */
function tuneSpec(spec: RequestSpec, options: BatchOptions): RequestSpec {
  const caption = options.caption_style ? legacyPresetOf(galleryIdOf(resolveCaptionStyle(options.caption_style))) : spec.caption_preset;
  return normalizeSpec({
    ...spec,
    count: options.count ?? spec.count,
    duration: { ...spec.duration, target_seconds: options.duration_s ?? spec.duration.target_seconds },
    caption_preset: caption,
  });
}

async function readProject(episodeId: string): Promise<Project | null> {
  const read = await io.read<Project>(`${projectRoot(episodeId)}/project.json`);
  return read.ok ? read.value : null;
}

async function readSentences(episodeId: string): Promise<Sentence[]> {
  const read = await io.read<unknown>(`${projectRoot(episodeId)}/analysis/transcript.json`);
  return read.ok ? toSentences(read.value) : [];
}

/**
 * Write the batch's look into the recording's own clip edits, for the clips
 * that just arrived. Anything the producer already set on a clip by hand is
 * left alone — a group run never overwrites individual work.
 */
async function styleDeliveredClips(episodeId: string, clipIds: string[], options: BatchOptions, template: BrandTemplate | null): Promise<void> {
  if (!clipIds.length) return;
  const style = options.caption_style ? resolveCaptionStyle(options.caption_style) : template?.captions ? resolveCaptionStyle(template.captions) : null;
  const brand = template ? resolveBrand(template) : null;
  const layoutMode = options.layout_mode || template?.layout?.mode || "";
  const aspect = template?.layout?.aspect || "";
  if (!style && !brand && !layoutMode && !aspect) return;
  const path = `${projectRoot(episodeId)}/edits/clip-edits.json`;
  const read = await io.read<ClipEdits>(path);
  // A read that FAILED is not an empty record: leave the file alone rather than write over real work.
  if (!read.ok && !read.missing) return;
  const current: ClipEdits = read.ok && read.value && typeof read.value === "object" ? read.value : { schema_version: 2, clips: {} };
  const clips: Record<string, ClipEdit> = { ...(current.clips ?? {}) };
  for (const clipId of clipIds) {
    const own = clips[clipId] ?? {};
    const next: ClipEdit = { ...own };
    if (style && own.caption_style === undefined && own.caption_preset === undefined) {
      next.caption_style = style;
      const legacy = legacyPresetOf(galleryIdOf(style));
      next.caption_preset = legacy;
      next.captions = legacy;
    }
    if (brand && own.brand === undefined) next.brand = brand;
    if (layoutMode && own.layout_mode === undefined) next.layout_mode = layoutMode;
    if (aspect && own.aspect === undefined) next.aspect = aspect;
    clips[clipId] = next;
  }
  await io.save(`clip-edits:${episodeId}`, path, { ...current, schema_version: Math.max(2, current.schema_version ?? 2), clips });
}

/** One recording: its own request file, its own director run, its own clips. */
async function runOne(batch: Batch, entry: BatchProject, parsed: ParsedPrompt, template: BrandTemplate | null, notify?: BatchListener): Promise<void> {
  entry.status = "running";
  delete entry.error;
  await persist(batch, notify);
  try {
    const request = await io.createRequest(entry.id, parsed);
    entry.request_id = request.request_id;
    await persist(batch, notify);
    const project = await readProject(entry.id);
    const useIndex = project?.index?.status === "indexed";
    const sentences = useIndex ? [] : await readSentences(entry.id);
    const result = await io.runDirector(entry.id, request, useIndex, sentences);
    if (result.error) throw new Error(result.error);
    entry.delivered = result.compliance?.delivered ?? result.candidates.length;
    entry.status = "done";
    await styleDeliveredClips(entry.id, result.candidates.map((c) => c.id), batch.options, template);
  } catch (e) {
    entry.status = "failed";
    entry.error = e instanceof Error ? e.message : String(e);
  }
  await persist(batch, notify);
}

/** Work through the queued recordings, `concurrency` at a time. */
async function drain(batch: Batch, parsed: ParsedPrompt, template: BrandTemplate | null, notify?: BatchListener): Promise<void> {
  const queue = batch.projects.filter((p) => p.status === "queued");
  let next = 0;
  const worker = async () => {
    for (;;) {
      const entry = queue[next++];
      if (!entry) return;
      await runOne(batch, entry, parsed, template, notify);
    }
  };
  const workers = Math.max(1, Math.min(batch.concurrency || BATCH_CONCURRENCY, queue.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

/**
 * Start a group run: understand the sentence once, then give every chosen
 * recording its own request and its own clips, two recordings at a time.
 */
export async function startBatch(request: BatchRequest, onProgress?: BatchListener): Promise<Batch> {
  const ids = [...new Set(request.projects.filter(Boolean))];
  if (!ids.length) throw new Error("Choose at least one recording.");
  const prompt = request.prompt.trim();
  if (!prompt) throw new Error("Say what the clips should be about.");
  const now = Date.now();
  const batch: Batch = {
    schema_version: BATCH_SCHEMA_VERSION,
    id: batchIdFor(now),
    prompt,
    spec: null,
    options: request.options ?? {},
    created: now / 1000,
    updated: now / 1000,
    concurrency: BATCH_CONCURRENCY,
    projects: ids.map((id) => ({ id, status: "queued" as BatchStatus })),
  };
  await persist(batch, onProgress);

  let parsed: ParsedPrompt;
  try {
    parsed = await io.parse(prompt);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    batch.error = error;
    batch.projects.forEach((p) => {
      p.status = "failed";
      p.error = error;
    });
    await persist(batch, onProgress);
    throw e;
  }
  const spec = tuneSpec(parsed.spec, batch.options);
  batch.spec = spec;
  await persist(batch, onProgress);

  const template = batch.options.template ? await io.loadTemplate(batch.options.template).catch(() => null) : null;
  await drain(batch, { ...parsed, spec }, template, onProgress);
  return batch;
}

// ------------------------------------------------------------------ reopening

/** One batch off the shelf. null = there is no such run; a read that FAILED throws. */
export async function loadBatch(id: string): Promise<Batch | null> {
  const read = await io.read<unknown>(batchPath(id));
  if (read.ok) return normalizeBatch(read.value, id);
  if (read.missing) return null;
  throw new Error(read.error || "That group run could not be opened.");
}

/** Every group run, newest first. */
export async function listBatches(limit = 20): Promise<Batch[]> {
  const listing = await io.list(BATCHES_ROOT);
  if (!listing.ok) return [];
  const names = listing.entries.map((e) => e.name ?? "").filter((name) => name.endsWith(".json"));
  const reads = await Promise.all(names.map(async (name) => ({ name, read: await io.read<unknown>(`${BATCHES_ROOT}/${name}`) })));
  return reads
    .map(({ name, read }) => (read.ok ? normalizeBatch(read.value, name.replace(/\.json$/, "")) : null))
    .filter((b): b is Batch => !!b)
    .sort((a, b) => b.created - a.created || b.id.localeCompare(a.id))
    .slice(0, limit);
}

/**
 * What actually happened to one recording in a run, read from its own request
 * file — the batch file is a record of intent, the request file is the truth.
 */
async function reconcileOne(entry: BatchProject): Promise<void> {
  if (!entry.request_id) {
    if (entry.status === "running") entry.status = "queued";
    return;
  }
  const read = await io.read<DirectorRequest>(`${projectRoot(entry.id)}/analysis/requests/${entry.request_id}.json`);
  if (!read.ok) {
    // The file may simply not be readable right now; a running job goes back in the queue.
    if (entry.status === "running") entry.status = "queued";
    return;
  }
  const request = read.value ?? ({} as DirectorRequest);
  const delivered = request.compliance?.delivered ?? (Array.isArray(request.candidates) ? request.candidates.length : 0);
  if (request.status === "error" || request.error) {
    entry.status = "failed";
    entry.error = request.error || "That recording did not finish.";
    return;
  }
  if (request.status === "done" || request.answered_at || delivered > 0) {
    entry.status = "done";
    entry.delivered = delivered;
    delete entry.error;
    return;
  }
  if (entry.status === "running") entry.status = "queued";
}

export interface ResumeOptions {
  /** carry on with whatever never finished (default true) */
  run?: boolean;
  onProgress?: BatchListener;
}

/**
 * Reopen a group run. Everything it claims is checked against the recordings'
 * own request files first — a run interrupted by a closed tab often finished
 * on the engine — and only what genuinely never happened is started again.
 */
export async function resumeBatch(id: string, options: ResumeOptions = {}): Promise<Batch> {
  const batch = await loadBatch(id);
  if (!batch) throw new Error("That group run is no longer on file.");
  for (const entry of batch.projects) await reconcileOne(entry);
  await persist(batch, options.onProgress);
  const remaining = batch.projects.filter((p) => p.status === "queued");
  if (options.run === false || !remaining.length || !batch.spec) return batch;
  const parsed: ParsedPrompt = { prompt: batch.prompt, raw: {}, spec: batch.spec, searchQuery: batch.prompt.slice(0, 200) };
  const template = batch.options.template ? await io.loadTemplate(batch.options.template).catch(() => null) : null;
  await drain(batch, parsed, template, options.onProgress);
  return batch;
}

// --------------------------------------------------------- search everywhere

export interface CrossProjectHit extends SearchHit {
  /** the recording the passage came from */
  episode_id: string;
  title?: string;
}

/**
 * Transcript search across several recordings at once. The index is scoped by
 * the recordings' ids (`filter.objectIds`), and every hit says which recording
 * it came from so the answers can be grouped.
 */
export async function searchAcrossProjects(
  episodeIds: string[],
  query: string,
  options: { limit?: number; titles?: Map<string, string> } = {}
): Promise<CrossProjectHit[]> {
  const ids = [...new Set(episodeIds.filter(Boolean))];
  const text = query.trim();
  if (!ids.length || !text) return [];
  const hits = await io.search(ids, text, options.limit ?? Math.min(30, ids.length * 6));
  return hits
    .map((hit) => ({ ...hit, title: options.titles?.get(hit.episode_id) }))
    .sort((a, b) => b.score - a.score);
}
