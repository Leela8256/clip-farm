"use client";

import { AlertTriangle, Download, Loader2, RefreshCw } from "lucide-react";
import { fmtSeconds, type RenderReport } from "@/lib/podcast";

/** The measured facts a render reports about its own output. */
export interface QualityBlock {
  tier?: string;
  width?: number;
  height?: number;
  fps?: number;
  video_codec?: string;
  crf?: number;
  preset?: string;
  audio_channels?: number;
  source_width?: number;
  source_height?: number;
  upscaled?: boolean;
}

export interface ReframeResult {
  aspect: string;
  report?: RenderReport;
  url?: string | null;
  name?: string;
  error?: string;
}

/** One honest line about the file that came out — only what the report measured. */
export function qualityLine(report: RenderReport | undefined): string {
  if (!report) return "";
  const q = (report as RenderReport & { quality?: QualityBlock }).quality;
  const width = q?.width ?? report.width;
  const height = q?.height ?? report.height;
  const parts: string[] = [];
  if (width && height) parts.push(`${width}×${height}`);
  if (q?.fps) parts.push(`${Math.round(q.fps)} fps`);
  if (q?.audio_channels) parts.push(q.audio_channels >= 2 ? "stereo" : "mono");
  else if (report.has_audio === false) parts.push("no sound");
  if (report.duration_ms) parts.push(fmtSeconds(report.duration_ms));
  return parts.join(" · ");
}

const RATIO: Record<string, string> = { "9:16": "9 / 16", "4:5": "4 / 5", "1:1": "1 / 1", "16:9": "16 / 9" };

export default function ResultCard({ result, running, onRetry }: { result: ReframeResult; running: boolean; onRetry: () => void }) {
  const { aspect, report, url, error } = result;
  return (
    <article className="rr-card rr-enter overflow-hidden">
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <span className="font-mono text-[12px] text-ink">{aspect}</span>
        {report && !error && <span className="truncate font-mono text-[11px] text-ink-faint">{qualityLine(report)}</span>}
      </header>
      <div className="p-3">
        {running ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-sm text-ink-dim">
            <Loader2 className="h-4 w-4 animate-spin text-accent" /> Re-shaping…
          </div>
        ) : error ? (
          <div className="space-y-2 py-4">
            <p className="flex items-start gap-2 text-[12px] leading-5 text-danger">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
            </p>
            <button type="button" onClick={onRetry} className="rr-btn rr-btn-sm">
              <RefreshCw className="h-3.5 w-3.5" /> Try {aspect} again
            </button>
          </div>
        ) : url ? (
          <>
            <div className="mx-auto overflow-hidden rounded-md bg-black" style={{ aspectRatio: RATIO[aspect] ?? "9 / 16", maxHeight: 360, maxWidth: "100%" }}>
              <video controls playsInline preload="metadata" src={url} className="h-full w-full object-contain" />
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <a href={url} download={result.name} className="rr-chip">
                <Download className="h-3.5 w-3.5" /> Download
              </a>
              <button type="button" onClick={onRetry} className="rr-btn rr-btn-ghost rr-btn-sm ml-auto">
                <RefreshCw className="h-3.5 w-3.5" /> Again
              </button>
            </div>
          </>
        ) : (
          <p className="py-8 text-center text-sm text-ink-faint">Nothing came back for this shape.</p>
        )}
      </div>
    </article>
  );
}
