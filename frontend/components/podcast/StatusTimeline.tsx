"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { analysisStep, describeStatus, fmtTime, type StatusEvent } from "@/lib/podcast";

const STEPS = ["Upload", "Transcribe", "Score", "Ready"] as const;

/** describeStatus() speaks in machine terms; this screen speaks in the producer's. */
const PLAIN: [RegExp, string][] = [
  [/^Waiting for the engine$/i, "Getting ready"],
  [/^Cutting the audio into pieces for the transcriber$/i, "Preparing the audio"],
  [/^Claude is scoring part (\d+) of (\d+)$/i, "Scoring part $1 of $2"],
  [/^Claude is scoring the moments$/i, "Scoring the moments"],
  [/^Indexing.*$/i, "Preparing transcript search"],
  [/^Transcript index ready.*$/i, "Transcript search ready"],
  [/(\d+) candidates ready/i, "$1 moments ready"],
  [/\bClaude\b/g, "The director"],
  [/\bengine\b/gi, "your library"],
  [/\bpipeline\b/gi, "analysis"],
  [/\bpodcast_/g, ""],
];

function plainStatus(evt: StatusEvent | null | undefined): string {
  let text = describeStatus(evt);
  for (const [re, to] of PLAIN) text = text.replace(re, to);
  return text;
}

/**
 * A slim stepper for the episode analysis: Upload → Transcribe → Score → Ready,
 * the current stage in words, elapsed time and a moving bar.
 */
export default function StatusTimeline({
  events,
  latest,
  stalled,
  title = "Analysing",
  startedAt,
}: {
  events: StatusEvent[];
  latest: StatusEvent | null;
  stalled?: boolean;
  title?: string;
  /** epoch ms the run began (for the elapsed counter) */
  startedAt?: number;
}) {
  const current = latest ?? events[events.length - 1] ?? null;
  const step = analysisStep(current);
  const failed = step === -1 || !!current?.error;
  const done = current?.node === "podcast_refine" && current.stage === "analyzed";
  const piece = typeof current?.piece === "number" ? (current.piece as number) : null;
  const pieces = typeof current?.pieces === "number" ? (current.pieces as number) : null;
  const percent = piece != null && pieces ? Math.round((piece / pieces) * 100) : null;
  const transcribing = !done && !failed && current?.stage === "transcribing";

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (done || failed) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [done, failed]);
  const firstEvent = events[0];
  const began = startedAt ?? (typeof firstEvent?.time === "number" ? firstEvent.time * 1000 : typeof current?.time === "number" ? current.time * 1000 : null);
  const elapsed = began ? Math.max(0, now - began) : null;

  const stage = Math.max(0, step);
  const indeterminate = !done && !failed && stage === 0;
  const width = done ? 100 : failed ? [10, 40, 80, 100][stage] : transcribing && percent != null ? 12 + percent * 0.62 : [8, 20, 82, 100][stage];
  const text = plainStatus(current);

  return (
    <div className="rr-card rr-enter px-4 pb-3.5 pt-3" role="status" aria-live="polite" aria-label={title}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <ol className="flex items-center">
          {STEPS.map((label, i) => {
            const isDone = done || i < stage;
            const active = !done && !failed && i === stage;
            const isError = failed && i === stage;
            return (
              <li key={label} className="flex items-center">
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium transition-colors ${
                    isDone ? "bg-ready/15 text-ready" : active ? "bg-accent/10 text-accent" : isError ? "bg-danger/15 text-danger" : "bg-surface-overlay text-ink-faint"
                  }`}
                >
                  {isDone ? <Check className="h-3 w-3" /> : active ? <Loader2 className="h-3 w-3 animate-spin" /> : isError ? <AlertTriangle className="h-3 w-3" /> : i + 1}
                </span>
                <span className={`ml-1.5 text-xs font-medium ${isDone || active ? "text-ink" : isError ? "text-danger" : "text-ink-faint"}`}>{label}</span>
                {i < STEPS.length - 1 && <span className={`mx-2.5 h-px w-4 sm:w-6 ${isDone ? "bg-ready/60" : "bg-line-strong"}`} />}
              </li>
            );
          })}
        </ol>
        <span className={`min-w-0 flex-1 truncate text-sm ${failed ? "text-danger" : "text-ink-dim"}`} title={text}>
          {text}
          {stalled && !failed && !done && <span className="ml-2 text-xs text-processing">· no news for a while</span>}
        </span>
        {elapsed != null && (
          <span className="font-mono text-[11px] tabular-nums text-ink-faint" title="elapsed">
            {fmtTime(elapsed)}
          </span>
        )}
      </div>
      <div className="rr-progress mt-3" data-indeterminate={indeterminate ? "true" : "false"}>
        <i className={!done && !failed && !indeterminate && !(transcribing && percent != null) ? "animate-pulse" : ""} style={{ width: `${width}%`, background: failed ? "var(--rr-danger)" : done ? "var(--rr-ready)" : undefined }} />
      </div>
      {transcribing && percent != null && <p className="mt-1.5 text-right font-mono text-[11px] text-ink-faint">{percent}% transcribed</p>}
    </div>
  );
}
