import { describe, expect, it } from "vitest";
import {
  analysisStep,
  customCandidate,
  describeStatus,
  effectiveRange,
  episodeIdFor,
  fmtClock,
  fmtTime,
  overallScore,
  pickManifest,
  toCandidate,
  toCandidates,
  toReport,
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

  it("maps engine events to analysis steps and readable text", () => {
    expect(analysisStep({ node: "podcast_ingest", stage: "probing" })).toBe(0);
    expect(analysisStep({ node: "podcast_ingest", stage: "transcribing" })).toBe(1);
    expect(analysisStep({ node: "podcast_segment", stage: "scoring" })).toBe(2);
    expect(analysisStep({ node: "podcast_refine", stage: "analyzed" })).toBe(3);
    expect(analysisStep({ node: "podcast_refine", stage: "error" })).toBe(-1);
    expect(describeStatus({ node: "podcast_segment", stage: "scoring", part: 2, parts: 6 })).toBe("Claude is scoring part 2 of 6");
    expect(describeStatus({ node: "podcast_refine", stage: "analyzed", candidates: 7, seconds: 102.3 })).toBe("7 candidates ready in 102s");
    expect(describeStatus({ node: "x", stage: "error", message: "nope" })).toBe("Failed: nope");
    expect(describeStatus(null)).toBe("Waiting for the engine");
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
