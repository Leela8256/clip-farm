"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { getRun, runKey, subscribeRun } from "@/lib/engine";
import { fmtTime, friendlyStatus, prettyTitle, runSummary, type Project, type RunStatus } from "@/lib/podcast";
import RunThumb from "./RunThumb";

const serverSnapshot = () => "";

/** The newest rendered thumbnail among the project's clips (previews first, exports as a fallback). */
function newestThumb(project: Project): { path: string; version: number } | null {
  let best: { path: string; version: number } | null = null;
  for (const clip of Object.values(project.clips ?? {})) {
    for (const render of [clip.preview, clip.export]) {
      const path = render?.files?.thumbnail;
      if (!path) continue;
      const version = render?.rendered_at ?? 0;
      if (!best || version > best.version) best = { path, version };
    }
  }
  return best;
}

const CHIP: Record<RunStatus, string> = {
  analysing: "bg-ready/10 text-ink",
  ready: "bg-ready/10 text-ready",
  failed: "bg-danger/10 text-danger",
  new: "bg-surface-overlay text-ink-faint",
};

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export default function RunRow({ project, index }: { project: Project; index: number }) {
  const key = runKey(project.episode_id);
  const subscribe = useCallback((fn: () => void) => subscribeRun(key, fn), [key]);
  const getSnapshot = useCallback(() => {
    const r = getRun(key);
    return r ? `${r.kind}|${r.events.length}|${r.done}|${r.error ?? ""}|${r.lost ? 1 : 0}` : "";
  }, [key]);
  useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);

  const run = getRun(key);
  const liveRun = run?.kind === "analysis" ? run : undefined;
  const live = !!liveRun && !liveRun.done;

  // Elapsed time ticks once a second while the analysis is running.
  const started = live && liveRun ? liveRun.started : null;
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (started == null) return;
    const tick = () => setElapsedMs(Date.now() - started);
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [started]);

  const summary = runSummary(project);
  let status: RunStatus = summary.status;
  let label = summary.label;
  if (live && liveRun) {
    status = "analysing";
    const latest = liveRun.events[liveRun.events.length - 1];
    label = `${friendlyStatus(latest)} · ${fmtTime(elapsedMs)}`;
  } else if (liveRun?.done && liveRun.error) {
    status = "failed";
    label = "failed";
  } else if (liveRun?.done && !liveRun.lost && summary.status !== "ready") {
    // Finished in this session; project.json is refreshed on the next load.
    const found = (liveRun.result as { candidates?: unknown[] } | undefined)?.candidates?.length ?? summary.moments;
    status = "ready";
    label = `ready · ${found} ${found === 1 ? "moment" : "moments"}`;
  }

  const title = prettyTitle(project.title || project.episode_id);
  const goal = project.settings?.goal?.trim();
  const thumb = newestThumb(project);
  const pills: string[] = [];
  if (project.media?.duration_ms) pills.push(fmtTime(project.media.duration_ms));
  if (project.media?.has_video && project.media.width && project.media.height) pills.push(`${project.media.width}×${project.media.height}`);
  if (project.created) pills.push(new Date(project.created * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }));

  return (
    <li className="rr-enter" style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}>
      <Link
        href={`/episode?id=${encodeURIComponent(project.episode_id)}`}
        className="rr-card rr-card-hover group flex items-center gap-4 p-3 pr-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <RunThumb path={thumb?.path} version={thumb?.version} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="truncate text-[15px] font-semibold text-ink">{title}</p>
            {pills.length > 0 && (
              <span className="flex flex-wrap items-center gap-1.5">
                {pills.map((p) => (
                  <span key={p} className="rounded-full bg-surface-overlay px-2 py-0.5 font-mono text-[11px] text-ink-dim">
                    {p}
                  </span>
                ))}
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-[13px] text-ink-faint" title={goal || undefined}>
            {goal ? `“${goal}”` : "No direction given"}
          </p>
        </div>
        <span className={`inline-flex max-w-[280px] shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium ${CHIP[status]}`} title={label}>
          {status === "analysing" && <i className="rr-dot-live h-1.5 w-1.5 shrink-0 rounded-full bg-ready" />}
          <span className="truncate">{capitalize(label)}</span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-ink" />
      </Link>
    </li>
  );
}
