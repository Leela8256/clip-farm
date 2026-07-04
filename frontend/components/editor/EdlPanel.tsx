"use client";

import { Loader2, Play, Scissors } from "lucide-react";
import { fmtMs } from "@/lib/api";
import type { Edl } from "@/lib/types";

const SOURCE_STYLES: Record<string, string> = {
  auto: "text-ink-faint",
  agent: "text-accent",
  user: "text-keep",
};

export default function EdlPanel({
  edl,
  onRender,
  rendering,
  stage,
}: {
  edl: Edl;
  onRender: () => void;
  rendering: boolean;
  stage?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface-raised">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="text-xs font-medium uppercase tracking-wider text-ink-faint">
          Edit decision list
        </span>
        <span className="font-mono text-[11px] text-ink-dim">
          {fmtMs(edl.stats.output_duration_ms)} output
        </span>
      </div>

      <div className="max-h-64 overflow-y-auto">
        {edl.edits.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-ink-faint">
            No cuts yet. Ask the editor to make changes.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {edl.edits.map((e) => (
              <li key={e.id} className="flex items-start gap-2 px-4 py-2.5 text-xs">
                <Scissors className="mt-0.5 h-3 w-3 shrink-0 text-cut" />
                <div className="min-w-0">
                  <span className="font-mono text-ink-dim">
                    {fmtMs(e.start_ms)}–{fmtMs(e.end_ms)}
                  </span>
                  <span className="ml-2 text-ink">{e.reason}</span>
                  <span className={`ml-2 ${SOURCE_STYLES[e.source]}`}>{e.source}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-line p-3">
        <button
          onClick={onRender}
          disabled={rendering}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-dim disabled:opacity-50"
        >
          {rendering ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {stage ? `${stage}…` : "Rendering…"}
            </>
          ) : (
            <>
              <Play className="h-4 w-4" /> Render final episode
            </>
          )}
        </button>
        <p className="mt-2 text-center text-[11px] text-ink-faint">
          Applies cuts with crossfades, masters, adds intro/outro
        </p>
      </div>
    </div>
  );
}
