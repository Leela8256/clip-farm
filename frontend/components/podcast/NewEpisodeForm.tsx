"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { ChevronDown, Film, Music, Sparkles, UploadCloud, X } from "lucide-react";
import { GOAL_PRESETS, fmtTime, prettyTitle } from "@/lib/podcast";
import { toast } from "@/components/shell/Toasts";

export interface NewEpisodeInput {
  file: File;
  goal: string;
  clipCount: number;
  minSeconds: number;
  maxSeconds: number;
}

export type UploadPhase = "idle" | "uploading" | "creating";

const VIDEO_EXT = /\.(mp4|mov|mkv|webm|m4v|avi|mpg|mpeg|wmv)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|flac|aac|ogg|opus|aiff?)$/i;
const ACCEPT = "video/*,audio/*,.mp4,.mov,.mkv,.webm,.m4v,.mp3,.wav,.m4a,.flac,.aac,.ogg";
const CLIP_COUNTS = [4, 6, 8, 10, 12];

type MediaKind = "video" | "audio";

function mediaKind(file: File): MediaKind | null {
  if (file.type.startsWith("video/") || VIDEO_EXT.test(file.name)) return "video";
  if (file.type.startsWith("audio/") || AUDIO_EXT.test(file.name)) return "audio";
  return null;
}

const fmtSize = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`);

interface Probe {
  for: File | null;
  durationMs: number | null;
  poster: string | null;
}

const NO_PROBE: Probe = { for: null, durationMs: null, poster: null };

/** The file's own length and, for a video, a poster frame from ~2 s in — read in the browser before anything is uploaded. */
function useMediaProbe(file: File | null, kind: MediaKind | null): Probe {
  const [probe, setProbe] = useState<Probe>(NO_PROBE);

  useEffect(() => {
    if (!file || !kind) return;
    let cancelled = false;
    const url = URL.createObjectURL(file);
    const el = document.createElement(kind);
    el.preload = "metadata";
    el.muted = true;

    const report = (durationMs: number | null) => {
      if (!cancelled) setProbe({ for: file, durationMs, poster: null });
    };
    const drawPoster = () => {
      if (cancelled || kind !== "video") return;
      const video = el as HTMLVideoElement;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 480;
        canvas.height = 270;
        const ctx = canvas.getContext("2d");
        if (!ctx || !video.videoWidth || !video.videoHeight) return;
        const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
        const w = video.videoWidth * scale;
        const h = video.videoHeight * scale;
        ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        const poster = canvas.toDataURL("image/jpeg", 0.82);
        setProbe((prev) => (prev.for === file ? { ...prev, poster } : prev));
      } catch {
        /* cross-origin or decoder trouble: keep the placeholder */
      }
    };
    const onMeta = () => {
      const durationMs = Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration * 1000) : null;
      report(durationMs);
      if (kind === "video") {
        el.addEventListener("seeked", drawPoster, { once: true });
        el.currentTime = Math.min(2, Math.max(0, (el.duration || 0) / 2));
      }
    };
    const onError = () => report(null);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("error", onError);
    el.src = url;

    return () => {
      cancelled = true;
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("error", onError);
      el.removeEventListener("seeked", drawPoster);
      el.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, [file, kind]);

  return probe.for === file ? probe : NO_PROBE;
}

export default function NewEpisodeForm({
  busy,
  phase,
  percent,
  canRun,
  error,
  onSubmit,
}: {
  busy: boolean;
  phase: UploadPhase;
  percent: number;
  canRun: boolean;
  /** Something went wrong on the last attempt (shown inline under the button). */
  error?: string | null;
  onSubmit: (input: NewEpisodeInput) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [goal, setGoal] = useState("");
  const [clipCount, setClipCount] = useState(8);
  const [minSeconds, setMinSeconds] = useState(20);
  const [maxSeconds, setMaxSeconds] = useState(90);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);

  const kind = file ? mediaKind(file) : null;
  const { durationMs, poster } = useMediaProbe(file, kind);

  const choose = (picked: File | null | undefined) => {
    if (!picked || busy) return;
    if (!mediaKind(picked)) {
      const message = "That doesn't look like a video or audio file.";
      setRejected(message);
      toast(message, "warn");
      return;
    }
    setRejected(null);
    setFile(picked);
  };

  const onDragOver = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    if (!busy && !dragging) setDragging(true);
  };
  const onDragLeave = (e: DragEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDragging(false);
    choose(e.dataTransfer.files[0]);
  };

  const submit = () => {
    if (!file || !canRun || busy) return;
    const min = Math.min(120, Math.max(5, minSeconds || 20));
    const max = Math.min(180, Math.max(min + 5, maxSeconds || 90));
    onSubmit({ file, goal: goal.trim(), clipCount, minSeconds: min, maxSeconds: max });
  };

  const title = file ? prettyTitle(file.name) : "";
  const meta = file ? `${fmtSize(file.size)} · ${durationMs != null ? fmtTime(durationMs) : kind === "audio" ? "audio" : "video"}` : "";
  const problem = rejected ?? error ?? null;

  return (
    <section
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-dragging={dragging ? "true" : undefined}
      className={`rr-card relative overflow-hidden transition-all duration-200 ${dragging ? "scale-[1.01] border-accent shadow-glow-accent ring-4 ring-accent/20" : ""}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        disabled={busy}
        onChange={(e) => {
          choose(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {!file ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className={`group flex w-full flex-col items-center justify-center gap-3 px-8 py-20 text-center transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 sm:py-24 ${
            dragging ? "bg-accent/5" : "hover:bg-surface-overlay/60"
          }`}
        >
          <span
            className={`flex h-16 w-16 items-center justify-center rounded-full border border-line bg-surface-raised text-ink-dim shadow-elev-1 transition-all duration-200 group-hover:-translate-y-0.5 group-hover:text-accent ${
              dragging ? "-translate-y-1 scale-110 text-accent" : ""
            }`}
          >
            <UploadCloud className="h-7 w-7" />
          </span>
          <span className="mt-1 text-lg font-medium text-ink">{dragging ? "Let go to add it" : "Drop your episode here"}</span>
          <span className="text-sm text-ink-faint">or click to browse · video or audio, any length</span>
        </button>
      ) : (
        <div className="p-4 sm:p-5">
          <div className="flex items-start gap-4">
            <div className="relative aspect-video w-36 shrink-0 overflow-hidden rounded-[10px] bg-surface-overlay sm:w-44">
              {poster ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={poster} alt="" className="rr-enter h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-ink-faint">{kind === "audio" ? <Music className="h-6 w-6" /> : <Film className="h-6 w-6" />}</div>
              )}
              {durationMs != null && (
                <span className="absolute bottom-1.5 right-1.5 rounded-[6px] bg-ink/80 px-1.5 py-0.5 font-mono text-[11px] text-ink-inverse">{fmtTime(durationMs)}</span>
              )}
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="truncate text-[15px] font-semibold text-ink" title={file.name}>
                {title}
              </p>
              <p className="mt-1 font-mono text-[12px] text-ink-faint">{meta}</p>
              {busy && (
                <div className="mt-4">
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="font-medium text-ink">{phase === "uploading" ? `Uploading… ${percent}%` : "Starting the analysis…"}</span>
                    {phase === "creating" && <span className="rr-dot-live h-2 w-2 rounded-full bg-ready" />}
                  </div>
                  <div className="rr-progress mt-2" data-indeterminate={phase === "creating" ? "true" : undefined}>
                    <i style={{ width: `${phase === "uploading" ? percent : 100}%` }} />
                  </div>
                </div>
              )}
            </div>
            {!busy && (
              <button type="button" onClick={() => setFile(null)} aria-label="Remove file" title="Remove" className="rr-btn rr-btn-ghost rr-btn-icon -mr-1 -mt-1">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {!busy && (
            <>
              <div className="mt-6">
                <label htmlFor="episode-goal" className="rr-label">
                  What are the clips for? <span className="font-normal text-ink-faint">(optional)</span>
                </label>
                <input
                  id="episode-goal"
                  className="rr-input mt-2"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submit();
                  }}
                  placeholder="e.g. funny moments for Reels, skip the sponsor read"
                  autoComplete="off"
                />
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {GOAL_PRESETS.map((p) => {
                    const active = goal === p.text;
                    return (
                      <button key={p.label} type="button" className="rr-chip" aria-pressed={active} onClick={() => setGoal(active ? "" : p.text)} title={p.text}>
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setOptionsOpen((o) => !o)}
                  aria-expanded={optionsOpen}
                  className="inline-flex items-center gap-1.5 rounded-[8px] py-1 pr-2 text-[13px] font-medium text-ink-dim transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${optionsOpen ? "rotate-180" : ""}`} />
                  Options
                  <span className="ml-1 font-mono text-[11px] font-normal text-ink-faint">
                    {clipCount} candidates · {minSeconds}–{maxSeconds} s
                  </span>
                </button>
                <div className="flex items-center gap-3">
                  {!canRun && <span className="text-[12px] text-ink-faint">Connecting…</span>}
                  <button type="button" onClick={submit} disabled={!canRun} className="rr-btn rr-btn-primary">
                    <Sparkles className="h-4 w-4 text-accent" />
                    Find the moments
                  </button>
                </div>
              </div>

              {optionsOpen && (
                <div className="rr-enter mt-4 grid grid-cols-3 gap-3 border-t border-line pt-4">
                  <div className="rr-field">
                    <label htmlFor="episode-count">Candidates</label>
                    <select id="episode-count" className="rr-select" value={clipCount} onChange={(e) => setClipCount(Number(e.target.value))}>
                      {CLIP_COUNTS.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="rr-field">
                    <label htmlFor="episode-min">Min seconds</label>
                    <input id="episode-min" type="number" min={5} max={120} className="rr-input" value={minSeconds} onChange={(e) => setMinSeconds(Number(e.target.value))} />
                  </div>
                  <div className="rr-field">
                    <label htmlFor="episode-max">Max seconds</label>
                    <input id="episode-max" type="number" min={15} max={180} className="rr-input" value={maxSeconds} onChange={(e) => setMaxSeconds(Number(e.target.value))} />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {problem && (
        <p role="alert" className="border-t border-danger/20 bg-danger/10 px-5 py-2.5 text-[13px] text-danger">
          {problem}
        </p>
      )}
    </section>
  );
}
