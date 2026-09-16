/**
 * Clip selection, case for case with the python twin
 * (local_nodes/tests/test_director.py · test_podcast_common.py). The browser
 * now writes candidates.json, chapters.json and the request files, so the
 * numbers here are not "a reasonable ranking" — they are THE ranking: same
 * weights, same duration penalty, same rejection wording, same file shapes.
 * Every expected value below was produced by running the python modules on
 * the same input.
 */

import { afterEach, describe, expect, it } from "vitest";
import { describeSpec, durationWindow, normalizeSpec } from "../director";
import {
  assignIds,
  checkConstraints,
  directorScore,
  findProfanity,
  mergeChapters,
  parseCandidateAnswer,
  parseChapters,
  parseDirectorAnswer,
  pyRound,
  refineAnalysis,
  requestCompliance,
  selectCandidates,
  snapToSentences,
  validateCandidates,
  type RefineSentence,
} from "../refine";
import {
  flushQueuedSaves,
  resetQueuedSaves,
  runAnalysis,
  runDirector,
  setQueuedWriter,
  setRefineIo,
  type StrictRead,
} from "../engine";
import type { DirectorRequest } from "../director";

const sentences = (count: number, lengthMs = 5000, text = "Sentence number {i} about the startup."): RefineSentence[] =>
  Array.from({ length: count }, (_, i) => ({ id: i, text: text.replace("{i}", String(i)), start_ms: i * lengthMs, end_ms: (i + 1) * lengthMs }));

const plain = (count: number) => sentences(count, 5000, "Sentence number {i} about something.");

// ------------------------------------------------------------ the answers

const DIRECTED_ANSWER = {
  candidates: [
    {
      start: "00:10", end: "00:50", title: "Why we failed", hook: "We were wrong about everything.",
      speaker: "Sarah", speaker_evidence: "introduced as Sarah", topic_found: true, complete_ending: true,
      scores: { prompt_match: 9, hook: 8, standalone: 8, clarity: 7, energy: 6 },
    },
    { start: "00:15", end: "00:55", title: "Overlaps the first", speaker: "Sarah", topic_found: true, scores: { prompt_match: 8, hook: 7, standalone: 7, clarity: 7, energy: 7 } },
    { start: "02:00", end: "02:40", title: "Wrong speaker", speaker: "Tom", topic_found: true, complete_ending: true, scores: { prompt_match: 9, hook: 9, standalone: 9, clarity: 9, energy: 9 } },
    { start: "03:00", end: "03:40", title: "Off topic", speaker: "Sarah", topic_found: false, scores: { prompt_match: 2, hook: 9, standalone: 9, clarity: 9, energy: 9 } },
    { start: "04:00", end: "04:10", title: "Too short", speaker: "Sarah", topic_found: true, scores: { prompt_match: 9, hook: 9, standalone: 9, clarity: 9, energy: 9 } },
    { start: "05:00", end: "05:40", title: "Unverified speaker", topic_found: true, complete_ending: true, scores: { prompt_match: 7, hook: 7, standalone: 7, clarity: 7, energy: 7 } },
  ],
};

const ANALYSIS_ANSWER = {
  chunk: 1,
  candidates: [
    { start: "00:10", end: "01:05", title: "A", hook: "h", reason: "r", quote: "q", scores: { hook: 9, clarity: 7, standalone: 8 } },
    { start: "00:20", end: "01:00", title: "B overlaps A", scores: { hook: 5, clarity: 5, standalone: 5 } },
    { start: "05:00", end: "05:10", title: "too short" },
    { start: "07:00", end: "09:30", title: "too long", scores: { hook: 8, clarity: 8, standalone: 8 } },
    { start: "garbage", end: "01:00" },
  ],
  chapters: [
    { start: "00:00", title: "Intro" },
    { start: "00:30", title: "too close to intro" },
    { start: "02:00", title: "Next" },
  ],
};

// ------------------------------------------------------ Prompt Director

describe("directed answers", () => {
  it("parses the director-specific fields", () => {
    const cands = parseDirectorAnswer(DIRECTED_ANSWER);
    expect(cands).toHaveLength(6);
    expect(cands[0].speaker).toBe("Sarah");
    expect(cands[0].topic_found).toBe(true);
    expect(cands[1].complete_ending).toBeNull();
    expect(cands[0].scores.prompt_match).toBe(9);
  });

  it("applies the hard constraints before the ranking", () => {
    const spec = normalizeSpec({ count: 3, target_duration_seconds: 40, speaker: "Sarah", topic: "why the startup failed" });
    const window = durationWindow(spec);
    expect([window.min_ms, window.max_ms, window.tolerance_ms]).toEqual([24_000, 60_000, 3000]);

    const { kept, rejected } = selectCandidates(parseDirectorAnswer(DIRECTED_ANSWER), spec, window, sentences(80), 400_000);
    expect(kept.map((c) => c.title)).toEqual(["Why we failed", "Unverified speaker"]);
    expect(kept.map((c) => c.score)).toEqual([8.05, 7.0]);
    const reasons = Object.fromEntries(rejected.map((c) => [c.title, c.rejected_for?.[0] ?? ""]));
    expect(reasons["Overlaps the first"]).toBe("overlaps a higher-ranked clip (Why we failed)");
    expect(reasons["Wrong speaker"]).toBe("speaker is Tom, not Sarah");
    expect(reasons["Off topic"]).toBe("required subject not covered");
    expect(reasons["Too short"]).toBe("10.0s is outside the 24-60s window");
    // the speaker of the second clip is never asserted, only reported as unverified
    expect(kept[1].compliance?.speaker_match).toBeNull();
    expect(kept[1].compliance?.warnings).toEqual(["Speaker could not be verified from the transcript (no diarization yet)."]);

    const report = requestCompliance(kept, rejected, spec, window);
    expect([report.requested, report.delivered, report.rejected]).toEqual([3, 2, 4]);
    expect(report.proposed).toBe(6);
    expect(report.rejection_reasons).toEqual({
      "speaker is Tom, not Sarah": 1,
      "overlaps a higher-ranked clip": 1,
      "10.0s is outside the 24-60s window": 1,
      "required subject not covered": 1,
    });
    expect(report.duration).toEqual({ mode: "natural", target_seconds: 40, window_seconds: [24, 60] });
    expect(report.all_topic_found).toBe(true);
    expect(report.profanity_free).toBe(true);
    expect(report.warnings.some((w) => w.includes("Only 2 of the 3"))).toBe(true);
    expect(report.warnings.some((w) => w.includes("1 clip(s) could not have their speaker verified."))).toBe(true);
  });

  it("finds profanity and pulls a clip that misses the target down", () => {
    expect(findProfanity("That's bullshit, honestly. Damn.")).toEqual(["bullshit", "damn"]);
    expect(findProfanity("a classy sentence")).toEqual([]);

    const spec = normalizeSpec({ target_duration_seconds: 40, exclude: ["swearing"] });
    const window = durationWindow(spec);
    const cand = { start_ms: 0, end_ms: 40_000, title: "", hook: "", reason: "", quote: "", scores: { prompt_match: 8, hook: 8, standalone: 8, clarity: 8, energy: 8 } };
    const verdict = checkConstraints(cand, spec, window, "This is bullshit.");
    expect(verdict.ok).toBe(false);
    expect(verdict.rejected_for).toEqual(["contains profanity (bullshit)"]);
    expect(verdict.profanity_found).toBe(true);
    expect(verdict.profane_words).toEqual(["bullshit"]);
    expect(verdict.complete_ending).toBe(true);
    expect(verdict.speaker_match).toBeNull();

    // natural mode: 0.15 points per second outside the ±3 s tolerance
    expect(directorScore(cand, window)).toBe(8.0);
    expect(directorScore({ ...cand, end_ms: 52_000 }, window)).toBe(6.65);
  });

  /**
   * Scores are rounded to the cent and a cent reorders clips, so the arithmetic
   * has to be python's, not "close enough": CPython sums floats with Neumaier
   * compensation and rounds half to even on the value's own decimal expansion.
   * A plain sum scores the clip below 5.2250000000000005 → 5.23; python (and
   * therefore the file already on disk) says 5.22.
   */
  it("adds and rounds the way the python twin does", () => {
    expect(pyRound(2.925, 2)).toBe(2.92);
    expect(pyRound(1.475, 2)).toBe(1.48);
    expect(pyRound(3.456, 1)).toBe(3.5);
    expect(pyRound(7.25, 1)).toBe(7.2);
    const window = durationWindow(normalizeSpec({ target_duration_seconds: 90, duration_mode: "maximum" }));
    const scored = (scores: Record<string, number>) => directorScore({ start_ms: 0, end_ms: 60_000, title: "", hook: "", reason: "", quote: "", scores }, window);
    expect(scored({ prompt_match: 9, hook: 3.5, standalone: 0, clarity: 5, energy: 7 })).toBe(5.22);
    expect(scored({ prompt_match: 7, hook: 0, standalone: 0, clarity: 7, energy: 10 })).toBe(4.15);
  });
});

// ---------------------------------------------------------- episode analysis

describe("analysis answers", () => {
  it("parses fenced json and scores it on hook / standalone / clarity", () => {
    const cands = parseCandidateAnswer("```json\n" + JSON.stringify(ANALYSIS_ANSWER) + "\n```");
    expect(cands.map((c) => c.title)).toEqual(["A", "B overlaps A", "too short", "too long"]);
    expect(cands[0].score).toBe(8.1); // 0.4*9 + 0.3*8 + 0.3*7
    expect(cands[2].scores).toEqual({ hook: 5, clarity: 5, standalone: 5 });
    expect(parseCandidateAnswer(ANALYSIS_ANSWER)).toHaveLength(4);
    expect(parseCandidateAnswer("no json here")).toEqual([]);
    expect(parseCandidateAnswer(null)).toEqual([]);
  });

  it("dedupes, trims to a sentence end and ranks", () => {
    const kept = validateCandidates(parseCandidateAnswer(ANALYSIS_ANSWER), 750_000, 20_000, 90_000, 10, plain(150));
    expect(kept.map((c) => c.title)).toEqual(["A", "too long"]);
    expect(kept[1].end_ms - kept[1].start_ms).toBeLessThanOrEqual(90_000);
    expect(kept[1].end_ms % 5000).toBe(0);
    assignIds(kept);
    expect(kept.map((c) => c.id)).toEqual(["c01", "c02"]);
    expect(kept.map((c) => c.rank)).toEqual([1, 2]);
  });

  it("merges chapters proposed twice by overlapping parts", () => {
    const merged = mergeChapters(parseChapters(ANALYSIS_ANSWER), 600_000);
    expect(merged.map((c) => c.title)).toEqual(["Intro", "Next"]);
    expect(merged[0].end_ms).toBe(120_000);
    expect(merged[merged.length - 1].end_ms).toBe(600_000);
    expect(merged.map((c) => c.id)).toEqual(["ch01", "ch02"]);
  });

  it("snaps a window onto sentence boundaries", () => {
    expect(snapToSentences(12_300, 61_200, plain(20))).toEqual([10_000, 60_000]);
    expect(snapToSentences(1, 2, [])).toEqual([1, 2]);
  });
});

// ------------------------------------------------------------ written files

const ANALYSIS_PAYLOADS: unknown[] = [
  {
    chunk: 1,
    candidates: [
      { start: "00:10", end: "00:50", title: "A", hook: "h", reason: "r", quote: "q", scores: { hook: 9, clarity: 7, standalone: 8 } },
      { start: "00:20", end: "01:00", title: "B overlaps A", scores: { hook: 5, clarity: 5, standalone: 5 } },
      { start: "00:00", end: "00:10", title: "too short" },
    ],
    chapters: [
      { start: "00:00", title: "Intro" },
      { start: "00:30", title: "too close" },
      { start: "01:30", title: "Next" },
    ],
  },
  "```json\n" + JSON.stringify({ candidates: [{ start: "01:10", end: "01:35", title: "C", scores: { hook: 8, clarity: 6, standalone: 6 } }] }) + "\n```",
  "no json here",
];

const quoteOf = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `Sentence number ${from + i} about something.`).join(" ");

const EXPECTED_CANDIDATES = [
  {
    start_ms: 10_000, end_ms: 50_000, title: "A", hook: "h", reason: "r", quote: "q",
    scores: { hook: 9, clarity: 7, standalone: 8 }, score: 8.1,
    proposed: { start_ms: 10_000, end_ms: 50_000 }, duration_ms: 40_000,
    text: quoteOf(2, 9), sentence_ids: [2, 3, 4, 5, 6, 7, 8, 9], id: "c01", rank: 1,
  },
  {
    start_ms: 70_000, end_ms: 95_000, title: "C", hook: "", reason: "", quote: quoteOf(14, 18),
    scores: { hook: 8, clarity: 6, standalone: 6 }, score: 6.8,
    proposed: { start_ms: 70_000, end_ms: 95_000 }, duration_ms: 25_000,
    text: quoteOf(14, 18), sentence_ids: [14, 15, 16, 17, 18], id: "c02", rank: 2,
  },
];

describe("refineAnalysis", () => {
  it("writes candidates.json, chapters.json and the raw answers, exactly as the node did", () => {
    const refined = refineAnalysis({
      root: "projects/ep",
      episodeId: "ep",
      goal: "punchy",
      want: 10,
      minMs: 20_000,
      maxMs: 90_000,
      sentences: plain(20),
      durationMs: 100_000,
      payloads: ANALYSIS_PAYLOADS,
      now: 1000.5,
      seconds: 12.3,
    });

    expect(refined.files.map((f) => f.path)).toEqual([
      "projects/ep/analysis/llm-answers.json",
      "projects/ep/analysis/candidates.json",
      "projects/ep/analysis/chapters.json",
    ]);
    expect(refined.files[0].value).toEqual({ schema_version: 1, generated: 1000.5, answers: ANALYSIS_PAYLOADS });
    expect(refined.files[1].value).toEqual({
      schema_version: 1,
      episode_id: "ep",
      goal: "punchy",
      generated: 1000.5,
      proposed: 4,
      parts: 3,
      empty_parts: 1,
      limits: { min_ms: 20_000, max_ms: 90_000, count: 10 },
      scoring: {
        weights: { hook: 0.4, standalone: 0.3, clarity: 0.3 },
        axes: {
          hook: "Would the first three seconds stop a scroll?",
          clarity: "Is the point easy to follow with no visuals?",
          standalone: "Does it work with zero episode context?",
        },
      },
      candidates: EXPECTED_CANDIDATES,
    });
    expect(refined.files[2].value).toEqual({
      schema_version: 1,
      chapters: [
        { start_ms: 0, title: "Intro", end_ms: 90_000, id: "ch01" },
        { start_ms: 90_000, title: "Next", end_ms: 100_000, id: "ch02" },
      ],
    });
    // the same keys in the same order — a reader must not be able to tell who wrote the file
    expect(Object.keys(refined.files[1].value as object)).toEqual([
      "schema_version", "episode_id", "goal", "generated", "proposed", "parts", "empty_parts", "limits", "scoring", "candidates",
    ]);
    expect(Object.keys(EXPECTED_CANDIDATES[0])).toEqual(Object.keys((refined.candidates[0] as unknown as object) ?? {}));

    expect(refined.analysis).toEqual({
      status: "analyzed", candidates: 2, proposed: 4, chapters: 2, sentences: 20, parts: 3, analyzed_at: 1000.5,
    });
    expect(refined.status).toEqual({ stage: "analyzed", data: { candidates: 2, proposed: 4, chapters: 2, seconds: 12.3 } });
  });
});

// -------------------------------------------------------------- end to end

type Files = Record<string, unknown>;

/** A store that answers from `files` and records everything written through the queued writer. */
function harness(files: Files) {
  const written: [string, unknown][] = [];
  setQueuedWriter(async (path, value) => {
    written.push([path, structuredClone(value)]);
    files[path] = value;
  });
  let answer = async (path: string): Promise<StrictRead<unknown>> =>
    path in files ? { ok: true, value: files[path] } : { ok: false, missing: true, error: "" };
  const read = <T,>(path: string) => answer(path) as Promise<StrictRead<T>>;
  /** make every read (or some of them) fail the way a dropped socket does */
  const readsAs = (fn: (path: string) => Promise<StrictRead<unknown>>) => {
    answer = fn;
  };
  return { written, read, readsAs, files };
}

const PROJECT = {
  episode_id: "ep",
  title: "Episode",
  source: "projects/ep/source/ep.mp4",
  created: 1,
  settings: { goal: "punchy", clip_count: 10, min_seconds: 20, max_seconds: 90 },
  media: { duration_ms: 100_000, width: 1920, height: 1080, fps: 25, has_video: true },
  analysis: { status: "analyzing", started_at: 1 },
};

afterEach(() => {
  setRefineIo(null);
  setQueuedWriter(null);
  resetQueuedSaves();
});

describe("runAnalysis", () => {
  it("turns the raw answers into the files the pages read", async () => {
    const { written, read } = harness({
      "projects/ep/project.json": structuredClone(PROJECT),
      "projects/ep/analysis/transcript.json": { sentences: plain(20), duration_ms: 100_000 },
    });
    const events: { node: string; stage: string }[] = [];
    setRefineIo({ read, run: async () => ({ answers: ANALYSIS_PAYLOADS.map((answer) => ({ answer })) }) });

    const manifest = await runAnalysis("ep", "punchy", (evt) => events.push(evt as unknown as { node: string; stage: string }));
    await flushQueuedSaves();

    expect(written.map(([path]) => path)).toEqual([
      "projects/ep/analysis/llm-answers.json",
      "projects/ep/analysis/candidates.json",
      "projects/ep/analysis/chapters.json",
      "projects/ep/project.json",
      "projects/ep/status.json",
    ]);
    const candidates = written[1][1] as { candidates: unknown[]; generated: number };
    expect(candidates.candidates).toEqual(EXPECTED_CANDIDATES);
    expect(candidates.generated).toEqual(expect.any(Number));

    // project.json keeps everything it had and gains the analysis stamp the node used to write
    const project = written[3][1] as Record<string, unknown>;
    expect(project.settings).toEqual(PROJECT.settings);
    expect(project.analysis).toEqual({ status: "analyzed", candidates: 2, proposed: 4, chapters: 2, sentences: 20, parts: 3, analyzed_at: expect.any(Number) });
    expect(project.schema_version).toBe(2);
    expect(project.updated).toEqual(expect.any(Number));

    // the progress line every screen keys its "analysed" state off
    const status = written[4][1] as Record<string, unknown>;
    expect(status).toMatchObject({ node: "podcast_refine", stage: "analyzed", episode_id: "ep", candidates: 2, proposed: 4, chapters: 2 });
    expect(events.at(-1)).toMatchObject({ node: "podcast_refine", stage: "analyzed", candidates: 2 });

    expect(manifest.candidates.map((c) => c.id)).toEqual(["c01", "c02"]);
    expect(manifest.chapters.map((c) => c.title)).toEqual(["Intro", "Next"]);
    expect(manifest.proposed).toBe(4);
    expect(manifest.parts).toBe(3);
    expect(manifest.error).toBeUndefined();
  });

  it("writes nothing when the project file cannot be read", async () => {
    const { written, read, readsAs } = harness({});
    readsAs(async () => ({ ok: false, missing: false, error: "socket closed" }));
    setRefineIo({ read, run: async () => ({ answers: [] }) });

    const manifest = await runAnalysis("ep", "punchy");
    await flushQueuedSaves();

    expect(manifest.error).toContain("socket closed");
    expect(manifest.candidates).toEqual([]);
    // only the failure is recorded — no candidates file was written over the good one
    expect(written.map(([path]) => path)).toEqual(["projects/ep/status.json"]);
    expect(written[0][1]).toMatchObject({ node: "podcast_refine", stage: "error" });
  });
});

describe("runDirector", () => {
  const storedSpec = normalizeSpec({ count: 3, target_duration_seconds: 40, speaker: "Sarah", topic: "why the startup failed" });
  const request: DirectorRequest = {
    schema_version: 1,
    request_id: "r01",
    prompt: "three clips of Sarah",
    raw: {},
    spec: storedSpec,
    search_query: "sarah startup",
    status: "parsed",
    created: 1,
  };
  const answer = {
    candidates: [DIRECTED_ANSWER.candidates[0], DIRECTED_ANSWER.candidates[5]],
    notes: "The episode never names the second voice.",
  };

  it("writes the request file with its compliance report", async () => {
    const { written, read } = harness({
      // the directed fixture works over a longer recording than the analysis one
      "projects/ep/project.json": { ...structuredClone(PROJECT), media: { ...PROJECT.media, duration_ms: 400_000 } },
      "projects/ep/analysis/transcript.json": { sentences: sentences(80), duration_ms: 400_000 },
      "projects/ep/analysis/requests/r01.json": structuredClone(request),
    });
    setRefineIo({ read, run: async () => ({ answers: [{ answer }] }) });

    const result = await runDirector("ep", request, true, []);
    await flushQueuedSaves();

    expect(written.map(([path]) => path)).toEqual([
      "projects/ep/analysis/requests/r01.json",
      "projects/ep/project.json",
      "projects/ep/status.json",
    ]);
    const file = written[0][1] as Record<string, unknown>;
    expect(Object.keys(file)).toEqual([
      "schema_version", "request_id", "prompt", "raw", "spec", "search_query", "status", "created",
      "summary", "window", "scoring", "candidates", "rejected", "compliance", "llm_answers", "answered_at", "seconds",
    ]);
    expect(file.status).toBe("done");
    expect(file.summary).toBe(describeSpec(normalizeSpec(storedSpec)));
    expect(file.window).toEqual({ mode: "natural", target_ms: 40_000, min_ms: 24_000, max_ms: 60_000, tolerance_ms: 3000 });
    expect(file.scoring).toEqual({
      weights: { prompt_match: 0.35, hook: 0.25, standalone: 0.2, clarity: 0.1, energy: 0.1 },
      axes: {
        prompt_match: "How well the moment answers the producer’s direction (subject, tone, hook, ending).",
        hook: "Would the first three seconds stop a scroll?",
        standalone: "Does it work with zero episode context?",
        clarity: "Is the point easy to follow with no visuals?",
        energy: "Vocal and visual energy: pace, emphasis, emotion.",
      },
    });
    expect(file.llm_answers).toEqual([answer]);

    const written_candidates = file.candidates as Record<string, unknown>[];
    expect(written_candidates.map((c) => c.id)).toEqual(["r01c01", "r01c02"]);
    expect(written_candidates.map((c) => c.score)).toEqual([8.05, 7.0]);
    expect(written_candidates.map((c) => c.request_id)).toEqual(["r01", "r01"]);
    expect(written_candidates[0].sentence_ids).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(written_candidates[1].sentence_ids).toEqual([60, 61, 62, 63, 64, 65, 66, 67]);
    expect(written_candidates[0].compliance).toEqual({
      ok: true,
      rejected_for: [],
      duration_requested: 40,
      duration_planned: 40,
      duration_ok: true,
      speaker_match: true,
      required_topic_found: true,
      excluded_subject_found: false,
      profanity_found: false,
      profane_words: [],
      complete_ending: true,
      warnings: [],
    });

    const compliance = file.compliance as Record<string, unknown>;
    expect(compliance).toMatchObject({
      requested: 3,
      delivered: 2,
      proposed: 2,
      rejected: 0,
      rejection_reasons: {},
      duration: { mode: "natural", target_seconds: 40, window_seconds: [24, 60] },
      all_topic_found: true,
      profanity_free: true,
      notes: ["The episode never names the second voice."],
    });

    // project.json records the request the same way the node did
    const project = written[1][1] as Record<string, unknown>;
    expect(project.requests).toEqual({
      r01: { prompt: "three clips of Sarah", summary: file.summary, delivered: 2, requested: 3, answered_at: expect.any(Number) },
    });
    expect(written[2][1]).toMatchObject({ node: "podcast_refine", stage: "directed", request: "r01", candidates: 2, proposed: 2, rejected: 0 });

    expect(result.candidates.map((c) => c.id)).toEqual(["r01c01", "r01c02"]);
    expect(result.compliance?.delivered).toBe(2);
    expect(result.notes).toEqual(["The episode never names the second voice."]);
    expect(result.mode).toBe("index");
    expect(result.error).toBeUndefined();
  });

  it("never rewrites a request it could not read", async () => {
    const { written, read, readsAs } = harness({ "projects/ep/project.json": structuredClone(PROJECT) });
    readsAs(async (path: string) =>
      path.includes("requests") ? { ok: false, missing: false, error: "connection lost" } : { ok: true, value: structuredClone(PROJECT) }
    );
    setRefineIo({ read, run: async () => ({ answers: [{ answer }] }) });

    const result = await runDirector("ep", request, true, []);
    await flushQueuedSaves();

    expect(result.error).toContain("connection lost");
    expect(result.candidates).toEqual([]);
    expect(written.map(([path]) => path)).toEqual(["projects/ep/status.json"]);
  });

  it("reports a request with no transcript instead of writing an empty one", async () => {
    const { written, read } = harness({
      "projects/ep/project.json": structuredClone(PROJECT),
      "projects/ep/analysis/requests/r01.json": structuredClone(request),
    });
    setRefineIo({ read, run: async () => ({ answers: [{ answer }] }) });

    const result = await runDirector("ep", request, true, []);
    await flushQueuedSaves();

    expect(result.error).toContain("run the episode analysis first");
    expect(written.map(([path]) => path)).toEqual(["projects/ep/status.json"]);
  });
});
