/**
 * The library screen is where a producer sees everything they have. Two
 * behaviours are load-bearing: a read that FAILED is never shown as an empty
 * shelf (they would upload everything again), and every change is a
 * read-modify-write on the recording's own file (there is no central index to
 * fall out of step).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  addToCollection,
  applyBrandTemplate,
  archiveProject,
  collectionPath,
  collectionProjects,
  createCollection,
  deleteCollection,
  listCollections,
  listProjects,
  loadCollections,
  normalizeCollection,
  projectSummary,
  removeFromCollection,
  renameCollection,
  renameProject,
  setCollectionMembership,
  setLibraryIo,
  type Collection,
} from "../library";
import type { Project } from "../podcast";

const project = (id: string, extra: Partial<Project> = {}): Project =>
  ({
    episode_id: id,
    title: `${id}_raw_take.mp4`,
    source: `projects/${id}/source.mp4`,
    created: 1_700_000_000,
    settings: { goal: "punchy moments", clip_count: 3, min_seconds: 20, max_seconds: 60 },
    media: { duration_ms: 3_600_000, width: 1920, height: 1080, fps: 30, has_video: true },
    analysis: { status: "analyzed", candidates: 8 },
    ...extra,
  }) as Project;

interface Store {
  files: Record<string, unknown>;
  saves: string[];
}

function fakeStore(files: Record<string, unknown> = {}, over: Record<string, unknown> = {}): Store {
  const store: Store = { files, saves: [] };
  const children = (path: string) => [
    ...new Set(
      Object.keys(store.files)
        .filter((f) => f.startsWith(`${path}/`))
        .map((f) => f.slice(path.length + 1).split("/"))
        .map((parts) => ({ name: parts[0], type: parts.length > 1 ? "dir" : "file" }))
        .map((e) => JSON.stringify(e))
    ),
  ].map((s) => JSON.parse(s) as { name: string; type: string });
  setLibraryIo({
    list: async (path) => ({ ok: true, entries: children(path) }),
    read: async <T,>(path: string) =>
      path in store.files ? { ok: true as const, value: store.files[path] as T } : { ok: false as const, missing: true, error: "" },
    save: async (_key, path, value) => {
      store.saves.push(path);
      store.files[path] = value;
    },
    write: async (path, value) => {
      store.files[path] = value;
    },
    remove: async (path) => {
      delete store.files[path];
    },
    ...over,
  });
  return store;
}

afterEach(() => setLibraryIo(null));

describe("projectSummary", () => {
  it("says what a card shows: name, length, size, state and what is in it", () => {
    const s = projectSummary(
      project("ep1", {
        display_title: "Episode 12 — the long one",
        brand_template: "weekly-abc123",
        requests: { r01: { delivered: 3 }, r02: { delivered: 2 } },
        clips: {
          r01c01: { preview: { files: { thumbnail: "projects/ep1/previews/a.jpg" }, rendered_at: 20 } },
          "x10-40": { export: { files: { vertical: "projects/ep1/exports/x.mp4", thumbnail: "projects/ep1/exports/x.jpg" }, rendered_at: 30 } },
        },
      }),
      { episodeExport: { version: 2, path: "projects/ep1/exports/studio/v2" } }
    );
    expect(s.title).toBe("Episode 12 — the long one");
    expect(s.resolution).toBe("1920×1080");
    expect(s.durationMs).toBe(3_600_000);
    expect(s.status).toBe("ready");
    expect(s.statusLabel).toContain("8 moments");
    // two clip records (one of them from a request) plus the 4 request clips not opened yet
    expect(s.requestClips).toBe(5);
    expect(s.clips).toBe(6);
    expect(s.exports).toBe(1);
    expect(s.thumbnail).toEqual({ path: "projects/ep1/exports/x.jpg", version: 30 });
    expect(s.episodeExport?.version).toBe(2);
    expect(s.brandTemplate).toBe("weekly-abc123");
    expect(s.goal).toBe("punchy moments");
  });

  it("falls back to a tidy file name and reports a recording with no picture honestly", () => {
    const s = projectSummary(project("ep2", { title: "my_first_show.mp4", media: undefined }));
    expect(s.title).toBe("My First Show");
    expect(s.displayTitle).toBeNull();
    expect(s.hasVideo).toBe(false);
    expect(s.resolution).toBeNull();
    expect(s.archived).toBe(false);
  });
});

describe("listProjects", () => {
  it("lists what is there, newest first, with the finished episode it found", async () => {
    fakeStore({
      "projects/ep1/project.json": project("ep1", { created: 100 }),
      "projects/ep2/project.json": project("ep2", { created: 200 }),
      "projects/ep2/exports/studio/v3/report.json": { ok: true },
    });
    const listing = await listProjects();
    expect(listing.projects.map((p) => p.id)).toEqual(["ep2", "ep1"]);
    expect(listing.projects[0].episodeExport).toEqual({ version: 3, path: "projects/ep2/exports/studio/v3" });
    expect(listing.projects[1].episodeExport).toBeNull();
    expect(listing.failed).toBe(false);
  });

  it("never turns a read that went wrong into an empty library", async () => {
    fakeStore({}, { list: async () => ({ ok: false, missing: false, error: "not connected" }) });
    const listing = await listProjects();
    expect(listing.failed).toBe(true);
    expect(listing.error).toContain("not connected");
    expect(listing.projects).toEqual([]);
  });

  it("keeps the recordings it could read and names the ones it could not", async () => {
    const files: Record<string, unknown> = {
      "projects/good/project.json": project("good"),
      "projects/bad/project.json": project("bad"),
    };
    fakeStore(files, {
      read: async <T,>(path: string) =>
        path === "projects/bad/project.json"
          ? { ok: false as const, missing: false, error: "the connection went away" }
          : path in files
            ? { ok: true as const, value: files[path] as T }
            : { ok: false as const, missing: true, error: "" },
    });
    const listing = await listProjects();
    expect(listing.projects.map((p) => p.id)).toEqual(["good"]);
    expect(listing.unreadable).toEqual(["bad"]);
    expect(listing.failed).toBe(true);
  });
});

describe("changing a recording", () => {
  it("renames, archives and brands it in its own file, never in an index", async () => {
    const store = fakeStore({ "projects/ep1/project.json": project("ep1") });

    await renameProject("ep1", "  Episode 12  ");
    expect((store.files["projects/ep1/project.json"] as Project).display_title).toBe("Episode 12");

    await archiveProject("ep1", true);
    expect((store.files["projects/ep1/project.json"] as Project).archived).toBe(true);
    await archiveProject("ep1", false);
    expect((store.files["projects/ep1/project.json"] as Project).archived).toBeUndefined();

    await applyBrandTemplate("ep1", "weekly-1");
    expect((store.files["projects/ep1/project.json"] as Project).brand_template).toBe("weekly-1");
    await applyBrandTemplate("ep1", null);
    expect((store.files["projects/ep1/project.json"] as Project).brand_template).toBeUndefined();

    // every change went through the queued writer, on the recording's own file
    expect(new Set(store.saves)).toEqual(new Set(["projects/ep1/project.json"]));

    // an empty name puts the file name back
    await renameProject("ep1", "");
    expect((store.files["projects/ep1/project.json"] as Project).display_title).toBeUndefined();
  });

  it("refuses to write when the recording's file could not be read", async () => {
    const store = fakeStore({}, { read: async () => ({ ok: false, missing: false, error: "the connection went away" }) });
    await expect(renameProject("ep1", "New name")).rejects.toThrow("connection");
    expect(store.saves).toEqual([]);
  });
});

describe("collections", () => {
  it("goes there and back: make, add, rename, remove, delete", async () => {
    const store = fakeStore();
    const made = await createCollection("Best of season 2", ["ep1"], 1_700_000_000_000);
    expect(store.files[collectionPath(made.id)]).toBeTruthy();
    expect(made.projects).toEqual(["ep1"]);

    const withTwo = await addToCollection(made.id, ["ep2", "ep2"]);
    expect(withTwo.projects).toEqual(["ep1", "ep2"]);

    const renamed = await renameCollection(made.id, "Season 2");
    expect(renamed.name).toBe("Season 2");
    expect(renamed.projects).toEqual(["ep1", "ep2"]);

    const ticked = await setCollectionMembership(made.id, "ep3", true);
    expect(ticked.projects).toContain("ep3");
    const unticked = await setCollectionMembership(made.id, "ep3", false);
    expect(unticked.projects).not.toContain("ep3");

    const smaller = await removeFromCollection(made.id, ["ep1"]);
    expect(smaller.projects).toEqual(["ep2"]);

    const listed = await listCollections();
    expect(listed.map((c) => c.id)).toEqual([made.id]);
    expect(listed[0].projects).toEqual(["ep2"]);

    await deleteCollection(made.id);
    expect(store.files[collectionPath(made.id)]).toBeUndefined();
    expect(await listCollections()).toEqual([]);
  });

  it("says so when the collections could not be read", async () => {
    fakeStore({}, { list: async () => ({ ok: false, missing: false, error: "not connected" }) });
    const listing = await loadCollections();
    expect(listing.failed).toBe(true);
    expect(listing.collections).toEqual([]);
  });

  it("treats a folder that is not there yet as simply empty", async () => {
    fakeStore({}, { list: async () => ({ ok: false, missing: true, error: "" }) });
    const listing = await loadCollections();
    expect(listing.failed).toBe(false);
    expect(listing.collections).toEqual([]);
  });

  it("reads an old or hand-edited file tolerantly", () => {
    const c = normalizeCollection({ name: "  Shorts  ", projects: ["a", "a", 7, "b"], created: 5 }, "shorts-1");
    expect(c).toEqual({ schema_version: 1, id: "shorts-1", name: "Shorts", created: 5, updated: 5, projects: ["a", "b"] });
    expect(normalizeCollection({ name: "no id" })).toBeNull();
    expect(normalizeCollection("nonsense")).toBeNull();
  });

  it("filters the library by a shelf, ignoring recordings that are gone", () => {
    const projects = [projectSummary(project("ep1")), projectSummary(project("ep2"))];
    const shelf: Collection = { schema_version: 1, id: "c1", name: "x", created: 0, updated: 0, projects: ["ep2", "vanished"] };
    expect(collectionProjects(shelf, projects).map((p) => p.id)).toEqual(["ep2"]);
    expect(collectionProjects(null, projects)).toHaveLength(2);
  });
});
