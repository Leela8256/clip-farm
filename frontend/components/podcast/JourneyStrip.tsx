"use client";

import { Check } from "lucide-react";

export const JOURNEY = ["Choose video", "Describe clips", "Review moments", "Edit & style", "Preview", "Export"] as const;

/**
 * Where the producer is in the six steps of making clips. It is a map, not a
 * wizard: the two steps that are places you can go (describing, reviewing) are
 * buttons, the rest simply show how far the work has got.
 */
export default function JourneyStrip({ step, onGo }: { step: number; onGo?: (index: number) => void }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-1.5" aria-label="How clips get made">
      {JOURNEY.map((label, i) => {
        const done = i < step;
        const here = i === step;
        const clickable = !!onGo && (i === 1 || i === 2);
        const inner = (
          <>
            <span
              aria-hidden="true"
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-medium ${
                done ? "bg-ready/15 text-ready" : here ? "bg-accent text-white" : "bg-surface-overlay text-ink-faint"
              }`}
            >
              {done ? <Check className="h-2.5 w-2.5" /> : i + 1}
            </span>
            <span className={here ? "font-medium text-ink" : done ? "text-ink-dim" : "text-ink-faint"}>{label}</span>
          </>
        );
        return (
          <li key={label} className="flex items-center gap-1">
            {clickable ? (
              <button
                type="button"
                onClick={() => onGo(i)}
                aria-current={here ? "step" : undefined}
                className="flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[12px] transition-colors hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {inner}
              </button>
            ) : (
              <span aria-current={here ? "step" : undefined} className="flex items-center gap-1.5 px-1.5 py-0.5 text-[12px]">
                {inner}
              </span>
            )}
            {i < JOURNEY.length - 1 && <span aria-hidden="true" className="h-px w-3 bg-line-strong sm:w-5" />}
          </li>
        );
      })}
    </ol>
  );
}
