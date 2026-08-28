"use client";

import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { ANALYSIS_STEPS, analysisStep, describeStatus, type StatusEvent } from "@/lib/podcast";

/** The episode-analysis pipeline's progress, from live SSE events or the last status.json. */
export default function StatusTimeline({
  events,
  latest,
  stalled,
  title = "Analysing the episode",
}: {
  events: StatusEvent[];
  latest: StatusEvent | null;
  stalled?: boolean;
  title?: string;
}) {
  const current = latest ?? events[events.length - 1] ?? null;
  const step = analysisStep(current);
  const failed = step === -1 || !!current?.error;
  const done = current?.node === "podcast_refine" && current.stage === "analyzed";
  const piece = typeof current?.piece === "number" ? (current.piece as number) : null;
  const pieces = typeof current?.pieces === "number" ? (current.pieces as number) : null;
  const percent = piece != null && pieces ? Math.round((piece / pieces) * 100) : null;

  return (
    <div className="rounded-lg border border-line bg-surface-raised p-5 shadow-elev-1">
      <div className="flex items-center justify-between gap-3">
        <span className="rr-eyebrow">{title}</span>
        <span className="truncate font-mono text-[11px] text-ink-dim">{describeStatus(current)}</span>
      </div>
      <ol className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-4">
        {ANALYSIS_STEPS.map((s, i) => {
          const isDone = done || i < step;
          const active = !done && !failed && i === step;
          const isError = failed && i === Math.max(0, step);
          return (
            <li key={s.key} className="flex items-center gap-2.5 text-sm">
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                  isDone
                    ? "border-ready bg-ready/15 text-ready"
                    : active
                    ? "border-accent bg-accent/10 text-accent"
                    : isError
                    ? "border-danger bg-danger/15 text-danger"
                    : "border-line text-ink-faint"
                }`}
              >
                {isDone ? <Check className="h-3 w-3" /> : active ? <Loader2 className="h-3 w-3 animate-spin" /> : isError ? <AlertTriangle className="h-3 w-3" /> : i + 1}
              </span>
              <span className={isDone || active ? "text-ink" : "text-ink-faint"}>{s.label}</span>
            </li>
          );
        })}
      </ol>
      {percent != null && !done && current?.stage === "transcribing" && (
        <div className="mt-3 flex items-center gap-3">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-overlay">
            <span className="block h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
          </span>
          <span className="font-mono text-[11px] text-ink-faint">{percent}% transcribed</span>
        </div>
      )}
      {failed && (
        <p className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[11px] text-danger">
          {String(current?.message ?? current?.error ?? "The pipeline reported an error.")}
        </p>
      )}
      {stalled && !failed && !done && (
        <p className="mt-3 font-mono text-[11px] text-processing">
          Last engine update was several minutes ago — see the note below to resume.
        </p>
      )}
    </div>
  );
}
