"use client";

import { Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Loader2, Sparkles, TriangleAlert, UserRound } from "lucide-react";
import { getClient, getConnectionState, listDir, mediaUrl, readJsonOr, runReframe, subscribeConnection } from "@/lib/engine";
import {
  LAYOUT_MODES,
  describeStatus,
  fmtTime,
  prettyTitle,
  previewFile,
  projectRoot,
  toCandidates,
  toSentences,
  type Candidate,
  type LayoutPerson,
  type Project,
  type RenderReport,
  type Sentence,
  type StatusEvent,
} from "@/lib/podcast";
import type { DirectorRequest } from "@/lib/director";
import { toast } from "@/components/shell/Toasts";
import TranscriptPanel from "@/components/podcast/TranscriptPanel";
import SourcePicker, { type SourceMode } from "@/components/reframe/SourcePicker";
import ResultCard, { type ReframeResult } from "@/components/reframe/ResultCard";

const serverState = () => "idle" as const;
const ASPECTS = ["9:16", "4:5", "1:1", "16:9"] as const;
const ASPECT_HINTS: Record<string, string> = {
  "9:16": "Reels, Shorts, TikTok",
  "4:5": "Instagram and LinkedIn feed",
  "1:1": "Square feed posts",
  "16:9": "YouTube and websites",
};
const DEFAULT_RANGE = { start_ms: 0, end_ms: 60_000 };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function ReframePage() {
  return (
    <Suspense fallback={null}>
      <Reframe />
    </Suspense>
  );
}

function Reframe() {
  const id = useSearchParams().get("id") ?? "";
  const root = projectRoot(id);
  const connection = useSyncExternalStore(subscribeConnection, getConnectionState, serverState);

  const [project, setProject] = useState<Project | null>(null);
  const [missing, setMissing] = useState(false);
  const [clips, setClips] = useState<Candidate[]>([]);
  const [loadingClips, setLoadingClips] = useState(true);
  const [sentences, setSentences] = useState<Sentence[] | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);

  const [mode, setMode] = useState<SourceMode>("clip");
  const [clipId, setClipId] = useState<string | null>(null);
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [aspects, setAspects] = useState<string[]>(["9:16"]);
  const [layoutMode, setLayoutMode] = useState("auto");
  const [subject, setSubject] = useState<string | null>(null);

  const [results, setResults] = useState<Record<string, ReframeResult>>({});
  const [running, setRunning] = useState<{ aspect: string; done: number; total: number } | null>(null);
  const [event, setEvent] = useState<StatusEvent | null>(null);
  const [people, setPeople] = useState<LayoutPerson[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  // keep knocking while the connection is down
  useEffect(() => {
    if (connection === "connected") return;
    const kick = () => void getClient().catch(() => {});
    const first = setTimeout(kick, 0);
    const retry = setInterval(kick, 5000);
    return () => {
      clearTimeout(first);
      clearInterval(retry);
    };
  }, [connection]);

  const load = useCallback(async () => {
    const p = await readJsonOr<Project | null>(`${root}/project.json`, null);
    if (!p) {
      setMissing(true);
      setLoadingClips(false);
      return;
    }
    setMissing(false);
    setProject({ ...p, episode_id: p.episode_id || id });
    const [cands, entries] = await Promise.all([readJsonOr<unknown>(`${root}/analysis/candidates.json`, null), listDir(`${root}/analysis/requests`)]);
    const names = entries.map((e) => e.name).filter((n) => /^r\d+\.json$/.test(n)).sort();
    const requests = await Promise.all(names.map((n) => readJsonOr<DirectorRequest | null>(`${root}/analysis/requests/${n}`, null)));
    const directed = requests.filter((r): r is DirectorRequest => !!r && typeof r.request_id === "string").flatMap((r) => toCandidates(r));
    const found = toCandidates(cands);
    const list = [...found, ...directed];
    setClips(list);
    setLoadingClips(false);
    setClipId((current) => current ?? list[0]?.id ?? null);
    const duration = p.media?.duration_ms ?? 0;
    if (duration) setRange((r) => (r === DEFAULT_RANGE ? { start_ms: 0, end_ms: Math.min(60_000, duration) } : r));
  }, [id, root]);

  useEffect(() => {
    if (connection !== "connected" || !id) return;
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [connection, id, load]);

  const openTranscript = useCallback(async () => {
    if (sentences || transcriptLoading) return;
    setTranscriptLoading(true);
    try {
      const doc = await readJsonOr<unknown>(`${root}/analysis/transcript.json`, null);
      setSentences(toSentences(doc));
    } finally {
      setTranscriptLoading(false);
    }
  }, [root, sentences, transcriptLoading]);

  useEffect(() => {
    if (mode !== "transcript") return;
    const timer = setTimeout(() => void openTranscript(), 0);
    return () => clearTimeout(timer);
  }, [mode, openTranscript]);

  const durationMs = project?.media?.duration_ms ?? 0;
  const chosenClip = clips.find((c) => c.id === clipId) ?? null;
  const source = useMemo(() => {
    if (mode === "clip") return chosenClip ? { clipId: chosenClip.id, label: chosenClip.title } : null;
    if (range.end_ms - range.start_ms < 3000) return null;
    return { start_ms: range.start_ms, end_ms: range.end_ms, label: `${fmtTime(range.start_ms)} → ${fmtTime(range.end_ms)}` };
  }, [mode, chosenClip, range]);

  const toggleAspect = (aspect: string) => setAspects((prev) => (prev.includes(aspect) ? prev.filter((a) => a !== aspect) : [...prev, aspect]));

  /** The people a finished render found on screen, so the next one can follow one of them. */
  const rememberPeople = (report: RenderReport) => {
    const found = report.layout?.people ?? [];
    if (found.length) setPeople(found);
    const entries = Object.entries(report.layout?.thumbnails ?? {});
    if (!entries.length) return;
    void Promise.all(entries.map(async ([pid, path]) => [pid, await mediaUrl(path, report.rendered_at)] as const))
      .then((pairs) => setThumbs((prev) => ({ ...prev, ...Object.fromEntries(pairs) })))
      .catch(() => {});
  };

  const runOne = async (aspect: string, at: { done: number; total: number }) => {
    if (!source) return;
    setRunning({ aspect, ...at });
    setResults((prev) => ({ ...prev, [aspect]: { aspect } }));
    try {
      const report = await runReframe(
        id,
        {
          clipId: "clipId" in source ? source.clipId : undefined,
          start_ms: "start_ms" in source ? source.start_ms : undefined,
          end_ms: "end_ms" in source ? source.end_ms : undefined,
          aspect,
          layoutMode,
          subject,
        },
        (evt) => setEvent(evt)
      );
      if (report.error) throw new Error(report.error);
      const file = previewFile(report);
      const url = file ? await mediaUrl(file.path, report.rendered_at) : null;
      setResults((prev) => ({ ...prev, [aspect]: { aspect, report, url, name: file?.path.split("/").pop() ?? `${id}-${aspect}.mp4` } }));
      rememberPeople(report);
    } catch (e) {
      setResults((prev) => ({ ...prev, [aspect]: { aspect, error: errorText(e) } }));
    }
  };

  const run = async () => {
    if (!source || !aspects.length || running) return;
    setEvent(null);
    for (let i = 0; i < aspects.length; i++) await runOne(aspects[i], { done: i, total: aspects.length });
    setRunning(null);
    setEvent(null);
    toast(aspects.length === 1 ? "Your new shape is ready" : `${aspects.length} shapes ready`, "ok");
  };

  const ready = connection === "connected" && !!source && aspects.length > 0 && !running;
  const resultList = aspects.map((a) => results[a]).filter((r): r is ReframeResult => !!r);

  if (!id) {
    return (
      <div className="rr-card rr-enter mx-auto mt-10 max-w-md px-6 py-12 text-center">
        <p className="rr-h3">Pick a recording first</p>
        <p className="mt-1 text-sm text-ink-faint">Open one from your projects and choose &ldquo;AI Reframe&rdquo;.</p>
        <Link href="/projects" className="rr-btn rr-btn-primary mt-5">
          Open my projects
        </Link>
      </div>
    );
  }

  if (missing) {
    return (
      <div className="rr-card rr-enter mx-auto mt-10 max-w-md px-6 py-12 text-center">
        <p className="rr-h3">We can&apos;t find that recording</p>
        <p className="mt-1 text-sm text-ink-faint">It may have been removed from your library.</p>
        <Link href="/projects" className="rr-btn rr-btn-primary mt-5">
          Open my projects
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="rr-eyebrow">AI Reframe</p>
          <h1 className="rr-h2 mt-1 truncate">{project ? prettyTitle(project.title || id) : "Re-shape a moment"}</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-dim">
            Make a moment fit another platform: the picture follows whoever is speaking, in the shape you ask for.
          </p>
        </div>
        {project && (
          <Link href={`/episode?id=${encodeURIComponent(id)}`} className="rr-btn rr-btn-ghost rr-btn-sm">
            Create clips
          </Link>
        )}
      </header>

      {connection !== "connected" && (
        <div className="flex items-center gap-2 rounded-md border border-processing/40 bg-processing/10 px-3.5 py-2.5 text-sm text-ink">
          <TriangleAlert className="h-4 w-4 shrink-0 text-processing" /> Waiting for your library to come back — re-shaping needs it.
        </div>
      )}

      {project && project.analysis?.status !== "analyzed" && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface-raised px-3.5 py-2.5 text-sm text-ink-dim">
          <span className="min-w-0 flex-1">This recording hasn&apos;t been gone through yet, so there are no clips or transcript to pick from — a stretch of time still works.</span>
          <Link href={`/episode?id=${encodeURIComponent(id)}`} className="rr-btn rr-btn-sm">
            Go through it
          </Link>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          <SourcePicker
            mode={mode}
            onMode={setMode}
            clips={clips}
            clipId={clipId}
            onClip={setClipId}
            range={range}
            onRange={setRange}
            durationMs={durationMs}
            loading={loadingClips}
          />

          {mode === "transcript" && (
            <TranscriptPanel
              sentences={sentences}
              loading={transcriptLoading}
              highlight={range}
              startOpen
              actionLabel="Use this moment"
              onOpen={() => void openTranscript()}
              onMakeClip={(start_ms, end_ms) => setRange({ start_ms, end_ms })}
            />
          )}

          {resultList.length > 0 && (
            <section className="space-y-3">
              <h2 className="rr-h3">The new shapes</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {resultList.map((r) => (
                  <ResultCard key={r.aspect} result={r} running={running?.aspect === r.aspect} onRetry={() => void runOne(r.aspect, { done: 0, total: 1 }).then(() => setRunning(null))} />
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="min-w-0 space-y-4 lg:sticky lg:top-6 lg:self-start">
          <section className="rr-card p-4">
            <h2 className="rr-h3">Shapes</h2>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {ASPECTS.map((a) => (
                <button key={a} type="button" onClick={() => toggleAspect(a)} data-active={aspects.includes(a)} className="rr-chip" title={ASPECT_HINTS[a]}>
                  {a}
                </button>
              ))}
            </div>

            <div className="rr-field mt-4">
              <span className="rr-label">Framing</span>
              <select value={layoutMode} onChange={(e) => setLayoutMode(e.target.value)} className="rr-select rr-select-sm" aria-label="Framing">
                {LAYOUT_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-4">
              <span className="rr-label">Who to follow</span>
              {people.length === 0 ? (
                <p className="mt-1 text-[12px] leading-5 text-ink-faint">
                  Whoever is speaking. After the first shape is made, the people found on screen appear here to choose from.
                </p>
              ) : (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <button type="button" onClick={() => setSubject(null)} data-active={subject == null} className="rr-chip">
                    whoever speaks
                  </button>
                  {people.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setSubject(subject === p.id ? null : p.id)}
                      aria-pressed={subject === p.id}
                      title={`On screen ${Math.round(p.coverage * 100)}% of the time`}
                      className={`flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-[12px] transition-colors ${
                        subject === p.id ? "border-accent bg-accent/10 text-accent" : "border-line text-ink-dim hover:border-line-strong hover:text-ink"
                      }`}
                    >
                      <span className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-surface-overlay">
                        {thumbs[p.id] ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={thumbs[p.id]} alt={p.id} className="h-full w-full object-cover" />
                        ) : (
                          <UserRound className="h-3.5 w-3.5" />
                        )}
                      </span>
                      <span className="font-mono text-[11px]">{p.id}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-4 border-t border-line pt-3">
              <p className="truncate text-[12px] text-ink-dim" title={source?.label}>
                {source ? source.label : mode === "clip" ? "Pick a clip to re-shape" : "Pick a moment at least three seconds long"}
              </p>
              {mode === "clip" && source && <p className="mt-1 text-[11px] leading-4 text-ink-faint">This becomes that clip&apos;s preview in Create Clips.</p>}
              <button type="button" onClick={() => void run()} disabled={!ready} className="rr-btn rr-btn-primary mt-2.5 w-full">
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 text-accent" />}
                {running ? `Re-shaping ${running.aspect}…` : aspects.length > 1 ? `Re-shape in ${aspects.length} shapes` : "Re-shape it"}
              </button>
              {running && (
                <div className="mt-2.5">
                  <div className="rr-progress" data-indeterminate="true">
                    <i />
                  </div>
                  <p className="mt-1.5 truncate text-[12px] text-ink-dim">
                    {event ? describeStatus(event) : "Getting ready"} · {running.done + 1} of {running.total}
                  </p>
                </div>
              )}
            </div>
          </section>

          <p className="px-1 text-[11px] leading-5 text-ink-faint">
            One moment at a time, up to a few minutes long. Re-shaping a whole recording end to end isn&apos;t offered yet — a long one has to be
            worked through in pieces, and that is still being built. Each shape is made on its own, so the same moment is looked at again for
            every shape you ask for.
          </p>
        </aside>
      </div>
    </div>
  );
}
