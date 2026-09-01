"use client";

import { useState } from "react";
import type { Collection } from "@/lib/library";
import { Modal } from "./Modal";

/** Tick the collections this recording belongs to. */
export default function CollectionPicker({
  collections,
  projectId,
  title,
  onToggle,
  onCreate,
  onClose,
}: {
  collections: Collection[] | null;
  projectId: string;
  title: string;
  onToggle: (collectionId: string, member: boolean) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");

  const toggle = async (id: string, member: boolean) => {
    setBusy(id);
    try {
      await onToggle(id, member);
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    const text = name.trim();
    if (!text) return;
    setBusy("new");
    try {
      await onCreate(text);
      setName("");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="Add to a collection" subtitle={title} onClose={onClose} width="460px">
      {collections === null ? (
        <div className="rr-skeleton h-20 w-full" />
      ) : (
        <ul className="space-y-1">
          {collections.length === 0 && <li className="pb-2 text-[13px] text-ink-faint">No collections yet. Make the first one below.</li>}
          {collections.map((c) => {
            const member = (c.projects ?? []).includes(projectId);
            return (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-surface-overlay">
                  <input
                    type="checkbox"
                    checked={member}
                    disabled={busy === c.id}
                    onChange={(e) => void toggle(c.id, e.target.checked)}
                    className="h-3.5 w-3.5 accent-[color:var(--rr-accent)]"
                  />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{c.name}</span>
                  <span className="font-mono text-[11px] text-ink-faint">{c.projects?.length ?? 0}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 flex items-end gap-2 border-t border-line pt-4">
        <div className="rr-field flex-1">
          <label htmlFor="rr-new-collection">New collection</label>
          <input
            id="rr-new-collection"
            className="rr-input"
            value={name}
            placeholder="Season 2"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void create();
              }
            }}
          />
        </div>
        <button type="button" className="rr-btn" onClick={() => void create()} disabled={!name.trim() || busy === "new"}>
          Add
        </button>
      </div>
    </Modal>
  );
}
