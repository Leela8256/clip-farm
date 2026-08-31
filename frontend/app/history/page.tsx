"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { RefreshCw, Search, Upload, X } from "lucide-react";
import { getClient, getConnectionState, listDir, readJsonOr, subscribeConnection } from "@/lib/engine";
import { prettyTitle, projectRoot, type Project } from "@/lib/podcast";
import RunRow from "@/components/history/RunRow";
import HistorySkeleton from "@/components/history/HistorySkeleton";

const serverState = () => "idle" as const;

type SortKey = "newest" | "oldest" | "title";

const titleOf = (p: Project) => prettyTitle(p.title || p.episode_id);

export default function HistoryPage() {
  const connection = useSyncExternalStore(subscribeConnection, getConnectionState, serverState);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");

  // Open the connection on arrival and keep knocking while it is down.
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
      setProjects(loaded.filter((p): p is Project => !!p));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connection !== "connected") return;
    const timer = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(timer);
  }, [connection, refresh]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (projects ?? []).filter((p) => !q || titleOf(p).toLowerCase().includes(q) || (p.settings?.goal ?? "").toLowerCase().includes(q));
    const created = (p: Project) => p.created ?? 0;
    return [...list].sort((a, b) => (sort === "newest" ? created(b) - created(a) : sort === "oldest" ? created(a) - created(b) : titleOf(a).localeCompare(titleOf(b))));
  }, [projects, query, sort]);

  return (
    <div className="mx-auto max-w-4xl">
      <header className="rr-enter flex items-end justify-between gap-4">
        <div>
          <h1 className="rr-h1">History</h1>
          <p className="mt-2 text-ink-dim">Every episode you&apos;ve run</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={connection !== "connected" || loading}
          aria-label="Refresh"
          title="Refresh"
          className="rr-btn rr-btn-ghost rr-btn-icon"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </header>

      <div className="rr-enter mt-6 flex flex-col gap-3 sm:flex-row sm:items-center" style={{ animationDelay: "60ms" }}>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            className="rr-input pl-9"
            placeholder="Search by title or direction"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search runs"
          />
        </div>
        <select className="rr-select sm:w-44" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort runs">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="title">By title</option>
        </select>
      </div>

      <div className="mt-6">
        {projects === null ? (
          <>
            <HistorySkeleton rows={4} />
            {connection === "error" && <p className="mt-4 text-center text-[13px] text-ink-faint">Still connecting… your runs will appear as soon as the dot in the sidebar turns green.</p>}
          </>
        ) : projects.length === 0 ? (
          <div className="rr-card rr-enter flex flex-col items-center px-6 py-14 text-center">
            <p className="text-lg font-medium text-ink">No runs yet</p>
            <p className="mt-1 text-[13px] text-ink-faint">Your episodes will show up here once you&apos;ve run one.</p>
            <Link href="/" className="rr-btn rr-btn-primary mt-5">
              <Upload className="h-4 w-4 text-accent" />
              Upload an episode
            </Link>
          </div>
        ) : visible.length === 0 ? (
          <div className="rr-card rr-enter flex flex-col items-center px-6 py-12 text-center">
            <p className="text-ink">Nothing matches &ldquo;{query.trim()}&rdquo;</p>
            <button type="button" onClick={() => setQuery("")} className="rr-btn rr-btn-sm mt-4">
              <X className="h-3.5 w-3.5" />
              Clear search
            </button>
          </div>
        ) : (
          <ul className="space-y-3">
            {visible.map((p, i) => (
              <RunRow key={p.episode_id} project={p} index={i} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
