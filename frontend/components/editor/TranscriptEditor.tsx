"use client";

import { useMemo } from "react";
import { fmtMs } from "@/lib/api";
import type { Transcript, Edl } from "@/lib/types";

/**
 * Renders the transcript at word level. Words inside cut ranges are shown
 * struck-through in red so the user can see exactly what the EDL removes.
 */
export default function TranscriptEditor({
  transcript,
  edl,
}: {
  transcript: Transcript;
  edl: Edl;
}) {
  const cuts = useMemo(
    () =>
      edl.edits
        .map((e) => ({ start: e.start_ms, end: e.end_ms }))
        .sort((a, b) => a.start - b.start),
    [edl]
  );

  const isCut = (start_ms: number, end_ms: number) =>
    cuts.some((c) => start_ms < c.end && end_ms > c.start);

  return (
    <div className="rounded-xl border border-line bg-surface-raised">
      <div className="border-b border-line px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-ink-faint">
        Transcript · {transcript.segments.length} segments
      </div>
      <div className="max-h-[560px] space-y-4 overflow-y-auto p-4">
        {transcript.segments.map((seg) => (
          <div key={seg.id} className="group">
            <div className="mb-1 font-mono text-[11px] text-ink-faint">
              {fmtMs(seg.start_ms)}
            </div>
            <p className="text-sm leading-7">
              {seg.words.length > 0
                ? seg.words.map((w, i) => (
                    <span
                      key={i}
                      className={
                        isCut(w.start_ms, w.end_ms)
                          ? "rounded-sm bg-cut/15 text-cut line-through decoration-cut/60"
                          : ""
                      }
                    >
                      {w.word}{" "}
                    </span>
                  ))
                : seg.text}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
