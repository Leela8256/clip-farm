"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Check, Loader2, Redo2, RefreshCw, Sparkles, TriangleAlert, Undo2, Wand2 } from "lucide-react";
import { getConnectionState, mediaUrl, readJsonOr, subscribeConnection } from "@/lib/engine";
import { prettyTitle, projectRoot, toSentences, type Project, type Sentence, type StatusEvent } from "@/lib/podcast";
import { rememberEpisode } from "@/lib/recent";
import { toast } from "@/components/shell/Toasts";
import {
  addCorrection,
  addOperation,
  applyAll,
  applyProposalItem,
  applySafeProposalItems,
  applySuggestion,
  assignSpeaker,
  canRedo,
  canUndo,
  clockFromSpec,
  discardProposal,
  editsSignature,
  fmtDuration,
  initHistory,
  isReviewOnly,
  markReviewed,
  mergedCuts,
  outputDurationMs,
  pushHistory,
  redo,
  rejectProposalItem,
  rejectSuggestion,
  removeCorrection,
  removeOperation,
  removeSection,
  renameSpeaker,
  setSuggestionMode,
  splitSection,
  suggestionState,
  suggestionsForMode,
  timelineMapLite,
  toggleOperation,
  undo,
  updateOperation,
  wordId,
  type Correction,
  type EditOperation,
  type EditProposal,
  type EditsVersion,
  type EpisodeEdits,
  type History,
  type PlaybackClock,
  type PreparedSpec,
  type ProposalItem,
  type StudioReport,
  type StudioTimeline,
  type StudioWaveform,
  type Suggestion,
  type SuggestionKind,
  type SuggestionMode,
  CURRENT_ALIGN_VERSION,
} from "@/lib/studio";
import {
  deleteProposal,
  getSaveState,
  isSaved,
  loadPreparedSpec,
  loadStudio,
  loadVersion,
  restoreEpisodeVersion,
  runProposal,
  runStudioExport,
  runStudioInit,
  runStudioPreview,
  saveEpisodeEdits,
  saveProposal,
  startStudioRun,
  studioRunKey,
  subscribeSave,
  uploadAsset,
  type SaveState,
} from "@/lib/studio-engine";
import StudioCanvas, { type AuditionRequest } from "@/components/studio/StudioCanvas";
import TimelineBar from "@/components/studio/TimelineBar";
import TranscriptEditor, { type Range } from "@/components/studio/TranscriptEditor";
import Inspector, { type DownloadLink, type ExportSize, type JobKind } from "@/components/studio/Inspector";
import SuggestionsPanel from "@/components/studio/SuggestionsPanel";
import ProposalPanel from "@/components/studio/ProposalPanel";
import VersionDialog from "@/components/studio/VersionDialog";
import {
  INIT_STEPS,
  WORKFLOW_STEPS,
  applySummary,
  buildTranscript,
  initStep,
  loadRenderQuality,
  markWords,
  qualityOfReport,
  rowAt,
  studioProgress,
  useJob,
  type RenderQuality,
} from "@/components/studio/helpers";
import { applyBrand, describeApply, listBrandTemplates, type BrandTemplate } from "@/components/studio/brand";

const serverState = () => "idle" as const;

/**
 * How big the finished episode is made travels to the render as one more line
 * of context. The studio's export call takes the episode and a progress handler
 * today and grows an options argument for the size; until it carries one, the
 * choice is not offered as though it worked (exports are 1080p) — see the
 * wiring note in the studio's engine module.
 */
type ExportCall = (episodeId: string, onProgress?: (evt: StatusEvent) => void, options?: { size?: ExportSize }) => Promise<StudioReport>;
const exportEpisode = runStudioExport as unknown as ExportCall;
const EXPORT_SIZE_READY = runStudioExport.length >= 3;
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

/** What a file that would not open is called on screen. */
const FAILED_LABELS: Record<string, string> = {
  timeline: "the words",
  waveform: "the sound",
  suggestions: "the suggestions",
  edits: "your edit",
  project: "the episode details",
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const IDLE_CLOCK: PlaybackClock = {
  mode: "source",
  map: null,
  rangeOutStartMs: 0,
  rangeOutEndMs: null,
  approximate: true,
  sourceDurationMs: 0,
  outputDurationMs: 0,
};
const IDLE_SAVE: SaveState = { saving: false, queued: false, saved: null, savedSignature: null, savedAt: null, error: null };
const idleSave = () => IDLE_SAVE;

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
  const [timingRefresh, setTimingRefresh] = useState(false);
  const [waveform, setWaveform] = useState<StudioWaveform | null>(null);
  const [allSuggestions, setAllSuggestions] = useState<Suggestion[]>([]);
  const [language, setLanguage] = useState("");
  const [unsupported, setUnsupported] = useState<SuggestionKind[]>([]);
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [history, setHistory] = useState<History | null>(null);
  const [baseline, setBaseline] = useState("");
  const [loadFailed, setLoadFailed] = useState<string[]>([]);
  const [editsFailed, setEditsFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const lastSaveToast = useRef(0);
  const editsRef = useRef<EpisodeEdits | null>(null);
  const blockedRef = useRef(false);

  const [currentMs, setCurrentMs] = useState(0);
  const [seekRequest, setSeekRequest] = useState<{ ms: number; at: number } | null>(null);
  const [auditionRequest, setAuditionRequest] = useState<AuditionRequest | null>(null);
  const [selection, setSelection] = useState<Range | null>(null);
  const [selectedOpId, setSelectedOpId] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [applyNote, setApplyNote] = useState("");

  const [busy, setBusy] = useState<JobKind | null>(null);
  const [progress, setProgress] = useState("");
  const [reports, setReports] = useState<Partial<Record<JobKind, StudioReport>>>({});
  const [quality, setQuality] = useState<Partial<Record<JobKind, RenderQuality | null>>>({});
  const [exportSize, setExportSize] = useState<ExportSize>("1080");
  const [brands, setBrands] = useState<BrandTemplate[]>([]);
  const [brandsLoading, setBrandsLoading] = useState(false);
  const [brandNote, setBrandNote] = useState("");
  const [links, setLinks] = useState<DownloadLink[]>([]);
  const [preview, setPreview] = useState<{ url: string; stamp: string; label: string } | null>(null);
  const [previewKind, setPreviewKind] = useState<"rough" | "range">("rough");
  const [previewRange, setPreviewRange] = useState<[number, number] | null>(null);
  const [previewLeadMs, setPreviewLeadMs] = useState(0);
  const [spec, setSpec] = useState<PreparedSpec | null>(null);
  const [specTick, setSpecTick] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);

  const [versionOpen, setVersionOpen] = useState<{ version: EditsVersion; snapshot: EpisodeEdits | null; loading: boolean } | null>(null);

  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [proposalProgress, setProposalProgress] = useState("");

  const saveState = useSyncExternalStore(
    useCallback((fn: () => void) => subscribeSave(id, fn), [id]),
    useCallback(() => getSaveState(id), [id]),
    idleSave
  );

  const edits = history?.present ?? null;
  const prepareKey = useMemo(() => studioRunKey(id, "studio-prepare"), [id]);
  const prepareJob = useJob(prepareKey);
  const preparing = !!prepareJob && !prepareJob.done;
  const blocked = editsFailed || loadFailed.length > 0;

  useEffect(() => {
    editsRef.current = edits;
    blockedRef.current = blocked;
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
    setLanguage(data.language ?? "");
    setUnsupported(data.unsupported);
    setLoadFailed(data.failedFiles.map((key) => FAILED_LABELS[key] ?? key));
    setEditsFailed(data.files.edits.failed);
    setSentences(toSentences(doc));
    setLoading(false);
    // a file that failed to load is not a file that isn't there: never start a
    // fresh, empty edit on top of work that is only temporarily out of reach
    if (data.files.edits.failed) return;
    const loaded = data.edits ?? data.blank;
    editsRef.current = loaded;
    setHistory(initHistory(loaded));
    setBaseline(editsSignature(loaded));
  }, [id, root]);

  useEffect(() => {
    if (connection !== "connected" || !id) return;
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [connection, id, load]);

  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      await load();
    } finally {
      setRetrying(false);
    }
  }, [load]);

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

  // the saved brands, when there are any: applying one only fills in blanks
  useEffect(() => {
    if (connection !== "connected") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setBrandsLoading(true);
      listBrandTemplates()
        .then((list) => !cancelled && setBrands(list))
        .catch(() => {})
        .finally(() => !cancelled && setBrandsLoading(false));
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connection]);

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

  // the exact positions of a made version, when one exists for this revision
  const revision = edits?.version ?? 0;
  useEffect(() => {
    if (!id || !revision) return;
    let cancelled = false;
    loadPreparedSpec(id, revision)
      .then((found) => !cancelled && setSpec(found))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, revision, specTick]);

  /* ---- what the screens read ------------------------------------------------ */

  const transcript = useMemo(() => buildTranscript(timeline?.words ?? [], sentences), [timeline, sentences]);
  const operations = edits?.operations;
  const marks = useMemo(() => markWords(transcript.words, operations ?? []), [transcript.words, operations]);
  const cuts = useMemo(() => (edits ? mergedCuts(edits) : []), [edits]);
  const fixes = useMemo<Map<string, Correction>>(() => new Map((edits?.corrections ?? []).map((c) => [c.word_id, c])), [edits]);
  const caption = useMemo(() => {
    const i = rowAt(transcript.rows, currentMs);
    if (i < 0) return "";
    const row = transcript.rows[i];
    const at = row.words.findIndex((w) => currentMs < w.e);
    const from = Math.max(0, (at < 0 ? row.words.length : at) - 4);
    return row.words
      .slice(from, from + 8)
      .map((w) => (w.k >= 0 ? fixes.get(wordId(w.k))?.text ?? w.text : w.text))
      .join(" ");
  }, [transcript.rows, currentMs, fixes]);

  const mode: SuggestionMode = edits?.suggestions?.mode ?? "balanced";
  const suggestions = useMemo(() => suggestionsForMode(allSuggestions, mode), [allSuggestions, mode]);
  const openCount = useMemo(
    () => (edits ? suggestions.filter((s) => !isReviewOnly(s) && suggestionState(edits, s) === "open").length : 0),
    [suggestions, edits]
  );

  // the picture and the transcript always talk in recording time; the player converts
  const sourceClock = useMemo<PlaybackClock>(() => (edits ? clockFromSpec(spec, edits, "source") : IDLE_CLOCK), [spec, edits]);
  const previewClock = useMemo<PlaybackClock>(() => {
    if (!edits) return IDLE_CLOCK;
    const base = clockFromSpec(spec, edits, previewKind === "range" ? "range_preview" : "rough_preview", previewRange ?? undefined);
    // a standard preview file opens with the intro/title card, so its media time
    // runs previewLeadMs ahead of the edit timeline — shift through range mode
    if (previewKind !== "range" && previewLeadMs > 0) return { ...base, mode: "range_preview", rangeOutStartMs: -previewLeadMs };
    return base;
  }, [spec, edits, previewKind, previewRange, previewLeadMs]);

  /* ---- changing the edit ---------------------------------------------------- */

  const commit = useCallback((change: (prev: EpisodeEdits) => EpisodeEdits) => {
    setHistory((h) => (h ? pushHistory(h, change(h.present)) : h));
  }, []);

  const stepBack = useCallback(() => setHistory((h) => (h ? undo(h) : h)), []);
  const stepForward = useCallback(() => setHistory((h) => (h ? redo(h) : h)), []);

  const save = useCallback(
    async (next: EpisodeEdits, quiet = true) => {
      if (blockedRef.current) return next;
      try {
        // one write at a time: quick changes collapse into a single newest save
        const saved = await saveEpisodeEdits(id, next);
        setHistory((h) => (h && h.present === next ? { ...h, present: saved } : h));
        const now = Date.now();
        if (!quiet || now - lastSaveToast.current > SAVE_TOAST_MS) {
          lastSaveToast.current = now;
          toast("Saved", "ok");
        }
        return saved;
      } catch (e) {
        toast(`Couldn't save your work: ${errorText(e)}`, "warn");
        return next;
      }
    },
    [id]
  );

  // "saved" means exactly what is on screen reached the file — nothing else counts
  const signature = edits ? editsSignature(edits) : "";
  const saving = saveState.saving || saveState.queued;
  const saveError = saveState.error;
  // before anything has been written this session the file itself is the truth;
  // after that only the save queue's own record of what landed counts
  const dirty = !!edits && (saveState.savedSignature ? !isSaved(id, edits) : signature !== baseline);

  // autosave: everything is kept for you a couple of seconds after you stop changing things
  useEffect(() => {
    if (!dirty || blocked) return;
    const timer = setTimeout(() => {
      const current = editsRef.current;
      if (current) void save(current);
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [dirty, blocked, signature, save]);

  const saveVersion = useCallback(
    async (note: string) => {
      const current = editsRef.current;
      if (!current || blockedRef.current) return;
      try {
        const saved = await saveEpisodeEdits(id, current, { snapshot: true, note });
        setHistory((h) => (h ? { ...h, present: saved } : h));
        toast(`Version ${saved.versions[saved.versions.length - 1]?.n ?? ""} saved`, "ok");
      } catch (e) {
        toast(`Couldn't save that version: ${errorText(e)}`, "warn");
      }
    },
    [id]
  );

  /* ---- versions ------------------------------------------------------------- */

  const openVersion = useCallback(
    (version: EditsVersion) => {
      setVersionOpen({ version, snapshot: null, loading: true });
      loadVersion(id, version.n)
        .then((snapshot) => setVersionOpen((held) => (held && held.version.n === version.n ? { ...held, snapshot, loading: false } : held)))
        .catch(() => setVersionOpen((held) => (held && held.version.n === version.n ? { ...held, snapshot: null, loading: false } : held)));
    },
    [id]
  );

  const restore = useCallback(async () => {
    const current = editsRef.current;
    const n = versionOpen?.version.n;
    if (!current || !versionOpen?.snapshot || n == null) return;
    setVersionOpen(null);
    try {
      // going back is a step forward: it becomes the newest version, nothing is rewritten
      const restored = await restoreEpisodeVersion(id, current, n);
      setHistory((h) => (h ? pushHistory(h, restored) : initHistory(restored)));
      toast(`Back at save point ${n} — undo with U`, "ok");
    } catch (e) {
      toast(`Couldn't go back to that version: ${errorText(e)}`, "warn");
    }
  }, [id, versionOpen]);

  /* ---- editor actions ------------------------------------------------------- */

  const seek = useCallback((ms: number) => {
    setCurrentMs(ms);
    setSeekRequest({ ms, at: Date.now() });
  }, []);

  const audition = useCallback((range: { start_ms: number; end_ms: number }) => {
    setAuditionRequest({ start_ms: range.start_ms, end_ms: range.end_ms, at: Date.now() });
  }, []);

  const act = useCallback(
    (type: EditOperation, range: Range) => {
      commit((prev) => addOperation(prev, { type, start_ms: range.start_ms, end_ms: range.end_ms, source: "user" }));
    },
    [commit]
  );

  const pickRange = useCallback((range: Range | null) => {
    setSelection(range);
    if (range) setSelectedOpId(null);
  }, []);

  const pickOperation = useCallback((opId: string | null) => {
    setSelectedOpId(opId);
    if (opId) setSelection(null);
  }, []);

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

  const applyEverything = useCallback(() => {
    const before = editsRef.current;
    if (!before) return;
    const result = applyAll(before, allSuggestions, before.suggestions.mode);
    setHistory((h) => (h ? pushHistory(h, result.edits) : h));
    const note = applySummary(result);
    setApplyNote(note);
    toast(result.applied ? `${note} — undo with U` : "Nothing left to apply", result.applied ? "ok" : "info");
  }, [allSuggestions]);

  /* ---- a drafted edit -------------------------------------------------------- */

  const draftEdit = useCallback(
    async (goal: string, pick: SuggestionMode) => {
      if (proposalBusy) return;
      setProposalBusy(true);
      setProposalProgress("Reading the episode…");
      try {
        const drafted = await runProposal(id, goal, pick, {}, (evt) => setProposalProgress(studioProgress(evt)));
        setProposal(drafted);
        toast(
          drafted.items.length ? `${drafted.items.length} changes drafted — nothing applied yet` : "Nothing worth cutting for that",
          drafted.items.length ? "ok" : "info"
        );
      } catch (e) {
        toast(`Couldn't draft that edit: ${errorText(e)}`, "warn");
      } finally {
        setProposalBusy(false);
        setProposalProgress("");
      }
    },
    [id, proposalBusy]
  );

  /** Keep the drafted list on file in step with what was taken or turned down. */
  const rememberProposal = useCallback(
    (next: EditProposal) => {
      setProposal(next);
      void saveProposal(id, next).catch(() => {});
    },
    [id]
  );

  const takeItem = useCallback(
    (item: ProposalItem) => {
      const held = proposal;
      if (!held) return;
      const current = editsRef.current;
      if (!current) return;
      const result = applyProposalItem(current, held, item.id);
      if (!result.applied) return;
      setHistory((h) => (h ? pushHistory(h, result.edits) : h));
      rememberProposal(result.proposal);
    },
    [proposal, rememberProposal]
  );

  const dropItem = useCallback(
    (item: ProposalItem) => {
      const held = proposal;
      const current = editsRef.current;
      if (!held || !current) return;
      const result = rejectProposalItem(current, held, item.id);
      if (result.edits !== current) setHistory((h) => (h ? pushHistory(h, result.edits) : h));
      rememberProposal(result.proposal);
    },
    [proposal, rememberProposal]
  );

  const takeSafeItems = useCallback(() => {
    const held = proposal;
    const current = editsRef.current;
    if (!held || !current) return;
    const result = applySafeProposalItems(current, held);
    if (!result.applied) {
      toast("Nothing safe enough to take on its own", "info");
      return;
    }
    setHistory((h) => (h ? pushHistory(h, result.edits) : h));
    rememberProposal(result.proposal);
    toast(
      `${result.applied} changes taken${result.skipped_conflict ? `, ${result.skipped_conflict} skipped (they overlap an edit)` : ""} — undo with U`,
      "ok"
    );
  }, [proposal, rememberProposal]);

  const dropProposal = useCallback(() => {
    const held = proposal;
    if (!held) return;
    commit((prev) => discardProposal(prev, held.id));
    setProposal(null);
    void deleteProposal(id, held.id).catch(() => {});
    toast("Draft thrown away — nothing from it is left in your edit", "info");
  }, [commit, id, proposal]);

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
        const stamp = editsSignature(stored);
        const range = kind === "range" ? rangeAround() : null;
        // the whole episode at preview quality, or the chosen stretch as it will
        // really be — the engine call takes the same two words it always has
        const report =
          kind === "export"
            ? await exportEpisode(id, onProgress, EXPORT_SIZE_READY ? { size: exportSize } : undefined)
            : await runStudioPreview(id, kind === "rough" ? { quality: "rough" } : { quality: "full", range: range ?? rangeAround() }, onProgress);
        if (report.error) throw new Error(report.error);
        setReports((prev) => ({ ...prev, [kind]: report }));
        // how it actually came out, measured from the file itself
        setQuality((prev) => ({ ...prev, [kind]: qualityOfReport(report) }));
        void loadRenderQuality(id, kind, report.version)
          .then((measured) => measured && setQuality((prev) => ({ ...prev, [kind]: measured })))
          .catch(() => {});
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
          setPreviewKind(kind === "rough" ? "rough" : "range");
          setPreviewRange(kind === "range" ? range : null);
          setPreviewLeadMs(kind === "rough" ? (report.lead_ms ?? 0) : 0);
          setPreview({ url, stamp, label: kind === "rough" ? "Standard preview" : "Selected section" });
        }
        // the made version carries the exact positions — use them from now on
        setSpecTick((n) => n + 1);
        toast(kind === "export" ? "Your episode is ready" : "Preview ready", "ok");
      } catch (e) {
        toast(`${kind === "export" ? "The export" : "The preview"} stopped: ${errorText(e)}`, "warn");
      } finally {
        setBusy(null);
        setProgress("");
      }
    },
    [busy, dirty, exportSize, id, rangeAround, save]
  );

  /** Fill this episode's blanks from a saved brand; anything already chosen stays. */
  const takeBrand = useCallback(
    (template: BrandTemplate) => {
      const current = editsRef.current;
      if (!current) return;
      const result = applyBrand(current, template);
      const note = describeApply(result, template.name);
      setBrandNote(note);
      if (!result.filled.length) {
        toast(note, "info");
        return;
      }
      setHistory((h) => (h ? pushHistory(h, result.edits) : h));
      toast(`${note} — undo with U`, "ok");
    },
    []
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

  const keys = useRef({ stepBack, stepForward, selectedOpId, commit, pickOperation });
  useEffect(() => {
    keys.current = { stepBack, stepForward, selectedOpId, commit, pickOperation };
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
      // a change picked on the sound bar answers to Delete and U first
      if (k.selectedOpId && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        const opId = k.selectedOpId;
        k.commit((prev) => removeOperation(prev, opId));
        k.pickOperation(null);
        return;
      }
      if (k.selectedOpId && (e.key === "u" || e.key === "U")) {
        e.preventDefault();
        const opId = k.selectedOpId;
        k.commit((prev) => toggleOperation(prev, opId));
        return;
      }
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
        <Link href="/projects" className="rr-btn rr-btn-primary mt-5">
          My projects
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

  // your own work would not open: never start again on top of it
  if (editsFailed) {
    return (
      <div className="rr-card rr-enter mx-auto mt-10 max-w-lg px-6 py-12 text-center">
        <TriangleAlert className="mx-auto h-6 w-6 text-processing" />
        <p className="rr-h3 mt-3">We couldn&apos;t open your edit</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-ink-faint">
          Your work is safe where it is — it just didn&apos;t come back this time. Nothing will be changed until it opens.
        </p>
        <button type="button" className="rr-btn rr-btn-primary mt-5" disabled={retrying} onClick={() => void retry()}>
          {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Try again
        </button>
      </div>
    );
  }

  if (project.analysis?.status !== "analyzed") {
    return (
      <div className="rr-card rr-enter mx-auto mt-10 max-w-lg px-6 py-12 text-center">
        <p className="rr-h3">This episode is still being listened to</p>
        <p className="mt-1 text-sm text-ink-faint">The episode editor opens as soon as the transcript is ready.</p>
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
      <div className="rr-card rr-enter mx-auto mt-10 max-w-xl px-6 py-10">
        <div className="text-center">
          <Wand2 className="mx-auto h-6 w-6 text-accent" />
          <h1 className="rr-h3 mt-3">Turn your raw recording into a finished episode</h1>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-ink-faint">
            Remove mistakes, improve pacing, clean the audio, add your branding and export a publish-ready full podcast episode.
          </p>
        </div>

        {preparing ? (
          <div className="mx-auto mt-6 w-fit space-y-2 text-left">
            {INIT_STEPS.map((s, i) => (
              <div key={s.label} className="flex items-center gap-2.5 text-sm">
                {i === step ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
                ) : i < step ? (
                  <Check className="h-4 w-4 shrink-0 text-ready" />
                ) : (
                  <span className="h-4 w-4 shrink-0 rounded-full border border-line-strong" />
                )}
                <span className={i === step ? "text-ink" : "text-ink-dim"}>{s.label}</span>
              </div>
            ))}
          </div>
        ) : (
          <ol className="mx-auto mt-6 max-w-md space-y-2.5">
            {WORKFLOW_STEPS.map((s, i) => (
              <li key={s.title} className="flex items-start gap-2.5 text-sm">
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium ${
                    finished && i === 0 ? "bg-ready/15 text-ready" : "bg-surface-overlay text-ink-dim"
                  }`}
                >
                  {finished && i === 0 ? <Check className="h-3 w-3" /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className="text-ink">{s.title}</span>
                  <span className="block text-[11px] leading-tight text-ink-faint">{s.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        )}

        {preparing ? (
          <div className="mt-5 space-y-1.5">
            <div className="rr-progress" data-indeterminate="true">
              <i />
            </div>
            <p className="text-center text-[11px] text-ink-dim">{studioProgress(latest)}</p>
          </div>
        ) : (
          <div className="mt-6 text-center">
            <button
              type="button"
              className="rr-btn rr-btn-accent"
              disabled={connection !== "connected"}
              onClick={() => startStudioRun(id, "studio-prepare", (onProgress) => runStudioInit(id, onProgress))}
            >
              <Sparkles className="h-4 w-4" /> {prepareJob?.error ? "Try again" : "Prepare full episode"}
            </button>
            <p className="mx-auto mt-2 max-w-sm text-[11px] text-ink-faint">
              The first step lines every word up with the recording and looks for filler, long pauses and repeats. A long episode takes a few
              minutes, and it only happens once.
            </p>
          </div>
        )}
        {prepareJob?.error ? <p className="mt-3 text-center text-sm text-danger">It stopped: {prepareJob.error}</p> : null}
      </div>
    );
  }

  /* ---- the editor ------------------------------------------------------------ */

  const sourceMs = edits.source_duration_ms || project.media?.duration_ms || timeline.duration_ms || 0;
  const finalMs = outputDurationMs(edits);
  const previewFresh = !!preview && preview.stamp === signature;
  const savedLabel = saving ? "saving…" : saveError ? "not saved" : dirty ? "unsaved" : "saved";

  const timingStale = (timeline.align_version ?? 1) !== CURRENT_ALIGN_VERSION;

  return (
    <div className="space-y-4">
      {timingStale && (
        <div className="rr-enter flex flex-wrap items-center justify-between gap-3 rounded-md border border-processing/40 bg-processing/10 px-3.5 py-2.5">
          <p className="text-sm text-ink">
            Word timing has improved since this episode was prepared — captions will sync better after a quick refresh.
          </p>
          <button
            type="button"
            className="rr-btn rr-btn-sm"
            disabled={timingRefresh || connection !== "connected"}
            onClick={() => {
              setTimingRefresh(true);
              void runStudioInit(id)
                .then(() => load())
                .finally(() => setTimingRefresh(false));
            }}
          >
            {timingRefresh ? "Refreshing timing…" : "Refresh timing"}
          </button>
        </div>
      )}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="rr-eyebrow">Episode Editor</p>
          <h1 className="rr-h2 mt-1 truncate">{prettyTitle(edits.title || project.title || id)}</h1>
          <p className="mt-1 text-sm text-ink-dim">
            {fmtDuration(sourceMs)} recorded · <span className="font-medium text-ink">{fmtDuration(finalMs)}</span> after your edit
            {sourceMs > finalMs + 500 ? ` · ${fmtDuration(sourceMs - finalMs)} taken out` : ""}
          </p>
          <p className="mt-0.5 text-[12px] text-ink-faint">Cut what you don&apos;t want, tidy the sound, add your look — then export the finished episode.</p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`rr-mono ${saveError ? "text-danger" : "text-ink-faint"}`}>{savedLabel}</span>
          <button type="button" className="rr-btn rr-btn-ghost rr-btn-sm" onClick={stepBack} title="Undo (U)" disabled={!canUndo(history)}>
            <Undo2 className="h-3.5 w-3.5" /> Undo
          </button>
          <button type="button" className="rr-btn rr-btn-ghost rr-btn-sm" onClick={stepForward} title="Redo (Shift U)" disabled={!canRedo(history)}>
            <Redo2 className="h-3.5 w-3.5" /> Redo
          </button>
          <Link href={`/episode?id=${encodeURIComponent(id)}`} className="rr-btn rr-btn-ghost rr-btn-sm">
            Create clips
          </Link>
        </div>
      </header>

      {loadFailed.length ? (
        <div className="rr-card flex flex-wrap items-center gap-2 border-processing/50 px-3.5 py-2.5 text-sm">
          <TriangleAlert className="h-4 w-4 shrink-0 text-processing" />
          <span className="min-w-0">
            We couldn&apos;t open {loadFailed.join(" and ")} just now. Editing is paused so nothing is written over it.
          </span>
          <button type="button" className="rr-btn rr-btn-sm ml-auto" disabled={retrying} onClick={() => void retry()}>
            {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Try again
          </button>
        </div>
      ) : null}

      {saveError ? (
        <div className="rr-card flex flex-wrap items-center gap-2 border-danger/50 px-3.5 py-2.5 text-sm">
          <TriangleAlert className="h-4 w-4 shrink-0 text-danger" />
          <span className="min-w-0">Your last change wasn&apos;t saved: {saveError}</span>
          <button
            type="button"
            className="rr-btn rr-btn-sm ml-auto"
            disabled={saving}
            onClick={() => {
              const current = editsRef.current;
              if (current) void save(current, false);
            }}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Save again
          </button>
        </div>
      ) : null}

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
              auditionRequest={auditionRequest}
              sourceClock={sourceClock}
              previewClock={previewClock}
              approximate={sourceClock.approximate}
              onTime={setCurrentMs}
            />
          </div>

          <TimelineBar
            peaks={waveform?.peaks ?? []}
            durationMs={sourceMs || waveform?.duration_ms || 1}
            cuts={cuts}
            operations={edits.operations}
            sections={edits.sections}
            words={timeline.words ?? []}
            currentMs={currentMs}
            selection={selection}
            selectedOpId={selectedOpId}
            onSeek={seek}
            onSelect={pickRange}
            onSelectOp={pickOperation}
            onResizeOp={(opId, start, end) => commit((prev) => updateOperation(prev, opId, { start_ms: start, end_ms: end }))}
            onRemoveOp={(opId) => {
              commit((prev) => removeOperation(prev, opId));
              setSelectedOpId(null);
            }}
            onToggleOp={(opId) => commit((prev) => toggleOperation(prev, opId))}
            onAudition={audition}
            onRemoveRange={(range) => act("cut", range)}
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
            onSelection={pickRange}
            syncSelection={selection}
            corrections={fixes}
            onCorrect={(word, text, original) => commit((prev) => addCorrection(prev, word, text, original))}
            onRevertCorrection={(word) => commit((prev) => removeCorrection(prev, word))}
          />
        </div>

        <aside className="min-w-0 space-y-4 xl:sticky xl:top-4 xl:self-start">
          <Inspector
            edits={edits}
            suggestionCount={openCount}
            applySummary={applyNote}
            dirty={dirty}
            saving={saving}
            busy={busy}
            progress={progress}
            reports={reports}
            quality={quality.export ?? quality.range ?? quality.rough ?? null}
            links={links}
            onPatch={(patch) => commit((prev) => ({ ...prev, ...patch }))}
            onPatchAudio={(patch) => commit((prev) => ({ ...prev, audio: { ...prev.audio, ...patch } }))}
            onPatchVisual={(patch) => commit((prev) => ({ ...prev, visual: { ...prev.visual, ...patch } }))}
            onPatchCaptions={(patch) => commit((prev) => ({ ...prev, visual: { ...prev.visual, caption_style: { ...prev.visual.caption_style, ...patch } } }))}
            onMode={(next) => commit((prev) => setSuggestionMode(prev, next))}
            onApplyAll={applyEverything}
            onSaveVersion={(note) => void saveVersion(note)}
            onOpenVersion={openVersion}
            onUpload={(kind, file) => void upload(kind, file)}
            onRemoveAsset={(kind) =>
              commit((prev) => {
                const assets = { ...prev.assets };
                delete assets[kind];
                return { ...prev, assets };
              })
            }
            onRun={(kind) => void run(kind)}
            onSeek={seek}
            onRenameSpeaker={(speakerId, name) => commit((prev) => renameSpeaker(prev, speakerId, name))}
            onRemoveSection={(sectionId) => commit((prev) => removeSection(prev, sectionId))}
            uploading={uploading}
            brands={brands}
            brandsLoading={brandsLoading}
            brandNote={brandNote}
            onApplyBrand={takeBrand}
            exportSize={exportSize}
            onExportSize={setExportSize}
            exportSizeReady={EXPORT_SIZE_READY}
            cleanup={
              <>
                <SuggestionsPanel
                  suggestions={suggestions}
                  edits={edits}
                  language={language}
                  unsupported={unsupported}
                  summary={applyNote}
                  onAccept={(s) => commit((prev) => applySuggestion(prev, s))}
                  onReject={(s) => commit((prev) => rejectSuggestion(prev, s))}
                  onPlay={seek}
                  onAudition={audition}
                  onMarkReviewed={(sid) => commit((prev) => markReviewed(prev, sid))}
                  onToggleOperation={(opId) => commit((prev) => toggleOperation(prev, opId))}
                  embedded
                />

                <ProposalPanel
                  proposal={proposal}
                  edits={edits}
                  busy={proposalBusy}
                  progress={proposalProgress}
                  mode={mode}
                  onDraft={(goal, pick) => void draftEdit(goal, pick)}
                  onApply={takeItem}
                  onReject={dropItem}
                  onApplySafe={takeSafeItems}
                  onDiscard={dropProposal}
                  onAudition={audition}
                  embedded
                />
              </>
            }
          />
        </aside>
      </div>

      {versionOpen ? (
        <VersionDialog
          version={versionOpen.version}
          snapshot={versionOpen.snapshot}
          loading={versionOpen.loading}
          onRestore={() => void restore()}
          onClose={() => setVersionOpen(null)}
        />
      ) : null}
    </div>
  );
}
