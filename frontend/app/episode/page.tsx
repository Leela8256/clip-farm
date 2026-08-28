"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, ExternalLink, RefreshCw } from "lucide-react";
import {
  analyzeClipAudio,
  getConnectionState,
  getRun,
  mediaUrl,
  type AudioProof,
  readJsonOr,
  runAnalysis,
  runClip,
  runKey,
  startRun,
  subscribeConnection,
  subscribeRun,
  writeJson,
} from "@/lib/engine";
import {
  customCandidate,
  effectiveRange,
  fmtTime,
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
import EngineBadge from "@/components/podcast/EngineBadge";
import StatusTimeline from "@/components/podcast/StatusTimeline";
import ChapterStrip from "@/components/podcast/ChapterStrip";
import CandidateCard from "@/components/podcast/CandidateCard";
import ClipWorkbench, { type ExportLink } from "@/components/podcast/ClipWorkbench";
import TranscriptPanel from "@/components/podcast/TranscriptPanel";

const serverState = () => "idle" as const;
const STALL_MS = 4 * 60_000;

type Reports = Record<string, { preview?: RenderReport; export?: RenderReport }>;

const EXPORT_LABELS: [string, string][] = [
  ["vertical", "Vertical 9:16"],
  ["wide", "Wide 16:9"],
  ["srt", "Captions .srt"],
  ["vtt", "Captions .vtt"],
  ["thumbnail", "Thumbnail"],
  ["audio", "Audio"],
];

/** Static-export friendly route: /episode?id=<episode>. useSearchParams needs a Suspense boundary. */
export default function EpisodePage() {
  return (
    <Suspense fallback={null}>
      <EpisodeWorkspace />
    </Suspense>
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
  const [chapters, setChapters] = useState<ReturnType<typeof toChapters>>([]);
  const [status, setStatus] = useState<StatusEvent | null>(null);
  const [edits, setEdits] = useState<ClipEdits>({ schema_version: 1, clips: {} });
  const [savedEdits, setSavedEdits] = useState<ClipEdits>({ schema_version: 1, clips: {} });
  const [reports, setReports] = useState<Reports>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sentences, setSentences] = useState<Sentence[] | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [exportLinks, setExportLinks] = useState<ExportLink[]>([]);
  const [clipText, setClipText] = useState<string | null>(null);
  const [audioProof, setAudioProof] = useState<AudioProof | null | undefined>(undefined);
  const [busy, setBusy] = useState<Record<string, "preview" | "export" | null>>({});
  const [jobEvents, setJobEvents] = useState<Record<string, StatusEvent[]>>({});
  const [jobError, setJobError] = useState<Record<string, string | null>>({});
  const [runVersion, setRunVersion] = useState(0);
  const [stalled, setStalled] = useState(false);
  const lastChange = useRef(Date.now());

  const run = getRun(runKey(id));
  const analysing = project?.analysis?.status === "analyzing" || (run != null && !run.done);

  // ---- loading ---------------------------------------------------------------

  const load = useCallback(async () => {
    const p = await readJsonOr<Project | null>(`${root}/project.json`, null);
    if (!p) {
      setMissing(true);
      return;
    }
    setMissing(false);
    setProject({ ...p, episode_id: p.episode_id || id });
    const [cands, chaps, st, ed] = await Promise.all([
      readJsonOr<unknown>(`${root}/analysis/candidates.json`, null),
      readJsonOr<unknown>(`${root}/analysis/chapters.json`, null),
      readJsonOr<StatusEvent | null>(`${root}/status.json`, null),
      readJsonOr<ClipEdits | null>(`${root}/edits/clip-edits.json`, null),
    ]);
    const list = toCandidates(cands);
    setCandidates(list);
    setChapters(toChapters(chaps));
    setStatus(st);
    const loadedEdits = ed && typeof ed === "object" ? { schema_version: 1, clips: ed.clips ?? {} } : { schema_version: 1, clips: {} };
    setEdits(loadedEdits);
    setSavedEdits(loadedEdits);
    // hand-made clips live only in the edits file
    setCustoms(
      Object.entries(loadedEdits.clips)
        .filter(([key, e]) => key.startsWith("x") && e.start_ms != null && e.end_ms != null && !list.some((c) => c.id === key))
        .map(([key, e]) => ({ ...customCandidate(e.start_ms!, e.end_ms!, e.title), id: key }))
    );
    // render reports for clips the store already has
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
    setSelectedId((current) => current ?? list[0]?.id ?? null);
  }, [id, root]);

  useEffect(() => {
    if (connection !== "connected") return;
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [connection, load]);

  // live analysis run started from the library (or here)
  useEffect(() => subscribeRun(runKey(id), () => setRunVersion((v) => v + 1)), [id]);
  useEffect(() => {
    if (run?.done) void load();
  }, [run?.done, load]);

  // No live run in this page (reload, or the socket dropped mid-run) but the project says
  // it's analysing → follow status.json. "Stalled" means the engine's own last status
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

  // ---- selection --------------------------------------------------------------

  const all = useMemo(() => [...candidates, ...customs], [candidates, customs]);
  const selected = all.find((c) => c.id === selectedId) ?? null;
  const edit: ClipEdit = selected ? edits.clips[selected.id] ?? {} : {};
  const range = selected ? effectiveRange(selected, edit) : { start_ms: 0, end_ms: 0 };
  const dirty = selected ? JSON.stringify(edits.clips[selected.id] ?? {}) !== JSON.stringify(savedEdits.clips[selected.id] ?? {}) : false;
  const previewReport = selected ? reports[selected.id]?.preview ?? null : null;
  const exportReport = selected ? reports[selected.id]?.export ?? null : null;

  useEffect(() => {
    let cancelled = false;
    setPreviewUrl(null);
    setClipText(null);
    setAudioProof(undefined);
    if (!selected || !previewReport?.files.vertical) return;
    mediaUrl(previewReport.files.vertical, previewReport.rendered_at).then((url) => !cancelled && setPreviewUrl(url)).catch(() => {});
    analyzeClipAudio(previewReport.files.vertical, previewReport.rendered_at)
      .then((proof) => !cancelled && setAudioProof(proof))
      .catch(() => !cancelled && setAudioProof(null));
    readJsonOr<{ transcript?: string } | null>(`${root}/analysis/clips/${selected.id}.json`, null).then((spec) => {
      if (!cancelled && spec?.transcript) setClipText(spec.transcript);
    });
    return () => {
      cancelled = true;
    };
  }, [selected, previewReport, root]);

  useEffect(() => {
    let cancelled = false;
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
    return () => {
      cancelled = true;
    };
  }, [selected, exportReport]);

  // ---- actions ----------------------------------------------------------------

  const patchEdit = (clipId: string, patch: ClipEdit) =>
    setEdits((prev) => ({ ...prev, clips: { ...prev.clips, [clipId]: { ...(prev.clips[clipId] ?? {}), ...patch } } }));

  const saveEdits = async (next: ClipEdits = edits) => {
    await writeJson(`${root}/edits/clip-edits.json`, next);
    setSavedEdits(next);
  };

  const resetEdit = (clipId: string) => {
    setEdits((prev) => {
      const clips = { ...prev.clips };
      const custom = customs.find((c) => c.id === clipId);
      if (custom) clips[clipId] = { start_ms: custom.start_ms, end_ms: custom.end_ms, title: custom.title };
      else delete clips[clipId];
      return { ...prev, clips };
    });
  };

  const render = async (kind: "preview" | "export", cand: Candidate) => {
    if (busy[cand.id]) return;
    const current = edits.clips[cand.id] ?? {};
    let next = edits;
    if (JSON.stringify(current) !== JSON.stringify(savedEdits.clips[cand.id] ?? {})) {
      next = edits;
      await saveEdits(next);
    }
    const explicit = cand.custom || current.start_ms != null || current.end_ms != null;
    const r = effectiveRange(cand, current);
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
          title: current.title ?? (cand.custom ? cand.title : undefined),
          captions: current.captions,
        },
        (evt) => setJobEvents((j) => ({ ...j, [cand.id]: [...(j[cand.id] ?? []), evt] }))
      );
      if (report.error) throw new Error(report.error);
      setReports((prev) => ({ ...prev, [cand.id]: { ...(prev[cand.id] ?? {}), [kind]: report } }));
      const p = await readJsonOr<Project | null>(`${root}/project.json`, null);
      if (p) setProject({ ...p, episode_id: p.episode_id || id });
    } catch (e) {
      setJobError((j) => ({ ...j, [cand.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy((b) => ({ ...b, [cand.id]: null }));
    }
  };

  const makeClip = async (start_ms: number, end_ms: number) => {
    const cand = customCandidate(start_ms, end_ms);
    setCustoms((prev) => [...prev.filter((c) => c.id !== cand.id), cand]);
    const next: ClipEdits = { ...edits, clips: { ...edits.clips, [cand.id]: { start_ms, end_ms, title: cand.title } } };
    setEdits(next);
    await saveEdits(next);
    setSelectedId(cand.id);
  };

  const rerun = async () => {
    if (!project) return;
    const goal = project.settings?.goal ?? "";
    const updated: Project = { ...project, analysis: { status: "analyzing", started_at: Date.now() / 1000 } };
    await writeJson(`${root}/project.json`, updated);
    setProject(updated);
    setStatus(null);
    lastChange.current = Date.now();
    setStalled(false);
    startRun(runKey(id), "analysis", (onProgress) => runAnalysis(id, goal, onProgress));
    setRunVersion((v) => v + 1);
  };

  const openTranscript = async () => {
    if (sentences) return;
    setTranscriptLoading(true);
    try {
      const doc = await readJsonOr<unknown>(`${root}/analysis/transcript.json`, null);
      setSentences(toSentences(doc));
    } finally {
      setTranscriptLoading(false);
    }
  };

  // ---- render -----------------------------------------------------------------

  const durationMs = project?.media?.duration_ms ?? 0;
  const liveEvents = run?.events ?? [];
  const latest = liveEvents[liveEvents.length - 1] ?? status;
  void runVersion;

  if (missing) {
    return (
      <div className="space-y-4">
        <Link href="/" className="inline-flex items-center gap-1 font-mono text-xs text-ink-dim hover:text-accent">
          <ArrowLeft className="h-3 w-3" /> library
        </Link>
        <p className="rounded-lg border border-dashed border-line-strong px-5 py-8 text-center text-sm text-ink-faint">No project at {root}.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="inline-flex items-center gap-1 font-mono text-xs text-ink-dim hover:text-accent">
          <ArrowLeft className="h-3 w-3" /> library
        </Link>
        <EngineBadge />
      </div>

      <section className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="rr-eyebrow">Episode · {id}</p>
          <h1 className="rr-h1 mt-1 truncate">{project?.title || id}</h1>
          <p className="mt-1 font-mono text-[11px] text-ink-faint">
            {durationMs ? `${fmtTime(durationMs)} · ` : ""}
            {project?.media?.width ? `${project.media.width}×${project.media.height} · ` : ""}
            {project?.source.split("/").pop()}
            {project?.analysis?.analyzed_at ? ` · analysed ${new Date(project.analysis.analyzed_at * 1000).toLocaleString()}` : ""}
          </p>
          {project?.settings?.goal && <p className="mt-2 max-w-2xl text-sm text-ink-dim">&ldquo;{project.settings.goal}&rdquo;</p>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {sourceUrl && (
            <a href={sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-xs text-ink-dim hover:border-accent hover:text-accent">
              <ExternalLink className="h-3 w-3" /> source video
            </a>
          )}
          <button
            type="button"
            onClick={() => void rerun()}
            disabled={connection !== "connected" || (run != null && !run.done)}
            title="Re-scores the episode with the current direction; the transcript is reused, so this takes a couple of minutes"
            className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-xs text-ink hover:border-accent hover:text-accent disabled:opacity-40"
          >
            <RefreshCw className={`h-3 w-3 ${run != null && !run.done ? "animate-spin" : ""}`} />{" "}
            {run != null && !run.done ? "analysing…" : analysing ? "resume analysis" : "re-run analysis"}
          </button>
        </div>
      </section>

      {(analysing || latest?.stage === "error" || (run && run.error)) && (
        <StatusTimeline events={liveEvents} latest={run?.error ? { node: "run", stage: "error", message: run.error } : latest} stalled={stalled} />
      )}
      {(run?.lost || stalled) && analysing && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-processing/40 bg-processing/10 px-3 py-2">
          <p className="font-mono text-[11px] text-processing">
            {run?.lost
              ? "The live connection dropped while the engine was working. The engine stops a run when its client disconnects, so this analysis was probably cut short."
              : "No progress reported by the engine for several minutes — the run was probably cut short."}{" "}
            Resuming continues from the last transcribed piece; already transcribed audio is kept.
          </p>
          <button
            type="button"
            onClick={() => void rerun()}
            disabled={connection !== "connected" || (run != null && !run.done)}
            className="inline-flex items-center gap-1 rounded-md bg-ink px-3 py-1.5 text-xs font-semibold text-ink-inverse disabled:opacity-40"
          >
            <RefreshCw className="h-3 w-3 text-accent" /> Resume analysis
          </button>
        </div>
      )}

      {all.length > 0 && <ChapterStrip chapters={chapters} candidates={all} durationMs={durationMs} selectedId={selectedId} onSelect={setSelectedId} />}

      {!analysing && candidates.length === 0 && project?.analysis?.status === "analyzed" && (
        <p className="rounded-lg border border-dashed border-line-strong px-5 py-8 text-center text-sm text-ink-faint">
          The analysis finished but no candidate met the length rules. Try a broader direction or shorter minimum length and re-run.
        </p>
      )}

      {all.length > 0 && (
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="space-y-4">
            <div className="flex items-end justify-between">
              <div>
                <p className="rr-eyebrow">Candidates</p>
                <h2 className="rr-h2 mt-1">
                  {candidates.length} moments Claude would clip
                  {project?.analysis?.proposed ? <span className="text-ink-faint"> · from {project.analysis.proposed} proposals</span> : null}
                </h2>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {all.map((cand) => (
                <CandidateCard
                  key={cand.id}
                  cand={cand}
                  selected={cand.id === selectedId}
                  hasPreview={!!reports[cand.id]?.preview}
                  hasExport={!!reports[cand.id]?.export}
                  busy={busy[cand.id] ?? null}
                  onSelect={() => setSelectedId(cand.id)}
                  onPreview={() => {
                    setSelectedId(cand.id);
                    void render("preview", cand);
                  }}
                  onExport={() => {
                    setSelectedId(cand.id);
                    void render("export", cand);
                  }}
                />
              ))}
            </div>
          </div>
          <aside className="lg:sticky lg:top-20 lg:self-start">
            {selected ? (
              <ClipWorkbench
                cand={selected}
                edit={edit}
                range={range}
                dirty={dirty}
                durationMs={durationMs}
                sourceUrl={sourceUrl}
                previewUrl={previewUrl}
                previewReport={previewReport}
                exportReport={exportReport}
                exportLinks={exportLinks}
                clipText={clipText}
                audioProof={audioProof}
                busy={busy[selected.id] ?? null}
                events={jobEvents[selected.id] ?? []}
                error={jobError[selected.id] ?? null}
                onEdit={(patch) => patchEdit(selected.id, patch)}
                onSave={() => void saveEdits()}
                onReset={() => resetEdit(selected.id)}
                onPreview={() => void render("preview", selected)}
                onExport={() => void render("export", selected)}
              />
            ) : null}
          </aside>
        </section>
      )}

      {project?.analysis?.status === "analyzed" && (
        <TranscriptPanel
          sentences={sentences}
          loading={transcriptLoading}
          highlight={selected ? range : null}
          onOpen={() => void openTranscript()}
          onMakeClip={(s, e) => void makeClip(s, e)}
        />
      )}
    </div>
  );
}
