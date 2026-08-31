"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Clapperboard, ExternalLink, Loader2, RefreshCw, TriangleAlert, Users } from "lucide-react";
import {
  analyzeClipAudio,
  createRequest,
  getConnectionState,
  getRun,
  listDir,
  mediaUrl,
  type AudioProof,
  type ParsedPrompt,
  readJsonOr,
  runAnalysis,
  runClip,
  runDirector,
  runIndex,
  runKey,
  runParse,
  runRevise,
  runVisualScan,
  type RunState,
  startRun,
  subscribeConnection,
  subscribeRun,
  writeJson,
} from "@/lib/engine";
import {
  captionPresetOf,
  customCandidate,
  effectiveRange,
  fmtTime,
  prettyTitle,
  previewFile,
  projectRoot,
  toCandidates,
  toChapters,
  toReport,
  toSentences,
  type Candidate,
  type ClipEdit,
  type ClipEdits,
  type Project,
  type RenderReport,
  type Sentence,
  type StatusEvent,
} from "@/lib/podcast";
import { applyRevision, normalizeSpec, resolveEdit, type ClipPlan, type Compliance, type DirectorRequest, type RequestSpec } from "@/lib/director";
import { rememberEpisode } from "@/lib/recent";
import { toast } from "@/components/shell/Toasts";
import StatusTimeline from "@/components/podcast/StatusTimeline";
import ChapterStrip from "@/components/podcast/ChapterStrip";
import CandidateCard from "@/components/podcast/CandidateCard";
import ClipWorkbench, { type ExportLink } from "@/components/podcast/ClipWorkbench";
import TranscriptPanel from "@/components/podcast/TranscriptPanel";
import PromptDirector from "@/components/podcast/PromptDirector";

const serverState = () => "idle" as const;
const serverRun = () => undefined;
const STALL_MS = 4 * 60_000;

/**
 * The background run as a useSyncExternalStore snapshot. The run object is
 * mutated in place by lib/engine, so a fresh shallow copy is handed out only
 * when something about it changed (same trick as the sidebar's recent list).
 */
let runSnap: { key: string; stamp: string; run: RunState | undefined } | null = null;
function runSnapshot(key: string): RunState | undefined {
  const run = getRun(key);
  const stamp = run ? `${run.events.length}|${run.done}|${run.error ?? ""}|${run.lost ?? false}|${run.started}` : "";
  if (!runSnap || runSnap.key !== key || runSnap.stamp !== stamp) runSnap = { key, stamp, run: run ? { ...run } : undefined };
  return runSnap.run;
}
const NUDGE_MS = 200;
const MIN_CLIP_MS = 1000;

type Reports = Record<string, { preview?: RenderReport; export?: RenderReport }>;
type Tab = "direct" | "moments" | "transcript";

const TABS: { key: Tab; label: string }[] = [
  { key: "direct", label: "Direct" },
  { key: "moments", label: "Moments" },
  { key: "transcript", label: "Transcript" },
];

const EXPORT_LABELS: [string, string][] = [
  ["vertical", "Vertical 9:16"],
  ["wide", "Wide 16:9"],
  ["srt", "Captions .srt"],
  ["vtt", "Captions .vtt"],
  ["thumbnail", "Thumbnail"],
  ["audio", "Audio"],
];

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Static-export friendly route: /episode?id=<episode>. useSearchParams needs a Suspense boundary. */
export default function EpisodePage() {
  return (
    <Suspense fallback={null}>
      <EpisodeWorkspace />
    </Suspense>
  );
}

function Pill({ children, title, tone = "muted" }: { children: ReactNode; title?: string; tone?: "muted" | "live" }) {
  return (
    <span
      title={title}
      className={`inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs ${tone === "live" ? "border-processing/30 bg-processing/10 text-processing" : "border-line bg-surface-raised text-ink-dim"}`}
    >
      {children}
    </span>
  );
}

function Rows({ list, children }: { list: Candidate[]; children: (cand: Candidate) => ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {list.map((cand, i) => (
        <div key={cand.id} className="rr-enter" style={{ animationDelay: `${Math.min(i, 10) * 30}ms` }}>
          {children(cand)}
        </div>
      ))}
    </div>
  );
}

function EpisodeWorkspace() {
  const id = useSearchParams().get("id") ?? "";
  const root = projectRoot(id);
  const connection = useSyncExternalStore(subscribeConnection, getConnectionState, serverState);

  const [project, setProject] = useState<Project | null>(null);
  const [missing, setMissing] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [customs, setCustoms] = useState<Candidate[]>([]);
  const [requests, setRequests] = useState<DirectorRequest[]>([]);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [chapters, setChapters] = useState<ReturnType<typeof toChapters>>([]);
  const [status, setStatus] = useState<StatusEvent | null>(null);
  const [edits, setEdits] = useState<ClipEdits>({ schema_version: 2, clips: {} });
  const [savedEdits, setSavedEdits] = useState<ClipEdits>({ schema_version: 2, clips: {} });
  const [reports, setReports] = useState<Reports>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sentences, setSentences] = useState<Sentence[] | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [exportLinks, setExportLinks] = useState<ExportLink[]>([]);
  const [plan, setPlan] = useState<ClipPlan | null>(null);
  const [planCompliance, setPlanCompliance] = useState<Compliance | null>(null);
  const [audioProof, setAudioProof] = useState<AudioProof | null | undefined>(undefined);
  const [busy, setBusy] = useState<Record<string, "preview" | "export" | null>>({});
  const [jobEvents, setJobEvents] = useState<Record<string, StatusEvent[]>>({});
  const [jobError, setJobError] = useState<Record<string, string | null>>({});
  const [stalled, setStalled] = useState(false);
  const lastChange = useRef(0);
  // director
  const [draft, setDraft] = useState<ParsedPrompt | null>(null);
  const [directorBusy, setDirectorBusy] = useState<"parsing" | "directing" | null>(null);
  const [directorEvents, setDirectorEvents] = useState<StatusEvent[]>([]);
  const [directorError, setDirectorError] = useState<string | null>(null);
  const [indexing, setIndexing] = useState(false);
  const indexAttempted = useRef(false);
  const [scanning, setScanning] = useState(false);
  const scanAttempted = useRef(false);
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [revising, setRevising] = useState(false);
  const [revisionNote, setRevisionNote] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<string | undefined>(undefined);
  // studio layout
  const [tabChoice, setTabChoice] = useState<Tab | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [seekTo, setSeekTo] = useState<number | undefined>(undefined);
  const asideRef = useRef<HTMLElement>(null);

  // live analysis run started from the home page (or here); runKey() is only called inside callbacks, never during render
  const subscribeToRun = useCallback((fn: () => void) => subscribeRun(runKey(id), fn), [id]);
  const readRun = useCallback(() => runSnapshot(runKey(id)), [id]);
  const run = useSyncExternalStore(subscribeToRun, readRun, serverRun);
  const analysing = project?.analysis?.status === "analyzing" || (run != null && !run.done);
  const analysed = project?.analysis?.status === "analyzed";
  const durationMs = project?.media?.duration_ms ?? 0;

  // ---- loading ---------------------------------------------------------------

  const loadRequests = useCallback(async (): Promise<DirectorRequest[]> => {
    const entries = await listDir(`${root}/analysis/requests`);
    const names = entries.map((e) => e.name).filter((n) => /^r\d+\.json$/.test(n)).sort();
    const loaded = await Promise.all(names.map((n) => readJsonOr<DirectorRequest | null>(`${root}/analysis/requests/${n}`, null)));
    const list = loaded.filter((r): r is DirectorRequest => !!r && typeof r.request_id === "string");
    for (const r of list) {
      r.spec = normalizeSpec(r.spec);
      r.candidates = toCandidates(r);
    }
    return list;
  }, [root]);

  const load = useCallback(async () => {
    const p = await readJsonOr<Project | null>(`${root}/project.json`, null);
    if (!p) {
      setMissing(true);
      return;
    }
    setMissing(false);
    setProject({ ...p, episode_id: p.episode_id || id });
    const [cands, chaps, st, ed, reqs] = await Promise.all([
      readJsonOr<unknown>(`${root}/analysis/candidates.json`, null),
      readJsonOr<unknown>(`${root}/analysis/chapters.json`, null),
      readJsonOr<StatusEvent | null>(`${root}/status.json`, null),
      readJsonOr<ClipEdits | null>(`${root}/edits/clip-edits.json`, null),
      loadRequests(),
    ]);
    const list = toCandidates(cands);
    setCandidates(list);
    setRequests(reqs);
    setChapters(toChapters(chaps));
    setStatus(st);
    const loadedEdits = ed && typeof ed === "object" ? { schema_version: 2, clips: ed.clips ?? {} } : { schema_version: 2, clips: {} };
    setEdits(loadedEdits);
    setSavedEdits(loadedEdits);
    // hand-made clips live only in the edits file
    const known = new Set([...list.map((c) => c.id), ...reqs.flatMap((r) => (r.candidates ?? []).map((c) => c.id))]);
    setCustoms(
      Object.entries(loadedEdits.clips)
        .filter(([key, e]) => key.startsWith("x") && e.start_ms != null && e.end_ms != null && !known.has(key))
        .map(([key, e]) => ({ ...customCandidate(e.start_ms!, e.end_ms!, e.title), id: key }))
    );
    // render reports for clips the library already has
    const clips = p.clips ?? {};
    const loaded: Reports = {};
    await Promise.all(
      Object.keys(clips).map(async (clipId) => {
        const [pv, ex] = await Promise.all([
          clips[clipId].preview ? readJsonOr<unknown>(`${root}/previews/${clipId}.json`, null) : null,
          clips[clipId].export ? readJsonOr<unknown>(`${root}/exports/${clipId}/report.json`, null) : null,
        ]);
        loaded[clipId] = { preview: pv ? toReport(pv) : undefined, export: ex ? toReport(ex) : undefined };
      })
    );
    setReports(loaded);
    setSelectedId((current) => current ?? list[0]?.id ?? reqs.flatMap((r) => r.candidates ?? [])[0]?.id ?? null);
  }, [id, root, loadRequests]);

  useEffect(() => {
    if (connection !== "connected") return;
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [connection, load]);

  // the sidebar's "Clip Studio" item opens the last episode looked at
  const loaded = project != null;
  const projectTitle = project?.title;
  useEffect(() => {
    if (!loaded || !id) return;
    const timer = setTimeout(() => rememberEpisode(id, prettyTitle(projectTitle || id)), 0);
    return () => clearTimeout(timer);
  }, [id, loaded, projectTitle]);

  const runDone = run?.done ?? false;
  useEffect(() => {
    if (!runDone) return;
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [runDone, load]);

  // No live run in this page (reload, or the socket dropped mid-run) but the project says
  // it's analysing → follow status.json. "Stalled" means the backend's own last status
  // timestamp is old, not that this page hasn't seen a change.
  useEffect(() => {
    if (connection !== "connected" || !analysing || (run && !run.done)) return;
    lastChange.current = Date.now();
    const timer = setInterval(async () => {
      const st = await readJsonOr<StatusEvent | null>(`${root}/status.json`, null);
      setStatus(st);
      const stamped = typeof st?.time === "number" ? st.time * 1000 : null;
      setStalled((stamped ?? lastChange.current) < Date.now() - STALL_MS);
      if (st?.node === "podcast_refine" && st.stage === "analyzed") void load();
      if (st?.stage === "error") void load();
    }, 3000);
    return () => clearInterval(timer);
  }, [connection, analysing, run, root, load]);

  // source video URL (instant previews play the raw recording by media fragment)
  useEffect(() => {
    if (!project?.source || connection !== "connected") return;
    let cancelled = false;
    mediaUrl(project.source).then((url) => !cancelled && setSourceUrl(url)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project?.source, connection]);

  // ---- transcript search (built once after the analysis, needed by the director) ----

  const buildIndex = useCallback(async () => {
    if (indexing) return;
    setIndexing(true);
    try {
      await runIndex(id, (evt) => setDirectorEvents((e) => [...e, evt]));
    } finally {
      setIndexing(false);
      const p = await readJsonOr<Project | null>(`${root}/project.json`, null);
      if (p) setProject({ ...p, episode_id: p.episode_id || id });
    }
  }, [id, root, indexing]);

  useEffect(() => {
    if (connection !== "connected" || !project || project.analysis?.status !== "analyzed") return;
    if (project.index?.status === "indexed" || indexAttempted.current) return;
    indexAttempted.current = true;
    const timer = setTimeout(() => void buildIndex(), 0);
    return () => clearTimeout(timer);
  }, [connection, project, buildIndex]);

  // ---- visual scan (people on screen + shot changes, once after the analysis) ----

  const scanVisual = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    try {
      await runVisualScan(id);
    } finally {
      setScanning(false);
      const p = await readJsonOr<Project | null>(`${root}/project.json`, null);
      if (p) setProject({ ...p, episode_id: p.episode_id || id });
    }
  }, [id, root, scanning]);

  useEffect(() => {
    if (connection !== "connected" || !project || project.analysis?.status !== "analyzed" || !project.media?.has_video) return;
    if (project.visual?.status === "scanned" || project.visual?.status === "failed" || scanAttempted.current) return;
    scanAttempted.current = true;
    const timer = setTimeout(() => void scanVisual(), 0);
    return () => clearTimeout(timer);
  }, [connection, project, scanVisual]);

  // ---- selection --------------------------------------------------------------

  const requestCandidates = useMemo(() => requests.flatMap((r) => r.candidates ?? []), [requests]);
  const all = useMemo(() => [...candidates, ...requestCandidates, ...customs], [candidates, requestCandidates, customs]);
  const directed = useMemo(
    () => (activeRequestId ? requestCandidates.filter((c) => c.request_id === activeRequestId) : requestCandidates),
    [requestCandidates, activeRequestId]
  );
  const selected = all.find((c) => c.id === selectedId) ?? null;
  const baseEdit: ClipEdit = selected ? edits.clips[selected.id] ?? {} : {};
  const edit = resolveEdit(baseEdit);
  const range = selected ? effectiveRange(selected, edit) : { start_ms: 0, end_ms: 0 };
  const dirty = selected ? JSON.stringify(edits.clips[selected.id] ?? {}) !== JSON.stringify(savedEdits.clips[selected.id] ?? {}) : false;
  const previewReport = selected ? reports[selected.id]?.preview ?? null : null;
  const exportReport = selected ? reports[selected.id]?.export ?? null : null;
  const selectedRequest = selected?.request_id ? requests.find((r) => r.request_id === selected.request_id) ?? null : null;
  const selectedSpec: RequestSpec | null = selectedRequest?.spec ?? null;
  const activeSpec: RequestSpec | null = (activeRequestId ? requests.find((r) => r.request_id === activeRequestId)?.spec : null) ?? null;

  // the tab: the producer's pick, else "Direct" once there are directed clips, else the auto moments
  const tab: Tab = tabChoice ?? (requests.length ? "direct" : "moments");
  const mapCandidates = tab === "direct" ? directed : tab === "moments" ? [...candidates, ...customs] : all;

  // The per-clip details reset and reload when the selection (or its preview) changes.
  // Deferred a tick so no state is set synchronously inside the effect body.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      setPreviewUrl(null);
      setPlan(null);
      setPlanCompliance(null);
      setAudioProof(undefined);
      setRevisionNote(null);
      if (!selected) return;
      Promise.all([
        readJsonOr<ClipPlan | null>(`${root}/analysis/clips/${selected.id}/plan.json`, null),
        readJsonOr<Compliance | null>(`${root}/analysis/clips/${selected.id}/compliance.json`, null),
      ]).then(async ([p, c]) => {
        // schema-1 plans live at analysis/clips/<id>.json (no cuts / fit, but words + transcript)
        const loaded = p ?? (await readJsonOr<ClipPlan | null>(`${root}/analysis/clips/${selected.id}.json`, null));
        if (cancelled) return;
        setPlan(loaded);
        setPlanCompliance(c ?? previewReport?.compliance ?? selected.compliance ?? null);
      });
      const file = previewFile(previewReport);
      if (!previewReport || !file) return;
      mediaUrl(file.path, previewReport.rendered_at).then((url) => !cancelled && setPreviewUrl(url)).catch(() => {});
      analyzeClipAudio(file.path, previewReport.rendered_at)
        .then((proof) => !cancelled && setAudioProof(proof))
        .catch(() => !cancelled && setAudioProof(null));
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selected, previewReport, root]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      setThumbUrls({});
      const thumbs = previewReport?.layout?.thumbnails ?? {};
      const entries = Object.entries(thumbs);
      if (!selected || !entries.length) return;
      Promise.all(entries.map(async ([pid, path]) => [pid, await mediaUrl(path, previewReport?.rendered_at ?? "")] as const))
        .then((pairs) => !cancelled && setThumbUrls(Object.fromEntries(pairs)))
        .catch(() => {});
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selected, previewReport]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      setExportLinks([]);
      if (!selected || !exportReport) return;
      Promise.all(
        EXPORT_LABELS.filter(([key]) => exportReport.files[key]).map(async ([key, label]) => ({
          label,
          url: await mediaUrl(exportReport.files[key], exportReport.rendered_at),
          name: exportReport.files[key].split("/").pop() ?? `${selected.id}_${key}`,
        }))
      )
        .then((links) => !cancelled && setExportLinks(links))
        .catch(() => {});
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selected, exportReport]);

  // ---- actions ----------------------------------------------------------------

  const patchEdit = (clipId: string, patch: ClipEdit) =>
    setEdits((prev) => ({ ...prev, clips: { ...prev.clips, [clipId]: { ...(prev.clips[clipId] ?? {}), ...patch } } }));

  const saveEdits = async (next: ClipEdits = edits) => {
    await writeJson(`${root}/edits/clip-edits.json`, next);
    setSavedEdits(next);
  };

  /** The explicit Save button: the other saves (render, versions, new cuts) stay quiet. */
  const saveNow = async () => {
    try {
      await saveEdits();
      toast("Edits saved", "ok");
    } catch (e) {
      toast(`Couldn't save the edits: ${errorText(e)}`, "warn");
    }
  };

  const resetEdit = (clipId: string) => {
    setEdits((prev) => {
      const clips = { ...prev.clips };
      const custom = customs.find((c) => c.id === clipId);
      const versions = prev.clips[clipId]?.versions;
      if (custom) clips[clipId] = { start_ms: custom.start_ms, end_ms: custom.end_ms, title: custom.title, ...(versions ? { versions } : {}) };
      else if (versions?.length) clips[clipId] = { versions, active_version: null };
      else delete clips[clipId];
      return { ...prev, clips };
    });
  };

  const ensureSentences = async (): Promise<Sentence[]> => {
    if (sentences) return sentences;
    const doc = await readJsonOr<unknown>(`${root}/analysis/transcript.json`, null);
    const list = toSentences(doc);
    setSentences(list);
    return list;
  };

  const render = async (kind: "preview" | "export", cand: Candidate) => {
    if (busy[cand.id]) return;
    const current = edits.clips[cand.id] ?? {};
    if (JSON.stringify(current) !== JSON.stringify(savedEdits.clips[cand.id] ?? {})) await saveEdits(edits);
    const effective = resolveEdit(current);
    const explicit = cand.custom || effective.start_ms != null || effective.end_ms != null;
    const r = effectiveRange(cand, effective);
    setBusy((b) => ({ ...b, [cand.id]: kind }));
    setJobEvents((j) => ({ ...j, [cand.id]: [] }));
    setJobError((j) => ({ ...j, [cand.id]: null }));
    try {
      const report = await runClip(
        kind,
        id,
        {
          clipId: cand.id,
          start_ms: explicit ? r.start_ms : undefined,
          end_ms: explicit ? r.end_ms : undefined,
          title: effective.title ?? (cand.custom ? cand.title : undefined),
          captions: captionPresetOf(effective, ""),
        },
        (evt) => setJobEvents((j) => ({ ...j, [cand.id]: [...(j[cand.id] ?? []), evt] }))
      );
      if (report.error) throw new Error(report.error);
      setReports((prev) => ({ ...prev, [cand.id]: { ...(prev[cand.id] ?? {}), [kind]: report } }));
      toast(kind === "preview" ? "Preview ready" : "Export ready", "ok");
      const p = await readJsonOr<Project | null>(`${root}/project.json`, null);
      if (p) setProject({ ...p, episode_id: p.episode_id || id });
    } catch (e) {
      const message = errorText(e);
      setJobError((j) => ({ ...j, [cand.id]: message }));
      toast(`${kind === "preview" ? "Preview" : "Export"} failed: ${message}`, "warn");
    } finally {
      setBusy((b) => ({ ...b, [cand.id]: null }));
    }
  };

  const makeClip = async (start_ms: number, end_ms: number) => {
    const cand = customCandidate(start_ms, end_ms);
    setCustoms((prev) => [...prev.filter((c) => c.id !== cand.id), cand]);
    const next: ClipEdits = { ...edits, clips: { ...edits.clips, [cand.id]: { start_ms, end_ms, title: cand.title } } };
    setEdits(next);
    try {
      await saveEdits(next);
      toast("Clip added", "ok");
    } catch (e) {
      toast(`Couldn't save the clip: ${errorText(e)}`, "warn");
    }
    setSelectedId(cand.id);
  };

  const rerun = async () => {
    if (!project) return;
    const goal = project.settings?.goal ?? "";
    const updated: Project = { ...project, analysis: { status: "analyzing", started_at: Date.now() / 1000 } };
    try {
      await writeJson(`${root}/project.json`, updated);
    } catch (e) {
      toast(`Couldn't start the analysis: ${errorText(e)}`, "warn");
      return;
    }
    setProject(updated);
    setStatus(null);
    lastChange.current = Date.now();
    setStalled(false);
    indexAttempted.current = false;
    startRun(runKey(id), "analysis", (onProgress) => runAnalysis(id, goal, onProgress));
  };

  const openTranscript = async () => {
    if (sentences) return;
    setTranscriptLoading(true);
    try {
      await ensureSentences();
    } finally {
      setTranscriptLoading(false);
    }
  };

  // ---- Prompt Director ----------------------------------------------------------

  const parsePrompt = async (prompt: string) => {
    setDirectorError(null);
    setDirectorBusy("parsing");
    try {
      setDraft(await runParse(prompt));
    } catch (e) {
      setDirectorError(errorText(e));
    } finally {
      setDirectorBusy(null);
    }
  };

  const editSpec = (patch: Partial<RequestSpec>) =>
    setDraft((d) => (d ? { ...d, spec: normalizeSpec({ ...specToRaw(d.spec), ...specToRaw({ ...d.spec, ...patch }) }) } : d));

  const runRequest = async () => {
    if (!draft) return;
    setDirectorError(null);
    setDirectorBusy("directing");
    setDirectorEvents([]);
    try {
      const request = await createRequest(id, draft);
      setRequests((prev) => [...prev, { ...request, candidates: [] }]);
      const useIndex = project?.index?.status === "indexed";
      const list = useIndex ? [] : await ensureSentences();
      const result = await runDirector(id, request, useIndex, list, (evt) => setDirectorEvents((e) => [...e, evt]));
      if (result.error) throw new Error(result.error);
      const reqs = await loadRequests();
      for (const r of reqs) if (r.request_id === request.request_id) r.mode = result.mode;
      setRequests(reqs);
      setActiveRequestId(request.request_id);
      setDraft(null);
      const first = reqs.find((r) => r.request_id === request.request_id)?.candidates?.[0];
      if (first) setSelectedId(first.id);
      const found = reqs.find((r) => r.request_id === request.request_id)?.candidates?.length ?? 0;
      toast(found ? `${found} directed clip${found === 1 ? "" : "s"} ready` : "Nothing met that request", found ? "ok" : "info");
      const p = await readJsonOr<Project | null>(`${root}/project.json`, null);
      if (p) setProject({ ...p, episode_id: p.episode_id || id });
    } catch (e) {
      setDirectorError(errorText(e));
      setRequests(await loadRequests());
    } finally {
      setDirectorBusy(null);
    }
  };

  /** Filtering by a request also brings its first clip into the workbench (unless the selection already belongs to it). */
  const selectRequest = (requestId: string | null) => {
    setActiveRequestId(requestId);
    if (!requestId) return;
    const inRequest = requests.find((r) => r.request_id === requestId)?.candidates ?? [];
    if (inRequest.length && !inRequest.some((c) => c.id === selectedId)) setSelectedId(inRequest[0].id);
  };

  const selectVersion = async (n: number | null) => {
    if (!selected) return;
    const next: ClipEdits = { ...edits, clips: { ...edits.clips, [selected.id]: { ...(edits.clips[selected.id] ?? {}), active_version: n } } };
    setEdits(next);
    await saveEdits(next);
  };

  const revise = async (instruction: string) => {
    if (!selected || !plan) return;
    setRevising(true);
    setRevisionNote(null);
    try {
      const list = await ensureSentences();
      const revision = await runRevise(id, selected.id, instruction, plan, list, all.filter((c) => !c.custom));
      const current = edits.clips[selected.id] ?? {};
      const version = applyRevision(revision, current, plan);
      if (version) {
        const next: ClipEdits = {
          ...edits,
          clips: { ...edits.clips, [selected.id]: { ...current, versions: [...(current.versions ?? []), version], active_version: version.n } },
        };
        setEdits(next);
        await saveEdits(next);
        setRevisionNote(`Version ${version.n}: ${version.note ?? revision.action}${revision.explanation ? ` — ${revision.explanation}` : ""}. Render a preview to see it.`);
      } else if (revision.action === "new_request" && revision.prompt) {
        setPrefill(revision.prompt);
        setTabChoice("direct");
        setRevisionNote(`That needs a new search — the request is waiting in the Direct tab: “${revision.prompt}”.`);
        void parsePrompt(revision.prompt);
      } else if (revision.action === "compilation") {
        setRevisionNote(`Compilations (${(revision.clips ?? []).join(" + ")}) aren't available yet. ${revision.explanation ?? ""}`);
      } else {
        setRevisionNote(revision.explanation ?? "Nothing changed.");
      }
      for (const w of revision.warnings ?? []) setRevisionNote((n) => `${n ?? ""} ${w}`);
    } catch (e) {
      setRevisionNote(`Revision failed: ${errorText(e)}`);
      toast(`Revision failed: ${errorText(e)}`, "warn");
    } finally {
      setRevising(false);
    }
  };

  // ---- studio interaction ---------------------------------------------------------

  const selectTab = (next: Tab) => {
    setTabChoice(next);
    if (next === "transcript") void openTranscript();
  };

  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.key === tab);
    const next =
      e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    selectTab(TABS[next].key);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  /** Selecting a clip also parks the playhead at its start. */
  const select = (clipId: string) => {
    setSelectedId(clipId);
    const cand = all.find((c) => c.id === clipId);
    if (cand) setCurrentMs(effectiveRange(cand, resolveEdit(edits.clips[cand.id] ?? {})).start_ms);
  };

  /**
   * The map (or a transcript line) asks for an episode time: move the playhead, and if the
   * time falls inside the selected clip, seek the player (which speaks clip-relative ms).
   */
  const seek = (ms: number) => {
    setCurrentMs(ms);
    if (selected && ms >= range.start_ms && ms <= range.end_ms) setSeekTo(ms - range.start_ms);
  };

  /** The player reports clip-relative ms; the map wants episode ms. */
  const followPlayer = (ms: number) => setCurrentMs(range.start_ms + ms);

  const nudge = (side: "start" | "end", delta: number) => {
    if (!selected) return;
    const limit = durationMs || Number.MAX_SAFE_INTEGER;
    if (side === "start") patchEdit(selected.id, { start_ms: Math.max(0, Math.min(range.end_ms - MIN_CLIP_MS, range.start_ms + delta)) });
    else patchEdit(selected.id, { end_ms: Math.min(limit, Math.max(range.start_ms + MIN_CLIP_MS, range.end_ms + delta)) });
  };

  // keyboard shortcuts read the latest state through a ref so the listener is attached once
  const keys = useRef({ selected, render, nudge, clear: () => setSelectedId(null) });
  useEffect(() => {
    keys.current = { selected, render, nudge, clear: () => setSelectedId(null) };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
      const k = keys.current;
      switch (e.key) {
        case "Escape":
          k.clear();
          return;
        case "r":
        case "R":
          if (!k.selected) return;
          e.preventDefault();
          void k.render("preview", k.selected);
          return;
        case "[":
          e.preventDefault();
          k.nudge("start", -NUDGE_MS);
          return;
        case "{":
          e.preventDefault();
          k.nudge("start", NUDGE_MS);
          return;
        case "]":
          e.preventDefault();
          k.nudge("end", NUDGE_MS);
          return;
        case "}":
          e.preventDefault();
          k.nudge("end", -NUDGE_MS);
          return;
        case " ": {
          if (tag === "BUTTON" || tag === "A" || tag === "VIDEO" || tag === "SUMMARY") return;
          const video = asideRef.current?.querySelector("video");
          if (!video) return;
          e.preventDefault();
          if (video.paused) void video.play().catch(() => {});
          else video.pause();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- render -----------------------------------------------------------------

  const liveEvents = run?.events ?? [];
  const latest = liveEvents[liveEvents.length - 1] ?? status;
  const liveRun = run != null && !run.done;
  const showStepper = analysing || !!run?.error || (latest?.stage === "error" && !analysed);
  const studioOpen = analysed || all.length > 0;
  const visual = project?.visual;

  const row = (cand: Candidate) => (
    <CandidateCard
      cand={cand}
      spec={cand.request_id ? requests.find((r) => r.request_id === cand.request_id)?.spec ?? activeSpec : null}
      selected={cand.id === selectedId}
      hasPreview={!!reports[cand.id]?.preview}
      hasExport={!!reports[cand.id]?.export}
      busy={busy[cand.id] ?? null}
      onSelect={() => select(cand.id)}
      onPreview={() => {
        select(cand.id);
        void render("preview", cand);
      }}
      onExport={() => {
        select(cand.id);
        void render("export", cand);
      }}
    />
  );

  if (missing) {
    return (
      <div className="rr-card rr-enter mx-auto mt-10 max-w-md px-6 py-12 text-center">
        <p className="rr-h3">We can&apos;t find that episode</p>
        <p className="mt-1 text-sm text-ink-faint">It may have been removed from your library.</p>
        <Link href="/history" className="rr-btn rr-btn-primary mt-5">
          Open History
        </Link>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="space-y-5" aria-busy="true" aria-label="Loading the episode">
        <div className="space-y-2">
          <div className="rr-skeleton h-3 w-20" />
          <div className="rr-skeleton h-8 w-80 max-w-full" />
          <div className="rr-skeleton h-6 w-96 max-w-full" />
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div className="space-y-4">
            <div className="rr-skeleton h-[88px]" />
            <div className="rr-skeleton h-7 w-64" />
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="rr-skeleton h-[68px]" />
            ))}
          </div>
          <div className="rr-skeleton h-[560px]" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* header */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="rr-eyebrow">Clip Studio</p>
          <h1 className="rr-h2 mt-1 truncate" title={project.title || project.source.split("/").pop() || id}>
            {prettyTitle(project.title || id)}
          </h1>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {durationMs > 0 && (
              <Pill title="Episode length">
                <span className="font-mono text-[11px] tabular-nums">{fmtTime(durationMs)}</span>
              </Pill>
            )}
            {project.media?.width ? <Pill title="Source resolution">{`${project.media.width}×${project.media.height}`}</Pill> : null}
            {scanning ? (
              <Pill tone="live" title="Finding who is on screen and where the shots change">
                <Loader2 className="h-3 w-3 animate-spin" /> Looking for people on screen
              </Pill>
            ) : visual?.status === "scanned" ? (
              <Pill title="People found on screen and shot changes in the recording">
                <Users className="h-3 w-3" />
                {`${visual.people ?? 0} ${visual.people === 1 ? "person" : "people"} on screen · ${visual.scenes ?? 0} shot${visual.scenes === 1 ? "" : "s"}`}
              </Pill>
            ) : null}
            {indexing && (
              <Pill tone="live" title="Transcript search makes directed requests faster and more precise">
                <Loader2 className="h-3 w-3 animate-spin" /> Preparing transcript search
              </Pill>
            )}
            {project.analysis?.analyzed_at ? (
              <Pill title={new Date(project.analysis.analyzed_at * 1000).toLocaleString()}>
                analysed {new Date(project.analysis.analyzed_at * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
              </Pill>
            ) : null}
          </div>
          {project.settings?.goal && (
            <p className="mt-2 max-w-2xl truncate text-sm text-ink-dim" title={project.settings.goal}>
              &ldquo;{project.settings.goal}&rdquo;
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {sourceUrl && (
            <a href={sourceUrl} target="_blank" rel="noreferrer" className="rr-btn rr-btn-ghost rr-btn-sm" title="Open the original recording">
              <ExternalLink className="h-3.5 w-3.5" /> Source
            </a>
          )}
          <button
            type="button"
            onClick={() => void rerun()}
            disabled={connection !== "connected" || liveRun}
            title="Finds the moments again with the current direction. The transcript is reused, so it takes a couple of minutes."
            className="rr-btn rr-btn-ghost rr-btn-sm"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${liveRun ? "animate-spin text-accent" : ""}`} />
            {liveRun ? "Analysing…" : analysing ? "Resume" : "Re-analyse"}
          </button>
        </div>
      </header>

      {showStepper && (
        <StatusTimeline
          events={liveEvents}
          latest={run?.error ? { node: "run", stage: "error", message: run.error } : latest}
          stalled={stalled}
          startedAt={run?.started ?? (project.analysis?.started_at ? project.analysis.started_at * 1000 : undefined)}
        />
      )}
      {(run?.lost || stalled) && analysing && (
        <div className="rr-enter flex flex-wrap items-center gap-3 rounded-md border border-processing/30 bg-processing/10 px-3.5 py-2 text-sm text-ink">
          <TriangleAlert className="h-4 w-4 shrink-0 text-processing" />
          <span className="min-w-0 flex-1">
            {run?.lost ? "The connection dropped mid-analysis, so it was probably cut short." : "No progress for a few minutes — the analysis was probably cut short."}
          </span>
          <button
            type="button"
            onClick={() => void rerun()}
            disabled={connection !== "connected" || liveRun}
            title="Continues from the last transcribed piece; what is already transcribed is kept."
            className="rr-btn rr-btn-primary rr-btn-sm"
          >
            <RefreshCw className="h-3.5 w-3.5 text-accent" /> Resume
          </button>
        </div>
      )}

      {studioOpen && (
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
          {/* left: map, tabs, lists */}
          <div className="min-w-0 space-y-4">
            {durationMs > 0 && (
              <ChapterStrip chapters={chapters} candidates={mapCandidates} durationMs={durationMs} selectedId={selectedId} onSelect={select} currentMs={currentMs} onSeek={seek} />
            )}

            <div role="tablist" aria-label="Studio sections" onKeyDown={onTabKey} className="flex flex-wrap items-center gap-1.5">
              {TABS.map((t) => {
                const active = t.key === tab;
                const count = t.key === "direct" ? requestCandidates.length : t.key === "moments" ? candidates.length + customs.length : 0;
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    id={`tab-${t.key}`}
                    aria-selected={active}
                    aria-controls={`panel-${t.key}`}
                    tabIndex={active ? 0 : -1}
                    data-active={active ? "true" : "false"}
                    onClick={() => selectTab(t.key)}
                    className="rr-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    {t.label}
                    {count > 0 && <span className={`font-mono text-[11px] tabular-nums ${active ? "text-ink-inverse/70" : "text-ink-faint"}`}>{count}</span>}
                  </button>
                );
              })}
            </div>

            <div key={tab} role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="rr-enter space-y-5">
              {tab === "direct" && (
                <>
                  <PromptDirector
                    key={prefill ?? "director"}
                    requests={requests}
                    activeRequestId={activeRequestId}
                    onSelectRequest={selectRequest}
                    index={project.index}
                    indexing={indexing}
                    onBuildIndex={() => void buildIndex()}
                    draft={draft}
                    onParse={(p) => void parsePrompt(p)}
                    onEditSpec={editSpec}
                    onRun={() => void runRequest()}
                    onDiscard={() => setDraft(null)}
                    busy={directorBusy}
                    events={directorEvents}
                    error={directorError}
                    canRun={connection === "connected" && !analysing}
                    prefill={prefill}
                  />
                  {directed.length > 0 && (
                    <section className="space-y-3">
                      <h3 className="rr-h3">
                        {directed.length} directed clip{directed.length === 1 ? "" : "s"}
                        {activeRequestId ? (
                          <span className="ml-2 text-sm font-normal text-ink-faint">· this request</span>
                        ) : requests.length > 1 ? (
                          <span className="ml-2 text-sm font-normal text-ink-faint">· {requests.length} requests</span>
                        ) : null}
                      </h3>
                      <Rows list={directed}>{row}</Rows>
                    </section>
                  )}
                  {activeRequestId && directed.length === 0 && directorBusy !== "directing" && (
                    <p className="rounded-md border border-dashed border-line-strong px-4 py-5 text-center text-sm text-ink-faint">Nothing met that request. Loosen it and run it again.</p>
                  )}
                </>
              )}

              {tab === "moments" && (
                <>
                  {candidates.length > 0 ? (
                    <section className="space-y-3">
                      <h3 className="rr-h3" title={project.analysis?.proposed ? `Picked from ${project.analysis.proposed} proposals` : undefined}>
                        {candidates.length} moment{candidates.length === 1 ? "" : "s"}
                        {requestCandidates.length > 0 && <span className="ml-2 text-sm font-normal text-ink-faint">· {requestCandidates.length} directed</span>}
                      </h3>
                      <Rows list={candidates}>{row}</Rows>
                    </section>
                  ) : analysing ? (
                    <div className="space-y-2" aria-busy="true">
                      {[0, 1, 2].map((i) => (
                        <div key={i} className="rr-skeleton h-[68px]" />
                      ))}
                    </div>
                  ) : (
                    <div className="rr-card flex flex-col items-center gap-3 px-6 py-10 text-center">
                      <p className="text-sm text-ink-dim">No moment met the length rules yet.</p>
                      <div className="flex flex-wrap justify-center gap-2">
                        <button type="button" onClick={() => selectTab("direct")} className="rr-btn rr-btn-primary rr-btn-sm">
                          Describe the clips you want
                        </button>
                        <button type="button" onClick={() => void rerun()} disabled={connection !== "connected" || liveRun} className="rr-btn rr-btn-sm">
                          Re-analyse
                        </button>
                      </div>
                    </div>
                  )}
                  {customs.length > 0 && (
                    <section className="space-y-3">
                      <h3 className="rr-h3">
                        {customs.length} of your own cut{customs.length === 1 ? "" : "s"}
                        <span className="ml-2 text-sm font-normal text-ink-faint">· from the transcript</span>
                      </h3>
                      <Rows list={customs}>{row}</Rows>
                    </section>
                  )}
                </>
              )}

              {tab === "transcript" && (
                <TranscriptPanel
                  sentences={sentences}
                  loading={transcriptLoading}
                  highlight={selected ? range : null}
                  onOpen={() => void openTranscript()}
                  onMakeClip={(s, e) => void makeClip(s, e)}
                  onSeek={seek}
                />
              )}
            </div>
          </div>

          {/* right: the selected clip */}
          <aside ref={asideRef} className="min-w-0 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:self-start lg:overflow-y-auto lg:px-1 lg:-mx-1 lg:pb-2">
            {selected ? (
              <ClipWorkbench
                cand={selected}
                spec={selectedSpec}
                edit={edit}
                baseEdit={baseEdit}
                range={range}
                dirty={dirty}
                durationMs={durationMs}
                sourceUrl={sourceUrl}
                previewUrl={previewUrl}
                previewReport={previewReport}
                exportReport={exportReport}
                exportLinks={exportLinks}
                plan={plan}
                compliance={planCompliance}
                thumbUrls={thumbUrls}
                audioProof={audioProof}
                busy={busy[selected.id] ?? null}
                events={jobEvents[selected.id] ?? []}
                error={jobError[selected.id] ?? null}
                revising={revising}
                revisionNote={revisionNote}
                onEdit={(patch) => patchEdit(selected.id, patch)}
                onSave={() => void saveNow()}
                onReset={() => resetEdit(selected.id)}
                onPreview={() => void render("preview", selected)}
                onExport={() => void render("export", selected)}
                onUseVersion={(n) => void selectVersion(n)}
                onRevise={(instruction) => void revise(instruction)}
                onTime={followPlayer}
                onSeek={followPlayer}
                currentMs={seekTo}
              />
            ) : (
              <div className="rr-card rr-enter flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-overlay text-ink-faint">
                  <Clapperboard className="h-5 w-5" />
                </span>
                <p className="text-sm font-medium text-ink">Pick a moment to preview it</p>
                <p className="text-xs text-ink-faint">Click a row, or a marker on the episode map.</p>
              </div>
            )}
            <p className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
              <span>
                <kbd className="rr-kbd">R</kbd> preview
              </span>
              <span>
                <kbd className="rr-kbd">[</kbd> <kbd className="rr-kbd">]</kbd> nudge 0.2 s
              </span>
              <span>
                <kbd className="rr-kbd">Space</kbd> play
              </span>
              <span>
                <kbd className="rr-kbd">Esc</kbd> clear
              </span>
            </p>
          </aside>
        </section>
      )}
    </div>
  );
}

/** The flat keys normalizeSpec reads, so an edited spec round-trips through the same validation. */
function specToRaw(spec: RequestSpec): Record<string, unknown> {
  return {
    count: spec.count,
    target_duration_seconds: spec.duration.target_seconds,
    min_duration_seconds: spec.duration.min_seconds,
    max_duration_seconds: spec.duration.max_seconds,
    duration_mode: spec.duration.mode,
    speakers: spec.speakers,
    subjects: spec.subjects,
    exclude_subjects: spec.exclude_subjects,
    exclude_content: spec.exclude_content,
    tone: spec.tone,
    hook: spec.hook,
    ending: spec.ending,
    filler_policy: spec.filler_policy,
    silence_policy: spec.silence_policy,
    caption_preset: spec.caption_preset,
    aspect_ratio: spec.aspect_ratio,
    platform: spec.platform,
    warnings: [],
  };
}
