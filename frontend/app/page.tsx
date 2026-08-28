"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clock, FolderOpen, RefreshCw } from "lucide-react";
import { getConnectionState, listDir, readJsonOr, runAnalysis, runKey, startRun, subscribeConnection, uploadFile, writeJson } from "@/lib/engine";
import { episodeIdFor, fmtTime, projectRoot, safeName, type Project } from "@/lib/podcast";
import EngineBadge from "@/components/podcast/EngineBadge";
import NewEpisodeForm, { type NewEpisodeInput } from "@/components/podcast/NewEpisodeForm";

const PIPELINES = [
  ["episode-analysis", "podcast_ingest → audio_transcribe → podcast_segment → llm_anthropic → podcast_refine"],
  ["clip-preview", "podcast_prepare_clip → podcast_render (fast 9:16 preview)"],
  ["clip-export", "podcast_prepare_clip → podcast_render (1080×1920 + 1920×1080, SRT/VTT)"],
] as const;

const serverState = () => "idle" as const;

function statusOf(p: Project): { label: string; tone: string } {
  const s = p.analysis?.status;
  if (s === "analyzed") return { label: `${p.analysis?.candidates ?? 0} candidates`, tone: "text-ready" };
  if (s === "analyzing") return { label: "analysing…", tone: "text-processing" };
  return { label: "not analysed", tone: "text-ink-faint" };
}

export default function LibraryPage() {
  const router = useRouter();
  const connection = useSyncExternalStore(subscribeConnection, getConnectionState, serverState);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<"idle" | "uploading" | "creating">("idle");
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const entries = await listDir("projects");
      const dirs = entries.filter((e) => e.type === "dir" || e.type === "directory");
      const loaded = await Promise.all(
        dirs.map(async (d) => {
          const p = await readJsonOr<Project | null>(`${projectRoot(d.name)}/project.json`, null);
          return p ? { ...p, episode_id: p.episode_id || d.name } : null;
        })
      );
      setProjects(loaded.filter((p): p is Project => !!p).sort((a, b) => (b.created ?? 0) - (a.created ?? 0)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connection !== "connected") return;
    const timer = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(timer);
  }, [connection, refresh]);

  const create = async (input: NewEpisodeInput) => {
    setError(null);
    setPhase("uploading");
    setPercent(0);
    const id = episodeIdFor(input.file.name);
    const root = projectRoot(id);
    try {
      const source = await uploadFile(`${root}/source/${safeName(input.file.name)}`, input.file, (sent, total) => setPercent(Math.round((sent / total) * 100)));
      setPhase("creating");
      const project: Project = {
        episode_id: id,
        title: input.file.name.replace(/\.[^.]+$/, ""),
        source,
        created: Date.now() / 1000,
        settings: { goal: input.goal, clip_count: input.clipCount, min_seconds: input.minSeconds, max_seconds: input.maxSeconds },
        analysis: { status: "analyzing", started_at: Date.now() / 1000 },
      };
      await writeJson(`${root}/project.json`, project);
      startRun(runKey(id), "analysis", (onProgress) => runAnalysis(id, input.goal, onProgress));
      router.push(`/episode?id=${encodeURIComponent(id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  };

  return (
    <div className="space-y-10">
      <section className="max-w-3xl">
        <div className="flex flex-wrap items-center gap-3">
          <p className="rr-eyebrow">Podcast → promo clips</p>
          <EngineBadge />
        </div>
        <h1 className="rr-display mt-3">
          Find the <span className="rr-underline">moments</span>. Cut the clips. Ship them.
        </h1>
        <p className="mt-4 max-w-2xl text-base text-ink-dim">
          Upload a raw episode. RocketRide transcribes it, Claude proposes explainable candidates, and every preview and
          export renders on the engine — no backend of ours, just three pipelines and your file store.
        </p>
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <NewEpisodeForm busy={phase !== "idle"} phase={phase} percent={percent} canRun={connection === "connected"} onSubmit={(input) => void create(input)} />
          {error && <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[11px] text-danger">{error}</p>}
        </div>
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <div className="rounded-lg border border-line bg-surface-raised p-5 shadow-elev-1">
            <span className="rr-eyebrow">Runs on RocketRide</span>
            <ol className="mt-4 space-y-3">
              {PIPELINES.map(([name, chain], i) => (
                <li key={name} className="flex gap-3">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line font-mono text-[10px] text-ink-faint">{i + 1}</span>
                  <div>
                    <p className="font-mono text-xs text-ink">{name}.pipe</p>
                    <p className="text-xs text-ink-dim">{chain}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">
              Stock nodes do the transcription and the LLM call; five small custom nodes handle the podcast-specific glue.
              Projects live in your account store under projects/&lt;episode&gt;/.
            </p>
          </div>
        </aside>
      </section>

      <section>
        <div className="flex items-center justify-between">
          <div>
            <p className="rr-eyebrow">Library</p>
            <h2 className="rr-h2 mt-1">Episodes in your RocketRide store</h2>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={connection !== "connected" || loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim hover:bg-surface-overlay disabled:opacity-40"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> refresh
          </button>
        </div>
        {projects.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-line-strong px-5 py-8 text-center text-sm text-ink-faint">
            {connection === "connected" ? (loading ? "Reading your store…" : "No episodes yet — analyse one above.") : "Waiting for the engine."}
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-line rounded-lg border border-line bg-surface-raised shadow-elev-1">
            {projects.map((p) => {
              const status = statusOf(p);
              return (
                <li key={p.episode_id}>
                  <Link href={`/episode?id=${encodeURIComponent(p.episode_id)}`} className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-surface-overlay">
                    <FolderOpen className="h-4 w-4 shrink-0 text-ink-faint" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{p.title || p.episode_id}</p>
                      <p className="truncate font-mono text-[11px] text-ink-faint">
                        {p.media?.duration_ms ? `${fmtTime(p.media.duration_ms)} · ` : ""}
                        {p.settings?.goal ? `“${p.settings.goal.slice(0, 80)}${p.settings.goal.length > 80 ? "…" : ""}”` : "no direction"}
                      </p>
                    </div>
                    <span className={`font-mono text-[11px] ${status.tone}`}>{status.label}</span>
                    {p.created && (
                      <span className="hidden items-center gap-1 font-mono text-[11px] text-ink-faint sm:flex">
                        <Clock className="h-3 w-3" /> {new Date(p.created * 1000).toLocaleDateString()}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
