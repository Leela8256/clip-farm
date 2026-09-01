/**
 * A group run: one sentence, several recordings. The parts that must hold are
 * the sentence being understood ONCE, no more than two recordings being worked
 * on at a time, every state change reaching the file, and reopening a run
 * believing the recordings' own request files rather than what the batch file
 * claims.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BATCH_CONCURRENCY,
  batchPath,
  batchProgress,
  listBatches,
  normalizeBatch,
  resetBatches,
  resumeBatch,
  searchAcrossProjects,
  setBatchIo,
  startBatch,
  subscribeBatch,
  type Batch,
} from "../batch";
import { normalizeSpec, type DirectorRequest } from "../director";
import type { Candidate } from "../podcast";
import type { DirectorResult, ParsedPrompt, SearchHit } from "../engine";

const parsed = (prompt: string): ParsedPrompt => ({ prompt, raw: {}, spec: normalizeSpec({ count: 3 }), searchQuery: prompt });

const candidate = (id: string): Candidate =>
  ({ id, rank: 1, title: id, hook: "", reason: "", quote: "", start_ms: 0, end_ms: 1000, duration_ms: 1000, score: 1, scores: { hook: 1, clarity: 1, standalone: 1 } }) as Candidate;

const result = (ids: string[]): DirectorResult => ({
  request_id: "r01",
  candidates: ids.map(candidate),
  rejected: [],
  compliance: null,
  notes: [],
  mode: "index",
});

interface Harness {
  files: Record<string, unknown>;
  writes: string[];
  parses: number;
}

function harness(over: Record<string, unknown> = {}, files: Record<string, unknown> = {}): Harness {
  const h: Harness = { files, writes: [], parses: 0 };
  setBatchIo({
    list: async (path) => ({
      ok: true,
      entries: Object.keys(h.files)
        .filter((f) => f.startsWith(`${path}/`))
        .map((f) => ({ name: f.slice(path.length + 1), type: "file" })),
    }),
    read: async <T,>(path: string) =>
      path in h.files ? { ok: true as const, value: h.files[path] as T } : { ok: false as const, missing: true, error: "" },
    save: async (_key, path, value) => {
      h.writes.push(path);
      h.files[path] = JSON.parse(JSON.stringify(value));
    },
    parse: async (prompt: string) => {
      h.parses++;
      return parsed(prompt);
    },
    createRequest: async (episodeId: string) => ({ request_id: `r01`, prompt: "", spec: normalizeSpec({}), search_query: "", status: "parsed", schema_version: 1, created: 0, episode: episodeId }) as unknown as DirectorRequest,
    runDirector: async () => result(["r01c01", "r01c02"]),
    loadTemplate: async () => null,
    search: async () => [],
    ...over,
  });
  return h;
}

afterEach(() => {
  setBatchIo(null);
  resetBatches();
});

describe("startBatch", () => {
  it("understands the sentence once and gives every recording its own clips", async () => {
    const h = harness();
    const seen: Batch[] = [];
    const batch = await startBatch({ prompt: "moments where they disagree", projects: ["ep1", "ep2", "ep3"] }, (b) => seen.push(b));

    expect(h.parses).toBe(1);
    expect(batch.projects.map((p) => p.status)).toEqual(["done", "done", "done"]);
    expect(batch.projects.every((p) => p.delivered === 2 && p.request_id === "r01")).toBe(true);
    expect(batch.concurrency).toBe(BATCH_CONCURRENCY);
    expect(batchProgress(batch)).toMatchObject({ total: 3, done: 3, failed: 0, delivered: 6, finished: true, fraction: 1 });
    // the run is written down as it happens, and the file holds the finished state
    expect(h.writes.filter((p) => p === batchPath(batch.id)).length).toBeGreaterThan(3);
    expect((h.files[batchPath(batch.id)] as Batch).projects.every((p) => p.status === "done")).toBe(true);
    expect(seen.length).toBeGreaterThan(3);
  });

  it("never works on more than two recordings at a time", async () => {
    let running = 0;
    let peak = 0;
    const h = harness({
      runDirector: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return result(["c1"]);
      },
    });
    const batch = await startBatch({ prompt: "five at once", projects: ["a", "b", "c", "d", "e"] });
    expect(peak).toBe(2);
    expect(batch.projects.filter((p) => p.status === "done")).toHaveLength(5);
    expect(h.parses).toBe(1);
  });

  it("keeps going when one recording fails, and says why", async () => {
    harness({
      runDirector: async (episodeId: string) => {
        if (episodeId === "bad") throw new Error("that recording has no transcript yet");
        return result(["c1"]);
      },
    });
    const batch = await startBatch({ prompt: "x", projects: ["good", "bad", "other"] });
    const failed = batch.projects.find((p) => p.id === "bad");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("no transcript");
    expect(batch.projects.filter((p) => p.status === "done")).toHaveLength(2);
    expect(batchProgress(batch).finished).toBe(true);
  });

  it("marks every recording when the sentence itself was not understood", async () => {
    const h = harness({
      parse: async () => {
        throw new Error("the assistant could not be reached");
      },
    });
    await expect(startBatch({ prompt: "x", projects: ["a", "b"] })).rejects.toThrow("could not be reached");
    const saved = Object.values(h.files).find((f) => (f as Batch).schema_version === 1) as Batch;
    expect(saved.error).toContain("could not be reached");
    expect(saved.projects.every((p) => p.status === "failed")).toBe(true);
  });

  it("takes the producer's own count and length over whatever it read into the sentence", async () => {
    const h = harness();
    const batch = await startBatch({
      prompt: "clips",
      projects: ["a"],
      options: { count: 6, duration_s: 30, caption_style: "bold-impact", layout_mode: "solo_follow" },
    });
    expect(batch.spec?.count).toBe(6);
    expect(batch.spec?.duration.target_seconds).toBe(30);
    // the look chosen for the run reaches the recording's clip edits
    const edits = h.files["projects/a/edits/clip-edits.json"] as { clips: Record<string, { caption_style?: { weight?: string }; layout_mode?: string }> };
    expect(edits.clips["r01c01"].caption_style?.weight).toBe("black");
    expect(edits.clips["r01c01"].layout_mode).toBe("solo_follow");
  });

  it("tells anyone watching how far it has got", async () => {
    harness();
    const seen: string[] = [];
    let stop = () => {};
    const promise = startBatch({ prompt: "x", projects: ["a"] }, (b) => {
      stop();
      stop = subscribeBatch(b.id, (live) => seen.push(live.projects[0].status));
    });
    await promise;
    stop();
    expect(seen).toContain("done");
  });
});

describe("resumeBatch", () => {
  const unfinished = (): Batch => ({
    schema_version: 1,
    id: "b1",
    prompt: "moments",
    spec: normalizeSpec({ count: 2 }),
    options: {},
    created: 1,
    updated: 1,
    concurrency: 2,
    projects: [
      { id: "finished", status: "running", request_id: "r01" },
      { id: "broke", status: "running", request_id: "r02" },
      { id: "never-started", status: "queued" },
    ],
  });

  it("believes the recordings' own request files over what the run claims", async () => {
    const request = (extra: Partial<DirectorRequest>) => ({ schema_version: 1, request_id: "r01", prompt: "", spec: normalizeSpec({}), search_query: "", created: 0, ...extra });
    const h = harness(
      { runDirector: async () => result(["c9"]) },
      {
        [batchPath("b1")]: unfinished(),
        "projects/finished/analysis/requests/r01.json": request({ status: "done", answered_at: 10, candidates: [candidate("r01c01"), candidate("r01c02")] }),
        "projects/broke/analysis/requests/r02.json": request({ request_id: "r02", status: "error", error: "the recording was still being read" }),
      }
    );
    const batch = await resumeBatch("b1");
    const byId = Object.fromEntries(batch.projects.map((p) => [p.id, p]));
    expect(byId.finished.status).toBe("done");
    expect(byId.finished.delivered).toBe(2);
    expect(byId.broke.status).toBe("failed");
    expect(byId.broke.error).toContain("still being read");
    // only the one that genuinely never happened was run again
    expect(byId["never-started"].status).toBe("done");
    expect(byId["never-started"].delivered).toBe(1);
    expect(h.parses).toBe(0);
    expect((h.files[batchPath("b1")] as Batch).projects.find((p) => p.id === "finished")?.status).toBe("done");
  });

  it("puts a recording that was running with nothing to show for it back in the queue", async () => {
    const h = harness({ runDirector: vi.fn(async () => result([])) }, { [batchPath("b1")]: unfinished() });
    const batch = await resumeBatch("b1", { run: false });
    expect(batch.projects.map((p) => p.status)).toEqual(["queued", "queued", "queued"]);
    expect(h.writes).toContain(batchPath("b1"));
  });

  it("says so when the run is not on file", async () => {
    harness();
    await expect(resumeBatch("nope")).rejects.toThrow("no longer on file");
  });
});

describe("listBatches and normalizeBatch", () => {
  it("lists the runs newest first", async () => {
    harness({}, {
      [batchPath("b1")]: { schema_version: 1, id: "b1", prompt: "one", created: 1, projects: [{ id: "a", status: "done" }] },
      [batchPath("b2")]: { schema_version: 1, id: "b2", prompt: "two", created: 2, projects: [{ id: "a", status: "queued" }] },
    });
    const list = await listBatches();
    expect(list.map((b) => b.id)).toEqual(["b2", "b1"]);
  });

  it("reads a hand-edited or older file tolerantly", () => {
    const b = normalizeBatch({ prompt: "x", projects: [{ id: "a", status: "weird" }, { status: "done" }, "junk"], options: { count: "4", template: "t1" } }, "b9");
    expect(b?.id).toBe("b9");
    expect(b?.projects).toEqual([{ id: "a", status: "queued" }]);
    expect(b?.options).toEqual({ count: 4, template: "t1" });
    expect(b?.concurrency).toBe(2);
    expect(normalizeBatch(null)).toBeNull();
  });
});

describe("searchAcrossProjects", () => {
  it("asks the index for several recordings at once and keeps the best answers first", async () => {
    const asked: { ids: string[]; query: string } = { ids: [], query: "" };
    const hits: SearchHit[] = [
      { score: 0.4, text: "b", start_ms: 0, end_ms: 1, passage: 0, episode_id: "ep2" },
      { score: 0.9, text: "a", start_ms: 0, end_ms: 1, passage: 1, episode_id: "ep1" },
    ];
    harness({
      search: async (ids: string[], query: string) => {
        asked.ids = ids;
        asked.query = query;
        return hits;
      },
    });
    const found = await searchAcrossProjects(["ep1", "ep2", "ep1"], "  disagreement  ", { titles: new Map([["ep1", "Episode one"]]) });
    expect(asked.ids).toEqual(["ep1", "ep2"]);
    expect(asked.query).toBe("disagreement");
    expect(found.map((h) => h.episode_id)).toEqual(["ep1", "ep2"]);
    expect(found[0].title).toBe("Episode one");
    expect(await searchAcrossProjects([], "x")).toEqual([]);
    expect(await searchAcrossProjects(["ep1"], "   ")).toEqual([]);
  });
});
