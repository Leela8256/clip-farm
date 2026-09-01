"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { CheckSquare, RefreshCw, Search, Upload, Wand2, X } from "lucide-react";
import { getClient, getConnectionState, subscribeConnection } from "@/lib/engine";
import {
  applyBrandTemplate,
  archiveProject,
  createCollection,
  deleteCollection,
  listCollections,
  listProjects,
  renameCollection,
  renameProject,
  setCollectionMembership,
  type Collection,
  type ProjectSummary,
} from "@/lib/library";
import { listTemplates, type BrandTemplate } from "@/lib/brand";
import { listBatches, type Batch } from "@/lib/batch";
import ProjectCard from "@/components/library/ProjectCard";
import LibrarySkeleton from "@/components/library/LibrarySkeleton";
import CollectionsRail from "@/components/library/CollectionsRail";
import TemplatePicker from "@/components/library/TemplatePicker";
import CollectionPicker from "@/components/library/CollectionPicker";
import BatchModal from "@/components/library/BatchModal";
import BatchHistory from "@/components/library/BatchHistory";
import { ConfirmDialog, TextDialog } from "@/components/library/Modal";
import { toast } from "@/components/shell/Toasts";

const serverState = () => "idle" as const;

type SortKey = "newest" | "oldest" | "title" | "longest";
type StatusKey = "all" | "ready" | "analysing" | "failed" | "new";

const STATUS_FILTERS: { key: StatusKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "ready", label: "Ready" },
  { key: "analysing", label: "Being read" },
  { key: "failed", label: "Needs a retry" },
  { key: "new", label: "Not read yet" },
];

export default function ProjectsPage() {
  const connection = useSyncExternalStore(subscribeConnection, getConnectionState, serverState);

  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [templates, setTemplates] = useState<BrandTemplate[] | null>(null);
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [loading, setLoading] = useState(false);

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [status, setStatus] = useState<StatusKey>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [collection, setCollection] = useState<string | null>(null);

  const [selecting, setSelecting] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [collectingMany, setCollectingMany] = useState(false);

  const [renaming, setRenaming] = useState<ProjectSummary | null>(null);
  const [archiving, setArchiving] = useState<ProjectSummary | null>(null);
  const [branding, setBranding] = useState<ProjectSummary | null>(null);
  const [collecting, setCollecting] = useState<ProjectSummary | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);

  // Open the connection on arrival and keep knocking while it is down.
  useEffect(() => {
    if (connection === "connected") return;
    const kick = () => void getClient().catch(() => {});
    const first = setTimeout(kick, 0);
    const retry = setInterval(kick, 5000);
    return () => {
      clearTimeout(first);
      clearInterval(retry);
    };
  }, [connection]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const listing = await listProjects({ exports: true });
      setProjects(listing.projects);
      setLoadError(listing.failed ? listing.error || "Your library could not be read just now." : null);
      const [cols, tpls, runs] = await Promise.all([listCollections(), listTemplates(), listBatches()]);
      setCollections(cols);
      setTemplates(tpls);
      setBatches(runs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connection !== "connected") return;
    const timer = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(timer);
  }, [connection, refresh]);

  const templateName = useMemo(() => new Map((templates ?? []).map((t) => [t.id, t.name])), [templates]);
  const names = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p.title])), [projects]);
  const inCollection = useMemo(() => {
    if (!collection) return null;
    const found = (collections ?? []).find((c) => c.id === collection);
    return new Set(found?.projects ?? []);
  }, [collection, collections]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (projects ?? []).filter((p) => {
      if (!showArchived && p.archived) return false;
      if (showArchived && !p.archived) return false;
      if (status !== "all" && p.status !== status) return false;
      if (inCollection && !inCollection.has(p.id)) return false;
      if (q && !p.title.toLowerCase().includes(q) && !(p.goal ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
    return [...list].sort((a, b) =>
      sort === "newest"
        ? (b.created ?? 0) - (a.created ?? 0)
        : sort === "oldest"
          ? (a.created ?? 0) - (b.created ?? 0)
          : sort === "longest"
            ? (b.durationMs ?? 0) - (a.durationMs ?? 0)
            : a.title.localeCompare(b.title)
    );
  }, [projects, query, sort, status, showArchived, inCollection]);

  const selected = useMemo(() => (projects ?? []).filter((p) => chosen.includes(p.id)), [projects, chosen]);
  const archivedCount = useMemo(() => (projects ?? []).filter((p) => p.archived).length, [projects]);

  const pick = (id: string, on: boolean) => setChosen((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));

  const doRename = async (title: string) => {
    if (!renaming) return;
    await renameProject(renaming.id, title);
    setProjects((prev) => (prev ?? []).map((p) => (p.id === renaming.id ? { ...p, title, displayTitle: title } : p)));
    toast("Renamed", "ok");
  };

  const doArchive = async () => {
    if (!archiving) return;
    const next = !archiving.archived;
    await archiveProject(archiving.id, next);
    setProjects((prev) => (prev ?? []).map((p) => (p.id === archiving.id ? { ...p, archived: next } : p)));
    toast(next ? "Moved to the archive" : "Back in your library", "ok");
  };

  const doTemplate = async (templateId: string | null) => {
    if (!branding) return;
    await applyBrandTemplate(branding.id, templateId);
    setProjects((prev) => (prev ?? []).map((p) => (p.id === branding.id ? { ...p, brandTemplate: templateId ?? undefined } : p)));
    toast(templateId ? "Brand look saved for this recording" : "Brand look removed", "ok");
  };

  const doCollectionToggle = async (collectionId: string, member: boolean) => {
    if (!collecting) return;
    const updated = await setCollectionMembership(collectionId, collecting.id, member);
    setCollections((prev) => (prev ?? []).map((c) => (c.id === updated.id ? updated : c)));
  };

  const addCollection = async (name: string) => {
    const made = await createCollection(name);
    setCollections((prev) => [...(prev ?? []), made]);
  };

  const editCollection = async (id: string, name: string) => {
    const updated = await renameCollection(id, name);
    setCollections((prev) => (prev ?? []).map((c) => (c.id === id ? updated : c)));
  };

  const dropCollection = async (id: string) => {
    await deleteCollection(id);
    setCollections((prev) => (prev ?? []).filter((c) => c.id !== id));
    if (collection === id) setCollection(null);
  };

  const offline = connection !== "connected";

  return (
    <div className="mx-auto max-w-[1180px]">
      <header className="rr-enter flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="rr-h1">My Projects</h1>
          <p className="mt-2 text-ink-dim">Every recording you&apos;ve brought in, and what you can do with it.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setSelecting((s) => !s);
              setChosen([]);
            }}
            className={`rr-btn rr-btn-sm ${selecting ? "rr-btn-primary" : ""}`}
          >
            <CheckSquare className="h-3.5 w-3.5" />
            {selecting ? "Stop choosing" : "Choose several"}
          </button>
          <button type="button" onClick={() => void refresh()} disabled={offline || loading} aria-label="Refresh" title="Refresh" className="rr-btn rr-btn-ghost rr-btn-icon">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <Link href="/" className="rr-btn rr-btn-primary rr-btn-sm">
            <Upload className="h-3.5 w-3.5 text-accent" />
            New episode
          </Link>
        </div>
      </header>

      <div className="rr-enter mt-6 flex flex-col gap-3 lg:flex-row lg:items-center" style={{ animationDelay: "60ms" }}>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <input type="search" className="rr-input pl-9" placeholder="Search by name or direction" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search recordings" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button key={f.key} type="button" className="rr-chip" data-active={status === f.key ? "true" : "false"} onClick={() => setStatus(f.key)}>
              {f.label}
            </button>
          ))}
          <button type="button" className="rr-chip" data-active={showArchived ? "true" : "false"} onClick={() => setShowArchived((v) => !v)} title="Recordings you have put away">
            Archived{archivedCount ? ` · ${archivedCount}` : ""}
          </button>
        </div>
        <select className="rr-select lg:w-44" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort recordings">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="title">By name</option>
          <option value="longest">Longest first</option>
        </select>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <CollectionsRail
            collections={collections}
            active={collection}
            total={(projects ?? []).filter((p) => !p.archived).length}
            onPick={setCollection}
            onCreate={addCollection}
            onRename={editCollection}
            onDelete={dropCollection}
          />
        </aside>

        <div>
          {projects === null ? (
            <>
              <LibrarySkeleton cards={6} />
              {connection === "error" && <p className="mt-4 text-center text-[13px] text-ink-faint">Still connecting — your recordings appear as soon as the dot in the sidebar turns green.</p>}
            </>
          ) : loadError ? (
            <div className="rr-card rr-enter flex flex-col items-center px-6 py-12 text-center">
              <p className="text-lg font-medium text-ink">We couldn&apos;t read your library</p>
              <p className="mt-1 max-w-md text-[13px] text-ink-faint">{loadError}</p>
              <button type="button" className="rr-btn rr-btn-primary mt-5" onClick={() => void refresh()} disabled={loading}>
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                Try again
              </button>
            </div>
          ) : projects.length === 0 ? (
            <div className="rr-card rr-enter flex flex-col items-center px-6 py-14 text-center">
              <p className="text-lg font-medium text-ink">Nothing here yet</p>
              <p className="mt-1 text-[13px] text-ink-faint">Bring in a recording and it will show up here.</p>
              <Link href="/" className="rr-btn rr-btn-primary mt-5">
                <Upload className="h-4 w-4 text-accent" />
                New episode
              </Link>
            </div>
          ) : visible.length === 0 ? (
            <div className="rr-card rr-enter flex flex-col items-center px-6 py-12 text-center">
              <p className="text-ink">{query.trim() ? `Nothing matches “${query.trim()}”` : showArchived ? "Nothing in the archive" : "Nothing matches these filters"}</p>
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setStatus("all");
                  setShowArchived(false);
                  setCollection(null);
                }}
                className="rr-btn rr-btn-sm mt-4"
              >
                <X className="h-3.5 w-3.5" />
                Clear filters
              </button>
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {visible.map((p, i) => (
                <ProjectCard
                  key={p.id}
                  summary={p}
                  index={i}
                  selecting={selecting}
                  selected={chosen.includes(p.id)}
                  templateName={p.brandTemplate ? templateName.get(p.brandTemplate) : undefined}
                  onSelect={pick}
                  onRename={setRenaming}
                  onArchive={setArchiving}
                  onTemplate={setBranding}
                  onCollection={setCollecting}
                />
              ))}
            </ul>
          )}

          <BatchHistory batches={batches} names={names} />
        </div>
      </div>

      {selecting && chosen.length > 0 && (
        <div className="rr-enter sticky bottom-4 z-40 mx-auto mt-6 flex max-w-xl items-center gap-3 rounded-full border border-line-strong bg-surface-raised px-4 py-2.5" style={{ boxShadow: "var(--rr-shadow-2)" }}>
          <span className="text-[13px] font-medium text-ink">
            {chosen.length} chosen · {selected.filter((s) => s.status === "ready").length} ready
          </span>
          <button type="button" className="rr-btn rr-btn-accent rr-btn-sm ml-auto" onClick={() => setBatchOpen(true)}>
            <Wand2 className="h-3.5 w-3.5" />
            Generate clips
          </button>
          <button type="button" className="rr-btn rr-btn-sm" onClick={() => setCollectingMany(true)}>
            Add to collection
          </button>
          <button type="button" className="rr-btn rr-btn-ghost rr-btn-sm" onClick={() => setChosen([])}>
            Clear
          </button>
        </div>
      )}

      {renaming && <TextDialog title="Rename recording" label="Name" initial={renaming.title} onSubmit={doRename} onClose={() => setRenaming(null)} />}
      {archiving && (
        <ConfirmDialog
          title={archiving.archived ? `Put “${archiving.title}” back?` : `Archive “${archiving.title}”?`}
          body={
            archiving.archived
              ? "It goes back into your library. Nothing else changes."
              : "It is hidden from your library but nothing is deleted — the recording, its clips and its full episode all stay. You can put it back any time."
          }
          confirmLabel={archiving.archived ? "Put it back" : "Archive it"}
          tone={archiving.archived ? "normal" : "danger"}
          onConfirm={doArchive}
          onClose={() => setArchiving(null)}
        />
      )}
      {branding && <TemplatePicker templates={templates} current={branding.brandTemplate} title={branding.title} onApply={doTemplate} onClose={() => setBranding(null)} />}
      {collectingMany && chosen.length > 0 && (
        <CollectionPicker
          collections={collections}
          projectId=""
          title={`${chosen.length} recordings`}
          onToggle={async (collectionId) => {
            for (const pid of chosen) await setCollectionMembership(collectionId, pid, true);
            setCollections(await listCollections());
          }}
          onCreate={addCollection}
          onClose={() => setCollectingMany(false)}
        />
      )}
      {collecting && (
        <CollectionPicker
          collections={collections}
          projectId={collecting.id}
          title={collecting.title}
          onToggle={doCollectionToggle}
          onCreate={addCollection}
          onClose={() => setCollecting(null)}
        />
      )}
      {batchOpen && (
        <BatchModal
          selected={selected}
          templates={templates}
          onClose={() => setBatchOpen(false)}
          onFinished={() => {
            void refresh();
          }}
        />
      )}
    </div>
  );
}
