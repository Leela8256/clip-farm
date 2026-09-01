"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Archive, ArchiveRestore, Crop, FolderPlus, MoreHorizontal, Palette, PencilLine, Scissors, Sparkles } from "lucide-react";
import { getRun, runKey, subscribeRun } from "@/lib/engine";
import { fmtTime, friendlyStatus, type RunStatus } from "@/lib/podcast";
import type { ProjectSummary } from "@/lib/library";
import ProjectThumb from "./ProjectThumb";

const serverSnapshot = () => "";

const CHIP: Record<RunStatus, string> = {
  analysing: "bg-processing/10 text-ink",
  ready: "bg-ready/10 text-ready",
  failed: "bg-danger/10 text-danger",
  new: "bg-surface-overlay text-ink-faint",
};

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export interface CardActions {
  onSelect?: (id: string, on: boolean) => void;
  onRename: (s: ProjectSummary) => void;
  onArchive: (s: ProjectSummary) => void;
  onTemplate: (s: ProjectSummary) => void;
  onCollection: (s: ProjectSummary) => void;
}

export default function ProjectCard({
  summary,
  index,
  selecting = false,
  selected = false,
  templateName,
  ...actions
}: { summary: ProjectSummary; index: number; selecting?: boolean; selected?: boolean; templateName?: string } & CardActions) {
  const key = runKey(summary.id);
  const subscribe = useCallback((fn: () => void) => subscribeRun(key, fn), [key]);
  const getSnapshot = useCallback(() => {
    const r = getRun(key);
    return r ? `${r.kind}|${r.events.length}|${r.done}|${r.error ?? ""}|${r.lost ? 1 : 0}` : "";
  }, [key]);
  useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);

  const run = getRun(key);
  const liveRun = run?.kind === "analysis" ? run : undefined;
  const live = !!liveRun && !liveRun.done;

  // Elapsed time ticks once a second while the recording is being read.
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

  const [menu, setMenu] = useState(false);

  let status: RunStatus = summary.status;
  let label = summary.statusLabel;
  if (live && liveRun) {
    status = "analysing";
    label = `${friendlyStatus(liveRun.events[liveRun.events.length - 1])} · ${fmtTime(elapsedMs)}`;
  } else if (liveRun?.done && liveRun.error) {
    status = "failed";
    label = "something went wrong";
  } else if (liveRun?.done && !liveRun.lost && summary.status !== "ready") {
    status = "ready";
    label = "ready";
  }

  const ready = status === "ready";
  const facts = [
    summary.created ? new Date(summary.created * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "",
    summary.durationMs ? fmtTime(summary.durationMs) : "",
    summary.hasVideo && summary.width && summary.height ? `${summary.width}×${summary.height}` : summary.hasVideo ? "" : "Audio only",
  ].filter(Boolean);

  const act = (fn: () => void) => () => {
    setMenu(false);
    fn();
  };

  return (
    <li className="rr-enter" style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}>
      <div className={`rr-card rr-card-hover relative flex h-full flex-col overflow-hidden ${selected ? "ring-2 ring-accent" : ""} ${summary.archived ? "opacity-75" : ""}`}>
        {selecting && (
          <label className="absolute left-3 top-3 z-10 flex cursor-pointer items-center gap-2 rounded-full bg-surface-raised/95 px-2.5 py-1.5 text-[12px] font-medium shadow-elev-1">
            <input
              type="checkbox"
              checked={selected}
              onChange={(e) => actions.onSelect?.(summary.id, e.target.checked)}
              aria-label={`Choose ${summary.title}`}
              className="h-3.5 w-3.5 accent-[color:var(--rr-accent)]"
            />
            {selected ? "Chosen" : "Choose"}
          </label>
        )}

        <Link href={`/episode?id=${encodeURIComponent(summary.id)}`} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" title={`Open ${summary.title}`}>
          <ProjectThumb path={summary.thumbnail?.path} version={summary.thumbnail?.version} className="aspect-video w-full" />
        </Link>

        <div className="flex flex-1 flex-col gap-3 p-4">
          <div className="min-w-0">
            <div className="flex items-start justify-between gap-2">
              <p className="truncate text-[15px] font-semibold text-ink" title={summary.title}>
                {summary.title}
              </p>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${CHIP[status]}`} title={label}>
                {status === "analysing" && <i className="rr-dot-live mr-1 inline-block h-1.5 w-1.5 rounded-full bg-processing align-middle" />}
                {capitalize(status === "ready" ? "Ready" : status === "analysing" ? "Reading" : status === "failed" ? "Needs a retry" : "Not read yet")}
              </span>
            </div>
            <p className="mt-1 truncate font-mono text-[11px] text-ink-faint">{facts.join(" · ") || "No details yet"}</p>
            <p className="mt-1 truncate text-[12px] text-ink-dim" title={label}>
              {capitalize(label)}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {summary.clips > 0 && (
              <span className="rounded-full bg-surface-overlay px-2 py-0.5 text-[11px] text-ink-dim">
                {summary.clips} {summary.clips === 1 ? "clip" : "clips"}
              </span>
            )}
            {summary.episodeExport ? (
              <span className="rounded-full bg-ready/10 px-2 py-0.5 text-[11px] text-ready">Full episode ready</span>
            ) : (
              <span className="rounded-full bg-surface-overlay px-2 py-0.5 text-[11px] text-ink-faint">No full episode yet</span>
            )}
            {templateName && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent">{templateName}</span>}
            {summary.archived && <span className="rounded-full bg-surface-overlay px-2 py-0.5 text-[11px] text-ink-faint">Archived</span>}
          </div>

          <div className="mt-auto flex items-center gap-2 pt-1">
            <Link
              href={`/episode?id=${encodeURIComponent(summary.id)}`}
              className="rr-btn rr-btn-primary rr-btn-sm flex-1"
              title={ready ? "Describe the clips you want" : "Open this recording"}
            >
              <Scissors className="h-3.5 w-3.5 text-accent" />
              Create clips
            </Link>
            <Link href={`/studio?id=${encodeURIComponent(summary.id)}`} className="rr-btn rr-btn-sm flex-1" title="Turn the raw recording into a finished episode">
              <Sparkles className="h-3.5 w-3.5" />
              Full episode
            </Link>
            <div className="relative">
              <button
                type="button"
                className="rr-btn rr-btn-sm rr-btn-icon"
                aria-label={`More for ${summary.title}`}
                aria-expanded={menu}
                onClick={() => setMenu((m) => !m)}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {menu && (
                <>
                  <button type="button" aria-label="Close menu" className="fixed inset-0 z-20 cursor-default" onClick={() => setMenu(false)} />
                  <div className="rr-card absolute bottom-full right-0 z-30 mb-2 w-56 overflow-hidden p-1" style={{ boxShadow: "var(--rr-shadow-2)" }} role="menu">
                    <Link href={`/reframe?id=${encodeURIComponent(summary.id)}`} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-ink hover:bg-surface-overlay" role="menuitem">
                      <Crop className="h-3.5 w-3.5 text-ink-faint" />
                      Reframe for another platform
                    </Link>
                    <button type="button" role="menuitem" onClick={act(() => actions.onTemplate(summary))} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-ink hover:bg-surface-overlay">
                      <Palette className="h-3.5 w-3.5 text-ink-faint" />
                      Use a brand look
                    </button>
                    <button type="button" role="menuitem" onClick={act(() => actions.onCollection(summary))} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-ink hover:bg-surface-overlay">
                      <FolderPlus className="h-3.5 w-3.5 text-ink-faint" />
                      Add to a collection
                    </button>
                    <button type="button" role="menuitem" onClick={act(() => actions.onRename(summary))} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-ink hover:bg-surface-overlay">
                      <PencilLine className="h-3.5 w-3.5 text-ink-faint" />
                      Rename
                    </button>
                    <button type="button" role="menuitem" onClick={act(() => actions.onArchive(summary))} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-ink hover:bg-surface-overlay">
                      {summary.archived ? <ArchiveRestore className="h-3.5 w-3.5 text-ink-faint" /> : <Archive className="h-3.5 w-3.5 text-ink-faint" />}
                      {summary.archived ? "Put back in the library" : "Archive"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}
