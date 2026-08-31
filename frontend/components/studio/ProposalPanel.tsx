"use client";

import { useState } from "react";
import { Check, Headphones, Loader2, Sparkles, Trash2, X } from "lucide-react";
import {
  MODE_LABELS,
  SUGGESTION_MODES,
  fmtDuration,
  fmtPosition,
  isSafeProposalItem,
  proposalItemConflict,
  type EditProposal,
  type EpisodeEdits,
  type ProposalItem,
  type SuggestionMode,
} from "@/lib/studio";
import { CATEGORY_LABELS } from "./helpers";

const PLACEHOLDER = "Tighten the first twenty minutes: drop the setup chatter and the long pauses, but keep the story about the first tour.";

/**
 * Ask for an edit in your own words and get a list of suggested removals back —
 * each one with a reason, how sure we are and how much time it saves. Nothing
 * happens to the episode until a change is taken, and every change taken is an
 * ordinary edit you can put back.
 */
export default function ProposalPanel({
  proposal,
  edits,
  busy,
  progress,
  mode,
  onDraft,
  onApply,
  onReject,
  onApplySafe,
  onDiscard,
  onAudition,
}: {
  proposal: EditProposal | null;
  edits: EpisodeEdits;
  busy: boolean;
  progress: string;
  mode: SuggestionMode;
  onDraft: (goal: string, mode: SuggestionMode) => void;
  onApply: (item: ProposalItem) => void;
  onReject: (item: ProposalItem) => void;
  onApplySafe: () => void;
  onDiscard: () => void;
  onAudition: (range: { start_ms: number; end_ms: number }) => void;
}) {
  const [goal, setGoal] = useState("");
  const [pick, setPick] = useState<SuggestionMode>(mode);

  const items = proposal?.items ?? [];
  const open = items.filter((item) => item.status === "open");
  const safeLeft = open.filter((item) => isSafeProposalItem(item) && !proposalItemConflict(edits, item, proposal?.id)).length;
  const takenMs = items.filter((item) => item.status === "applied").reduce((sum, item) => sum + item.saved_ms, 0);

  const groups = new Map<string, ProposalItem[]>();
  for (const item of items) {
    const list = groups.get(item.category) ?? [];
    list.push(item);
    groups.set(item.category, list);
  }

  return (
    <section className="rr-card overflow-hidden">
      <header className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-2.5">
        <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="h-3.5 w-3.5 text-accent" /> Draft an edit
        </h2>
        {proposal ? <span className="rr-mono text-ink-faint">{open.length} to decide</span> : null}
      </header>

      <div className="space-y-2.5 px-3.5 py-3">
        <textarea
          className="rr-textarea min-h-[76px] text-sm"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder={PLACEHOLDER}
          aria-label="What should this edit do?"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          {SUGGESTION_MODES.map((m) => (
            <button key={m} type="button" className="rr-chip" data-active={pick === m} onClick={() => setPick(m)}>
              {MODE_LABELS[m]}
            </button>
          ))}
          <button type="button" className="rr-btn rr-btn-accent rr-btn-sm ml-auto" disabled={busy || goal.trim().length < 8} onClick={() => onDraft(goal.trim(), pick)}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Draft it
          </button>
        </div>
        <p className="text-[11px] text-ink-faint">Say what to keep as well as what to lose. Nothing changes until you take a change.</p>
        {busy ? (
          <div className="space-y-1.5">
            <div className="rr-progress" data-indeterminate="true">
              <i />
            </div>
            <p className="text-[11px] text-ink-dim">{progress || "Reading the episode…"}</p>
          </div>
        ) : null}
      </div>

      {proposal ? (
        <>
          <div className="flex flex-wrap items-center gap-x-2 border-t border-line bg-surface-overlay px-3.5 py-2 text-[11px] text-ink-dim">
            <span>
              {fmtDuration(proposal.totals.original_ms)} → <span className="font-medium text-ink">{fmtDuration(proposal.totals.proposed_ms)}</span> ·{" "}
              {fmtDuration(proposal.totals.removed_ms)} would come out
              {takenMs ? ` · ${fmtDuration(takenMs)} taken so far` : ""}
            </span>
            {proposal.dropped.length ? <span className="text-ink-faint">{proposal.dropped.length} left out (they clashed with your edits)</span> : null}
          </div>

          {proposal.notes ? <p className="border-b border-line px-3.5 py-1.5 text-[11px] text-ink-dim">{proposal.notes}</p> : null}

          <div className="max-h-[40vh] overflow-y-auto">
            {[...groups.entries()].map(([category, list]) => (
              <details key={category} open className="border-b border-line last:border-b-0">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2 text-[13px] font-medium marker:hidden hover:bg-surface-overlay">
                  <span>{CATEGORY_LABELS[category] ?? category}</span>
                  <span className="rr-mono text-ink-faint">{list.length}</span>
                </summary>
                <ul className="pb-1">
                  {list.map((item) => {
                    const clash = item.status === "open" && proposalItemConflict(edits, item, proposal.id);
                    return (
                      <li
                        key={item.id}
                        className={`flex items-start gap-2 px-3.5 py-1.5 text-[13px] ${item.status === "applied" ? "bg-ready/5" : item.status === "rejected" ? "opacity-45" : ""}`}
                      >
                        <button
                          type="button"
                          onClick={() => onAudition({ start_ms: item.start_ms, end_ms: item.end_ms })}
                          title="Listen with a run-up"
                          className="rr-btn rr-btn-ghost rr-btn-icon h-6 w-6 shrink-0"
                        >
                          <Headphones className="h-3 w-3" />
                        </button>
                        <div className="min-w-0 flex-1">
                          <p className="text-ink" title={item.reason}>
                            {item.reason || "Suggested removal"}
                          </p>
                          <p className="rr-mono text-ink-faint">
                            {fmtPosition(item.start_ms)} · saves {fmtDuration(item.saved_ms)} · {Math.round(item.confidence * 100)}% sure
                            {item.status === "applied" ? " · taken" : item.status === "rejected" ? " · turned down" : ""}
                            {clash ? " · overlaps an edit" : ""}
                          </p>
                        </div>
                        {item.status === "open" ? (
                          <div className="flex shrink-0 gap-1">
                            <button type="button" onClick={() => onApply(item)} className="rr-btn rr-btn-sm px-2" title={clash ? "Take it anyway — it overlaps a change you made" : "Take this change"}>
                              <Check className="h-3.5 w-3.5 text-ready" />
                            </button>
                            <button type="button" onClick={() => onReject(item)} className="rr-btn rr-btn-sm px-2" title="No thanks">
                              <X className="h-3.5 w-3.5 text-ink-faint" />
                            </button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </details>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3.5 py-2">
            <button type="button" className="rr-btn rr-btn-sm" disabled={!safeLeft} onClick={onApplySafe}>
              <Check className="h-3.5 w-3.5" /> Apply all {safeLeft} safe changes
            </button>
            <button type="button" className="rr-btn rr-btn-ghost rr-btn-sm ml-auto" onClick={onDiscard}>
              <Trash2 className="h-3.5 w-3.5" /> Discard this draft
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
