"use client";

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Flag, ZoomIn, ZoomOut } from "lucide-react";
import { fmtPosition, type Operation, type Section } from "@/lib/studio";

const HEIGHT = 76;

interface Band {
  start_ms: number;
  end_ms: number;
  fill: string;
}

/**
 * The whole episode at a glance: the sound, what was removed (red), silenced
 * (amber) or bleeped (purple), where the chapters start, and where you are.
 */
export default function TimelineBar({
  peaks,
  durationMs,
  cuts,
  operations,
  sections,
  currentMs,
  onSeek,
}: {
  peaks: number[];
  durationMs: number;
  cuts: [number, number][];
  operations: Operation[];
  sections: Section[];
  currentMs: number;
  onSeek: (ms: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    const timer = setTimeout(measure, 0);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  const total = Math.max(1, durationMs);
  const canvasWidth = Math.max(1, Math.round(width * zoom));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasWidth < 2) return;
    const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(canvasWidth * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, canvasWidth, HEIGHT);

    const mid = HEIGHT / 2;
    ctx.fillStyle = "rgba(22,19,15,0.28)";
    if (peaks.length) {
      for (let x = 0; x < canvasWidth; x++) {
        const from = Math.floor((x / canvasWidth) * peaks.length);
        const to = Math.max(from + 1, Math.floor(((x + 1) / canvasWidth) * peaks.length));
        let top = 0;
        for (let k = from; k < to && k < peaks.length; k++) top = Math.max(top, peaks[k] ?? 0);
        const h = Math.max(1, top * (HEIGHT - 12));
        ctx.fillRect(x, mid - h / 2, 1, h);
      }
    } else {
      ctx.fillRect(0, mid - 1, canvasWidth, 2);
    }

    const bands: Band[] = [
      ...cuts.map(([a, b]) => ({ start_ms: a, end_ms: b, fill: "rgba(211,54,43,0.30)" })),
      ...operations
        .filter((op) => op.enabled !== false && op.type === "mute")
        .map((op) => ({ start_ms: op.start_ms, end_ms: op.end_ms, fill: "rgba(194,122,10,0.35)" })),
      ...operations
        .filter((op) => op.enabled !== false && op.type === "bleep")
        .map((op) => ({ start_ms: op.start_ms, end_ms: op.end_ms, fill: "rgba(124,58,237,0.35)" })),
    ];
    for (const band of bands) {
      const x = (band.start_ms / total) * canvasWidth;
      const w = Math.max(1.5, ((band.end_ms - band.start_ms) / total) * canvasWidth);
      ctx.fillStyle = band.fill;
      ctx.fillRect(x, 0, w, HEIGHT);
    }
  }, [peaks, canvasWidth, cuts, operations, total]);

  // keep the playhead in view while it moves through a zoomed timeline
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || zoom === 1) return;
    const x = (currentMs / total) * canvasWidth;
    if (x < wrap.scrollLeft + 40 || x > wrap.scrollLeft + wrap.clientWidth - 40) wrap.scrollLeft = Math.max(0, x - wrap.clientWidth / 2);
  }, [currentMs, zoom, canvasWidth, total]);

  const seekAt = (e: ReactMouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / Math.max(1, box.width)));
    onSeek(Math.round(ratio * total));
  };

  const left = (ms: number) => `${((ms / total) * 100).toFixed(4)}%`;

  return (
    <section className="rr-card rr-enter px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 text-[11px] text-ink-faint">
          <span className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-danger/60" /> removed</span>
          <span className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-processing/70" /> silenced</span>
          <span className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-full" style={{ background: "rgba(124,58,237,0.7)" }} /> bleeped</span>
        </div>
        <div className="flex items-center gap-1.5">
          <ZoomOut className="h-3.5 w-3.5 text-ink-faint" />
          <input
            type="range"
            min={1}
            max={10}
            step={0.5}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            aria-label="Zoom the timeline"
            className="h-1.5 w-28 cursor-pointer accent-[color:var(--rr-accent)]"
          />
          <ZoomIn className="h-3.5 w-3.5 text-ink-faint" />
          <span className="rr-mono w-8 text-right text-ink-faint">{zoom.toFixed(0)}×</span>
        </div>
      </div>

      <div ref={wrapRef} className="relative overflow-x-auto overflow-y-hidden">
        <div className="relative" style={{ width: canvasWidth, height: HEIGHT }} onClick={seekAt} role="presentation">
          <canvas ref={canvasRef} style={{ width: canvasWidth, height: HEIGHT }} className="block cursor-pointer rounded-sm bg-surface-overlay" />
          {sections.map((s) => (
            <div key={s.id} className="pointer-events-none absolute top-0 z-10 h-full" style={{ left: left(s.start_ms) }}>
              <div className="h-full w-px bg-ink/50" />
              <span className="absolute -top-0.5 left-1 flex max-w-[160px] items-center gap-1 truncate rounded-sm bg-surface-raised/90 px-1 text-[10px] text-ink-dim">
                <Flag className="h-2.5 w-2.5 shrink-0" />
                {s.title}
              </span>
            </div>
          ))}
          <div className="pointer-events-none absolute top-0 z-20 h-full w-0.5 bg-accent" style={{ left: left(currentMs) }}>
            <span className="absolute -top-0.5 left-1 rr-mono rounded-sm bg-accent px-1 text-[10px] text-white">{fmtPosition(currentMs)}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
