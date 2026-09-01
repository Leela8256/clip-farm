import { describe, expect, it } from "vitest";
import {
  RENDERABLE_ASPECTS,
  applyRevision,
  buildDirectQuestion,
  buildParseQuestion,
  buildReviseQuestion,
  complianceBadges,
  describeSpec,
  durationWindow,
  nextRequestId,
  normalizeSpec,
  parseTs,
  requestIdOf,
  resolveEdit,
  searchQueryOf,
  transcriptLines,
  type QuestionLike,
} from "../director";
import { toCandidate } from "../podcast";

class FakeQuestion implements QuestionLike {
  role = "";
  expectJson = false;
  filter: { objectIds?: string[]; limit?: number } = {};
  instructions: [string, string][] = [];
  examples: [string, unknown][] = [];
  context: string[] = [];
  goals: string[] = [];
  questions: string[] = [];
  addInstruction(title: string, text: string) {
    this.instructions.push([title, text]);
  }
  addExample(given: string, result: string | object | unknown[]) {
    this.examples.push([given, result]);
  }
  addContext(context: string) {
    this.context.push(context);
  }
  addGoal(goal: string) {
    this.goals.push(goal);
  }
  addQuestion(text: string) {
    this.questions.push(text);
  }
}

describe("normalizeSpec", () => {
  it("keeps the example prompt's fields and warns about unverifiable speakers", () => {
    const spec = normalizeSpec({
      count: 3,
      target_duration_seconds: 42,
      duration_mode: "natural",
      speakers: ["Sarah"],
      subjects: ["why the startup failed"],
      exclude_content: ["profanity"],
      hook: "a surprising statement",
      ending: "a complete takeaway",
      filler_policy: "smart",
      caption_preset: "yellow-bold",
      aspect_ratio: "9:16",
      warnings: [],
    });
    expect(spec.count).toBe(3);
    expect(spec.duration).toEqual({ target_seconds: 42, min_seconds: null, max_seconds: null, mode: "natural" });
    expect(spec.speakers).toEqual(["Sarah"]);
    expect(spec.exclude_content).toEqual(["profanity"]);
    expect(spec.caption_preset).toBe("yellow-bold");
    expect(spec.warnings.some((w) => w.includes("Speaker"))).toBe(true);
    expect(describeSpec(spec)).toContain("42s natural");
  });

  it("turns contradictions into warnings instead of guesses", () => {
    const spec = normalizeSpec({ count: 99, min_duration_seconds: 60, max_duration_seconds: 30, duration_mode: "exactly", aspect_ratio: "square", fillers: "obliterate", exclude: ["politics"] });
    expect(spec.count).toBe(20);
    expect(spec.duration.mode).toBe("strict");
    expect([spec.duration.min_seconds, spec.duration.max_seconds]).toEqual([30, 60]);
    expect(spec.aspect_ratio).toBe("1:1");
    expect(spec.filler_policy).toBe("smart");
    expect(spec.exclude_subjects).toEqual(["politics"]);
    const joined = spec.warnings.join(" ");
    for (const needle of ["clamped", "swapped", "Strict", "filler policy", "excluded subject"]) expect(joined).toContain(needle);
    expect(spec.aspect_ratio in RENDERABLE_ASPECTS).toBe(true);
  });

  it("understands units, maximum mode and empty input", () => {
    const spec = normalizeSpec({ duration: { target: "1.5 minutes", mode: "max" } });
    expect(spec.duration.target_seconds).toBe(90);
    expect(spec.duration.mode).toBe("maximum");
    expect(spec.duration.max_seconds).toBe(90);
    expect(normalizeSpec(null).count).toBe(3);
    expect(normalizeSpec("garbage").duration.target_seconds).toBe(45);
  });

  it("derives the same duration windows as the node", () => {
    const natural = durationWindow(normalizeSpec({ target_duration_seconds: 42 }));
    expect([natural.min_ms, natural.max_ms, natural.tolerance_ms]).toEqual([25_200, 63_000, 3000]);
    const strict = durationWindow(normalizeSpec({ target_duration_seconds: 42, duration_mode: "strict" }));
    expect([strict.min_ms, strict.max_ms, strict.tolerance_ms]).toEqual([35_700, 63_000, 1000]);
    const maximum = durationWindow(normalizeSpec({ target_duration_seconds: 42, duration_mode: "maximum" }));
    expect([maximum.min_ms, maximum.max_ms, maximum.tolerance_ms]).toEqual([21_000, 54_600, 0]);
  });
});

describe("questions", () => {
  it("builds the parse question with the shared prompt", () => {
    const q = buildParseQuestion(new FakeQuestion(), "three funny clips");
    expect(q.expectJson).toBe(true);
    expect(q.role).toContain("Prompt Director");
    expect(q.instructions.map(([t]) => t)).toContain("Search query");
    expect(q.examples.length).toBeGreaterThan(1);
    expect(q.questions).toEqual(["three funny clips"]);
  });

  it("scopes the discovery question to the episode and carries the request context", () => {
    const spec = normalizeSpec({ count: 2, target_duration_seconds: 40, subjects: ["pricing"] });
    const q = buildDirectQuestion(new FakeQuestion(), {
      prompt: "two clips about pricing",
      spec,
      window: durationWindow(spec),
      projectRoot: "projects/ep1",
      requestId: "r01",
      episodeId: "ep1",
      searchQuery: "pricing debate",
    });
    expect(q.filter).toEqual({ objectIds: ["ep1"], limit: 16 });
    expect(q.context[0]).toBe("project: projects/ep1\nrequest: r01");
    expect(q.questions).toEqual(["pricing debate"]);
    expect(q.instructions.find(([t]) => t === "Request")?.[1]).toContain("Subject the clip must cover: pricing.");
    expect(q.goals[0]).toContain("two clips about pricing");
  });

  it("adds the transcript as context for the full-transcript fallback", () => {
    const spec = normalizeSpec({});
    const lines = transcriptLines([
      { id: 0, text: "Hello there.", start_ms: 0, end_ms: 1500 },
      { id: 1, text: "", start_ms: 1500, end_ms: 2000 },
    ]);
    expect(lines).toBe("[0:00 - 0:01] Hello there.");
    const q = buildDirectQuestion(new FakeQuestion(), { prompt: "p", spec, window: durationWindow(spec), projectRoot: "projects/x", requestId: "r02", episodeId: "x", searchQuery: "", transcriptLines: lines });
    expect(q.context[1]).toContain("Transcript:\n[0:00 - 0:01] Hello there.");
    expect(q.questions).toEqual(["p"]);
    expect(searchQueryOf({ search_query: " a b " }, spec, "p")).toBe("a b");
    expect(searchQueryOf({}, normalizeSpec({ speakers: ["Sarah"], subjects: ["failure"] }), "p")).toBe("Sarah failure");
  });

  it("gives the revision question the clip plan, the cuts and the surrounding transcript", () => {
    const sentences = [
      { id: 0, text: "Before.", start_ms: 0, end_ms: 4000 },
      { id: 1, text: "Inside the clip.", start_ms: 10_000, end_ms: 20_000 },
      { id: 2, text: "Far away.", start_ms: 200_000, end_ms: 210_000 },
    ];
    const q = buildReviseQuestion(new FakeQuestion(), {
      instruction: "Make the opening stronger.",
      projectRoot: "projects/x",
      clipId: "c01",
      plan: { schema_version: 2, clip_id: "c01", title: "T", start_ms: 10_000, end_ms: 20_000, duration_ms: 10_000, cuts: [{ id: "f01", kind: "filler", word: "um", start_ms: 500, end_ms: 800, action: "cut", safe: true, reason: null, enabled: true }] },
      sentences,
      candidates: [toCandidate({ id: "c02", start_ms: 30_000, end_ms: 40_000, title: "Other" })],
    });
    expect(q.context[1]).toContain("f01: filler “um” at 0.5s — cut");
    expect(q.context[2]).toContain("> [0:10 - 0:20] Inside the clip.");
    expect(q.context[2]).toContain("  [0:00 - 0:04] Before.");
    expect(q.context[2]).not.toContain("Far away");
    expect(q.context[3]).toContain("c02: [0:30 - 0:40] Other");
  });
});

describe("revisions and edits", () => {
  const plan = { start_ms: 10_000, end_ms: 50_000 };

  it("creates versions without touching the base edit", () => {
    const edit = { start_ms: 10_000, disabled_cuts: ["f01"], versions: [{ n: 1, note: "first" }] };
    const retime = applyRevision({ action: "retime", start: "0:14", note: "later start" }, edit, plan, 1000);
    expect(retime).toEqual({ n: 2, created: 1, note: "later start", source: "revision", start_ms: 14_000, end_ms: 50_000 });
    const options = applyRevision({ action: "options", options: { restore: ["s03"], silence_policy: "keep" } }, edit, plan);
    expect(options?.disabled_cuts).toEqual(["f01", "s03"]);
    expect(options?.silence_policy).toBe("keep");
    expect(applyRevision({ action: "retitle" }, edit, plan)).toBeNull();
    expect(applyRevision({ action: "new_request", prompt: "x" }, edit, plan)).toBeNull();
    expect(applyRevision({ action: "options", options: {} }, edit, plan)).toBeNull();
  });

  it("overlays the active version like the node does", () => {
    const edit = { title: "base", versions: [{ n: 1, note: "a", start_ms: 1 }, { n: 2, note: "b", title: "v2" }], active_version: 2 };
    expect(resolveEdit(edit)).toEqual({ ...edit, title: "v2" });
    expect(resolveEdit(edit, 1)).toEqual({ ...edit, start_ms: 1 });
    expect(resolveEdit(undefined)).toEqual({});
  });

  it("parses timestamps and request ids", () => {
    expect(parseTs("1:02:03.5")).toBe(3_723_500);
    expect(parseTs(1500)).toBe(1500);
    expect(parseTs("nope")).toBeNull();
    expect(nextRequestId([])).toBe("r01");
    expect(nextRequestId(["r01.json", "r07.json", "junk"])).toBe("r08");
    expect(requestIdOf("r03c02")).toBe("r03");
    expect(requestIdOf("c02")).toBeNull();
  });

  it("summarises compliance as badges", () => {
    const spec = normalizeSpec({ speakers: ["Sarah"], subjects: ["failure"], exclude_content: ["profanity"] });
    const badges = complianceBadges({ prompt_match: 0.9, duration_requested: 42, duration_final: 41.7, duration_mode: "strict", duration_met: true, speaker_match: null, required_topic_found: true, profanity_found: false, complete_ending: true }, spec);
    expect(badges.map((b) => b.label)).toEqual(["prompt match 90%", "41.7s of 42s strict", "speaker unverified", "on topic", "clean", "complete ending"]);
    expect(badges.map((b) => b.tone)).toEqual(["ok", "ok", "muted", "ok", "ok", "ok"]);
    expect(complianceBadges({ profanity_found: true }, spec).find((b) => b.label === "profanity")?.tone).toBe("bad");
    expect(complianceBadges({ profanity_found: true }, null).find((b) => b.label === "profanity")?.tone).toBe("warn");
    const visual = complianceBadges({ visual: { applied: true, speaker_visible_pct: 100, face_cut_violations: 2, face_checks: 100, smooth: true } });
    expect(visual.map((b) => b.label)).toEqual(["speaker visible 100%", "faces safe", "smooth camera"]);
    expect(complianceBadges({ visual: { applied: true, face_cut_violations: 30, face_checks: 100, smooth: false } }).map((b) => b.tone)).toEqual(["warn", "warn"]);
    expect(complianceBadges({ visual: { applied: false, people: 0 } })).toEqual([]);
    expect(complianceBadges(null)).toEqual([]);
  });
});
