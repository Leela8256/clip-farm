"use client";

import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Scissors, Sparkles } from "lucide-react";
import { fmtPosition, mediaToSource, nextKeepEdge, sourceToMedia, type EpisodeEdits, type PlaybackClock } from "@/lib/studio";

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

export interface AuditionRequest {
  start_ms: number;
  end_ms: number;
  at: number;
}

/**
 * The picture. Two ways to watch the episode:
 *   • the original recording with the removed parts skipped over — instant, always available
 *   • the finished-looking preview once one has been made for these changes
 *
 * The rest of the screen always talks in recording time; only this component
 * knows where that lands in whichever file is playing, so a word clicked in the
 * text finds the same moment in a made preview and back again.
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
  auditionRequest,
  sourceClock,
  previewClock,
  approximate,
  onTime,
}: {
  sourceUrl: string | null;
  previewUrl: string | null;
  previewFresh: boolean;
  previewLabel: string;
  edits: EpisodeEdits;
  caption: string;
  logoUrl: string | null;
  /** where we are on the recording */
  currentMs: number;
  /** a place on the recording to jump to */
  seekRequest: { ms: number; at: number } | null;
  /** listen to one stretch with a run-up and a run-out, then stop */
  auditionRequest: AuditionRequest | null;
  sourceClock: PlaybackClock;
  previewClock: PlaybackClock;
  /** true while the positions are worked out here rather than read from a made version */
  approximate: boolean;
  onTime: (ms: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [showPreview, setShowPreview] = useState(false);
  const lastSeek = useRef(0);
  const lastAudition = useRef(0);
  const auditionUntil = useRef<number | null>(null);
  const auditionFrom = useRef<number | null>(null);
  const skipping = useRef(false);

  const watchingPreview = showPreview && previewFresh && !!previewUrl;
  const src = watchingPreview ? previewUrl : sourceUrl;
  const clock = watchingPreview ? previewClock : sourceClock;

  /** Where a moment on the recording sits in the file that is playing. */
  const toMedia = (sourceMs: number) => {
    const direct = sourceToMedia(clock, sourceMs);
    if (direct != null) return Math.max(0, direct);
    // inside something that was taken out — land on the next thing that was kept
    return Math.max(0, sourceToMedia(clock, nextKeepEdge(edits, sourceMs)) ?? 0);
  };

  // a fresh preview is worth watching, but never yank the picture away mid-play
  useEffect(() => {
    if (!previewFresh || !previewUrl) return;
    const timer = setTimeout(() => setShowPreview((on) => (videoRef.current?.paused === false ? on : true)), 0);
    return () => clearTimeout(timer);
  }, [previewFresh, previewUrl]);

  useEffect(() => {
    if (!seekRequest || seekRequest.at === lastSeek.current) return;
    lastSeek.current = seekRequest.at;
    auditionUntil.current = null;
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = toMedia(seekRequest.ms) / 1000;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest, watchingPreview]);

  // listen to one stretch on the recording: two seconds before, through, two after
  useEffect(() => {
    if (!auditionRequest || auditionRequest.at === lastAudition.current) return;
    lastAudition.current = auditionRequest.at;
    const timer = setTimeout(() => {
      auditionUntil.current = auditionRequest.end_ms + 2000;
      auditionFrom.current = Math.max(0, auditionRequest.start_ms - 2000);
      // always on the recording: it is there straight away and holds every word
      setShowPreview(false);
      const v = videoRef.current;
      if (!v || watchingPreview) return; // a swap of picture picks it up in onLoadedMetadata
      v.currentTime = auditionFrom.current / 1000;
      auditionFrom.current = null;
      void v.play().catch(() => {});
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditionRequest]);

  const handleTime = (e: SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    const media = Math.round(v.currentTime * 1000);
    const source = Math.round(mediaToSource(clock, media));
    if (!watchingPreview) {
      const edge = nextKeepEdge(edits, source);
      if (edge > source + 30 && !v.paused) {
        if (!skipping.current) {
          skipping.current = true;
          v.currentTime = toMedia(edge) / 1000;
          setTimeout(() => {
            skipping.current = false;
          }, 60);
        }
        return;
      }
    }
    if (auditionUntil.current != null && source >= auditionUntil.current) {
      auditionUntil.current = null;
      v.pause();
    }
    onTime(source);
  };

  // keep the place when the picture swaps between the recording and a made preview
  const handleLoaded = (e: SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    if (auditionFrom.current != null) {
      v.currentTime = auditionFrom.current / 1000;
      auditionFrom.current = null;
      void v.play().catch(() => {});
      return;
    }
    if (currentMs > 0) v.currentTime = toMedia(currentMs) / 1000;
  };

  const style = edits.visual?.caption_style;
  const captionsOn = edits.visual?.captions !== false;
  const logo = edits.assets?.logo;
  // captions and the logo are drawn over the recording here for the sense of it;
  // the real thing is burned in when a version is made
  const overlays = !watchingPreview && ((captionsOn && !!caption) || (!!logoUrl && !!logo));

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
            onLoadedMetadata={handleLoaded}
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
              <Scissors className="h-3 w-3" /> Instant playback
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <p className="rr-mono text-ink-faint">
          {fmtPosition(currentMs)}
          <span className="ml-2 text-[11px] normal-case tracking-normal text-ink-faint">
            {watchingPreview
              ? "the version that was made"
              : `removed parts are skipped as it plays${overlays ? " · captions and logo are a rough guide here" : ""}`}
            {!watchingPreview && approximate ? " · positions are close until a preview is made" : ""}
          </span>
        </p>
        {previewUrl ? (
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => setShowPreview(false)} className="rr-chip" data-active={!watchingPreview}>
              Instant playback
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
