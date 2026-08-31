"use client";

import { useState } from "react";
import { History, Loader2 } from "lucide-react";
import { fmtDuration, outputDurationMs, type EditsVersion, type EpisodeEdits } from "@/lib/studio";

const when = (created?: number) => (created ? new Date(created * 1000).toLocaleString() : "earlier");

/**
 * A look at a save point before going back to it: what it was called, when it
 * was made, how many changes it holds and how long the episode was. Going back
 * never overwrites anything — it becomes the newest version, and every earlier
 * one stays exactly where it is.
 */
export default function VersionDialog({
  version,
  snapshot,
  loading,
  onRestore,
  onClose,
}: {
  version: EditsVersion;
  snapshot: EpisodeEdits | null;
  loading: boolean;
  onRestore: () => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const ops = snapshot ? snapshot.operations.filter((op) => op.enabled).length : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={`Version ${version.n}`}>
      <div className="rr-card rr-enter w-full max-w-sm p-5">
        <p className="rr-eyebrow inline-flex items-center gap-1.5">
          <History className="h-3.5 w-3.5" /> Save point {version.n}
        </p>
        <p className="rr-h3 mt-2">{version.note || "Untitled save point"}</p>
        <p className="mt-1 text-sm text-ink-dim">Kept on {when(version.created)}</p>

        <div className="mt-3 space-y-1 rounded-sm border border-line bg-surface-overlay px-3 py-2 text-[13px] text-ink-dim">
          {loading ? (
            <p className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking it up…
            </p>
          ) : snapshot ? (
            <>
              <p>{ops} changes in this version</p>
              <p>Episode length {fmtDuration(outputDurationMs(snapshot))}</p>
            </>
          ) : (
            <p>This save point could not be opened. Nothing has changed.</p>
          )}
        </div>

        {confirming ? (
          <p className="mt-3 text-sm text-ink">
            Go back to this save point? Your work right now is kept as a version of its own, so nothing is lost.
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {confirming ? (
            <button type="button" className="rr-btn rr-btn-accent rr-btn-sm" onClick={onRestore}>
              Yes, go back to it
            </button>
          ) : (
            <button type="button" className="rr-btn rr-btn-primary rr-btn-sm" disabled={!snapshot} onClick={() => setConfirming(true)}>
              Go back to this version
            </button>
          )}
          <button type="button" className="rr-btn rr-btn-ghost rr-btn-sm ml-auto" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
