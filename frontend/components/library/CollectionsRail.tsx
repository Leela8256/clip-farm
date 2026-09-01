"use client";

import { useState } from "react";
import { FolderOpen, FolderPlus, Layers, PencilLine, Trash2 } from "lucide-react";
import type { Collection } from "@/lib/library";
import { ConfirmDialog, TextDialog } from "./Modal";

/**
 * Groups of recordings ("Season 2", "Guest interviews"). A collection only
 * points at recordings — deleting one never touches the recordings themselves.
 */
export default function CollectionsRail({
  collections,
  active,
  total,
  onPick,
  onCreate,
  onRename,
  onDelete,
}: {
  collections: Collection[] | null;
  active: string | null;
  total: number;
  onPick: (id: string | null) => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Collection | null>(null);
  const [deleting, setDeleting] = useState<Collection | null>(null);

  return (
    <div className="rr-card p-3">
      <div className="flex items-center justify-between gap-2 px-1.5">
        <p className="rr-eyebrow">Collections</p>
        <button type="button" className="rr-btn rr-btn-ghost rr-btn-sm" onClick={() => setCreating(true)} title="New collection">
          <FolderPlus className="h-3.5 w-3.5" />
          New
        </button>
      </div>

      <ul className="mt-2 space-y-0.5">
        <li>
          <button
            type="button"
            onClick={() => onPick(null)}
            aria-current={active === null ? "true" : undefined}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${
              active === null ? "bg-surface-overlay text-ink" : "text-ink-dim hover:bg-surface-overlay hover:text-ink"
            }`}
          >
            <Layers className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            <span className="flex-1 truncate">Everything</span>
            <span className="font-mono text-[11px] text-ink-faint">{total}</span>
          </button>
        </li>
        {collections === null ? (
          <li className="px-2 py-2">
            <div className="rr-skeleton h-3.5 w-2/3" />
          </li>
        ) : collections.length === 0 ? (
          <li className="px-2 py-2 text-[12px] text-ink-faint">No collections yet — group recordings any way you like.</li>
        ) : (
          collections.map((c) => (
            <li key={c.id} className="group flex items-center gap-1">
              <button
                type="button"
                onClick={() => onPick(c.id)}
                aria-current={active === c.id ? "true" : undefined}
                className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${
                  active === c.id ? "bg-surface-overlay text-ink" : "text-ink-dim hover:bg-surface-overlay hover:text-ink"
                }`}
              >
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <span className="flex-1 truncate" title={c.name}>
                  {c.name}
                </span>
                <span className="font-mono text-[11px] text-ink-faint">{c.projects?.length ?? 0}</span>
              </button>
              <span className="flex shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <button type="button" className="rounded-md p-1 text-ink-faint hover:bg-surface-overlay hover:text-ink" onClick={() => setRenaming(c)} aria-label={`Rename ${c.name}`}>
                  <PencilLine className="h-3.5 w-3.5" />
                </button>
                <button type="button" className="rounded-md p-1 text-ink-faint hover:bg-surface-overlay hover:text-danger" onClick={() => setDeleting(c)} aria-label={`Delete ${c.name}`}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </li>
          ))
        )}
      </ul>

      {creating && <TextDialog title="New collection" label="Name" placeholder="Season 2" confirmLabel="Create" onSubmit={(v) => onCreate(v)} onClose={() => setCreating(false)} />}
      {renaming && (
        <TextDialog title="Rename collection" label="Name" initial={renaming.name} onSubmit={(v) => onRename(renaming.id, v)} onClose={() => setRenaming(null)} />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.name}”?`}
          body="The collection goes away. Every recording in it stays in your library."
          confirmLabel="Delete collection"
          onConfirm={() => onDelete(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
