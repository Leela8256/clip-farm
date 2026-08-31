"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Flag, Headphones, RotateCcw, Scissors, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { fmtPosition, snapToWordGap, type Operation, type Section, type StudioWord } from "@/lib/studio";

const HEIGHT = 76;
/** how close to an edge counts as grabbing the handle */
const GRAB_PX = 7;
/** a drag shorter than this is a click, not a selection */
const CLICK_MS = 140;

export interface Range {
  start_ms: number;
  end_ms: number;
}

interface Band {
  start_ms: number;
  end_ms: number;
  fill: string | CanvasPattern;
}

const OP_FILL: Record<string, string> = {
  cut: "rgba(211,54,43,0.30)",
  mute: "rgba(194,122,10,0.35)",
  bleep: "rgba(124,58,237,0.35)",
  shorten_silence: "rgba(94,110,120,0.30)",
};

const OP_LABEL: Record<string, string> = {
  cut: "Removed",
  mute: "Silenced",
  bleep: "Bleeped",
  shorten_silence: "Shortened",
};

/** Diagonal stripes for a shortened pause — cheap, made once per canvas. */
function stripes(ctx: CanvasRenderingContext2D): CanvasPattern | string {
  const tile = document.createElement("canvas");
  tile.width = 8;
  tile.height = 8;
  const c = tile.getContext("2d");
  if (!c) return OP_FILL.shorten_silence;
  c.strokeStyle = "rgba(94,110,120,0.55)";
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(-2, 8);
  c.lineTo(8, -2);
  c.moveTo(2, 12);
  c.lineTo(12, 2);
  c.stroke();
  return ctx.createPattern(tile, "repeat") ?? OP_FILL.shorten_silence;
}

/**
 * The whole episode at a glance and a second way to edit it: the sound, what was
 * removed (red), silenced (amber), bleeped (purple) or shortened (striped), the
 * chapters, and where you are. Drag across it to pick a stretch — the text
 * selects with it — or click a change to nudge its edges, listen to it, put it
 * back or take it away.
 */
export default function TimelineBar({
  peaks,
  durationMs,
  cuts,
  operations,
  sections,
  words,
  currentMs,
  selection,
  selectedOpId,
  onSeek,
  onSelect,
  onSelectOp,
  onResizeOp,
  onRemoveOp,
  onToggleOp,
  onAudition,
  onRemoveRange,
}: {
  peaks: number[];
  durationMs: number;
  cuts: [number, number][];
  operations: Operation[];
  sections: Section[];
  /** the recording's words — an edge always lands in the gap between two of them */
  words: StudioWord[];
  currentMs: number;
  selection: Range | null;
  selectedOpId: string | null;
  onSeek: (ms: number) => void;
  onSelect: (range: Range | null) => void;
  onSelectOp: (id: string | null) => void;
  onResizeOp: (id: string, startMs: number, endMs: number) => void;
  onRemoveOp: (id: string) => void;
  onToggleOp: (id: string) => void;
  onAudition: (range: Range) => void;
  onRemoveRange: (range: Range) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<{ kind: "range" | "start" | "end"; anchor: number; at: number; opId?: string } | null>(null);
  const [draft, setDraft] = useState<Range | null>(null);

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
  const selectedOp = useMemo(() => operations.find((op) => op.id === selectedOpId) ?? null, [operations, selectedOpId]);
  const shown = drag && draft ? draft : selection;

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

    const hatch = operations.some((op) => op.enabled !== false && op.type === "shorten_silence") ? stripes(ctx) : OP_FILL.shorten_silence;
    const bands: Band[] = [
      ...cuts.map(([a, b]) => ({ start_ms: a, end_ms: b, fill: OP_FILL.cut })),
      ...operations
        .filter((op) => op.enabled !== false && op.type !== "cut")
        .map((op) => ({ start_ms: op.start_ms, end_ms: op.end_ms, fill: op.type === "shorten_silence" ? hatch : OP_FILL[op.type] })),
      // changes that were put back stay visible, faintly, so they can be found again
      ...operations.filter((op) => op.enabled === false).map((op) => ({ start_ms: op.start_ms, end_ms: op.end_ms, fill: "rgba(22,19,15,0.10)" })),
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

  /* ---- pointing at the sound ---- */

  const msAt = (clientX: number, box: DOMRect) => {
    const ratio = Math.min(1, Math.max(0, (clientX - box.left) / Math.max(1, box.width)));
    return Math.round(ratio * total);
  };

  const snap = (ms: number) => (words.length ? snapToWordGap(ms, words, 120) : ms);
  const msPerPx = total / Math.max(1, canvasWidth);

  const opAt = (ms: number): Operation | null => {
    let best: Operation | null = null;
    for (const op of operations) {
      if (ms < op.start_ms - msPerPx * 2 || ms > op.end_ms + msPerPx * 2) continue;
      if (!best || op.end_ms - op.start_ms < best.end_ms - best.start_ms) best = op;
    }
    return best;
  };

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const ms = msAt(e.clientX, box);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (selectedOp) {
      const grab = GRAB_PX * msPerPx;
      if (Math.abs(ms - selectedOp.start_ms) <= grab) {
        setDrag({ kind: "start", anchor: selectedOp.end_ms, at: Date.now(), opId: selectedOp.id });
        setDraft({ start_ms: selectedOp.start_ms, end_ms: selectedOp.end_ms });
        return;
      }
      if (Math.abs(ms - selectedOp.end_ms) <= grab) {
        setDrag({ kind: "end", anchor: selectedOp.start_ms, at: Date.now(), opId: selectedOp.id });
        setDraft({ start_ms: selectedOp.start_ms, end_ms: selectedOp.end_ms });
        return;
      }
    }
    const hit = opAt(ms);
    if (hit) {
      onSelectOp(hit.id);
      onSelect(null);
      onSeek(hit.start_ms);
      return;
    }
    onSelectOp(null);
    setDrag({ kind: "range", anchor: ms, at: Date.now() });
    setDraft({ start_ms: ms, end_ms: ms });
  };

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const ms = msAt(e.clientX, e.currentTarget.getBoundingClientRect());
    const lo = Math.min(drag.anchor, ms);
    const hi = Math.max(drag.anchor, ms);
    setDraft({ start_ms: lo, end_ms: hi });
  };

  const up = () => {
    if (!drag || !draft) {
      setDrag(null);
      setDraft(null);
      return;
    }
    const start = snap(draft.start_ms);
    const end = snap(draft.end_ms);
    if (drag.kind === "range") {
      if (end - start < CLICK_MS) {
        onSeek(draft.start_ms);
        onSelect(null);
      } else onSelect({ start_ms: start, end_ms: end });
    } else if (drag.opId && end > start) {
      onResizeOp(drag.opId, start, end);
    }
    setDrag(null);
    setDraft(null);
  };

  const left = (ms: number) => `${((ms / total) * 100).toFixed(4)}%`;
  const span = (a: number, b: number) => ({ left: left(a), width: `${(((b - a) / total) * 100).toFixed(4)}%` });

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
        <div
          className="relative touch-none select-none"
          style={{ width: canvasWidth, height: HEIGHT }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          role="presentation"
        >
          <canvas ref={canvasRef} style={{ width: canvasWidth, height: HEIGHT }} className="block cursor-pointer rounded-sm bg-surface-overlay" />

          {shown ? (
            <div className="pointer-events-none absolute top-0 z-10 h-full border-x border-accent bg-accent/20" style={span(shown.start_ms, shown.end_ms)} />
          ) : null}

          {selectedOp ? (
            <div
              className="pointer-events-none absolute top-0 z-10 h-full border-2 border-ink"
              style={span(draft && drag?.opId === selectedOp.id ? draft.start_ms : selectedOp.start_ms, draft && drag?.opId === selectedOp.id ? draft.end_ms : selectedOp.end_ms)}
            >
              <i className="absolute -left-[3px] top-1/2 h-5 w-1.5 -translate-y-1/2 cursor-ew-resize rounded-sm bg-ink" />
              <i className="absolute -right-[3px] top-1/2 h-5 w-1.5 -translate-y-1/2 cursor-ew-resize rounded-sm bg-ink" />
            </div>
          ) : null}

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

      {selectedOp ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-2">
          <span className="rr-mono text-ink-dim">
            {OP_LABEL[selectedOp.type] ?? "Change"} {fmtPosition(selectedOp.start_ms)} – {fmtPosition(selectedOp.end_ms)}
            {selectedOp.enabled === false ? " · put back" : ""}
          </span>
          <button type="button" className="rr-btn rr-btn-sm" onClick={() => onAudition({ start_ms: selectedOp.start_ms, end_ms: selectedOp.end_ms })}>
            <Headphones className="h-3.5 w-3.5" /> Listen
          </button>
          <button type="button" className="rr-btn rr-btn-sm" onClick={() => onToggleOp(selectedOp.id)} title="U">
            <RotateCcw className="h-3.5 w-3.5" /> {selectedOp.enabled === false ? "Apply again" : "Put back"}
          </button>
          <button type="button" className="rr-btn rr-btn-sm" onClick={() => onRemoveOp(selectedOp.id)} title="Delete">
            <Trash2 className="h-3.5 w-3.5" /> Forget it
          </button>
          <span className="ml-auto text-[11px] text-ink-faint">Drag either edge to change where it starts and ends</span>
        </div>
      ) : selection ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-2">
          <span className="rr-mono text-ink-dim">
            {fmtPosition(selection.start_ms)} – {fmtPosition(selection.end_ms)} picked
          </span>
          <button type="button" className="rr-btn rr-btn-sm" onClick={() => onAudition(selection)}>
            <Headphones className="h-3.5 w-3.5" /> Listen
          </button>
          <button type="button" className="rr-btn rr-btn-sm" onClick={() => onRemoveRange(selection)} title="Delete">
            <Scissors className="h-3.5 w-3.5" /> Remove
          </button>
          <button type="button" className="rr-btn rr-btn-ghost rr-btn-sm ml-auto" onClick={() => onSelect(null)}>
            Clear
          </button>
        </div>
      ) : null}
    </section>
  );
}
