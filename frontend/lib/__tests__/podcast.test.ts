import { describe, expect, it } from "vitest";
import {
  analysisStep,
  customCandidate,
  describeStatus,
  effectiveRange,
  episodeIdFor,
  fmtClock,
  fmtTime,
  friendlyStatus,
  overallScore,
  pickManifest,
  prettyTitle,
  previewFile,
  runSummary,
  toCandidate,
  toCandidates,
  toReport,
  type Project,
} from "../podcast";

describe("pickManifest", () => {
  it("returns the last answer that names the project (the answers lane carries the LLM's raw answers too)", () => {
    const result = {
      answers: [
        { candidates: [{ start: "00:10" }], chunk: 1 },
        { project: "projects/ep1", episode_id: "ep1", candidates: [], chapters: [] },
      ],
    };
    expect(pickManifest(result)?.project).toBe("projects/ep1");
  });

  it("parses JSON strings and falls back to the last payload", () => {
    expect(pickManifest({ answers: [{ answer: JSON.stringify({ project: "projects/x" }) }] })?.project).toBe("projects/x");
    expect(pickManifest({ answers: [{ error: "boom" }] })?.error).toBe("boom");
    expect(pickManifest({})).toBeNull();
  });
});

describe("candidates", () => {
  it("normalises numbers and fills the weighted score", () => {
    const c = toCandidate({ id: "c03", start_ms: "1000", end_ms: 31000, title: "T", scores: { hook: 9, clarity: 7, standalone: 8 } }, 2);
    expect(c.id).toBe("c03");
    expect(c.duration_ms).toBe(30000);
    expect(c.score).toBe(8.1);
    expect(overallScore({ hook: 10, clarity: 10, standalone: 10 })).toBe(10);
  });

  it("defaults missing ids and lists", () => {
    expect(toCandidates({ candidates: [{ start_ms: 0, end_ms: 5000 }] })[0].id).toBe("c01");
    expect(toCandidates(null)).toEqual([]);
  });

  it("applies saved edits over the candidate's own range", () => {
    const c = toCandidate({ start_ms: 1000, end_ms: 2000 });
    expect(effectiveRange(c, { start_ms: 500 })).toEqual({ start_ms: 500, end_ms: 2000 });
    expect(effectiveRange(c, null)).toEqual({ start_ms: 1000, end_ms: 2000 });
  });

  it("builds hand-made clips with stable ids", () => {
    const c = customCandidate(53_000, 96_400);
    expect(c.id).toBe("x53-96");
    expect(c.custom).toBe(true);
    expect(c.title).toContain("0:53");
  });
});

describe("reports and status", () => {
  it("normalises render reports", () => {
    const r = toReport({ clip_id: "c01", mode: "export", files: { vertical: "a.mp4", junk: 1 }, loudness: { integrated_lufs: -16 }, has_audio: true, width: 1080, height: 1920 });
    expect(r.files).toEqual({ vertical: "a.mp4" });
    expect(r.loudness?.integrated_lufs).toBe(-16);
    expect(r.mode).toBe("export");
  });

  it("picks the rendered layout a preview player should show", () => {
    expect(previewFile(toReport({ files: { wide: "w.mp4", thumbnail: "t.jpg" } }))).toEqual({ path: "w.mp4", layout: "wide" });
    expect(previewFile(toReport({ files: { vertical: "v.mp4", wide: "w.mp4" } }))?.layout).toBe("vertical");
    expect(previewFile(toReport({ files: { audio: "a.mp3" } }))?.layout).toBe("audio");
    expect(previewFile(toReport({ files: { thumbnail: "t.jpg" } }))).toBeNull();
    expect(previewFile(null)).toBeNull();
  });

  it("maps engine events to analysis steps and readable text", () => {
    expect(analysisStep({ node: "podcast_ingest", stage: "probing" })).toBe(0);
    expect(analysisStep({ node: "podcast_ingest", stage: "transcribing" })).toBe(1);
    expect(analysisStep({ node: "podcast_segment", stage: "scoring" })).toBe(2);
    expect(analysisStep({ node: "podcast_refine", stage: "analyzed" })).toBe(3);
    expect(analysisStep({ node: "podcast_refine", stage: "error" })).toBe(-1);
    expect(describeStatus({ node: "podcast_segment", stage: "scoring", part: 2, parts: 6 })).toBe("Scoring part 2 of 6");
    expect(describeStatus({ node: "podcast_refine", stage: "analyzed", candidates: 7, seconds: 102.3 })).toBe("7 candidates ready in 102s");
    expect(describeStatus({ node: "x", stage: "error", message: "nope" })).toBe("Failed: nope");
    expect(describeStatus(null)).toBe("Getting ready");
  });
});

describe("formatting", () => {
  it("formats times", () => {
    expect(fmtTime(65_000)).toBe("1:05");
    expect(fmtTime(3_723_000)).toBe("1:02:03");
    expect(fmtClock(315_106)).toBe("5:15.1");
  });

  it("derives readable episode ids", () => {
    expect(episodeIdFor("My Podcast EP 12 (final).mp4", 1000)).toBe("my-podcast-ep-12-final-rs");
    expect(episodeIdFor(".mp4", 1000)).toBe("episode-rs");
  });
});

describe("visual director", () => {
  it("normalises the layout summary of a render report", () => {
    const r = toReport({
      clip_id: "c01",
      files: { vertical: "v.mp4" },
      layout: {
        mode: "auto",
        applied: true,
        segments: [{ start_ms: 0, end_ms: 4000, layout: "solo_follow", subjects: ["p1"], reason: "one person on screen" }, { start_ms: 4000, end_ms: 9000, layout: "stacked_two", subjects: ["p1", "p2"] }],
        people: [{ id: "p1", coverage: 0.9, mean_center: [0.5, 0.3], mean_face_h: 0.3 }],
        thumbnails: { p1: "projects/x/analysis/clips/c01/p1.jpg", junk: 1 },
        metrics: { people: 2, speaker_visible_pct: 100, smooth: true },
      },
    });
    expect(r.layout?.applied).toBe(true);
    expect(r.layout?.segments.map((s) => s.layout)).toEqual(["solo_follow", "stacked_two"]);
    expect(r.layout?.people[0].mean_center).toEqual([0.5, 0.3]);
    expect(r.layout?.thumbnails).toEqual({ p1: "projects/x/analysis/clips/c01/p1.jpg" });
    expect(r.layout?.metrics.people).toBe(2);
    expect(toReport({ files: {} }).layout).toBeNull();
  });
});

describe("titles and run summaries", () => {
  const base: Project = { episode_id: "ep", source: "projects/ep/source/ep.mp4", settings: { goal: "", clip_count: 8, min_seconds: 20, max_seconds: 90 } };

  it("makes readable titles from file names and ids", () => {
    expect(prettyTitle("my_podcast-ep_12.mp4")).toBe("My Podcast Ep 12");
    expect(prettyTitle("EP12_AI-roundtable (final).m4a")).toBe("EP12 AI Roundtable (Final)");
    expect(prettyTitle("my-podcast-ep-12-final-rs")).toBe("My Podcast Ep 12 Final Rs");
    expect(prettyTitle("  Already Pretty  ")).toBe("Already Pretty");
    expect(prettyTitle("Season 3.5")).toBe("Season 3.5");
    expect(prettyTitle("")).toBe("Untitled episode");
    expect(prettyTitle(undefined)).toBe("Untitled episode");
  });

  it("summarises a project's run from project.json", () => {
    const now = 100_000;
    expect(runSummary(base, now)).toMatchObject({ status: "new", label: "new", moments: 0 });
    expect(runSummary({ ...base, analysis: { status: "analyzing", started_at: now - 60 } }, now)).toMatchObject({ status: "analysing", label: "analysing" });
    expect(runSummary({ ...base, analysis: { status: "analyzing", started_at: now - 4 * 3600 } }, now).status).toBe("failed");
    expect(runSummary({ ...base, analysis: { status: "analyzed", candidates: 1 } }, now).label).toBe("ready · 1 moment");
    const rich = runSummary(
      {
        ...base,
        analysis: { status: "analyzed", candidates: 8 },
        requests: { r01: { delivered: 3 }, r02: { delivered: 0 } },
        clips: {
          c01: { preview: { files: { vertical: "p.mp4", thumbnail: "t.jpg" } } },
          c02: { preview: { files: {} }, export: { files: { vertical: "e.mp4" } } },
        },
      },
      now
    );
    expect(rich).toEqual({ status: "ready", label: "ready · 8 moments · 3 directed · 1 export", moments: 8, directed: 3, exports: 1, previews: 1 });
    expect(runSummary(null, now).status).toBe("new");
  });

  it("describes progress without naming the machinery", () => {
    expect(friendlyStatus(null)).toBe("Getting ready");
    expect(friendlyStatus({ node: "podcast_segment", stage: "scoring", part: 2, parts: 6 })).toBe("Scoring part 2 of 6");
    expect(friendlyStatus({ node: "podcast_segment", stage: "scoring" })).toBe("Scoring the moments");
    expect(friendlyStatus({ node: "podcast_ingest", stage: "splitting" })).toBe("Cutting the audio into pieces");
    expect(friendlyStatus({ node: "podcast_segment", stage: "indexing", passages: 40 })).toBe("Preparing transcript search · 40 passages");
    expect(friendlyStatus({ node: "podcast_segment", stage: "indexed", passages: 40 })).toBe("Transcript search ready · 40 passages");
    expect(friendlyStatus({ node: "podcast_ingest", stage: "transcribing", piece: 3, pieces: 12 })).toBe("Transcribing · piece 3 of 12");
    expect(friendlyStatus({ node: "x", stage: "warming_up" })).toBe("Warming up");
    expect(friendlyStatus({ node: "x", stage: "error", message: "boom" })).toBe("Failed: boom");
  });
});
