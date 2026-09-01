/**
 * The producer's library: every recording they have uploaded, what state it is
 * in, and the collections they have sorted it into.
 *
 * Three things this module is careful about:
 *
 *  - **Fail-closed reading.** A listing or a file that could not be READ is
 *    never reported as "nothing there". The library says so and offers a
 *    retry, because a screen that shows an empty shelf on a dropped connection
 *    invites the producer to upload everything again — and a writer that
 *    starts from an empty record would write over their work.
 *  - **No central index.** The truth about a recording lives in its own
 *    `projects/<id>/project.json`; renaming, archiving and applying a brand
 *    look are read-modify-write on that one file through the queued writer, so
 *    two quick changes can never land out of order.
 *  - **Collections hold references only.** `library/collections/<id>.json`
 *    lists episode ids; deleting a collection never touches a recording.
 */

import {
  deleteFile,
  listDirStrict,
  readJsonStrict,
  saveJsonQueued,
  writeJson,
  type DirEntry,
  type StrictList,
  type StrictRead,
} from "./engine";
import { prettyTitle, projectRoot, runSummary, safeName, type ClipRender, type Project, type RunStatus } from "./podcast";
import { requestIdOf } from "./director";

// ---------------------------------------------------------------- store seam

export interface LibraryIo {
  list: (path: string) => Promise<StrictList>;
  read: <T>(path: string) => Promise<StrictRead<T>>;
  save: (key: string, path: string, value: unknown) => Promise<void>;
  write: (path: string, value: unknown) => Promise<void>;
  remove: (path: string) => Promise<void>;
}

const REAL_IO: LibraryIo = {
  list: listDirStrict,
  read: readJsonStrict,
  save: saveJsonQueued,
  write: writeJson,
  remove: deleteFile,
};

let io: LibraryIo = { ...REAL_IO };

/** Test seam: swap where the library reads and writes (null puts the store back). */
export function setLibraryIo(patch: Partial<LibraryIo> | null): void {
  io = patch ? { ...REAL_IO, ...patch } : { ...REAL_IO };
}

// ------------------------------------------------------------------- reading

export const projectFile = (episodeId: string) => `${projectRoot(episodeId)}/project.json`;
export const studioExportsRoot = (episodeId: string) => `${projectRoot(episodeId)}/exports/studio`;

/** The finished full episode a recording has, when one has been made. */
export interface EpisodeExport {
  version: number;
  /** exports/studio/v<n> */
  path: string;
}

/** Everything a library card shows, worked out from the recording's own files. */
export interface ProjectSummary {
  id: string;
  /** what the producer sees: their own name for it, else a tidy version of the file name */
  title: string;
  /** the name they typed, when they have renamed it */
  displayTitle: string | null;
  archived: boolean;
  /** the id of the brand look last applied to it */
  brandTemplate?: string;
  /** what the producer asked for when they uploaded it (searchable) */
  goal?: string;
  /** seconds, like project.json */
  created: number;
  updated: number;
  durationMs: number;
  width: number;
  height: number;
  hasVideo: boolean;
  /** "1920×1080", or null for a recording with no picture */
  resolution: string | null;
  status: RunStatus;
  statusLabel: string;
  /** moments the first read of the recording found */
  moments: number;
  /** clips it holds: made by hand, from a request, or already rendered */
  clips: number;
  /** clips the director delivered across every request */
  requestClips: number;
  previews: number;
  exports: number;
  /** the full episode, when one has been rendered */
  episodeExport: EpisodeExport | null;
  indexed: boolean;
  thumbnail: { path: string; version: number } | null;
  project: Project;
}

/** The newest rendered thumbnail among the recording's clips (previews first, exports as a fallback). */
function newestThumb(project: Project): { path: string; version: number } | null {
  let best: { path: string; version: number } | null = null;
  for (const clip of Object.values(project.clips ?? {})) {
    for (const render of [clip.preview, clip.export] as (ClipRender | undefined)[]) {
      const path = render?.files?.thumbnail;
      if (!path) continue;
      const version = render?.rendered_at ?? 0;
      if (!best || version > best.version) best = { path, version };
    }
  }
  return best;
}

/**
 * What a card says about one recording. Pure: the caller passes anything that
 * has to be looked up (the finished episode), so the summary itself can be
 * recomputed on screen without touching the store.
 */
export function projectSummary(project: Project, extras: { episodeExport?: EpisodeExport | null } = {}): ProjectSummary {
  const run = runSummary(project);
  const media = project.media;
  const clipIds = Object.keys(project.clips ?? {});
  const fromRequests = clipIds.filter((id) => requestIdOf(id)).length;
  const requestClips = Object.values(project.requests ?? {}).reduce((n, r) => n + (r.delivered ?? 0), 0);
  const displayTitle = typeof project.display_title === "string" && project.display_title.trim() ? project.display_title.trim() : null;
  const hasVideo = media?.has_video !== false && !!media?.width;
  return {
    id: project.episode_id,
    title: displayTitle || prettyTitle(project.title || project.episode_id),
    displayTitle,
    archived: project.archived === true,
    brandTemplate: typeof project.brand_template === "string" && project.brand_template ? project.brand_template : undefined,
    goal: project.settings?.goal || undefined,
    created: project.created ?? 0,
    updated: project.updated ?? project.created ?? 0,
    durationMs: media?.duration_ms ?? 0,
    width: media?.width ?? 0,
    height: media?.height ?? 0,
    hasVideo,
    resolution: hasVideo && media?.width && media?.height ? `${media.width}×${media.height}` : null,
    status: run.status,
    statusLabel: run.label,
    moments: run.moments,
    // the clips it holds: its own records plus request clips not yet opened
    clips: clipIds.length + Math.max(0, requestClips - fromRequests),
    requestClips,
    previews: run.previews,
    exports: run.exports,
    episodeExport: extras.episodeExport ?? null,
    indexed: project.index?.status === "indexed",
    thumbnail: newestThumb(project),
    project,
  };
}

/** The finished full episode, newest version — null when there is none yet. */
export async function loadEpisodeExport(episodeId: string): Promise<EpisodeExport | null> {
  const listing = await io.list(studioExportsRoot(episodeId));
  if (!listing.ok) return null;
  let best = 0;
  for (const entry of listing.entries) {
    const n = Number(/^v(\d+)$/.exec(entry.name ?? "")?.[1] ?? 0);
    if (Number.isFinite(n) && n > best) best = n;
  }
  return best ? { version: best, path: `${studioExportsRoot(episodeId)}/v${best}` } : null;
}

export interface LibraryListing {
  projects: ProjectSummary[];
  /** something could not be read — the screen must offer a retry, not an empty shelf */
  failed: boolean;
  error: string | null;
  /** the ids whose own file could not be read */
  unreadable: string[];
}

/**
 * Every recording in the library. A recording whose file could not be read is
 * listed as unreadable rather than dropped, and a listing that failed comes
 * back `failed` — never as an empty library.
 */
export async function listProjects(options: { exports?: boolean } = {}): Promise<LibraryListing> {
  const listing = await io.list("projects");
  if (!listing.ok) {
    if (listing.missing) return { projects: [], failed: false, error: null, unreadable: [] };
    return { projects: [], failed: true, error: listing.error || "Your library could not be read just now.", unreadable: [] };
  }
  const dirs = listing.entries.filter((e: DirEntry) => e.type === "dir" || e.type === "directory").map((e) => e.name);
  const loaded = await Promise.all(
    dirs.map(async (name) => {
      const read = await io.read<Project>(projectFile(name));
      if (!read.ok) return { name, project: null, failed: !read.missing, error: read.error };
      const project = { ...read.value, episode_id: read.value.episode_id || name } as Project;
      const episodeExport = options.exports === false ? null : await loadEpisodeExport(name);
      return { name, project, episodeExport, failed: false, error: "" };
    })
  );
  const projects: ProjectSummary[] = [];
  const unreadable: string[] = [];
  let error: string | null = null;
  for (const entry of loaded) {
    if (entry.project) {
      projects.push(projectSummary(entry.project, { episodeExport: entry.episodeExport ?? null }));
      continue;
    }
    if (entry.failed) {
      unreadable.push(entry.name);
      error = error ?? entry.error ?? null;
    }
  }
  projects.sort((a, b) => b.created - a.created || a.title.localeCompare(b.title));
  return { projects, failed: unreadable.length > 0, error, unreadable };
}

/** One recording's own file. null = there is no such recording; a read that FAILED throws. */
export async function loadProject(episodeId: string): Promise<Project | null> {
  const read = await io.read<Project>(projectFile(episodeId));
  if (read.ok) return { ...read.value, episode_id: read.value.episode_id || episodeId };
  if (read.missing) return null;
  throw new Error(read.error || "That recording could not be opened.");
}

// ------------------------------------------------------------------- writing

/**
 * Change one recording's own file: read what is there, change the field, write
 * it back through the queued writer. A read that failed stops the write — the
 * file may well hold work, and starting a fresh record would lose it.
 */
async function patchProject(episodeId: string, patch: (project: Project) => Project): Promise<Project> {
  const current = await loadProject(episodeId);
  if (!current) throw new Error("That recording is no longer in your library.");
  const next = { ...patch(current), updated: Date.now() / 1000 };
  await io.save(`project:${episodeId}`, projectFile(episodeId), next);
  return next;
}

/** Give a recording the producer's own name (an empty name puts the file name back). */
export async function renameProject(episodeId: string, title: string): Promise<Project> {
  const name = title.trim();
  return patchProject(episodeId, (project) => {
    const next = { ...project };
    if (name) next.display_title = name;
    else delete next.display_title;
    return next;
  });
}

/** Put a recording away (or bring it back). Nothing is deleted. */
export async function archiveProject(episodeId: string, archived: boolean): Promise<Project> {
  return patchProject(episodeId, (project) => {
    const next = { ...project };
    if (archived) next.archived = true;
    else delete next.archived;
    return next;
  });
}

/** Remember which brand look this recording's clips start from (null clears it). */
export async function applyBrandTemplate(episodeId: string, templateId: string | null): Promise<Project> {
  return patchProject(episodeId, (project) => {
    const next = { ...project };
    if (templateId) next.brand_template = templateId;
    else delete next.brand_template;
    return next;
  });
}

// --------------------------------------------------------------- collections

export const COLLECTIONS_ROOT = "library/collections";
export const collectionPath = (id: string) => `${COLLECTIONS_ROOT}/${id}.json`;
export const COLLECTION_SCHEMA_VERSION = 1;

/** A named shelf. It holds references only — never copies of a recording. */
export interface Collection {
  schema_version: number;
  id: string;
  name: string;
  created: number;
  updated: number;
  projects: string[];
}

export function collectionIdFor(name: string, now: number = Date.now()): string {
  const stem = safeName(name.toLowerCase().replace(/\s+/g, "-")).replace(/^_+|_+$/g, "").slice(0, 32) || "collection";
  return `${stem}-${now.toString(36).slice(-6)}`;
}

/** A collection file as it can be trusted; anything unrecognisable comes back null. */
export function normalizeCollection(raw: unknown, fallbackId = ""): Collection | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = (typeof r.id === "string" ? r.id : fallbackId).trim();
  if (!id) return null;
  const now = Date.now() / 1000;
  const created = typeof r.created === "number" && Number.isFinite(r.created) ? r.created : now;
  const projects = Array.isArray(r.projects) ? r.projects.filter((p): p is string => typeof p === "string" && !!p) : [];
  return {
    schema_version: typeof r.schema_version === "number" ? Math.max(1, Math.round(r.schema_version)) : COLLECTION_SCHEMA_VERSION,
    id,
    name: (typeof r.name === "string" ? r.name : "").trim() || "Untitled collection",
    created,
    updated: typeof r.updated === "number" && Number.isFinite(r.updated) ? r.updated : created,
    projects: [...new Set(projects)],
  };
}

export interface CollectionListing {
  collections: Collection[];
  failed: boolean;
  error: string | null;
}

/** Every collection, by name — fail-closed like the library itself. */
export async function loadCollections(): Promise<CollectionListing> {
  const listing = await io.list(COLLECTIONS_ROOT);
  if (!listing.ok) {
    if (listing.missing) return { collections: [], failed: false, error: null };
    return { collections: [], failed: true, error: listing.error || "Your collections could not be read." };
  }
  const names = listing.entries.map((e) => e.name ?? "").filter((name) => name.endsWith(".json"));
  const reads = await Promise.all(names.map(async (name) => ({ name, read: await io.read<unknown>(`${COLLECTIONS_ROOT}/${name}`) })));
  const collections: Collection[] = [];
  let error: string | null = null;
  for (const { name, read } of reads) {
    if (read.ok) {
      const c = normalizeCollection(read.value, name.replace(/\.json$/, ""));
      if (c) collections.push(c);
    } else if (!read.missing) {
      error = error ?? read.error;
    }
  }
  return { collections: collections.sort((a, b) => a.name.localeCompare(b.name)), failed: !!error, error };
}

/** Every collection, quietly — the shape the screens hand straight to a picker. */
export async function listCollections(): Promise<Collection[]> {
  return (await loadCollections()).collections;
}

/** One collection. null = there is no such file; a read that FAILED throws. */
export async function loadCollection(id: string): Promise<Collection | null> {
  const read = await io.read<unknown>(collectionPath(id));
  if (read.ok) return normalizeCollection(read.value, id);
  if (read.missing) return null;
  throw new Error(read.error || "That collection could not be opened.");
}

export async function saveCollection(collection: Collection): Promise<Collection> {
  const next: Collection = {
    ...collection,
    schema_version: COLLECTION_SCHEMA_VERSION,
    projects: [...new Set(collection.projects)],
    updated: Date.now() / 1000,
  };
  await io.save(`collection:${next.id}`, collectionPath(next.id), next);
  return next;
}

export async function createCollection(name: string, projects: string[] = [], now: number = Date.now()): Promise<Collection> {
  const collection: Collection = {
    schema_version: COLLECTION_SCHEMA_VERSION,
    id: collectionIdFor(name, now),
    name: name.trim() || "Untitled collection",
    created: now / 1000,
    updated: now / 1000,
    projects: [...new Set(projects)],
  };
  await io.save(`collection:${collection.id}`, collectionPath(collection.id), collection);
  return collection;
}

export async function renameCollection(id: string, name: string): Promise<Collection> {
  const current = await loadCollection(id);
  if (!current) throw new Error("That collection is no longer there.");
  return saveCollection({ ...current, name: name.trim() || current.name });
}

/** Delete the shelf, never what is on it. */
export async function deleteCollection(id: string): Promise<void> {
  await io.remove(collectionPath(id));
}

async function editMembership(id: string, episodeIds: string[], member: boolean): Promise<Collection> {
  const current = await loadCollection(id);
  if (!current) throw new Error("That collection is no longer there.");
  const set = new Set(current.projects);
  for (const episodeId of episodeIds) {
    if (member) set.add(episodeId);
    else set.delete(episodeId);
  }
  return saveCollection({ ...current, projects: [...set] });
}

export const addToCollection = (id: string, episodeIds: string[]): Promise<Collection> => editMembership(id, episodeIds, true);
export const removeFromCollection = (id: string, episodeIds: string[]): Promise<Collection> => editMembership(id, episodeIds, false);

/** Tick or untick one recording on one shelf. */
export const setCollectionMembership = (collectionId: string, episodeId: string, member: boolean): Promise<Collection> =>
  editMembership(collectionId, [episodeId], member);

/** The recordings on a shelf, in library order (references to recordings that are gone are simply not shown). */
export function collectionProjects(collection: Collection | null | undefined, projects: ProjectSummary[]): ProjectSummary[] {
  if (!collection) return projects;
  const ids = new Set(collection.projects);
  return projects.filter((p) => ids.has(p.id));
}
