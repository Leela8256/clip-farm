"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import { fmtMs } from "@/lib/api";
import type { Edl } from "@/lib/types";

/**
 * Waveform view of the original upload with EDL cut regions overlaid in red,
 * so you can see exactly what the edit list removes before rendering. Uses
 * wavesurfer.js (already a project dep). Regions are redrawn whenever the EDL
 * changes — e.g. after a chat-editing turn adds or removes a cut.
 */
export default function WaveformPlayer({ src, edl }: { src: string; edl: Edl | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);

  // Initialise wavesurfer once per src
  useEffect(() => {
    if (!containerRef.current) return;

    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: containerRef.current,
      height: 96,
      waveColor: "rgba(255,255,255,0.22)", // --rr-wave, inactive bars
      progressColor: "#6E8BFF", // --rr-accent, active/played waveform
      cursorColor: "#F4F4F6", // --rr-text, playhead
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      plugins: [regions],
    });

    wsRef.current = ws;
    regionsRef.current = regions;

    ws.load(src);
    ws.on("ready", () => {
      setReady(true);
      setDuration(ws.getDuration() * 1000);
    });
    ws.on("timeupdate", (t) => setCurrent(t * 1000));
    ws.on("play", () => setPlaying(true));
    ws.on("pause", () => setPlaying(false));
    ws.on("finish", () => setPlaying(false));

    return () => {
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
      setReady(false);
    };
  }, [src]);

  // Redraw cut regions whenever the EDL changes
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || !ready || !edl) return;
    regions.clearRegions();
    for (const edit of edl.edits) {
      regions.addRegion({
        start: edit.start_ms / 1000,
        end: edit.end_ms / 1000,
        color: "rgba(224, 98, 91, 0.35)", // --rr-wave-cut region, translucent
        drag: false,
        resize: false,
      });
    }
  }, [edl, ready]);

  const toggle = () => wsRef.current?.playPause();

  return (
    <div className="rounded-lg border border-line bg-surface-raised p-4 shadow-elev-1">
      <div className="mb-3 flex items-center gap-3">
        <button
          onClick={toggle}
          disabled={!ready}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-ink-inverse transition-colors hover:bg-white disabled:opacity-40"
          aria-label={playing ? "Pause" : "Play"}
        >
          {!ready ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : playing ? (
            <Pause className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4" />
          )}
        </button>
        <span className="font-mono text-xs text-ink-dim">
          {fmtMs(current)} / {fmtMs(duration)}
        </span>
        {edl && edl.edits.length > 0 && (
          <span className="ml-auto font-mono text-xs text-danger">
            {edl.edits.length} cut{edl.edits.length === 1 ? "" : "s"} shown in red
          </span>
        )}
      </div>
      <div ref={containerRef} />
    </div>
  );
}
