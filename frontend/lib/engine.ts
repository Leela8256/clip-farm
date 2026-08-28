/**
 * Browser-side RocketRide integration for the podcast clip studio.
 *
 * There is no backend of ours in the path: the page talks to the engine over
 * the SDK's WebSocket. Recordings go into the account file store, the three
 * pipelines (episode analysis, clip preview, clip export) are started with
 * their JSON definitions, one chat question runs a job with live progress on
 * the 'podcast' SSE channel, and every result is read back from the store.
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
import {
  pickManifest,
  projectRoot,
  toCandidates,
  toChapters,
  toReport,
  type AnalysisManifest,
  type PipeKind,
  type RenderReport,
  type StatusEvent,
} from "./podcast";

export const ENGINE_URI = process.env.NEXT_PUBLIC_ROCKETRIDE_URI ?? "http://127.0.0.1:5567";
export const ENGINE_APIKEY = process.env.NEXT_PUBLIC_ROCKETRIDE_APIKEY ?? "MYAPIKEY";

const UPLOAD_CHUNK = 4 * 1024 * 1024;
const RECONNECT_WAIT_MS = 8000;
const KEEPALIVE_MS = 20_000;

type UseOptions = NonNullable<Parameters<RocketRideClient["use"]>[0]>;
type PipelineConfig = NonNullable<UseOptions["pipeline"]>;

const PIPES: Record<PipeKind, unknown> = { analysis: analysisPipe, preview: previewPipe, export: exportPipe };

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

async function runQuestion(kind: PipeKind, context: string[], text: string, onProgress?: ProgressHandler): Promise<unknown> {
  const token = await pipelineToken(kind);
  const question = new Question();
  question.addContext(context.join("\n"));
  question.addQuestion(text || "go");
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
  captions?: boolean;
  layouts?: string;
}

/** Render one clip as a fast preview or a final export. Explicit times override saved edits. */
export async function runClip(kind: "preview" | "export", episodeId: string, req: ClipRequest, onProgress?: ProgressHandler): Promise<RenderReport> {
  const context = [`project: ${projectRoot(episodeId)}`, `clip: ${req.clipId}`];
  if (req.start_ms != null) context.push(`start: ${Math.round(req.start_ms)}`);
  if (req.end_ms != null) context.push(`end: ${Math.round(req.end_ms)}`);
  if (req.title) context.push(`title: ${req.title.replace(/\n/g, " ")}`);
  if (req.captions === false) context.push("captions: off");
  if (req.layouts) context.push(`layouts: ${req.layouts}`);
  const result = await runQuestion(kind, context, `${kind} ${req.clipId}`, onProgress);
  return toReport(pickManifest(result) ?? {});
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
