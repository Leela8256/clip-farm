"use client";

import { Check, Play, RotateCcw, X } from "lucide-react";
import { SUGGESTION_LABELS, fmtPosition, suggestionState, type EpisodeEdits, type Suggestion, type SuggestionKind } from "@/lib/studio";
import { ACTION_LABELS, operationFor } from "./helpers";

/**
 * Things worth tidying, found in the recording. Nothing here changes the episode
 * until it is accepted, and anything accepted can be put back.
 */
export default function SuggestionsPanel({
  suggestions,
  edits,
  onAccept,
  onReject,
  onPlay,
  onToggleOperation,
}: {
  suggestions: Suggestion[];
  edits: EpisodeEdits;
  onAccept: (s: Suggestion) => void;
  onReject: (s: Suggestion) => void;
  onPlay: (ms: number) => void;
  onToggleOperation: (id: string) => void;
}) {
  const groups = new Map<SuggestionKind, Suggestion[]>();
  for (const s of suggestions) {
    const list = groups.get(s.kind) ?? [];
    list.push(s);
    groups.set(s.kind, list);
  }
  const open = suggestions.filter((s) => suggestionState(edits, s) === "open").length;

  return (
    <section className="rr-card overflow-hidden">
      <header className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-2.5">
        <h2 className="text-sm font-semibold">Suggestions</h2>
        <span className="rr-mono text-ink-faint">{open} to review</span>
      </header>

      {!suggestions.length ? (
        <p className="px-3.5 py-6 text-center text-sm text-ink-faint">Nothing to tidy at this level. Try a tighter cleanup.</p>
      ) : (
        <div className="max-h-[46vh] overflow-y-auto">
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
                  return (
                    <li
                      key={s.id}
                      className={`flex items-start gap-2 px-3.5 py-1.5 text-[13px] ${accepted ? "bg-ready/5" : rejected ? "opacity-45" : ""}`}
                    >
                      <button type="button" onClick={() => onPlay(s.start_ms)} title="Listen to this bit" className="rr-btn rr-btn-ghost rr-btn-icon h-6 w-6 shrink-0">
                        <Play className="h-3 w-3" />
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-ink" title={s.text}>
                          {s.text || ACTION_LABELS[s.action]}
                        </p>
                        <p className="rr-mono text-ink-faint">
                          {fmtPosition(s.start_ms)} · {ACTION_LABELS[s.action] ?? s.action}
                          {accepted ? (restored ? " · put back" : " · applied") : ""}
                        </p>
                      </div>
                      {accepted && op ? (
                        <button type="button" onClick={() => onToggleOperation(op.id)} className="rr-btn rr-btn-ghost rr-btn-sm shrink-0" title={restored ? "Apply it again" : "Put this back"}>
                          <RotateCcw className="h-3 w-3" /> {restored ? "Redo" : "Undo"}
                        </button>
                      ) : (
                        <div className="flex shrink-0 gap-1">
                          <button type="button" onClick={() => onAccept(s)} className="rr-btn rr-btn-sm px-2" title="Accept">
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
    </section>
  );
}
