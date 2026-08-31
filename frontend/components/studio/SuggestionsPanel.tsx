"use client";

import { Check, Ear, Headphones, Play, RotateCcw, X } from "lucide-react";
import {
  SUGGESTION_LABELS,
  fmtDuration,
  fmtPosition,
  isEnglish,
  isReviewOnly,
  isReviewed,
  suggestionConflict,
  suggestionState,
  suggestionTimeSavedMs,
  type EpisodeEdits,
  type Suggestion,
  type SuggestionKind,
} from "@/lib/studio";
import { ACTION_LABELS, operationFor } from "./helpers";

/**
 * Things worth tidying, found in the recording. Nothing here changes the episode
 * until it is accepted, and anything accepted can be put back. Anything we are
 * not sure about is only ever offered for a listen — never applied for you.
 */
export default function SuggestionsPanel({
  suggestions,
  edits,
  language,
  unsupported,
  summary,
  onAccept,
  onReject,
  onPlay,
  onAudition,
  onMarkReviewed,
  onToggleOperation,
}: {
  suggestions: Suggestion[];
  edits: EpisodeEdits;
  /** the language of the recording, when it was recognised */
  language: string;
  /** kinds of cleanup that cannot be offered for that language */
  unsupported: SuggestionKind[];
  /** what the last "apply all" actually did */
  summary: string;
  onAccept: (s: Suggestion) => void;
  onReject: (s: Suggestion) => void;
  onPlay: (ms: number) => void;
  onAudition: (range: { start_ms: number; end_ms: number }) => void;
  onMarkReviewed: (id: string) => void;
  onToggleOperation: (id: string) => void;
}) {
  const review = suggestions.filter(isReviewOnly);
  const actionable = suggestions.filter((s) => !isReviewOnly(s));

  const groups = new Map<SuggestionKind, Suggestion[]>();
  for (const s of actionable) {
    const list = groups.get(s.kind) ?? [];
    list.push(s);
    groups.set(s.kind, list);
  }
  const open = actionable.filter((s) => suggestionState(edits, s) === "open").length;
  const toListen = review.filter((s) => !isReviewed(edits, s)).length;
  const missing = (isEnglish(language) ? [] : unsupported).map((k) => (SUGGESTION_LABELS[k as SuggestionKind] ?? k).toLowerCase());

  return (
    <section className="rr-card overflow-hidden">
      <header className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-2.5">
        <h2 className="text-sm font-semibold">Suggestions</h2>
        <span className="rr-mono text-ink-faint">{open} to review</span>
      </header>

      {summary ? <p className="border-b border-line bg-surface-overlay px-3.5 py-1.5 text-[11px] text-ink-dim">{summary}</p> : null}

      {!suggestions.length ? (
        <p className="px-3.5 py-6 text-center text-sm text-ink-faint">Nothing to tidy at this level. Try a tighter cleanup.</p>
      ) : (
        <div className="max-h-[46vh] overflow-y-auto">
          {review.length ? (
            <details open={toListen > 0} className="border-b border-line">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2 text-[13px] font-medium marker:hidden hover:bg-surface-overlay">
                <span className="inline-flex items-center gap-1.5">
                  <Ear className="h-3.5 w-3.5 text-processing" /> Needs a listen
                </span>
                <span className="rr-mono text-ink-faint">{toListen}</span>
              </summary>
              <p className="px-3.5 pb-1.5 text-[11px] text-ink-faint">
                We couldn&apos;t hear these clearly. Nothing is changed here — have a listen and decide yourself.
              </p>
              <ul className="pb-1">
                {review.map((s) => {
                  const done = isReviewed(edits, s);
                  return (
                    <li key={s.id} className={`flex items-start gap-2 px-3.5 py-1.5 text-[13px] ${done ? "opacity-45" : ""}`}>
                      <button
                        type="button"
                        onClick={() => onAudition({ start_ms: s.start_ms, end_ms: s.end_ms })}
                        title="Listen with a run-up"
                        className="rr-btn rr-btn-ghost rr-btn-icon h-6 w-6 shrink-0"
                      >
                        <Headphones className="h-3 w-3" />
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-ink" title={s.text}>
                          {s.text || "Hard to make out"}
                        </p>
                        <p className="rr-mono text-ink-faint">
                          {fmtPosition(s.start_ms)}
                          {done ? " · listened" : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button type="button" onClick={() => onPlay(s.start_ms)} className="rr-btn rr-btn-sm px-2" title="Jump to it in the text">
                          <Play className="h-3.5 w-3.5" />
                        </button>
                        {!done ? (
                          <button type="button" onClick={() => onMarkReviewed(s.id)} className="rr-btn rr-btn-sm" title="I have listened to this">
                            <Check className="h-3.5 w-3.5 text-ready" /> Done
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}

          {[...groups.entries()].map(([kind, list]) => (
            <details key={kind} open={list.length <= 12} className="border-b border-line last:border-b-0">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2 text-[13px] font-medium marker:hidden hover:bg-surface-overlay">
                <span>{SUGGESTION_LABELS[kind] ?? kind}</span>
                <span className="rr-mono text-ink-faint">{list.length}</span>
              </summary>
              <ul className="pb-1">
                {list.map((s) => {
                  const state = suggestionState(edits, s);
                  const accepted = state === "accepted";
                  const rejected = state === "rejected";
                  const op = operationFor(edits, s);
                  const restored = !!op && op.enabled === false;
                  const clash = !accepted && !rejected && suggestionConflict(edits, s);
                  const saves = suggestionTimeSavedMs(s);
                  return (
                    <li
                      key={s.id}
                      className={`flex items-start gap-2 px-3.5 py-1.5 text-[13px] ${accepted ? "bg-ready/5" : rejected ? "opacity-45" : ""}`}
                    >
                      <button
                        type="button"
                        onClick={() => onAudition({ start_ms: s.start_ms, end_ms: s.end_ms })}
                        title="Listen with a run-up"
                        className="rr-btn rr-btn-ghost rr-btn-icon h-6 w-6 shrink-0"
                      >
                        <Headphones className="h-3 w-3" />
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-ink" title={s.text}>
                          {s.text || ACTION_LABELS[s.action]}
                        </p>
                        <p className="rr-mono text-ink-faint">
                          {fmtPosition(s.start_ms)} · {ACTION_LABELS[s.action] ?? s.action}
                          {saves > 400 ? ` · saves ${fmtDuration(saves)}` : ""}
                          {accepted ? (restored ? " · put back" : " · applied") : ""}
                          {clash ? " · overlaps an edit" : ""}
                        </p>
                      </div>
                      {accepted && op ? (
                        <button type="button" onClick={() => onToggleOperation(op.id)} className="rr-btn rr-btn-ghost rr-btn-sm shrink-0" title={restored ? "Apply it again" : "Put this back"}>
                          <RotateCcw className="h-3 w-3" /> {restored ? "Redo" : "Undo"}
                        </button>
                      ) : (
                        <div className="flex shrink-0 gap-1">
                          <button type="button" onClick={() => onAccept(s)} className="rr-btn rr-btn-sm px-2" title={clash ? "Take it anyway — it overlaps a change you made" : "Accept"}>
                            <Check className="h-3.5 w-3.5 text-ready" />
                          </button>
                          <button type="button" onClick={() => onReject(s)} className="rr-btn rr-btn-sm px-2" title="No thanks">
                            <X className="h-3.5 w-3.5 text-ink-faint" />
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </details>
          ))}
        </div>
      )}

      {missing.length ? (
        <p className="border-t border-line px-3.5 py-2 text-[11px] text-ink-faint">
          Tidying {missing.join(" and ")} isn&apos;t available for this recording&apos;s language yet — everything else still is.
        </p>
      ) : null}
    </section>
  );
}
