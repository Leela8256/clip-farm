"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Check, Loader2, Redo2, Sparkles, Undo2, Wand2 } from "lucide-react";
import { getConnectionState, mediaUrl, readJsonOr, subscribeConnection } from "@/lib/engine";
import { prettyTitle, projectRoot, toSentences, type Project, type Sentence, type StatusEvent } from "@/lib/podcast";
import { rememberEpisode } from "@/lib/recent";
import { toast } from "@/components/shell/Toasts";
import {
  addOperation,
  applyAll,
  applySuggestion,
  assignSpeaker,
  canRedo,
  canUndo,
  emptyEdits,
  fmtDuration,
  initHistory,
  mergedCuts,
  outputDurationMs,
  pushHistory,
  redo,
  rejectSuggestion,
  renameSpeaker,
  setSuggestionMode,
  splitSection,
  suggestionState,
  suggestionsForMode,
  timelineMapLite,
  toggleOperation,
  undo,
  type EditOperation,
  type EpisodeEdits,
  type History,
  type StudioReport,
  type StudioTimeline,
  type StudioWaveform,
  type Suggestion,
  type SuggestionMode,
} from "@/lib/studio";
import { loadStudio, runStudioExport, runStudioInit, runStudioPreview, saveEpisodeEdits, startStudioRun, studioRunKey, uploadAsset } from "@/lib/studio-engine";
import StudioCanvas from "@/components/studio/StudioCanvas";
import TimelineBar from "@/components/studio/TimelineBar";
import TranscriptEditor, { type Range } from "@/components/studio/TranscriptEditor";
import Inspector, { type DownloadLink, type JobKind } from "@/components/studio/Inspector";
import SuggestionsPanel from "@/components/studio/SuggestionsPanel";
import { INIT_STEPS, buildTranscript, initStep, markWords, rowAt, studioProgress, useJob } from "@/components/studio/helpers";

const serverState = () => "idle" as const;
const RANGE_PAD_MS = 20_000;
const AUTOSAVE_MS = 2000;
const SAVE_TOAST_MS = 60_000;

const FILE_LABELS: Record<string, string> = {
  video: "Video",
  episode: "Video",
  mp4: "Video",
  mp3: "Audio (mp3)",
  wav: "Audio (wav)",
  audio: "Audio",
  srt: "Captions .srt",
  vtt: "Captions .vtt",
  chapters: "Chapters",
  chapters_txt: "Chapters",
  chapters_json: "Chapters",
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Static-export friendly route: /studio?id=<episode>. useSearchParams needs a Suspense boundary. */
export default function StudioPage() {
  return (
    <Suspense fallback={null}>
      <StudioWorkspace />
    </Suspense>
  );
}

function StudioWorkspace() {
  const id = useSearchParams().get("id") ?? "";
  const root = projectRoot(id);
  const connection = useSyncExternalStore(subscribeConnection, getConnectionState, serverState);

  const [project, setProject] = useState<Project | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [timeline, setTimeline] = useState<StudioTimeline | null>(null);
  const [waveform, setWaveform] = useState<StudioWaveform | null>(null);
  const [allSuggestions, setAllSuggestions] = useState<Suggestion[]>([]);
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [history, setHistory] = useState<History | null>(null);
  const [savedJson, setSavedJson] = useState("");
  const [saving, setSaving] = useState(false);
  const lastSaveToast = useRef(0);
  const editsRef = useRef<EpisodeEdits | null>(null);

  const [currentMs, setCurrentMs] = useState(0);
  const [seekRequest, setSeekRequest] = useState<{ ms: number; at: number } | null>(null);
  const [selection, setSelection] = useState<Range | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  const [busy, setBusy] = useState<JobKind | null>(null);
  const [progress, setProgress] = useState("");
  const [reports, setReports] = useState<Partial<Record<JobKind, StudioReport>>>({});
  const [links, setLinks] = useState<DownloadLink[]>([]);
  const [preview, setPreview] = useState<{ url: string; stamp: string; label: string } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const edits = history?.present ?? null;
  const prepareKey = useMemo(() => studioRunKey(id, "studio-prepare"), [id]);
  const prepareJob = useJob(prepareKey);
  const preparing = !!prepareJob && !prepareJob.done;

  useEffect(() => {
    editsRef.current = edits;
  });

  /* ---- loading ------------------------------------------------------------- */

  const load = useCallback(async () => {
    const p = await readJsonOr<Project | null>(`${root}/project.json`, null);
    if (!p) {
      setMissing(true);
      setLoading(false);
      return;
    }
    setMissing(false);
    setProject({ ...p, episode_id: p.episode_id || id });
    const [data, doc] = await Promise.all([loadStudio(id), readJsonOr<unknown>(`${root}/analysis/transcript.json`, null)]);
    setTimeline(data.timeline);
    setWaveform(data.waveform);
    setAllSuggestions(data.suggestions);
    setSentences(toSentences(doc));
    const loaded = data.edits ?? emptyEdits(p.media?.duration_ms ?? 0);
    editsRef.current = loaded;
    setHistory(initHistory(loaded));
    setSavedJson(JSON.stringify(loaded));
    setLoading(false);
  }, [id, root]);

  useEffect(() => {
    if (connection !== "connected" || !id) return;
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [connection, id, load]);

  const projectTitle = project?.title;
  const haveProject = project != null;
  useEffect(() => {
    if (!haveProject || !id) return;
    const timer = setTimeout(() => rememberEpisode(id, prettyTitle(projectTitle || id)), 0);
    return () => clearTimeout(timer);
  }, [id, haveProject, projectTitle]);

  const prepareDone = prepareJob?.done ?? false;
  useEffect(() => {
    if (!prepareDone) return;
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [prepareDone, load]);

  useEffect(() => {
    if (!project?.source || connection !== "connected") return;
    let cancelled = false;
    mediaUrl(project.source)
      .then((url) => !cancelled && setSourceUrl(url))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project?.source, connection]);

  const logoPath = edits?.assets?.logo?.path ?? "";
  useEffect(() => {
    if (!logoPath) return;
    let cancelled = false;
    mediaUrl(logoPath)
      .then((url) => !cancelled && setLogoUrl(url))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [logoPath]);

  /* ---- what the screens read ------------------------------------------------ */

  const transcript = useMemo(() => buildTranscript(timeline?.words ?? [], sentences), [timeline, sentences]);
  const operations = edits?.operations;
  const marks = useMemo(() => markWords(transcript.words, operations ?? []), [transcript.words, operations]);
  const cuts = useMemo(() => (edits ? mergedCuts(edits) : []), [edits]);
  const caption = useMemo(() => {
    const i = rowAt(transcript.rows, currentMs);
    if (i < 0) return "";
    const row = transcript.rows[i];
    const at = row.words.findIndex((w) => currentMs < w.e);
    const from = Math.max(0, (at < 0 ? row.words.length : at) - 4);
    return row.words
      .slice(from, from + 8)
      .map((w) => w.text)
      .join(" ");
  }, [transcript.rows, currentMs]);

  const mode: SuggestionMode = edits?.suggestions?.mode ?? "balanced";
  const suggestions = useMemo(() => suggestionsForMode(allSuggestions, mode), [allSuggestions, mode]);
  const openCount = useMemo(() => (edits ? suggestions.filter((s) => suggestionState(edits, s) === "open").length : 0), [suggestions, edits]);

  /* ---- changing the edit ---------------------------------------------------- */

  const commit = useCallback((change: (prev: EpisodeEdits) => EpisodeEdits) => {
    setHistory((h) => (h ? pushHistory(h, change(h.present)) : h));
  }, []);

  const stepBack = useCallback(() => setHistory((h) => (h ? undo(h) : h)), []);
  const stepForward = useCallback(() => setHistory((h) => (h ? redo(h) : h)), []);

  const save = useCallback(
    async (next: EpisodeEdits, quiet = true) => {
      setSaving(true);
      try {
        const saved = await saveEpisodeEdits(id, next);
        setHistory((h) => (h && h.present === next ? { ...h, present: saved } : h));
        setSavedJson(JSON.stringify(saved));
        const now = Date.now();
        if (!quiet || now - lastSaveToast.current > SAVE_TOAST_MS) {
          lastSaveToast.current = now;
          toast("Saved", "ok");
        }
        return saved;
      } catch (e) {
        toast(`Couldn't save your work: ${errorText(e)}`, "warn");
        return next;
      } finally {
        setSaving(false);
      }
    },
    [id]
  );

  const editsJson = edits ? JSON.stringify(edits) : "";
  const dirty = !!edits && editsJson !== savedJson;

  // autosave: everything is kept for you a couple of seconds after you stop changing things
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => {
      const current = editsRef.current;
      if (current) void save(current);
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [dirty, editsJson, save]);

  const saveVersion = useCallback(
    async (note: string) => {
      const current = editsRef.current;
      if (!current) return;
      setSaving(true);
      try {
        const saved = await saveEpisodeEdits(id, current, { snapshot: true, note });
        setHistory((h) => (h ? { ...h, present: saved } : h));
        setSavedJson(JSON.stringify(saved));
        toast(`Version ${saved.versions[saved.versions.length - 1]?.n ?? ""} saved`, "ok");
      } catch (e) {
        toast(`Couldn't save that version: ${errorText(e)}`, "warn");
      } finally {
        setSaving(false);
      }
    },
    [id]
  );

  /* ---- editor actions ------------------------------------------------------- */

  const seek = useCallback((ms: number) => {
    setCurrentMs(ms);
    setSeekRequest({ ms, at: Date.now() });
  }, []);

  const act = useCallback(
    (type: EditOperation, range: Range) => {
      commit((prev) => addOperation(prev, { type, start_ms: range.start_ms, end_ms: range.end_ms, source: "user" }));
    },
    [commit]
  );

  const speakerTo = useCallback(
    (range: Range, choice: string | null) => {
      if (!choice) return;
      commit((prev) => {
        const speakerId = choice === "new" ? `s${Object.keys(prev.speakers).length + 1}` : choice;
        return assignSpeaker(prev, range.start_ms, range.end_ms, speakerId);
      });
    },
    [commit]
  );

  const addChapter = useCallback(
    (ms: number, hint: string) => {
      const title = hint.split(/\s+/).slice(0, 5).join(" ").replace(/[.,;:]$/, "");
      commit((prev) => splitSection(prev, ms, title || `Chapter ${prev.sections.length + 1}`));
      toast("Chapter added", "ok");
    },
    [commit]
  );

  /* ---- previews and export --------------------------------------------------- */

  const rangeAround = useCallback((): [number, number] => {
    const current = editsRef.current;
    const center = Math.round(selection ? (selection.start_ms + selection.end_ms) / 2 : currentMs);
    const out = current ? timelineMapLite(current).sourceToOut(center) : center;
    return [Math.max(0, out - RANGE_PAD_MS), out + RANGE_PAD_MS];
  }, [selection, currentMs]);

  const run = useCallback(
    async (kind: JobKind) => {
      const current = editsRef.current;
      if (!current || busy) return;
      setBusy(kind);
      setProgress("");
      setLinks([]);
      const onProgress = (evt: StatusEvent) => setProgress(studioProgress(evt));
      try {
        const stored = dirty ? await save(current) : current;
        const stamp = JSON.stringify(stored);
        const report =
          kind === "export"
            ? await runStudioExport(id, onProgress)
            : await runStudioPreview(id, kind === "rough" ? { quality: "rough" } : { quality: "full", range: rangeAround() }, onProgress);
        if (report.error) throw new Error(report.error);
        setReports((prev) => ({ ...prev, [kind]: report }));
        const entries = Object.entries(report.files ?? {}).filter(([key]) => key !== "report" && key !== "parts");
        setLinks(
          await Promise.all(
            entries.map(async ([key, path]) => ({
              label: FILE_LABELS[key] ?? key.replace(/[_-]/g, " "),
              url: await mediaUrl(path, report.rendered_at ?? ""),
              name: path.split("/").pop() ?? key,
            }))
          )
        );
        const video = entries.find(([key, path]) => path.endsWith(".mp4") || key === "video" || key === "episode");
        if (video && kind !== "export") {
          const url = await mediaUrl(video[1], report.rendered_at ?? "");
          setPreview({ url, stamp, label: kind === "rough" ? "edited preview" : "this part" });
        }
        toast(kind === "export" ? "Your episode is ready" : "Preview ready", "ok");
      } catch (e) {
        toast(`${kind === "export" ? "The export" : "The preview"} stopped: ${errorText(e)}`, "warn");
      } finally {
        setBusy(null);
        setProgress("");
      }
    },
    [busy, dirty, id, rangeAround, save]
  );

  const upload = useCallback(
    async (kind: "intro" | "outro" | "music" | "logo", file: File) => {
      setUploading(kind);
      try {
        const path = await uploadAsset(id, kind, file);
        commit((prev) => {
          const assets = { ...prev.assets };
          if (kind === "music") assets.music = { path, gain_db: prev.assets.music?.gain_db ?? -22, duck_db: prev.assets.music?.duck_db ?? -12, fade_ms: 1500 };
          else if (kind === "logo") assets.logo = { path, corner: prev.assets.logo?.corner ?? "tr", height: prev.assets.logo?.height ?? 0.1, opacity: 0.9 };
          else assets[kind] = { path };
          return { ...prev, assets };
        });
        toast(`${file.name} added`, "ok");
      } catch (e) {
        toast(`Couldn't add that file: ${errorText(e)}`, "warn");
      } finally {
        setUploading(null);
      }
    },
    [commit, id]
  );

  /* ---- keyboard ------------------------------------------------------------- */

  const keys = useRef({ stepBack, stepForward });
  useEffect(() => {
    keys.current = { stepBack, stepForward };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
      const k = keys.current;
      if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) k.stepForward();
        else k.stepBack();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "u") {
        e.preventDefault();
        k.stepBack();
        return;
      }
      if (e.key === "U") {
        e.preventDefault();
        k.stepForward();
        return;
      }
      if (e.key === " ") {
        if (tag === "BUTTON" || tag === "A" || tag === "VIDEO" || tag === "SUMMARY") return;
        const video = canvasRef.current?.querySelector("video");
        if (!video) return;
        e.preventDefault();
        if (video.paused) void video.play().catch(() => {});
        else video.pause();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---- the states before the editor ------------------------------------------- */

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

  if (loading || !project) {
    return (
      <div className="space-y-5" aria-busy="true" aria-label="Opening the episode">
        <div className="rr-skeleton h-8 w-80 max-w-full" />
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-4">
            <div className="rr-skeleton aspect-video w-full" />
            <div className="rr-skeleton h-24" />
            <div className="rr-skeleton h-64" />
          </div>
          <div className="rr-skeleton h-[520px]" />
        </div>
      </div>
    );
  }

  if (project.analysis?.status !== "analyzed") {
    return (
      <div className="rr-card rr-enter mx-auto mt-10 max-w-lg px-6 py-12 text-center">
        <p className="rr-h3">This episode is still being listened to</p>
        <p className="mt-1 text-sm text-ink-faint">The full-episode editor opens as soon as the transcript is ready.</p>
        <Link href={`/episode?id=${encodeURIComponent(id)}`} className="rr-btn rr-btn-primary mt-5">
          Watch the progress
        </Link>
      </div>
    );
  }

  const latest: StatusEvent | null = prepareJob?.events[prepareJob.events.length - 1] ?? null;

  if (!timeline || !edits || !history) {
    const step = initStep(latest);
    const finished = !!prepareJob?.done && !prepareJob.error;
    return (
      <div className="rr-card rr-enter mx-auto mt-10 max-w-lg px-6 py-10 text-center">
        <Wand2 className="mx-auto h-6 w-6 text-accent" />
        <p className="rr-h3 mt-3">Prepare the episode for editing</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-ink-faint">
          We line every word up with the recording and look for filler, long pauses and repeats. A long episode takes a few minutes, and it only happens once.
        </p>
        <div className="mx-auto mt-6 w-fit space-y-2 text-left">
          {INIT_STEPS.map((s, i) => (
            <div key={s.label} className="flex items-center gap-2.5 text-sm">
              {preparing && i === step ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
              ) : (preparing && i < step) || finished ? (
                <Check className="h-4 w-4 shrink-0 text-ready" />
              ) : (
                <span className="h-4 w-4 shrink-0 rounded-full border border-line-strong" />
              )}
              <span className={preparing && i === step ? "text-ink" : "text-ink-dim"}>{s.label}</span>
            </div>
          ))}
        </div>
        {preparing ? (
          <div className="mt-5 space-y-1.5">
            <div className="rr-progress" data-indeterminate="true">
              <i />
            </div>
            <p className="text-[11px] text-ink-dim">{studioProgress(latest)}</p>
          </div>
        ) : (
          <button
            type="button"
            className="rr-btn rr-btn-accent mt-6"
            disabled={connection !== "connected"}
            onClick={() => startStudioRun(id, "studio-prepare", (onProgress) => runStudioInit(id, onProgress))}
          >
            <Sparkles className="h-4 w-4" /> {prepareJob?.error ? "Try again" : "Prepare the episode"}
          </button>
        )}
        {prepareJob?.error ? <p className="mt-3 text-sm text-danger">It stopped: {prepareJob.error}</p> : null}
      </div>
    );
  }

  /* ---- the editor ------------------------------------------------------------ */

  const sourceMs = edits.source_duration_ms || project.media?.duration_ms || timeline.duration_ms || 0;
  const finalMs = outputDurationMs(edits);
  const previewFresh = !!preview && preview.stamp === savedJson;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="rr-eyebrow">Podcast Studio</p>
          <h1 className="rr-h2 mt-1 truncate">{prettyTitle(edits.title || project.title || id)}</h1>
          <p className="mt-1 text-sm text-ink-dim">
            {fmtDuration(sourceMs)} recorded · <span className="font-medium text-ink">{fmtDuration(finalMs)}</span> after your edit
            {sourceMs > finalMs + 500 ? ` · ${fmtDuration(sourceMs - finalMs)} taken out` : ""}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="rr-mono text-ink-faint">{saving ? "saving…" : dirty ? "unsaved" : "saved"}</span>
          <button type="button" className="rr-btn rr-btn-ghost rr-btn-sm" onClick={stepBack} title="Undo (U)" disabled={!canUndo(history)}>
            <Undo2 className="h-3.5 w-3.5" /> Undo
          </button>
          <button type="button" className="rr-btn rr-btn-ghost rr-btn-sm" onClick={stepForward} title="Redo (Shift U)" disabled={!canRedo(history)}>
            <Redo2 className="h-3.5 w-3.5" /> Redo
          </button>
          <Link href={`/episode?id=${encodeURIComponent(id)}`} className="rr-btn rr-btn-ghost rr-btn-sm">
            Short clips
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          <div ref={canvasRef}>
            <StudioCanvas
              sourceUrl={sourceUrl}
              previewUrl={preview?.url ?? null}
              previewFresh={previewFresh}
              previewLabel={preview?.label ?? "edited preview"}
              edits={edits}
              caption={caption}
              logoUrl={logoUrl}
              currentMs={currentMs}
              seekRequest={seekRequest}
              onTime={setCurrentMs}
            />
          </div>

          <TimelineBar
            peaks={waveform?.peaks ?? []}
            durationMs={sourceMs || waveform?.duration_ms || 1}
            cuts={cuts}
            operations={edits.operations}
            sections={edits.sections}
            currentMs={currentMs}
            onSeek={seek}
          />

          <TranscriptEditor
            rows={transcript.rows}
            words={transcript.words}
            marks={marks}
            edits={edits}
            currentMs={currentMs}
            onSeek={seek}
            onAction={act}
            onUndoOperation={(opId) => commit((prev) => toggleOperation(prev, opId))}
            onAssignSpeaker={speakerTo}
            onRenameSpeaker={(speakerId, name) => commit((prev) => renameSpeaker(prev, speakerId, name))}
            onAddSection={addChapter}
            onSelection={setSelection}
          />
        </div>

        <aside className="min-w-0 space-y-4 xl:sticky xl:top-4 xl:self-start">
          <Inspector
            edits={edits}
            suggestionCount={openCount}
            dirty={dirty}
            saving={saving}
            busy={busy}
            progress={progress}
            reports={reports}
            links={links}
            uploading={uploading}
            onPatch={(patch) => commit((prev) => ({ ...prev, ...patch }))}
            onPatchAudio={(patch) => commit((prev) => ({ ...prev, audio: { ...prev.audio, ...patch } }))}
            onPatchVisual={(patch) => commit((prev) => ({ ...prev, visual: { ...prev.visual, ...patch } }))}
            onPatchCaptions={(patch) => commit((prev) => ({ ...prev, visual: { ...prev.visual, caption_style: { ...prev.visual.caption_style, ...patch } } }))}
            onMode={(next) => commit((prev) => setSuggestionMode(prev, next))}
            onApplyAll={() => {
              commit((prev) => applyAll(prev, allSuggestions, prev.suggestions.mode));
              toast(openCount ? `${openCount} changes applied — undo with U` : "Nothing left to apply", openCount ? "ok" : "info");
            }}
            onSaveVersion={(note) => void saveVersion(note)}
            onUpload={(kind, file) => void upload(kind, file)}
            onRemoveAsset={(kind) =>
              commit((prev) => {
                const assets = { ...prev.assets };
                delete assets[kind];
                return { ...prev, assets };
              })
            }
            onRun={(kind) => void run(kind)}
          />

          <SuggestionsPanel
            suggestions={suggestions}
            edits={edits}
            onAccept={(s) => commit((prev) => applySuggestion(prev, s))}
            onReject={(s) => commit((prev) => rejectSuggestion(prev, s))}
            onPlay={seek}
            onToggleOperation={(opId) => commit((prev) => toggleOperation(prev, opId))}
          />

          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[11px] text-ink-faint">
            <span>
              <span className="rr-kbd">Delete</span> remove
            </span>
            <span>
              <span className="rr-kbd">M</span> silence
            </span>
            <span>
              <span className="rr-kbd">B</span> bleep
            </span>
            <span>
              <span className="rr-kbd">U</span> undo
            </span>
            <span>
              <span className="rr-kbd">⇧U</span> redo
            </span>
            <span>
              <span className="rr-kbd">Space</span> play
            </span>
            <span>
              <span className="rr-kbd">/</span> find
            </span>
          </p>
        </aside>
      </div>
    </div>
  );
}
