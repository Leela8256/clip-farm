/**
 * Browser-side RocketRide integration for the podcast clip studio.
 *
 * There is no backend of ours in the path: the page talks to the engine over
 * the SDK's WebSocket. Recordings go into the account file store, the
 * pipelines are started with their JSON definitions, one chat question runs a
 * job with live progress on the 'podcast' SSE channel, and every result is
 * read back from the store.
 *
 * Pipelines (mirrors of .rocketride/*.pipe):
 *   episode-analysis   upload → transcript → scored candidates + chapters
 *   transcript-index   transcript passages → embedding_transformer → qdrant
 *   transcript-search  question → embedding → qdrant → passages (stock only)
 *   director-chat      question → llm_anthropic (prompt parsing, revisions)
 *   prompt-director    question → embedding → qdrant → llm → podcast_refine
 *   prompt-director-full  the same without the index (transcript in context)
 *   clip-preview / clip-export
 *
 * Secrets never reach the browser: the pipeline JSON keeps its
 * `${ROCKETRIDE_ANTHROPIC_KEY}` placeholder and the engine substitutes it from
 * its own environment. The engine address and API key are build-time config.
 *
 * Connection handling: the SDK client runs in persist mode (it reconnects by
 * itself with backoff after a drop — laptop sleep, idle close, engine restart)
 * and reports every transition through onConnected / onDisconnected, which is
 * what the UI's connection state is derived from. Store calls wait for the
 * connection to come back and retry once; pipeline runs never retry (that
 * would run the job twice).
 */

import { RocketRideClient, Question } from "rocketride";
import analysisPipe from "./pipelines/episode-analysis.json";
import previewPipe from "./pipelines/clip-preview.json";
import exportPipe from "./pipelines/clip-export.json";
import chatPipe from "./pipelines/director-chat.json";
import directorPipe from "./pipelines/prompt-director.json";
import directorFullPipe from "./pipelines/prompt-director-full.json";
import indexPipe from "./pipelines/transcript-index.json";
import searchPipe from "./pipelines/transcript-search.json";
import visualPipe from "./pipelines/visual-scan.json";
import {
  firstJsonAnswer,
  pickManifest,
  projectRoot,
  toCandidates,
  toChapters,
  toReport,
  type AnalysisManifest,
  type Candidate,
  type PipeKind,
  type RenderReport,
  type Sentence,
  type StatusEvent,
} from "./podcast";
import {
  buildDirectQuestion,
  buildParseQuestion,
  buildReviseQuestion,
  durationWindow,
  nextRequestId,
  normalizeSpec,
  searchQueryOf,
  transcriptLines,
  type ClipPlan,
  type DirectorRequest,
  type RejectedCandidate,
  type RequestCompliance,
  type RequestSpec,
  type Revision,
} from "./director";

export const ENGINE_URI = process.env.NEXT_PUBLIC_ROCKETRIDE_URI ?? "http://127.0.0.1:5567";
export const ENGINE_APIKEY = process.env.NEXT_PUBLIC_ROCKETRIDE_APIKEY ?? "MYAPIKEY";

const UPLOAD_CHUNK = 4 * 1024 * 1024;
const RECONNECT_WAIT_MS = 8000;
const KEEPALIVE_MS = 20_000;

type UseOptions = NonNullable<Parameters<RocketRideClient["use"]>[0]>;
type PipelineConfig = NonNullable<UseOptions["pipeline"]>;

const PIPES: Record<PipeKind, unknown> = {
  analysis: analysisPipe,
  preview: previewPipe,
  export: exportPipe,
  chat: chatPipe,
  director: directorPipe,
  "director-full": directorFullPipe,
  index: indexPipe,
  search: searchPipe,
  visual: visualPipe,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------- connection

export type ConnectionState = "idle" | "connecting" | "connected" | "error";

export const CONNECTION_LOST_MESSAGE =
  "Lost the connection to the RocketRide engine. The page reconnects by itself — wait for the badge to turn green and try again.";

let client: RocketRideClient | null = null;
let pending: Promise<RocketRideClient> | null = null;
let state: ConnectionState = "idle";
let lastError: string | null = null;
let keepalive: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function setState(next: ConnectionState, error: string | null = null) {
  state = next;
  lastError = error;
  listeners.forEach((fn) => fn());
}

/**
 * A tiny request every 20 s while connected. Long jobs can go minutes without
 * any traffic in either direction (the transcriber only reports per piece), and
 * a socket with no traffic is what idle timeouts on the way to the engine cut.
 */
function startKeepalive() {
  if (keepalive) return;
  keepalive = setInterval(() => {
    if (client?.isConnected()) client.fsStat("projects").catch(() => {});
  }, KEEPALIVE_MS);
}

export const getConnectionState = () => state;
export const getConnectionError = () => lastError;
export function subscribeConnection(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isConnectionError(message: string): boolean {
  return /not connected|connection (closed|lost|refused)|closed unexpectedly|socket|ECONNREFUSED|disconnected|network/i.test(message);
}

async function waitForConnection(c: RocketRideClient, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (c.isConnected()) return true;
    await sleep(250);
  }
  return c.isConnected();
}

/**
 * The shared client, connecting on first use. If the socket is down, this waits
 * for the SDK's own reconnect for a few seconds, then falls back to a fresh
 * client. Concurrent callers share one connection attempt.
 */
export async function getClient(): Promise<RocketRideClient> {
  if (client) {
    if (client.isConnected()) return client;
    if (await waitForConnection(client, RECONNECT_WAIT_MS)) return client;
    const dead = client;
    client = null;
    dead.disconnect().catch(() => {});
  }
  if (pending) return pending;
  setState("connecting");
  pending = (async () => {
    const c = new RocketRideClient({
      uri: ENGINE_URI,
      auth: ENGINE_APIKEY,
      persist: true,
      onConnected: async () => setState("connected"),
      onDisconnected: async (reason?: string) => setState("connecting", reason ?? "connection lost"),
      onConnectError: async (err: Error) => setState("error", err.message),
    });
    try {
      await c.connect();
    } catch (e) {
      setState("error", e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      pending = null;
    }
    client = c;
    setState("connected");
    startKeepalive();
    return c;
  })();
  return pending;
}

/** Throw away the current client and connect again (manual retry button). */
export async function reconnect(): Promise<void> {
  const old = client;
  client = null;
  if (old) {
    try {
      await old.disconnect();
    } catch {}
  }
  try {
    await getClient();
  } catch {}
}

/**
 * Run a store call against a live connection. A call that fails because the
 * socket dropped is retried once after the connection comes back; pipeline
 * runs pass retries=0 so a job is never started twice.
 */
async function withClient<T>(fn: (c: RocketRideClient) => Promise<T>, retries = 1): Promise<T> {
  const c = await getClient();
  try {
    return await fn(c);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!isConnectionError(message)) throw e;
    if (!c.isConnected()) setState("connecting", message);
    if (retries > 0) {
      await sleep(500);
      return withClient(fn, retries - 1);
    }
    throw new Error(CONNECTION_LOST_MESSAGE);
  }
}

// ---------------------------------------------------------------------- store

export interface DirEntry {
  name: string;
  type: string;
  size?: number;
  modified?: number;
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  return withClient((c) => c.fsReadJson<T>(path));
}

export async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  try {
    const value = await readJson<T>(path);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

/** A read that says WHY it came back empty. */
export type StrictRead<T> = { ok: true; value: T } | { ok: false; missing: boolean; error: string };

/**
 * Read a file without pretending a broken connection is an empty account.
 * `readJsonOr` cannot tell the two apart, and a caller that starts a fresh
 * record on a transport error would write over real work. Here a failed read
 * is checked against the file listing: gone means gone, anything else is a
 * problem the screen must report and offer to retry.
 */
export async function readJsonStrict<T = unknown>(path: string): Promise<StrictRead<T>> {
  try {
    const value = await readJson<T>(path);
    if (value == null) return { ok: false, missing: true, error: "" };
    return { ok: true, value };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // A dropped socket can make everything look absent, so it is never "missing".
    if (isConnectionError(error) || error === CONNECTION_LOST_MESSAGE) return { ok: false, missing: false, error };
    const present = await exists(path);
    return { ok: false, missing: !present, error };
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await withClient((c) => c.fsWriteJson(path, value));
}

export async function exists(path: string): Promise<boolean> {
  try {
    const info = (await withClient((c) => c.fsStat(path))) as { exists?: boolean };
    return info?.exists === true;
  } catch {
    return false;
  }
}

export async function listDir(path: string): Promise<DirEntry[]> {
  try {
    const listing = (await withClient((c) => c.fsListDir(path))) as { entries?: DirEntry[] };
    return listing.entries ?? [];
  } catch {
    return [];
  }
}

export async function deleteFile(path: string): Promise<void> {
  await withClient((c) => c.fsDelete(path));
}

/** Stream a browser File into the account store in 4 MB chunks (restarted from scratch if the socket drops). */
export async function uploadFile(path: string, file: File, onProgress?: (sent: number, total: number) => void): Promise<string> {
  await withClient(async (c) => {
    const { handle } = await c.fsOpen(path, "w");
    for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK) {
      const chunk = new Uint8Array(await file.slice(offset, offset + UPLOAD_CHUNK).arrayBuffer());
      await c.fsWrite(handle, chunk);
      onProgress?.(Math.min(offset + UPLOAD_CHUNK, file.size), file.size);
    }
    await c.fsClose(handle, "w");
  });
  return path;
}

export async function readStoreFile(path: string): Promise<Uint8Array> {
  return withClient(async (c) => {
    const { handle, size } = (await c.fsOpen(path, "r")) as { handle: string; size?: number };
    const parts: Uint8Array[] = [];
    let offset = 0;
    while (true) {
      const chunk = await c.fsRead(handle, offset);
      if (!chunk || chunk.length === 0) break;
      parts.push(chunk);
      offset += chunk.length;
      if (typeof size === "number" && offset >= size) break;
    }
    await c.fsClose(handle, "r");
    const out = new Uint8Array(offset);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  });
}

/** Signed engine URL (needs RR_SIGNING_KEY on the engine); null if unavailable. */
export async function storeUrl(path: string, expiresIn = 6 * 3600): Promise<string | null> {
  try {
    const result = await withClient((c) => c.call("rrext_store", { subcommand: "fs_geturl", path, expires_in: expiresIn }));
    const url = (result as { url?: unknown })?.url;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}

const MIME: Record<string, string> = {
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  srt: "text/plain",
  vtt: "text/vtt",
  jpg: "image/jpeg",
  json: "application/json",
};

const urlCache = new Map<string, Promise<string>>();

/**
 * A URL the browser can play or download: the signed engine URL when signing is
 * enabled, else an in-memory blob. `version` (e.g. rendered_at) keys the cache so
 * a re-rendered file at the same path gets a fresh URL.
 */
export function mediaUrl(path: string, version: string | number = ""): Promise<string> {
  const key = `${path}@${version}`;
  let url = urlCache.get(key);
  if (!url) {
    url = (async () => {
      const signed = await storeUrl(path);
      if (signed) return signed;
      const bytes = await readStoreFile(path);
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      return URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[ext] ?? "application/octet-stream" }));
    })();
    urlCache.set(key, url);
    url.catch(() => urlCache.delete(key));
  }
  return url;
}

// ------------------------------------------------------------- audio proof

export interface AudioProof {
  peakDb: number;
  rmsDb: number;
  channels: number;
  seconds: number;
}

const proofCache = new Map<string, Promise<AudioProof | null>>();

/**
 * Decode a rendered clip's audio track in the browser (bytes come through the
 * SDK, so no CORS involved) and measure it. Shows the user that the file has
 * sound even when the tab or the system output is muted.
 */
export function analyzeClipAudio(path: string, version: string | number = ""): Promise<AudioProof | null> {
  const key = `${path}@${version}`;
  let pending = proofCache.get(key);
  if (!pending) {
    pending = (async () => {
      const Ctx = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as
        | typeof AudioContext
        | undefined;
      if (!Ctx) return null;
      const bytes = await readStoreFile(path);
      const ctx = new Ctx();
      try {
        const buffer = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        let peak = 0;
        let sum = 0;
        let count = 0;
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
          const data = buffer.getChannelData(ch);
          for (let i = 0; i < data.length; i += 4) {
            const v = Math.abs(data[i]);
            if (v > peak) peak = v;
            sum += v * v;
            count++;
          }
        }
        const db = (x: number) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -100);
        return { peakDb: db(peak), rmsDb: db(Math.sqrt(sum / Math.max(1, count))), channels: buffer.numberOfChannels, seconds: buffer.duration };
      } finally {
        void ctx.close();
      }
    })();
    proofCache.set(key, pending);
    pending.catch(() => proofCache.delete(key));
  }
  return pending;
}

// ------------------------------------------------------------------ pipelines

async function pipelineToken(kind: PipeKind): Promise<string> {
  const result = await withClient((c) => c.use({ pipeline: PIPES[kind] as PipelineConfig, useExisting: true }));
  return result.token;
}

export type ProgressHandler = (evt: StatusEvent) => void;

async function runPrepared(kind: PipeKind, question: Question, onProgress?: ProgressHandler): Promise<unknown> {
  const token = await pipelineToken(kind);
  return withClient(
    (c) =>
      c.chat({
        token,
        question,
        onSSE: async (type, data) => {
          if (type === "podcast" && onProgress) onProgress(data as unknown as StatusEvent);
        },
      }),
    0
  );
}

async function runQuestion(kind: PipeKind, context: string[], text: string, onProgress?: ProgressHandler): Promise<unknown> {
  const question = new Question();
  question.addContext(context.join("\n"));
  question.addQuestion(text || "go");
  return runPrepared(kind, question, onProgress);
}

/** A fresh SDK Question whose filter object exists (the builders write into it). */
function newQuestion(): Question {
  const q = new Question();
  if (!q.filter) (q as unknown as { filter: Record<string, unknown> }).filter = {};
  return q;
}

/** Episode analysis: transcript → scored candidates + chapters, persisted under the project. */
export async function runAnalysis(episodeId: string, goal: string, onProgress?: ProgressHandler): Promise<AnalysisManifest> {
  const result = await runQuestion("analysis", [`project: ${projectRoot(episodeId)}`], goal, onProgress);
  const m = pickManifest(result) ?? {};
  return {
    project: String(m.project ?? projectRoot(episodeId)),
    episode_id: String(m.episode_id ?? episodeId),
    candidates: toCandidates(m),
    chapters: toChapters(m),
    proposed: typeof m.proposed === "number" ? m.proposed : undefined,
    parts: typeof m.parts === "number" ? m.parts : undefined,
    seconds: typeof m.seconds === "number" ? m.seconds : undefined,
    error: typeof m.error === "string" ? m.error : undefined,
  };
}

export interface ClipRequest {
  clipId: string;
  start_ms?: number;
  end_ms?: number;
  title?: string;
  /** caption preset name, or "off" */
  captions?: string;
  layouts?: string;
  version?: number | null;
}

/** Render one clip as a fast preview or a final export. Explicit times override saved edits. */
export async function runClip(kind: "preview" | "export", episodeId: string, req: ClipRequest, onProgress?: ProgressHandler): Promise<RenderReport> {
  const context = [`project: ${projectRoot(episodeId)}`, `clip: ${req.clipId}`];
  if (req.start_ms != null) context.push(`start: ${Math.round(req.start_ms)}`);
  if (req.end_ms != null) context.push(`end: ${Math.round(req.end_ms)}`);
  if (req.title) context.push(`title: ${req.title.replace(/\n/g, " ")}`);
  if (req.captions) context.push(`captions: ${req.captions}`);
  if (req.layouts) context.push(`layouts: ${req.layouts}`);
  if (req.version != null) context.push(`version: ${req.version}`);
  const result = await runQuestion(kind, context, `${kind} ${req.clipId}`, onProgress);
  return toReport(pickManifest(result) ?? {});
}

// ------------------------------------------------------------ Prompt Director

export interface ParsedPrompt {
  prompt: string;
  raw: Record<string, unknown>;
  spec: RequestSpec;
  searchQuery: string;
}

/** Step 1 — the stock LLM turns the producer's sentence into a spec (director-chat pipe). */
export async function runParse(prompt: string, onProgress?: ProgressHandler): Promise<ParsedPrompt> {
  const q = buildParseQuestion(newQuestion(), prompt);
  const result = await runPrepared("chat", q, onProgress);
  const raw = firstJsonAnswer(result) ?? {};
  if (typeof raw.error === "string") throw new Error(raw.error);
  const spec = normalizeSpec(raw);
  return { prompt, raw, spec, searchQuery: searchQueryOf(raw, spec, prompt) };
}

/** Persist a parsed prompt as analysis/requests/<rNN>.json (the node fills it in when the run completes). */
export async function createRequest(episodeId: string, parsed: ParsedPrompt): Promise<DirectorRequest> {
  const root = projectRoot(episodeId);
  const entries = await listDir(`${root}/analysis/requests`);
  const request: DirectorRequest = {
    schema_version: 1,
    request_id: nextRequestId(entries.map((e) => e.name)),
    prompt: parsed.prompt,
    raw: parsed.raw,
    spec: parsed.spec,
    search_query: parsed.searchQuery,
    status: "parsed",
    created: Date.now() / 1000,
  };
  await writeJson(`${root}/analysis/requests/${request.request_id}.json`, request);
  return request;
}

export interface DirectorResult {
  request_id: string;
  candidates: Candidate[];
  rejected: RejectedCandidate[];
  compliance: RequestCompliance | null;
  notes: string[];
  summary?: string;
  proposed?: number;
  seconds?: number;
  mode: "index" | "full";
  error?: string;
}

/**
 * Step 2 — find and validate the clips. With a transcript index the question
 * flows through embedding_transformer → qdrant (scoped to this episode) → llm
 * → podcast_refine; without one the transcript rides in the question context.
 */
export async function runDirector(
  episodeId: string,
  request: DirectorRequest,
  useIndex: boolean,
  sentences: Sentence[],
  onProgress?: ProgressHandler
): Promise<DirectorResult> {
  const root = projectRoot(episodeId);
  const spec = normalizeSpec(request.spec);
  const q = buildDirectQuestion(newQuestion(), {
    prompt: request.prompt,
    spec,
    window: durationWindow(spec),
    projectRoot: root,
    requestId: request.request_id,
    episodeId,
    searchQuery: request.search_query,
    transcriptLines: useIndex ? null : transcriptLines(sentences),
  });
  const result = await runPrepared(useIndex ? "director" : "director-full", q, onProgress);
  const m = pickManifest(result) ?? {};
  return {
    request_id: String(m.request_id ?? request.request_id),
    candidates: toCandidates(m),
    rejected: Array.isArray(m.rejected) ? (m.rejected as RejectedCandidate[]) : [],
    compliance: m.compliance && typeof m.compliance === "object" ? (m.compliance as RequestCompliance) : null,
    notes: Array.isArray(m.notes) ? m.notes.map(String) : [],
    summary: typeof m.summary === "string" ? m.summary : undefined,
    proposed: typeof m.proposed === "number" ? m.proposed : undefined,
    seconds: typeof m.seconds === "number" ? m.seconds : undefined,
    mode: useIndex ? "index" : "full",
    error: typeof m.error === "string" ? m.error : undefined,
  };
}

export interface SearchHit {
  score: number;
  text: string;
  start_ms: number;
  end_ms: number;
  passage: number;
}

/** Semantic search over the episode's transcript passages (transcript-search pipe: stock nodes only). */
export async function runSearch(episodeId: string, query: string, limit = 6): Promise<SearchHit[]> {
  const q = newQuestion();
  q.filter.objectIds = [episodeId];
  q.filter.limit = limit;
  q.addQuestion(query);
  const result = (await runPrepared("search", q)) as { documents?: unknown[] };
  const docs = Array.isArray(result?.documents) ? result.documents : [];
  return docs.map((raw) => {
    const d = (raw ?? {}) as Record<string, unknown>;
    const md = (d.metadata ?? {}) as Record<string, unknown>;
    return {
      score: typeof d.score === "number" ? d.score : 0,
      text: String(d.page_content ?? ""),
      start_ms: typeof md.start_ms === "number" ? md.start_ms : 0,
      end_ms: typeof md.end_ms === "number" ? md.end_ms : 0,
      passage: typeof md.chunkId === "number" ? md.chunkId : 0,
    };
  });
}

export interface IndexResult {
  ok: boolean;
  passages?: number;
  error?: string;
}

/**
 * Build (or rebuild) the episode's transcript index: transcript-index pipe
 * (podcast_segment passages → embedding_transformer → qdrant), then a search
 * probe proves the store answers. The verdict is recorded in project.json.
 */
export async function runIndex(episodeId: string, onProgress?: ProgressHandler): Promise<IndexResult> {
  const root = projectRoot(episodeId);
  let verdict: IndexResult;
  try {
    await runQuestion("index", [`project: ${root}`], "index", onProgress);
    const hits = await runSearch(episodeId, "the main topic of this episode", 1);
    const index = await readJsonOr<{ passages?: number } | null>(`${root}/analysis/index.json`, null);
    verdict = hits.length ? { ok: true, passages: index?.passages } : { ok: false, error: "the index answered with no passages" };
  } catch (e) {
    verdict = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const project = await readJsonOr<Record<string, unknown> | null>(`${root}/project.json`, null);
  if (project) {
    project.index = verdict.ok
      ? { status: "indexed", passages: verdict.passages, indexed_at: Date.now() / 1000 }
      : { status: "failed", error: verdict.error, indexed_at: Date.now() / 1000 };
    await writeJson(`${root}/project.json`, project);
  }
  return verdict;
}

export interface VisualScanResult {
  ok: boolean;
  people?: number;
  scenes?: number;
  error?: string;
}

/**
 * The episode's visual scan (visual-scan pipe: podcast_ingest streams the video →
 * frame_grabber → pose_estimation → podcast_visual): people on screen with
 * thumbnails and shot changes, recorded in project.json by the node.
 */
export async function runVisualScan(episodeId: string, onProgress?: ProgressHandler): Promise<VisualScanResult> {
  const root = projectRoot(episodeId);
  try {
    const result = await runQuestion("visual", [`project: ${root}`], "scan", onProgress);
    const m = pickManifest(result) ?? {};
    if (typeof m.error === "string") throw new Error(m.error);
    return { ok: true, people: Array.isArray(m.people) ? m.people.length : undefined, scenes: typeof m.scenes === "number" ? m.scenes : undefined };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const project = await readJsonOr<Record<string, unknown> | null>(`${root}/project.json`, null);
    if (project) {
      project.visual = { status: "failed", error, scanned_at: Date.now() / 1000 };
      await writeJson(`${root}/project.json`, project);
    }
    return { ok: false, error };
  }
}

/** Conversational revision of one prepared clip (director-chat pipe); the caller applies the change as a new version. */
export async function runRevise(
  episodeId: string,
  clipId: string,
  instruction: string,
  plan: ClipPlan,
  sentences: Sentence[],
  candidates: Candidate[]
): Promise<Revision> {
  const q = buildReviseQuestion(newQuestion(), { instruction, projectRoot: projectRoot(episodeId), clipId, plan, sentences, candidates });
  const result = await runPrepared("chat", q);
  const raw = firstJsonAnswer(result);
  if (!raw) throw new Error("The model did not return a revision.");
  if (typeof raw.error === "string") throw new Error(raw.error);
  return raw as unknown as Revision;
}

// --------------------------------------------------------- background runs

export interface RunState {
  kind: PipeKind;
  events: StatusEvent[];
  done: boolean;
  /** The pipeline reported a failure. */
  error?: string;
  /** The socket dropped while the job was running; the engine may still finish it (watch status.json). */
  lost?: boolean;
  result?: unknown;
  started: number;
}

const runs = new Map<string, RunState>();
const runListeners = new Map<string, Set<() => void>>();

function notify(key: string) {
  runListeners.get(key)?.forEach((fn) => fn());
}

export const runKey = (episodeId: string, clipId?: string, kind?: PipeKind) => (clipId ? `${episodeId}/${clipId}/${kind}` : episodeId);
export const getRun = (key: string): RunState | undefined => runs.get(key);
export function subscribeRun(key: string, fn: () => void): () => void {
  let set = runListeners.get(key);
  if (!set) {
    set = new Set();
    runListeners.set(key, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
  };
}

/**
 * Start a job that outlives the page that started it (navigating from the
 * library to the workspace keeps the socket and the progress). Returns the
 * run key; subscribe to it for events.
 */
export function startRun<T>(key: string, kind: PipeKind, job: (onProgress: ProgressHandler) => Promise<T>): string {
  if (runs.get(key)?.done === false) return key;
  const run: RunState = { kind, events: [], done: false, started: Date.now() };
  runs.set(key, run);
  notify(key);
  job((evt) => {
    run.events = [...run.events, evt];
    notify(key);
  })
    .then((result) => {
      run.result = result;
      const err = (result as { error?: string } | null)?.error;
      if (err) run.error = err;
    })
    .catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      if (isConnectionError(message) || message === CONNECTION_LOST_MESSAGE) run.lost = true;
      else run.error = message;
    })
    .finally(() => {
      run.done = true;
      notify(key);
    });
  return key;
}
