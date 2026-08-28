"use client";

import { Download, Film, Loader2, Play } from "lucide-react";
import { fmtSeconds, fmtTime, scoreTone, type Candidate } from "@/lib/podcast";

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2" title={`${label}: ${value}/10`}>
      <span className="w-[74px] font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">{label}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-overlay">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(4, Math.min(100, value * 10))}%` }} />
      </span>
      <span className="w-5 text-right font-mono text-[10px] text-ink-dim">{value}</span>
    </div>
  );
}

export default function CandidateCard({
  cand,
  selected,
  hasPreview,
  hasExport,
  busy,
  onSelect,
  onPreview,
  onExport,
}: {
  cand: Candidate;
  selected: boolean;
  hasPreview: boolean;
  hasExport: boolean;
  busy: "preview" | "export" | null;
  onSelect: () => void;
  onPreview: () => void;
  onExport: () => void;
}) {
  return (
    <article
      onClick={onSelect}
      className={`cursor-pointer rounded-lg border bg-surface-raised p-4 shadow-elev-1 transition-colors ${
        selected ? "border-accent shadow-glow-accent" : "border-line hover:border-line-strong"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-mono text-xs ${
            cand.custom ? "bg-surface-overlay text-ink-dim" : "bg-ink text-ink-inverse"
          }`}
        >
          {cand.custom ? "✎" : `#${cand.rank}`}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-semibold leading-tight tracking-[-0.01em]">{cand.title}</h3>
          <p className="mt-0.5 font-mono text-[11px] text-ink-faint">
            {fmtTime(cand.start_ms)} → {fmtTime(cand.end_ms)} · {fmtSeconds(cand.duration_ms)}
            {hasPreview ? " · previewed" : ""}
            {hasExport ? " · exported" : ""}
          </p>
        </div>
        {!cand.custom && (
          <span className={`font-display text-2xl font-semibold ${scoreTone(cand.score)}`} title="Weighted score: hook 40%, standalone 30%, clarity 30%">
            {cand.score.toFixed(1)}
          </span>
        )}
      </div>

      {cand.hook && <p className="mt-3 text-sm text-ink">&ldquo;{cand.hook}&rdquo;</p>}
      {cand.reason && <p className="mt-1.5 text-xs leading-relaxed text-ink-dim">{cand.reason}</p>}

      {!cand.custom && (
        <div className="mt-3 space-y-1">
          <ScoreBar label="hook" value={cand.scores.hook} />
          <ScoreBar label="clarity" value={cand.scores.clarity} />
          <ScoreBar label="standalone" value={cand.scores.standalone} />
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onPreview}
          disabled={busy !== null}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-[11px] text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
        >
          {busy === "preview" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          {hasPreview ? "Re-render preview" : "Render preview"}
        </button>
        <button
          type="button"
          onClick={onExport}
          disabled={busy !== null}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-[11px] text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
        >
          {busy === "export" ? <Loader2 className="h-3 w-3 animate-spin" /> : hasExport ? <Download className="h-3 w-3" /> : <Film className="h-3 w-3" />}
          {hasExport ? "Re-export" : "Export 9:16 + 16:9"}
        </button>
      </div>
    </article>
  );
}
