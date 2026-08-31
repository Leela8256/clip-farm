"use client";

import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Scissors, Sparkles } from "lucide-react";
import { fmtPosition, nextKeepEdge, type EpisodeEdits } from "@/lib/studio";

const CORNERS: Record<string, string> = {
  tl: "left-[4%] top-[5%]",
  tr: "right-[4%] top-[5%]",
  bl: "left-[4%] bottom-[12%]",
  br: "right-[4%] bottom-[12%]",
};

const CAPTION_POSITION: Record<string, string> = {
  bottom: "bottom-[7%]",
  middle: "top-1/2 -translate-y-1/2",
  top: "top-[7%]",
};

/**
 * The picture. Two ways to watch the episode:
 *   • the original recording with the removed parts skipped over — instant, always available
 *   • the finished-looking preview once one has been made for these changes
 * The logo and caption style are drawn on top as a rough stand-in so branding is
 * visible before anything is made.
 */
export default function StudioCanvas({
  sourceUrl,
  previewUrl,
  previewFresh,
  previewLabel,
  edits,
  caption,
  logoUrl,
  currentMs,
  seekRequest,
  onTime,
}: {
  sourceUrl: string | null;
  previewUrl: string | null;
  previewFresh: boolean;
  previewLabel: string;
  edits: EpisodeEdits;
  caption: string;
  logoUrl: string | null;
  currentMs: number;
  seekRequest: { ms: number; at: number } | null;
  onTime: (ms: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [showPreview, setShowPreview] = useState(false);
  const lastSeek = useRef(0);
  const skipping = useRef(false);

  const watchingPreview = showPreview && previewFresh && !!previewUrl;
  const src = watchingPreview ? previewUrl : sourceUrl;

  // a fresh preview is worth watching, but never yank the picture away mid-play
  useEffect(() => {
    if (!previewFresh || !previewUrl) return;
    const timer = setTimeout(() => setShowPreview((on) => (videoRef.current?.paused === false ? on : true)), 0);
    return () => clearTimeout(timer);
  }, [previewFresh, previewUrl]);

  useEffect(() => {
    if (!seekRequest || seekRequest.at === lastSeek.current) return;
    lastSeek.current = seekRequest.at;
    const v = videoRef.current;
    if (!v || watchingPreview) return;
    v.currentTime = seekRequest.ms / 1000;
  }, [seekRequest, watchingPreview]);

  const handleTime = (e: SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    const ms = Math.round(v.currentTime * 1000);
    if (!watchingPreview) {
      const edge = nextKeepEdge(edits, ms);
      if (edge > ms + 30 && !v.paused) {
        if (!skipping.current) {
          skipping.current = true;
          v.currentTime = edge / 1000;
          setTimeout(() => {
            skipping.current = false;
          }, 60);
        }
        return;
      }
    }
    onTime(ms);
  };

  const style = edits.visual?.caption_style;
  const captionsOn = edits.visual?.captions !== false;
  const logo = edits.assets?.logo;

  return (
    <section className="rr-card rr-enter overflow-hidden">
      <div className="relative aspect-video w-full bg-black">
        {src ? (
          <video
            key={src}
            ref={videoRef}
            controls
            playsInline
            preload="metadata"
            src={src}
            onTimeUpdate={handleTime}
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-white/60">
            The recording is still loading.
          </div>
        )}

        {logoUrl && logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUrl}
            alt=""
            className={`pointer-events-none absolute ${CORNERS[logo.corner ?? "tr"] ?? CORNERS.tr}`}
            style={{ height: `${Math.round((logo.height ?? 0.1) * 100)}%`, opacity: logo.opacity ?? 0.9 }}
          />
        ) : null}

        {captionsOn && caption && !watchingPreview ? (
          <div
            className={`pointer-events-none absolute inset-x-0 flex justify-center px-[8%] ${CAPTION_POSITION[style?.position ?? "bottom"] ?? CAPTION_POSITION.bottom}`}
          >
            <p
              className="max-w-full rounded-md bg-black/55 px-3 py-1.5 text-center font-semibold leading-snug"
              style={{ color: style?.color ?? "#FFFFFF", fontSize: `${Math.max(11, Math.round((style?.size ?? 20) * 0.8))}px` }}
            >
              {caption}
            </p>
          </div>
        ) : null}

        <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5">
          {watchingPreview ? (
            <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-accent px-2.5 text-xs font-medium text-white">
              <Sparkles className="h-3 w-3" /> {previewLabel}
            </span>
          ) : (
            <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-black/55 px-2.5 text-xs text-white">
              <Scissors className="h-3 w-3" /> Playing your edit
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <p className="rr-mono text-ink-faint">
          {fmtPosition(currentMs)}
          <span className="ml-2 text-[11px] normal-case tracking-normal text-ink-faint">
            {watchingPreview ? "finished look" : "removed parts are skipped as it plays"}
          </span>
        </p>
        {previewUrl ? (
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => setShowPreview(false)} className="rr-chip" data-active={!watchingPreview}>
              Your edit
            </button>
            <button
              type="button"
              onClick={() => setShowPreview(true)}
              disabled={!previewFresh}
              title={previewFresh ? "Watch the version that was made" : "This preview is older than your latest changes — make a new one"}
              className="rr-chip disabled:opacity-45"
              data-active={watchingPreview}
            >
              {previewLabel}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
