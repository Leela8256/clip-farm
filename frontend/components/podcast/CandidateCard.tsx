"use client";

import { Download, Loader2, Play } from "lucide-react";
import { complianceBadges, type RequestSpec } from "@/lib/director";
import { fmtSeconds, fmtTime, scoreTone, type Candidate } from "@/lib/podcast";
import ComplianceBadges from "./ComplianceBadges";

interface Props {
  cand: Candidate;
  spec?: RequestSpec | null;
  selected: boolean;
  hasPreview: boolean;
  hasExport: boolean;
  /** the preview was made before the changes now on screen */
  stale?: boolean;
  busy: "preview" | "export" | null;
  onSelect: () => void;
  onPreview: () => void;
  onExport: () => void;
  /** "row" (default): one compact line that expands when selected; "card": the older tall card */
  variant?: "row" | "card";
}

const WEIGHTS_DIRECTED = "Weighted score: prompt match 35%, hook 25%, standalone 20%, clarity 10%, energy 10%";
const WEIGHTS_PLAIN = "Weighted score: hook 40%, standalone 30%, clarity 30%";

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2" title={`${label}: ${value}/10`}>
      <span className="w-[72px] shrink-0 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-faint">{label}</span>
      <span className="h-1 flex-1 overflow-hidden rounded-full bg-surface-overlay">
        <span className="block h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(4, Math.min(100, value * 10))}%` }} />
      </span>
      <span className="w-5 shrink-0 text-right font-mono text-[11px] text-ink-dim">{value}</span>
    </div>
  );
}

function ScoreRing({ score, directed }: { score: number; directed: boolean }) {
  const r = 12;
  const circumference = 2 * Math.PI * r;
  const share = Math.max(0, Math.min(1, score / 10));
  return (
    <span className={`relative flex h-8 w-8 shrink-0 items-center justify-center ${scoreTone(score)}`} title={directed ? WEIGHTS_DIRECTED : WEIGHTS_PLAIN}>
      <svg viewBox="0 0 32 32" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden="true">
        <circle cx="16" cy="16" r={r} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.5" />
        <circle cx="16" cy="16" r={r} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${circumference * share} ${circumference}`} />
      </svg>
      <span className="font-mono text-[10px] font-medium leading-none text-ink">{score.toFixed(1)}</span>
    </span>
  );
}

function ScoreBars({ cand }: { cand: Candidate }) {
  const directed = cand.scores.prompt_match != null;
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
      {directed && <ScoreBar label="prompt" value={cand.scores.prompt_match ?? 0} />}
      <ScoreBar label="hook" value={cand.scores.hook} />
      <ScoreBar label="standalone" value={cand.scores.standalone} />
      <ScoreBar label="clarity" value={cand.scores.clarity} />
      {directed && <ScoreBar label="energy" value={cand.scores.energy ?? 0} />}
    </div>
  );
}

function RankBadge({ cand, size = "h-6 w-6 text-[11px]" }: { cand: Candidate; size?: string }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full font-mono ${size} ${cand.custom ? "bg-surface-overlay text-ink-dim" : "bg-ink text-ink-inverse"}`}
      title={cand.request_id ? `request ${cand.request_id}` : cand.custom ? "picked by hand" : `rank ${cand.rank}`}
    >
      {cand.custom ? "✎" : cand.rank}
    </span>
  );
}

/** A clip candidate: one compact row (default) or the older tall card. */
export default function CandidateCard(props: Props) {
  const { variant = "row" } = props;
  return variant === "card" ? <CardVariant {...props} /> : <RowVariant {...props} />;
}

function RowVariant({ cand, spec, selected, hasPreview, hasExport, stale, busy, onSelect, onPreview, onExport }: Props) {
  const directed = cand.scores.prompt_match != null;
  const badges = cand.compliance ? complianceBadges(cand.compliance, spec) : [];
  const seconds = Math.round(cand.duration_ms / 1000);
  const actionsVisible = selected || busy !== null;

  return (
    <article
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`rr-card group relative cursor-pointer select-none overflow-hidden outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 ${
        selected ? "border-accent bg-accent/[0.06] shadow-glow-accent" : "rr-card-hover"
      }`}
    >
      {selected && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-accent" />}

      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <RankBadge cand={cand} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[14px] font-medium leading-5 text-ink">{cand.title}</h3>
          <p className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-[12px] leading-4">
            <span className="shrink-0 font-mono text-[11px] text-ink-faint">
              {fmtTime(cand.start_ms)} → {fmtTime(cand.end_ms)} · {seconds}s
            </span>
            {cand.hook && <span className="min-w-0 truncate text-ink-dim">&ldquo;{cand.hook}&rdquo;</span>}
          </p>
        </div>

        <span className="flex w-4 shrink-0 flex-col items-center gap-1" aria-hidden={!hasPreview && !hasExport}>
          {hasPreview && (
            <span
              className={`h-1.5 w-1.5 rounded-full ${stale ? "bg-processing ring-2 ring-processing/30" : "bg-ready"}`}
              title={stale ? "Preview is behind your edits" : "Previewed"}
            />
          )}
          {hasExport && <span className="h-1.5 w-1.5 rounded-full bg-accent" title="Exported" />}
        </span>

        {!cand.custom && <ScoreRing score={cand.score} directed={directed} />}

        <div
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className={`flex shrink-0 items-center gap-0.5 transition-opacity ${actionsVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}
        >
          <button type="button" onClick={onPreview} disabled={busy !== null} className="rr-btn rr-btn-ghost rr-btn-sm" title={hasPreview ? "Render the preview again" : "Render a preview"}>
            {busy === "preview" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Preview
          </button>
          <button type="button" onClick={onExport} disabled={busy !== null} className="rr-btn rr-btn-ghost rr-btn-sm" title={hasExport ? "Export again" : "Export 9:16 + 16:9 with captions"}>
            {busy === "export" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Export
          </button>
        </div>
      </div>

      {selected && (
        <div className="rr-enter border-t border-line px-3.5 py-3 pl-[52px]">
          <p className="mb-2 flex flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-accent">
            Editing this clip
            {stale && <span className="rounded-full bg-processing/15 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-processing">preview is behind your edits</span>}
          </p>
          {cand.reason && <p className="line-clamp-2 text-[12px] leading-5 text-ink-dim">{cand.reason}</p>}
          {!cand.custom && (
            <div className={cand.reason ? "mt-2.5" : ""}>
              <ScoreBars cand={cand} />
            </div>
          )}
          <ComplianceBadges badges={badges} className="mt-2.5" />
        </div>
      )}
    </article>
  );
}

function CardVariant({ cand, spec, selected, hasPreview, hasExport, busy, onSelect, onPreview, onExport }: Props) {
  const directed = cand.scores.prompt_match != null;
  const badges = cand.compliance ? complianceBadges(cand.compliance, spec) : [];
  return (
    <article onClick={onSelect} className={`rr-card cursor-pointer p-4 ${selected ? "border-accent shadow-glow-accent" : "rr-card-hover"}`}>
      <div className="flex items-start gap-3">
        <RankBadge cand={cand} size="h-8 w-8 text-xs" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold leading-snug text-ink">{cand.title}</h3>
          <p className="mt-0.5 font-mono text-[11px] text-ink-faint">
            {fmtTime(cand.start_ms)} → {fmtTime(cand.end_ms)} · {fmtSeconds(cand.duration_ms)}
            {cand.speaker ? ` · ${cand.speaker}` : ""}
            {hasPreview ? " · previewed" : ""}
            {hasExport ? " · exported" : ""}
          </p>
        </div>
        {!cand.custom && <ScoreRing score={cand.score} directed={directed} />}
      </div>
      {cand.hook && <p className="mt-3 text-[13px] text-ink">&ldquo;{cand.hook}&rdquo;</p>}
      {cand.reason && <p className="mt-1.5 text-[12px] leading-5 text-ink-dim">{cand.reason}</p>}
      <ComplianceBadges badges={badges} className="mt-2" />
      {!cand.custom && (
        <div className="mt-3">
          <ScoreBars cand={cand} />
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={onPreview} disabled={busy !== null} className="rr-btn rr-btn-sm">
          {busy === "preview" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          {hasPreview ? "Preview again" : "Preview"}
        </button>
        <button type="button" onClick={onExport} disabled={busy !== null} className="rr-btn rr-btn-ghost rr-btn-sm">
          {busy === "export" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {hasExport ? "Export again" : "Export"}
        </button>
      </div>
    </article>
  );
}
