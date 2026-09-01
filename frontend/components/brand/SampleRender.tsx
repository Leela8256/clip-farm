"use client";

import { useMemo, useState } from "react";
import { Clapperboard, Loader2 } from "lucide-react";
import { mediaUrl, runClip } from "@/lib/engine";
import { friendlyStatus, previewFile, type RenderReport, type StatusEvent } from "@/lib/podcast";
import { galleryIdOf, legacyPresetOf, type CaptionStyle } from "@/lib/brand";
import type { ProjectSummary } from "@/lib/library";

const SAMPLE_MS = 12_000;

/** A short window from the middle of a recording — enough talking for captions. */
function window(durationMs: number): { start_ms: number; end_ms: number } | null {
  if (!durationMs || durationMs < 6_000) return null;
  const length = Math.min(SAMPLE_MS, durationMs);
  const start = Math.max(0, Math.min(Math.round(durationMs * 0.2), durationMs - length));
  return { start_ms: start, end_ms: start + length };
}

/**
 * Makes a real 12-second clip with this look burned in, so the producer can
 * judge it on a video rather than on a mock-up.
 */
export default function SampleRender({ style, projects }: { style: CaptionStyle; projects: ProjectSummary[] | null }) {
  const ready = useMemo(() => (projects ?? []).filter((p) => p.status === "ready" && p.durationMs >= 6_000), [projects]);
  const [pick, setPick] = useState("");
  const [event, setEvent] = useState<StatusEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [video, setVideo] = useState<string | null>(null);
  const [report, setReport] = useState<RenderReport | null>(null);

  const chosen = ready.find((p) => p.id === pick) ?? ready[0];

  const run = async () => {
    if (!chosen) return;
    const range = window(chosen.durationMs);
    if (!range) return;
    setBusy(true);
    setError("");
    setVideo(null);
    setReport(null);
    try {
      const result = await runClip(
        "preview",
        chosen.id,
        { clipId: "", start_ms: range.start_ms, end_ms: range.end_ms, title: "Brand sample", captions: legacyPresetOf(galleryIdOf(style)), caption_style: style as unknown as Record<string, unknown>, layouts: "vertical" },
        (evt) => setEvent(evt)
      );
      setReport(result);
      const file = previewFile(result);
      if (!file) throw new Error("The sample came back without a video.");
      setVideo(await mediaUrl(file.path, result.rendered_at ?? 0));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setEvent(null);
    }
  };

  return (
    <section className="rr-card p-4">
      <h3 className="rr-h3">See it on a real clip</h3>
      <p className="mt-1 text-[13px] text-ink-dim">
        Makes a twelve-second clip from the middle of a recording with the closest built-in caption look burned in. Your own fine tuning shows in the live preview and travels with the
        brand look when you make real clips.
      </p>

      {ready.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-faint">No recording is ready yet. Bring one in and let it finish first.</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="rr-field min-w-[220px] flex-1">
            <label htmlFor="rr-sample-project">Recording</label>
            <select id="rr-sample-project" className="rr-select" value={chosen?.id ?? ""} onChange={(e) => setPick(e.target.value)} disabled={busy}>
              {ready.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className="rr-btn rr-btn-primary" onClick={() => void run()} disabled={busy || !chosen}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4 text-accent" />}
            {busy ? "Making it…" : "Make a sample"}
          </button>
        </div>
      )}

      {busy && (
        <div className="mt-3">
          <div className="rr-progress" data-indeterminate="true">
            <i />
          </div>
          <p className="mt-1.5 text-[12px] text-ink-faint">{friendlyStatus(event)}</p>
        </div>
      )}

      {video && (
        <div className="mt-4">
          <video src={video} controls playsInline className="mx-auto max-h-[420px] rounded-[14px] bg-black" />
          {report && (
            <p className="mt-2 text-center font-mono text-[11px] text-ink-faint">
              {[
                report.width && report.height ? `${report.width}×${report.height}` : "",
                report.has_audio ? "with sound" : "no sound",
                report.loudness ? `${report.loudness.integrated_lufs.toFixed(1)} LUFS` : "",
                report.duration_ms ? `${Math.round(report.duration_ms / 1000)}s` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </div>
      )}

      {error && <p className="mt-3 rounded-md bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</p>}
    </section>
  );
}
