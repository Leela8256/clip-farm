"use client";

import { useState } from "react";
import { Film, Sparkles, UploadCloud, X } from "lucide-react";
import { GOAL_PRESETS } from "@/lib/podcast";

export interface NewEpisodeInput {
  file: File;
  goal: string;
  clipCount: number;
  minSeconds: number;
  maxSeconds: number;
}

export default function NewEpisodeForm({
  busy,
  phase,
  percent,
  canRun,
  onSubmit,
}: {
  busy: boolean;
  phase: "idle" | "uploading" | "creating";
  percent: number;
  canRun: boolean;
  onSubmit: (input: NewEpisodeInput) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [goal, setGoal] = useState("");
  const [clipCount, setClipCount] = useState(8);
  const [minSeconds, setMinSeconds] = useState(20);
  const [maxSeconds, setMaxSeconds] = useState(90);
  const [dragging, setDragging] = useState(false);

  const submit = () => {
    if (!file) return;
    onSubmit({ file, goal: goal.trim(), clipCount, minSeconds, maxSeconds });
  };

  const field =
    "rounded-md border border-line bg-surface-overlay px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60";

  return (
    <div className="rounded-lg border border-line bg-surface-raised p-5 shadow-elev-1">
      <span className="rr-eyebrow">1 · Recording</span>
      {file ? (
        <div className="mt-3 flex items-center gap-3 rounded-md border border-line bg-surface-overlay px-3 py-2.5">
          <Film className="h-5 w-5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{file.name}</p>
            <p className="font-mono text-[11px] text-ink-faint">{(file.size / 1e6).toFixed(1)} MB</p>
          </div>
          <button
            type="button"
            onClick={() => setFile(null)}
            disabled={busy}
            aria-label="Remove file"
            className="rounded-md p-1 text-ink-faint hover:bg-surface-hover hover:text-ink disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const dropped = e.dataTransfer.files[0];
            if (dropped) setFile(dropped);
          }}
          className={`mt-3 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed px-6 py-10 text-center transition-colors ${
            dragging ? "border-accent bg-accent/5" : "border-line-strong hover:border-ink-faint hover:bg-surface-overlay"
          }`}
        >
          <UploadCloud className="h-7 w-7 text-ink-faint" />
          <span className="text-sm text-ink-dim">Drop the raw episode here, or click to browse</span>
          <span className="font-mono text-[11px] text-ink-faint">MP4, MOV, MKV, WEBM · audio-only files work too</span>
          <input
            type="file"
            accept=".mp4,.mov,.mkv,.webm,.m4v,.mp3,.wav,.m4a,.flac"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (picked) setFile(picked);
            }}
          />
        </label>
      )}

      <div className="mt-6 flex items-center justify-between">
        <span className="rr-eyebrow">2 · What are the clips for?</span>
        <span className="font-mono text-[11px] text-ink-faint">Claude follows this when it scores moments</span>
      </div>
      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        rows={3}
        disabled={busy}
        placeholder="e.g. Funny, self-aware moments about streaming TV for vertical Reels. Skip the news round-up."
        className={`mt-2 w-full resize-none leading-relaxed placeholder:text-ink-faint ${field}`}
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {GOAL_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            disabled={busy}
            onClick={() => setGoal(p.text)}
            className="rounded-full border border-line bg-surface-raised px-3 py-1 font-mono text-[11px] text-ink-dim transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-3 gap-3">
        <label className="flex flex-col gap-1">
          <span className="rr-eyebrow">Candidates</span>
          <select value={clipCount} disabled={busy} onChange={(e) => setClipCount(Number(e.target.value))} className={field}>
            {[4, 6, 8, 10, 12, 15].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="rr-eyebrow">Min seconds</span>
          <input type="number" min={5} max={120} value={minSeconds} disabled={busy} onChange={(e) => setMinSeconds(Number(e.target.value) || 20)} className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="rr-eyebrow">Max seconds</span>
          <input type="number" min={15} max={180} value={maxSeconds} disabled={busy} onChange={(e) => setMaxSeconds(Number(e.target.value) || 90)} className={field} />
        </label>
      </div>

      <button
        type="button"
        onClick={submit}
        disabled={!canRun || !file || busy}
        className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-md bg-ink px-5 py-3 text-sm font-semibold text-ink-inverse shadow-glow-accent transition-colors hover:bg-[#2B2620] disabled:opacity-40 disabled:shadow-none"
      >
        <Sparkles className="h-4 w-4 text-accent" />
        {phase === "uploading" ? `Uploading ${percent}%` : phase === "creating" ? "Starting the analysis…" : "Analyze the episode"}
      </button>
      <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
        The file goes straight into your RocketRide store; the episode-analysis pipeline transcribes it with the stock
        transcriber and asks Claude for explainable candidates. Nothing leaves the engine except the transcript text sent to Claude.
      </p>
    </div>
  );
}
