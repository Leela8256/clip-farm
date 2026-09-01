"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2, Wand2 } from "lucide-react";
import { LAYOUT_MODES } from "@/lib/podcast";
import type { ProjectSummary } from "@/lib/library";
import type { BrandTemplate, CaptionStyle } from "@/lib/brand";
import { CAPTION_GALLERY } from "@/lib/brand";
import { startBatch, type Batch, type BatchProject } from "@/lib/batch";
import { Modal } from "./Modal";
import { toast } from "@/components/shell/Toasts";

const STATE_TEXT: Record<BatchProject["status"], string> = {
  queued: "Waiting",
  running: "Finding moments…",
  done: "Done",
  failed: "Didn’t work",
};

/**
 * One request, many recordings. The same sentence is sent to every chosen
 * recording, two at a time, and each one keeps its own clips.
 */
export default function BatchModal({
  selected,
  templates,
  onClose,
  onFinished,
}: {
  selected: ProjectSummary[];
  templates: BrandTemplate[] | null;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(3);
  const [duration, setDuration] = useState(45);
  const [template, setTemplate] = useState("");
  const [caption, setCaption] = useState("clean-karaoke");
  const [layout, setLayout] = useState("auto");
  const [batch, setBatch] = useState<Batch | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const ready = useMemo(() => selected.filter((s) => s.status === "ready"), [selected]);
  const notReady = useMemo(() => selected.filter((s) => s.status !== "ready"), [selected]);
  const nameOf = useMemo(() => new Map(selected.map((s) => [s.id, s.title])), [selected]);

  const start = async () => {
    const text = prompt.trim();
    if (!text || ready.length === 0) return;
    setRunning(true);
    setError("");
    try {
      const captionStyle: CaptionStyle | undefined = CAPTION_GALLERY.find((p) => p.id === caption)?.style;
      const result = await startBatch(
        {
          prompt: text,
          projects: ready.map((s) => s.id),
          options: {
            count,
            duration_s: duration,
            template: template || undefined,
            caption_style: captionStyle,
            layout_mode: layout,
          },
        },
        (b) => setBatch({ ...b })
      );
      setBatch({ ...result });
      const failed = result.projects.filter((p) => p.status === "failed").length;
      toast(failed ? `Finished with ${failed} that didn’t work` : "Clips are ready", failed ? "warn" : "ok");
      onFinished();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const rows = batch?.projects ?? ready.map((s) => ({ id: s.id, status: "queued" as const }));
  const done = rows.filter((r) => r.status === "done" || r.status === "failed").length;

  return (
    <Modal
      title="Make the same clips from every chosen recording"
      subtitle={`${selected.length} chosen · ${ready.length} ready to work with`}
      onClose={onClose}
      width="680px"
      footer={
        batch && !running ? (
          <button type="button" className="rr-btn rr-btn-primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="rr-btn" onClick={onClose} disabled={running}>
              Cancel
            </button>
            <button type="button" className="rr-btn rr-btn-accent" onClick={() => void start()} disabled={running || !prompt.trim() || ready.length === 0}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              {running ? "Working…" : `Find clips in ${ready.length} ${ready.length === 1 ? "recording" : "recordings"}`}
            </button>
          </>
        )
      }
    >
      <div className="rr-field">
        <label htmlFor="rr-batch-prompt">What should every clip be about?</label>
        <textarea
          id="rr-batch-prompt"
          className="rr-textarea"
          value={prompt}
          disabled={running || !!batch}
          placeholder="Three punchy 45-second moments where the guest disagrees with something"
          onChange={(e) => setPrompt(e.target.value)}
        />
        <p className="text-[12px] text-ink-faint">One sentence. It is sent to each recording on its own, so every recording keeps its own clips.</p>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rr-field">
          <label htmlFor="rr-batch-count">Clips per recording</label>
          <input id="rr-batch-count" type="number" min={1} max={10} className="rr-input" value={count} disabled={running || !!batch} onChange={(e) => setCount(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} />
        </div>
        <div className="rr-field">
          <label htmlFor="rr-batch-duration">Length (seconds)</label>
          <input id="rr-batch-duration" type="number" min={10} max={180} step={5} className="rr-input" value={duration} disabled={running || !!batch} onChange={(e) => setDuration(Math.max(10, Math.min(180, Number(e.target.value) || 45)))} />
        </div>
        <div className="rr-field">
          <label htmlFor="rr-batch-template">Brand look</label>
          <select id="rr-batch-template" className="rr-select" value={template} disabled={running || !!batch} onChange={(e) => setTemplate(e.target.value)}>
            <option value="">None</option>
            {(templates ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="rr-field">
          <label htmlFor="rr-batch-caption">Captions</label>
          <select id="rr-batch-caption" className="rr-select" value={caption} disabled={running || !!batch} onChange={(e) => setCaption(e.target.value)}>
            {CAPTION_GALLERY.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="rr-field sm:col-span-2">
          <label htmlFor="rr-batch-layout">Framing</label>
          <select id="rr-batch-layout" className="rr-select" value={layout} disabled={running || !!batch} onChange={(e) => setLayout(e.target.value)}>
            {LAYOUT_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {notReady.length > 0 && !batch && (
        <div className="mt-4 rounded-[14px] border border-line bg-processing/5 p-3">
          <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <AlertTriangle className="h-3.5 w-3.5 text-processing" />
            {notReady.length} {notReady.length === 1 ? "recording is" : "recordings are"} skipped
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {notReady.map((s) => (
              <li key={s.id} className="truncate text-[12px] text-ink-dim">
                {s.title} — {s.status === "analysing" ? "still being read" : s.status === "failed" ? "reading it didn’t finish" : "not read yet"}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[12px] text-ink-faint">Open one and let it finish, then run this again.</p>
        </div>
      )}

      {(running || batch) && (
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <p className="rr-eyebrow">Progress</p>
            <p className="font-mono text-[11px] text-ink-faint">
              {done}/{rows.length}
            </p>
          </div>
          <div className="rr-progress mt-2" data-indeterminate={rows.length === 0 ? "true" : "false"}>
            <i style={{ width: `${rows.length ? (done / rows.length) * 100 : 0}%` }} />
          </div>
          <ul className="mt-3 space-y-1.5">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-3 rounded-md bg-surface-overlay/60 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{nameOf.get(r.id) ?? r.id}</span>
                {r.status === "done" ? (
                  <span className="flex items-center gap-2 text-[12px] text-ready">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {r.delivered ?? 0} {(r.delivered ?? 0) === 1 ? "clip" : "clips"}
                    <Link href={`/episode?id=${encodeURIComponent(r.id)}`} className="inline-flex items-center gap-1 text-ink underline-offset-2 hover:underline">
                      Open <ArrowRight className="h-3 w-3" />
                    </Link>
                  </span>
                ) : r.status === "failed" ? (
                  <span className="truncate text-[12px] text-danger" title={r.error}>
                    {r.error || STATE_TEXT.failed}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-[12px] text-ink-faint">
                    {r.status === "running" && <Loader2 className="h-3 w-3 animate-spin" />}
                    {STATE_TEXT[r.status]}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(error || batch?.error) && <p className="mt-4 rounded-md bg-danger/10 px-3 py-2 text-[13px] text-danger">{error || batch?.error}</p>}
    </Modal>
  );
}
