import { beforeEach, describe, expect, it, vi } from "vitest";

/** studio-engine is exercised here too (the save queue and the fail-closed load); the store is a stand-in. */
vi.mock("../engine", () => ({
  deleteFile: vi.fn(async () => undefined),
  getClient: vi.fn(),
  listDir: vi.fn(async () => []),
  mediaUrl: vi.fn(),
  readJsonOr: vi.fn(async (_path: string, fallback: unknown) => fallback),
  readJsonStrict: vi.fn(async () => ({ ok: false, missing: true, error: "" })),
  startRun: vi.fn(),
  uploadFile: vi.fn(),
  writeJson: vi.fn(async () => undefined),
}));
import {
  addOperation,
  applyAll,
  applySuggestion,
  assignSpeaker,
  bumpVersion,
  canRedo,
  canUndo,
  chapterListOut,
  emptyEdits,
  fmtDuration,
  fmtPosition,
  initHistory,
  keepSegments,
  mergedCuts,
  nextKeepEdge,
  normalizeEdits,
  normalizeSuggestions,
  outputDurationMs,
  pushHistory,
  redo,
  rejectSuggestion,
  removeOperation,
  renameSpeaker,
  searchWords,
  silenceCut,
  snapshotVersion,
  speakerAt,
  splitSection,
  suggestionState,
  suggestionsForMode,
  timelineMapLite,
  toggleOperation,
  undo,
  updateOperation,
  addCorrection,
  applyProposalItem,
  applySafeProposalItems,
  buildProposalQuestion,
  clockFromSpec,
  correctedWord,
  discardProposal,
  editsSignature,
  isReviewOnly,
  listenWindow,
  isReviewed,
  markReviewed,
  mediaToSource,
  nextKeptSource,
  normalizeCorrections,
  normalizeSuggestionsFile,
  outputToSource,
  proposalTotals,
  rejectProposalItem,
  removeCorrection,
  restoreVersion,
  snapToWordGap,
  sourceToMedia,
  sourceToOutput,
  suggestionConflict,
  suggestionTimeSavedMs,
  validateProposal,
  wordId,
  type EditProposal,
  type EpisodeEdits,
  type PreparedSpec,
  type ProposalQuestionLike,
  type Suggestion,
  type StudioWord,
} from "../studio";
import * as engine from "../engine";
import {
  editsPath,
  flushSaves,
  loadVersion,
  restoreEpisodeVersion,
  getSaveState,
  isSaved,
  loadStudio,
  resetSaveState,
  saveEpisodeEdits,
  setStudioWriter,
} from "../studio-engine";

const NOW = 1_724_900_000_000;

function base(durationMs = 600_000): EpisodeEdits {
  return emptyEdits(durationMs, NOW);
}

const cut = (edits: EpisodeEdits, start: number, end: number) => addOperation(edits, { type: "cut", start_ms: start, end_ms: end });

describe("operations", () => {
  it("numbers new instructions and keeps them in order without moving the record on", () => {
    let edits = cut(base(), 20_000, 25_000);
    edits = cut(edits, 5_000, 6_000);
    expect(edits.operations.map((o) => o.id)).toEqual(["e002", "e001"]);
    expect(edits.operations.map((o) => o.start_ms)).toEqual([5_000, 20_000]);
    expect(edits.version).toBe(1);
    expect(bumpVersion(edits, NOW).version).toBe(2);
  });

  it("ignores an empty or backwards range and clamps to the recording", () => {
    const edits = base(10_000);
    expect(addOperation(edits, { type: "cut", start_ms: 500, end_ms: 500 })).toBe(edits);
    const clamped = addOperation(edits, { type: "cut", start_ms: 9_000, end_ms: 99_000 });
    expect(clamped.operations[0].end_ms).toBe(10_000);
    const flipped = addOperation(edits, { type: "mute", start_ms: 4_000, end_ms: 1_000 });
    expect([flipped.operations[0].start_ms, flipped.operations[0].end_ms]).toEqual([1_000, 4_000]);
  });

  it("merges overlapping and touching removals", () => {
    let edits = cut(base(), 1_000, 5_000);
    edits = cut(edits, 4_000, 7_000);
    edits = cut(edits, 7_000, 8_000);
    edits = cut(edits, 20_000, 21_000);
    expect(mergedCuts(edits)).toEqual([
      [1_000, 8_000],
      [20_000, 21_000],
    ]);
  });

  it("restores an instruction without losing it, and puts it back", () => {
    const edits = cut(base(), 1_000, 5_000);
    const off = toggleOperation(edits, "e001");
    expect(off.operations[0].enabled).toBe(false);
    expect(mergedCuts(off)).toEqual([]);
    expect(outputDurationMs(off)).toBe(600_000);
    const on = toggleOperation(off, "e001", true);
    expect(mergedCuts(on)).toEqual([[1_000, 5_000]]);
    expect(removeOperation(on, "e001").operations).toHaveLength(0);
    expect(removeOperation(on, "nope")).toBe(on);
    expect(updateOperation(on, "e001", { end_ms: 9_000 }).operations[0].end_ms).toBe(9_000);
  });

  it("shortens a silence by taking its middle out and leaves short ones alone", () => {
    let edits = addOperation(base(), { type: "shorten_silence", start_ms: 100_000, end_ms: 104_000, target_ms: 600 });
    expect(silenceCut(edits.operations[0])).toEqual([100_300, 103_700]);
    expect(mergedCuts(edits)).toEqual([[100_300, 103_700]]);
    edits = addOperation(base(), { type: "shorten_silence", start_ms: 100_000, end_ms: 100_400, target_ms: 600 });
    expect(mergedCuts(edits)).toEqual([]);
  });

  it("counts the finished length and the pieces that stay", () => {
    let edits = cut(base(60_000), 10_000, 15_000);
    edits = cut(edits, 30_000, 31_000);
    expect(keepSegments(edits)).toEqual([
      [0, 10_000],
      [15_000, 30_000],
      [31_000, 60_000],
    ]);
    expect(outputDurationMs(edits)).toBe(54_000);
    const wholeThing = cut(base(60_000), 0, 60_000);
    expect(keepSegments(wholeThing)).toEqual([]);
    expect(outputDurationMs(wholeThing)).toBe(0);
  });
});

describe("timeline map", () => {
  let edits = cut(base(60_000), 10_000, 15_000);
  edits = cut(edits, 30_000, 31_000);

  it("maps a kept position both ways", () => {
    const map = timelineMapLite(edits);
    expect(map.outputDurationMs).toBe(54_000);
    expect(map.sourceToOut(5_000)).toBe(5_000);
    expect(map.sourceToOut(20_000)).toBe(15_000);
    expect(map.sourceToOut(40_000)).toBe(34_000);
    expect(map.outToSource(map.sourceToOut(40_000))).toBe(40_000);
    expect(map.outToSource(15_000)).toBe(20_000);
  });

  it("lands a removed position on the next moment that stays", () => {
    const map = timelineMapLite(edits);
    expect(map.isCut(12_000)).toBe(true);
    expect(map.isCut(9_999)).toBe(false);
    expect(map.sourceToOut(12_000)).toBe(10_000);
    expect(map.sourceToOut(15_000)).toBe(10_000);
    expect(map.sourceToOut(999_999)).toBe(54_000);
    expect(map.outToSource(-50)).toBe(0);
    expect(map.outToSource(99_999)).toBe(60_000);
  });

  it("reads the prepared instructions when they exist", () => {
    const map = timelineMapLite({
      schema_version: 1,
      version: 3,
      episode_id: "ep",
      keep: [],
      mutes: [],
      bleeps: [],
      output_duration_ms: 9_000,
      map: [
        [0, 4_000, 0],
        [6_000, 11_000, 4_000],
      ],
    });
    expect(map.sourceToOut(7_000)).toBe(5_000);
    expect(map.outToSource(5_000)).toBe(7_000);
    expect(map.isCut(5_000)).toBe(true);
  });

  it("finds the next moment playback should jump to", () => {
    expect(nextKeepEdge(edits, 5_000)).toBe(5_000);
    expect(nextKeepEdge(edits, 12_000)).toBe(15_000);
    expect(nextKeepEdge(edits, 30_500)).toBe(31_000);
    expect(nextKeepEdge(edits, 59_000)).toBe(59_000);
    expect(nextKeepEdge(edits, 70_000)).toBe(60_000);
  });
});

describe("history", () => {
  it("steps back and forward over changes", () => {
    const first = base();
    let history = initHistory(first);
    expect(canUndo(history)).toBe(false);
    const second = cut(first, 1_000, 2_000);
    history = pushHistory(history, second);
    const third = cut(second, 5_000, 6_000);
    history = pushHistory(history, third);
    expect(history.present.operations).toHaveLength(2);
    history = undo(history);
    expect(history.present).toBe(second);
    expect(canRedo(history)).toBe(true);
    history = undo(history);
    expect(history.present).toBe(first);
    expect(undo(history)).toBe(history);
    history = redo(history);
    expect(history.present).toBe(second);
    history = pushHistory(history, cut(second, 9_000, 9_500));
    expect(canRedo(history)).toBe(false);
  });

  it("keeps at most fifty steps", () => {
    let edits = base();
    let history = initHistory(edits);
    for (let i = 0; i < 80; i++) {
      edits = cut(edits, i * 1_000, i * 1_000 + 500);
      history = pushHistory(history, edits);
    }
    expect(history.past).toHaveLength(50);
    expect(pushHistory(history, history.present)).toBe(history);
  });
});

const suggestions: Suggestion[] = normalizeSuggestions({
  suggestions: [
    { id: "f001", kind: "filler", start_ms: 1_000, end_ms: 1_300, action: "cut", level: "natural", text: "um" },
    { id: "p002", kind: "pause", start_ms: 5_000, end_ms: 8_000, action: "shorten_silence", target_ms: 600, level: "balanced" },
    { id: "q003", kind: "quiet", start_ms: 20_000, end_ms: 22_000, action: "mute", level: "tight" },
    { id: "bad", kind: "filler", start_ms: 100, end_ms: 100, action: "cut", level: "tight" },
  ],
});

describe("suggestions", () => {
  it("keeps the levels nested", () => {
    expect(normalizeSuggestions(null)).toEqual([]);
    expect(suggestions.map((s) => s.id)).toEqual(["f001", "p002", "q003"]);
    expect(suggestionsForMode(suggestions, "natural").map((s) => s.id)).toEqual(["f001"]);
    expect(suggestionsForMode(suggestions, "balanced").map((s) => s.id)).toEqual(["f001", "p002"]);
    expect(suggestionsForMode(suggestions, "tight")).toHaveLength(3);
  });

  it("accepts one, remembers it, and does nothing the second time", () => {
    const edits = applySuggestion(base(), suggestions[0]);
    expect(edits.operations[0].source).toBe("suggestion:f001");
    expect(edits.operations[0].reason).toContain("Filler word");
    expect(edits.suggestions.accepted).toEqual(["f001"]);
    expect(suggestionState(edits, suggestions[0])).toBe("accepted");
    expect(applySuggestion(edits, suggestions[0])).toBe(edits);
  });

  it("turns one down and takes its instruction away", () => {
    const accepted = applySuggestion(base(), suggestions[0]);
    const rejected = rejectSuggestion(accepted, suggestions[0]);
    expect(rejected.operations).toHaveLength(0);
    expect(rejected.suggestions.accepted).toEqual([]);
    expect(suggestionState(rejected, suggestions[0])).toBe("rejected");
    const all = applyAll(rejected, suggestions, "tight");
    expect(all.edits.operations.map((o) => o.source)).toEqual(["suggestion:p002", "suggestion:q003"]);
    expect(all).toMatchObject({ applied: 2, rejected: 1, skipped_conflict: 0, already_accepted: 0, review_only: 0 });
  });

  it("applies everything for a level once and only once", () => {
    const once = applyAll(base(), suggestions, "balanced");
    expect(once.edits.operations).toHaveLength(2);
    expect(once.edits.suggestions.mode).toBe("balanced");
    expect(once.applied).toBe(2);
    const twice = applyAll(once.edits, suggestions, "balanced");
    expect(twice.edits.operations).toHaveLength(2);
    expect(twice.edits.suggestions.accepted).toEqual(["f001", "p002"]);
    expect(twice).toMatchObject({ applied: 0, already_accepted: 2 });
  });

  it("skips a suggestion that lands on an instruction already there and says so", () => {
    const result = applyAll(cut(base(), 900, 2_000), suggestions, "natural");
    expect(result.edits.operations).toHaveLength(1);
    expect(result.skipped_conflict).toBe(1);
    expect(result.conflicts).toEqual(["f001"]);
    expect(suggestionState(result.edits, suggestions[0])).toBe("open");
  });

  it("says a hand-made instruction from a suggestion counts as accepted", () => {
    const edits = addOperation(base(), { type: "cut", start_ms: 1_000, end_ms: 1_300, source: "suggestion:f001" });
    expect(suggestionState(edits, "f001")).toBe("accepted");
  });
});

describe("save points", () => {
  it("numbers snapshots and moves the record on", () => {
    const first = snapshotVersion(base(), "first pass", NOW);
    expect(first.file).toBe("edits/versions/001.json");
    expect(first.edits.version).toBe(2);
    expect(first.edits.versions).toEqual([{ n: 1, file: "edits/versions/001.json", note: "first pass", created: NOW / 1000 }]);
    const second = snapshotVersion(first.edits, "", NOW);
    expect(second.file).toBe("edits/versions/002.json");
    expect(second.edits.versions).toHaveLength(2);
    expect(second.edits.version).toBe(3);
  });
});

describe("chapters, speakers and sections", () => {
  it("places chapters on the finished episode and drops one whose stretch is gone", () => {
    let edits = splitSection(base(60_000), 0, "Welcome");
    edits = splitSection(edits, 20_000, "Interview");
    edits = splitSection(edits, 40_000, "Wrap up");
    edits = cut(edits, 20_000, 40_000);
    const chapters = chapterListOut(edits);
    expect(chapters.map((c) => c.title)).toEqual(["Welcome", "Wrap up"]);
    expect(chapters[1].out_ms).toBe(20_000);
    expect(splitSection(edits, 40_100, "Renamed").sections).toHaveLength(3);
  });

  it("marks who is talking and renames them", () => {
    let edits = assignSpeaker(base(), 0, 30_000, "s1");
    edits = assignSpeaker(edits, 10_000, 20_000, "s2");
    expect(edits.speaker_map).toEqual([
      [0, 10_000, "s1"],
      [10_000, 20_000, "s2"],
      [20_000, 30_000, "s1"],
    ]);
    expect(speakerAt(edits, 15_000)).toBe("s2");
    expect(speakerAt(edits, 40_000)).toBeNull();
    expect(edits.speakers.s2.name).toBe("Speaker 2");
    expect(renameSpeaker(edits, "s2", "Dana").speakers.s2.name).toBe("Dana");
  });
});

describe("search and wording", () => {
  const words: StudioWord[] = [
    { w: "The", s: 0, e: 300 },
    { w: "quick,", s: 300, e: 700 },
    { w: "brown", s: 700, e: 1_000 },
    { w: "fox", s: 1_000, e: 1_400 },
    { w: "quick", s: 2_000, e: 2_400 },
  ];

  it("finds a phrase across words and ignores punctuation", () => {
    const matches = searchWords(words, "quick brown");
    expect(matches).toHaveLength(1);
    expect([matches[0].start, matches[0].end]).toEqual([1, 2]);
    expect(matches[0].start_ms).toBe(300);
    expect(matches[0].end_ms).toBe(1_000);
    expect(searchWords(words, "quick")).toHaveLength(2);
    expect(searchWords(words, "  ")).toEqual([]);
    expect(searchWords(words, "own")).toEqual([]);
  });

  it("says lengths and positions in plain words", () => {
    expect(fmtDuration(400)).toBe("0.4 sec");
    expect(fmtDuration(7_600)).toBe("7.6 sec");
    expect(fmtDuration(45_000)).toBe("45 sec");
    expect(fmtDuration(320_000)).toBe("5 min 20 sec");
    expect(fmtDuration(300_000)).toBe("5 min");
    expect(fmtDuration(3_852_000)).toBe("1 hr 4 min");
    expect(fmtPosition(3_852_000)).toBe("1:04:12");
    expect(fmtPosition(72_400)).toBe("1:12");
  });
});

describe("reading what is on file", () => {
  it("turns nonsense into a usable record", () => {
    for (const junk of [null, 42, "nope", [], { operations: "many" }]) {
      const edits = normalizeEdits(junk, 1_000, NOW);
      expect(edits.schema_version).toBe(1);
      expect(edits.version).toBe(1);
      expect(edits.operations).toEqual([]);
      expect(edits.source_duration_ms).toBe(1_000);
      expect(edits.audio.loudness_lufs).toBe(-16);
      expect(edits.visual.caption_style.position).toBe("bottom");
      expect(edits.suggestions.mode).toBe("balanced");
    }
  });

  it("keeps what it recognises and drops what it does not", () => {
    const edits = normalizeEdits(
      {
        schema_version: 1,
        version: 4,
        source_duration_ms: 60_000,
        operations: [
          { id: "e001", type: "cut", start_ms: 1_000, end_ms: 5_000, enabled: false },
          { id: "e002", type: "sparkle", start_ms: 1_000, end_ms: 2_000 },
          { type: "mute", start_ms: 9_000, end_ms: "nope" },
          { id: "e004", type: "shorten_silence", start_ms: 10_000, end_ms: 14_000 },
        ],
        speaker_map: [[0, 5_000, "s1"], "junk"],
        sections: [{ title: "Intro", start_ms: 0 }],
        visual: { aspect_ratio: "9:16", fit: "fill", captions: false, caption_style: { position: "sideways", karaoke: true } },
        suggestions: { mode: "wild", accepted: ["f001", 7], rejected: [] },
        versions: [{ n: 2, file: "edits/versions/002.json" }, { n: 0 }],
        extra_aspects: ["1:1", 9],
      },
      0,
      NOW
    );
    expect(edits.version).toBe(4);
    expect(edits.operations.map((o) => o.id)).toEqual(["e001", "e004"]);
    expect(edits.operations[0].enabled).toBe(false);
    expect(edits.operations[1].target_ms).toBe(600);
    expect(edits.speaker_map).toEqual([[0, 5_000, "s1"]]);
    expect(edits.speakers.s1.name).toBe("Speaker 1");
    expect(edits.sections[0].id).toBe("sec01");
    expect(edits.visual.fit).toBe("fill");
    expect(edits.visual.caption_style.position).toBe("bottom");
    expect(edits.visual.caption_style.karaoke).toBe(true);
    expect(edits.suggestions.mode).toBe("balanced");
    expect(edits.suggestions.accepted).toEqual(["f001"]);
    expect(edits.versions).toEqual([{ n: 2, file: "edits/versions/002.json" }]);
    expect(edits.extra_aspects).toEqual(["1:1"]);
    expect(outputDurationMs(edits)).toBe(60_000 - 3_400);
  });
});

// ---------------------------------------------------------------- playback clock

/** 100 s recording with two stretches removed: 10–20 s and 50–60 s. */
function cutTwice(): EpisodeEdits {
  return cut(cut(base(100_000), 10_000, 20_000), 50_000, 60_000);
}

describe("playback clock", () => {
  const edits = cutTwice();

  it("uses the prepared instructions when they match the record, and says so when it guessed", () => {
    const spec: PreparedSpec = {
      schema_version: 1,
      version: edits.version,
      episode_id: "ep",
      keep: [],
      mutes: [],
      bleeps: [],
      output_duration_ms: 80_000,
      // the finished file snapped the first cut to a word edge
      map: [
        [0, 9_800, 0],
        [20_200, 50_000, 9_800],
        [60_000, 100_000, 39_600],
      ],
    };
    const exact = clockFromSpec(spec, edits, "rough_preview");
    expect(exact.approximate).toBe(false);
    expect(exact.map?.[1][0]).toBe(20_200);
    expect(exact.outputDurationMs).toBe(79_600);

    const stale = clockFromSpec({ ...spec, version: edits.version + 1 }, edits, "rough_preview");
    expect(stale.approximate).toBe(true);
    expect(stale.map?.[1][0]).toBe(20_000);
    expect(clockFromSpec(null, edits, "rough_preview").approximate).toBe(true);
  });

  it("converts positions before, inside and after every cut", () => {
    const clock = clockFromSpec(null, edits, "rough_preview");
    const map = clock.map;
    expect(sourceToOutput(map, 5_000)).toBe(5_000);
    // inside the first cut: the next moment that is still in the episode
    expect(sourceToOutput(map, 15_000)).toBe(10_000);
    expect(sourceToOutput(map, 30_000)).toBe(20_000);
    expect(sourceToOutput(map, 55_000)).toBe(40_000);
    expect(sourceToOutput(map, 70_000)).toBe(50_000);
    expect(sourceToOutput(map, 200_000)).toBe(80_000);
    expect(outputToSource(map, 0)).toBe(0);
    expect(outputToSource(map, 20_000)).toBe(30_000);
    expect(outputToSource(map, 40_000)).toBe(60_000);
    expect(outputToSource(map, 999_000)).toBe(100_000);
    expect(sourceToMedia(clock, 15_000)).toBeNull();
    expect(nextKeptSource(map, 15_000)).toBe(20_000);
    expect(sourceToMedia(clock, nextKeptSource(map, 15_000))).toBe(10_000);
  });

  it("keeps the recording's own clock straight through", () => {
    const clock = clockFromSpec(null, edits, "source");
    expect(mediaToSource(clock, 15_000)).toBe(15_000);
    expect(sourceToMedia(clock, 15_000)).toBe(15_000);
    expect(sourceToMedia(clock, 200_000)).toBe(100_000);
  });

  it("handles a close look at a stretch that starts after an earlier cut", () => {
    const clock = clockFromSpec(null, edits, "range_preview", [20_000, 50_000]);
    expect(clock.rangeOutStartMs).toBe(20_000);
    // the file starts at 0 but the stretch starts 20 s into the finished episode
    expect(mediaToSource(clock, 0)).toBe(30_000);
    expect(mediaToSource(clock, 5_000)).toBe(35_000);
    expect(sourceToMedia(clock, 30_000)).toBe(0);
    expect(sourceToMedia(clock, 70_000)).toBe(30_000);
    // outside the stretch, and inside a cut, there is nothing to seek to
    expect(sourceToMedia(clock, 5_000)).toBeNull();
    expect(sourceToMedia(clock, 55_000)).toBeNull();
  });

  it("puts the playhead and the caption on the same word after several cuts", () => {
    const clock = clockFromSpec(null, edits, "rough_preview");
    const words: StudioWord[] = [
      { w: "before", s: 4_000, e: 4_500 },
      { w: "gone", s: 12_000, e: 12_500 },
      { w: "middle", s: 30_000, e: 30_500 },
      { w: "after", s: 70_000, e: 70_500 },
    ];
    // the player is at 20.2 s of the preview: that is 30.2 s of the recording, the "middle" word
    const at = mediaToSource(clock, 20_200);
    expect(at).toBe(30_200);
    expect(words.filter((w) => at >= w.s && at < w.e).map((w) => w.w)).toEqual(["middle"]);
    // seeking to a word from the transcript lands on the same spot both ways
    for (const word of [words[0], words[2], words[3]]) {
      const media = sourceToMedia(clock, word.s);
      expect(media).not.toBeNull();
      expect(mediaToSource(clock, media as number)).toBe(word.s);
    }
    // a word inside a cut has no place in the preview
    expect(sourceToMedia(clock, words[1].s)).toBeNull();
  });
});

// ------------------------------------------------------------- review-only ideas

const reviewIdea: Suggestion = { id: "l001", kind: "low_confidence", start_ms: 4_000, end_ms: 5_000, action: "review", level: "natural", review_only: true };

describe("cleanup ideas that are only worth a listen", () => {
  it("never mutes a hard-to-make-out stretch, whatever an older file asks for", () => {
    const [old] = normalizeSuggestions({ suggestions: [{ id: "l001", kind: "low_confidence", start_ms: 4_000, end_ms: 5_000, action: "mute", level: "natural" }] });
    expect(old.action).toBe("review");
    expect(isReviewOnly(old)).toBe(true);
    expect(applySuggestion(base(), old)).toEqual(base());
    const result = applyAll(base(), [old], "tight");
    expect(result).toMatchObject({ applied: 0, review_only: 1 });
    expect(result.edits.operations).toHaveLength(0);
  });

  it("remembers which ones the producer has looked at", () => {
    const seen = markReviewed(base(), reviewIdea);
    expect(seen.suggestions.reviewed).toEqual(["l001"]);
    expect(isReviewed(seen, "l001")).toBe(true);
    expect(markReviewed(seen, "l001")).toBe(seen);
    expect(isReviewed(markReviewed(seen, "l001", false), "l001")).toBe(false);
    expect(normalizeEdits(seen).suggestions.reviewed).toEqual(["l001"]);
  });

  it("says which kinds cannot be looked for in the recording's language", () => {
    const german = normalizeSuggestionsFile({ language: "de", suggestions: [] });
    expect(german.unsupported).toEqual(["filler", "profanity"]);
    const english = normalizeSuggestionsFile({ language: "en-US", suggestions: [], unsupported: [] });
    expect(english.unsupported).toEqual([]);
    expect(english.language).toBe("en-US");
    expect(normalizeSuggestionsFile(null).unsupported).toEqual([]);
  });

  it("counts the time each idea saves and spots the ones that clash", () => {
    const filler: Suggestion = { id: "f009", kind: "filler", start_ms: 1_000, end_ms: 1_400, action: "cut", level: "natural" };
    const pause: Suggestion = { id: "p009", kind: "pause", start_ms: 8_000, end_ms: 10_000, action: "shorten_silence", target_ms: 600, level: "balanced" };
    expect(suggestionTimeSavedMs(filler)).toBe(400);
    expect(suggestionTimeSavedMs(pause)).toBe(1_400);
    expect(suggestionTimeSavedMs(reviewIdea)).toBe(0);
    expect(suggestionConflict(base(), filler)).toBe(false);
    expect(suggestionConflict(cut(base(), 1_200, 1_600), filler)).toBe(true);
    // listening with context stays inside the recording
    expect(listenWindow(filler, 600_000)).toEqual([0, 3_400]);
    expect(listenWindow({ start_ms: 10_000, end_ms: 599_000 }, 600_000)).toEqual([8_000, 600_000]);
  });
});

// ------------------------------------------------------------------ corrections

describe("transcript corrections", () => {
  const words: StudioWord[] = [
    { w: "Kubernetes", s: 0, e: 500 },
    { w: "coobernetes", s: 600, e: 1_100 },
    { w: "rocks", s: 1_200, e: 1_500 },
  ];

  it("respells a word without touching a single millisecond", () => {
    const edits = addCorrection(base(), 1, "Kubernetes", "coobernetes");
    expect(edits.corrections).toEqual([{ word_id: "w1", text: "Kubernetes", original: "coobernetes" }]);
    const shown = correctedWord(words, edits.corrections);
    expect(shown.map((w) => w.w)).toEqual(["Kubernetes", "Kubernetes", "rocks"]);
    expect(shown[1]).toMatchObject({ id: "w1", s: 600, e: 1_100, original: "coobernetes" });
    expect(shown[0].original).toBeUndefined();
    expect(outputDurationMs(edits)).toBe(outputDurationMs(base()));
  });

  it("puts the original back, and typing the original back is the same thing", () => {
    const fixed = addCorrection(base(), 1, "Kubernetes", "coobernetes");
    expect(removeCorrection(fixed, "w1").corrections).toEqual([]);
    expect(removeCorrection(fixed, wordId(1)).corrections).toEqual([]);
    expect(addCorrection(fixed, 1, "coobernetes", "coobernetes").corrections).toEqual([]);
    expect(addCorrection(fixed, 1, "Kubernetes", "coobernetes")).toBe(fixed);
  });

  it("reads any vintage of file, including one with no corrections at all", () => {
    expect(normalizeEdits({}).corrections).toEqual([]);
    expect(normalizeCorrections([{ word_id: "w2", text: "rocks!" }, { word_id: "nope", text: "x" }, { word_id: "w2", text: "twice" }])).toEqual([
      { word_id: "w2", text: "rocks!", original: "" },
    ]);
  });

  it("snaps a dragged edge onto the gap between words", () => {
    expect(snapToWordGap(560, words, 120)).toBe(600);
    expect(snapToWordGap(700, words, 120)).toBe(600);
    expect(snapToWordGap(3_000, words, 120)).toBe(3_000);
  });
});

// -------------------------------------------------------------- save points back

describe("going back to a save point", () => {
  it("brings the old work forward without rewriting history", () => {
    const first = snapshotVersion(cut(base(60_000), 1_000, 2_000), "first pass", NOW);
    const current = cut(cut(first.edits, 10_000, 12_000), 20_000, 22_000);
    const restored = restoreVersion(current, first.edits, { n: 1, now: NOW });
    expect(restored.operations.map((o) => [o.start_ms, o.end_ms])).toEqual([[1_000, 2_000]]);
    expect(restored.version).toBe(current.version + 1);
    expect(restored.versions).toHaveLength(2);
    expect(restored.versions[1]).toMatchObject({ n: 2, file: "edits/versions/002.json", note: "restored v1" });
    // the snapshot and the record it came from are untouched
    expect(first.edits.versions).toHaveLength(1);
    expect(current.operations).toHaveLength(3);
    restored.operations.push({ id: "x", type: "cut", start_ms: 0, end_ms: 1, enabled: true });
    expect(first.edits.operations).toHaveLength(1);
  });
});

// ------------------------------------------------------------- editing proposal

const proposalSentences = [
  { text: "Welcome to the show.", start_ms: 0, end_ms: 2_000 },
  { text: "Let me set this up.", start_ms: 2_000, end_ms: 6_000 },
  { text: "Actually let me set this up again.", start_ms: 6_000, end_ms: 10_000 },
  { text: "Here is the real story.", start_ms: 10_000, end_ms: 20_000 },
  { text: "Anyway, back to my dog.", start_ms: 20_000, end_ms: 26_000 },
];

const proposalWords: StudioWord[] = [
  { w: "Welcome", s: 0, e: 900 },
  { w: "everyone", s: 1_000, e: 1_900 },
  { w: "setup", s: 2_000, e: 5_900 },
  { w: "again", s: 6_000, e: 9_900 },
  { w: "story", s: 10_000, e: 19_900 },
  { w: "dog", s: 20_000, e: 25_900 },
];

function fakeQuestion() {
  return {
    role: "",
    expectJson: false,
    instructions: [] as [string, string][],
    contexts: [] as string[],
    goals: [] as string[],
    questions: [] as string[],
    addInstruction(title: string, text: string) {
      this.instructions.push([title, text]);
    },
    addContext(context: string) {
      this.contexts.push(context);
    },
    addGoal(goal: string) {
      this.goals.push(goal);
    },
    addQuestion(text: string) {
      this.questions.push(text);
    },
  };
}

describe("the editing proposal", () => {
  it("asks for line numbers, never timestamps", () => {
    const q = buildProposalQuestion(fakeQuestion as unknown as () => ProposalQuestionLike, {
      goal: "cut the setup chatter",
      sentences: proposalSentences,
      mode: "balanced",
    }) as unknown as ReturnType<typeof fakeQuestion>;
    expect(q.expectJson).toBe(true);
    expect(q.role).toContain("editing assistant");
    const text = q.instructions.map(([title, body]) => `${title}: ${body}`).join("\n");
    expect(text).toContain("NEVER return timestamps");
    expect(text).toContain('"category"');
    expect(q.contexts.join("\n")).toContain("[s2] [0:06 - 0:10] Actually let me set this up again.");
    expect(q.goals[0]).toContain("cut the setup chatter");
    expect(q.questions[0]).toBe("cut the setup chatter");
  });

  it("turns line numbers into times, widens to whole words and keeps everything inside the recording", () => {
    const edits = base(26_000);
    const proposal = validateProposal(
      {
        items: [
          { sentences: [1, 2], action: "cut", reason: "restarts the same setup", category: "retake", confidence: 0.9 },
          { sentences: [4, 99], action: "cut", reason: "off on a tangent", category: "tangent", confidence: 0.8 },
          { words: { sentence: 3, from: 0, to: 0 }, action: "cut", reason: "false start", category: "setup", confidence: 0.6 },
          { sentences: [42], action: "cut", reason: "not a line", category: "other", confidence: 1 },
          { action: "cut", reason: "no ids at all", category: "other", confidence: 1 },
        ],
        target_minutes: 20,
        notes: "kept the story",
      },
      { sentences: proposalSentences, words: proposalWords, edits, durationMs: 26_000, id: "p01", prompt: "tighten it", mode: "balanced" }
    );
    expect(proposal.items.map((i) => [i.start_ms, i.end_ms])).toEqual([
      [2_000, 10_000],
      [10_000, 19_900],
    ]);
    expect(proposal.items[0]).toMatchObject({ id: "i01", category: "retake", saved_ms: 8_000, status: "open" });
    expect(proposal.dropped.map((d) => d.reason)).toEqual([
      "lines s4–s99 are not in this transcript",
      "lines s42–s42 are not in this transcript",
      "it did not say which lines to remove",
    ]);
    expect(proposal.target_minutes).toBe(20);
    expect(proposal.notes).toBe("kept the story");
    expect(proposal.schema_version).toBe(1);
  });

  it("merges overlapping suggestions; a stretch partly cut already stays, counting only what is left", () => {
    const edits = cut(base(26_000), 21_000, 22_000);
    const proposal = validateProposal(
      {
        items: [
          { sentences: [1, 2], action: "cut", reason: "setup", category: "setup", confidence: 0.9 },
          { sentences: [2, 2], action: "cut", reason: "same again", category: "retake", confidence: 0.5 },
          { sentences: [4, 4], action: "cut", reason: "tangent", category: "tangent", confidence: 0.9 },
        ],
      },
      { sentences: proposalSentences, words: proposalWords, edits, durationMs: 26_000, id: "p02" }
    );
    expect(proposal.items).toHaveLength(2);
    expect(proposal.items[0]).toMatchObject({ start_ms: 2_000, end_ms: 10_000, confidence: 0.5, saved_ms: 8_000 });
    // the tangent overlaps the producer's own 21-22s cut: it stays on the list
    // (badged in the panel) and only counts the 5s it would still remove
    expect(proposal.items[1]).toMatchObject({ start_ms: 20_000, end_ms: 26_000, saved_ms: 5_000, status: "open" });
    expect(proposal.dropped).toEqual([]);
    expect(proposal.totals.original_ms).toBe(25_000);
    expect(proposal.totals.removed_ms).toBe(13_000);
    expect(proposal.totals.proposed_ms).toBe(12_000);
  });

  it("leaves out only a stretch the producer's cuts already remove entirely", () => {
    const edits = cut(base(26_000), 19_000, 26_000);
    const proposal = validateProposal(
      { items: [{ sentences: [4, 4], action: "cut", reason: "tangent", category: "tangent", confidence: 0.9 }] },
      { sentences: proposalSentences, words: proposalWords, edits, durationMs: 26_000, id: "p03" }
    );
    expect(proposal.items).toEqual([]);
    expect(proposal.dropped).toEqual([{ ref: "0:20–0:26", reason: "already removed by your edits" }]);
    expect(proposal.totals.removed_ms).toBe(0);
  });

  it("takes one, gives it back, takes every safe one and can be thrown away whole", () => {
    const edits = base(26_000);
    const proposal: EditProposal = validateProposal(
      {
        items: [
          { sentences: [1, 2], action: "cut", reason: "setup", category: "setup", confidence: 0.9 },
          { sentences: [4, 4], action: "cut", reason: "maybe?", category: "other", confidence: 0.95 },
          { sentences: [3, 3], action: "cut", reason: "unsure", category: "tangent", confidence: 0.4 },
        ],
      },
      { sentences: proposalSentences, words: proposalWords, edits, durationMs: 26_000, id: "p03" }
    );
    // ids follow the order they run in: setup cut, unsure tangent, then the "other" one
    expect(proposal.items.map((i) => [i.id, i.category, i.confidence])).toEqual([
      ["i01", "setup", 0.9],
      ["i02", "tangent", 0.4],
      ["i03", "other", 0.95],
    ]);

    const one = applyProposalItem(edits, proposal, "i01");
    expect(one.applied).toBe(1);
    expect(one.edits.operations[0].source).toBe("proposal:p03/i01");
    expect(one.proposal.items[0].status).toBe("applied");
    expect(applyProposalItem(one.edits, one.proposal, "i01").applied).toBe(0);

    const back = rejectProposalItem(one.edits, one.proposal, "i01");
    expect(back.edits.operations).toHaveLength(0);
    expect(back.proposal.items[0].status).toBe("rejected");

    // only what the assistant is sure about, and never the "other" pile
    const safe = applySafeProposalItems(edits, proposal);
    expect(safe.applied).toBe(1);
    expect(safe.edits.operations.map((o) => o.source)).toEqual(["proposal:p03/i01"]);
    expect(safe.proposal.totals.proposed_ms).toBe(proposalTotals(safe.edits, safe.proposal.items).proposed_ms);

    expect(discardProposal(safe.edits, "p03").operations).toHaveLength(0);
    // the producer's own instructions survive the discard
    const mixed = addOperation(safe.edits, { type: "mute", start_ms: 100, end_ms: 200 });
    expect(discardProposal(mixed, "p03").operations.map((o) => o.type)).toEqual(["mute"]);
  });

  it("skips a safe item that has come to overlap an edit made since", () => {
    const edits = base(26_000);
    const proposal = validateProposal(
      { items: [{ sentences: [1, 2], action: "cut", reason: "setup", category: "setup", confidence: 0.9 }] },
      { sentences: proposalSentences, words: proposalWords, edits, durationMs: 26_000, id: "p04" }
    );
    const later = cut(edits, 3_000, 4_000);
    const safe = applySafeProposalItems(later, proposal);
    expect(safe).toMatchObject({ applied: 0, skipped_conflict: 1 });
    expect(safe.edits.operations).toHaveLength(1);
  });
});

// ------------------------------------------------------- saving and reloading

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Write {
  path: string;
  value: EpisodeEdits;
}

describe("saving the producer's work", () => {
  beforeEach(() => {
    resetSaveState();
    setStudioWriter(null);
    vi.mocked(engine.readJsonStrict).mockReset();
    vi.mocked(engine.readJsonStrict).mockResolvedValue({ ok: false, missing: true, error: "" });
  });

  it("writes one at a time, folds a change made mid-save into the next write and answers everyone in order", async () => {
    const writes: Write[] = [];
    const gates: (() => void)[] = [];
    setStudioWriter((path, value) => {
      writes.push({ path, value: value as EpisodeEdits });
      return new Promise<void>((resolve) => gates.push(resolve));
    });
    const a = base(60_000);
    const b = cut(a, 1_000, 2_000);
    const c = cut(b, 5_000, 6_000);
    const order: string[] = [];

    const first = saveEpisodeEdits("ep", a).then((saved) => {
      order.push("first");
      return saved;
    });
    await tick();
    expect(writes).toHaveLength(1);
    expect(getSaveState("ep").saving).toBe(true);

    // two more changes while the first write is still in the air
    const second = saveEpisodeEdits("ep", b).then((saved) => {
      order.push("second");
      return saved;
    });
    const third = saveEpisodeEdits("ep", c).then((saved) => {
      order.push("third");
      return saved;
    });
    await tick();
    expect(writes).toHaveLength(1);
    expect(getSaveState("ep").queued).toBe(true);

    gates[0]();
    await first;
    await tick();
    // exactly one more write, holding the NEWEST work — the middle state is never written
    expect(writes).toHaveLength(2);
    expect(writes[1].value.operations).toHaveLength(2);
    gates[1]();
    const [, secondSaved, thirdSaved] = [await first, await second, await third];
    expect(order).toEqual(["first", "second", "third"]);
    expect(secondSaved).toBe(thirdSaved);
    expect(writes.map((w) => w.path)).toEqual([editsPath("ep"), editsPath("ep")]);
    expect(writes[0].value.version).toBe(2);
    await flushSaves("ep");
    expect(getSaveState("ep").saving).toBe(false);

    // "saved" means exactly this work reached the file — not an earlier version of it
    expect(isSaved("ep", c)).toBe(true);
    expect(isSaved("ep", thirdSaved)).toBe(true);
    expect(isSaved("ep", a)).toBe(false);
    expect(editsSignature(thirdSaved)).toBe(editsSignature(c));
  });

  it("stays unsaved when the write fails, and recovers on the next one", async () => {
    let fail = true;
    const writes: Write[] = [];
    setStudioWriter(async (path, value) => {
      if (fail) throw new Error("the connection went away");
      writes.push({ path, value: value as EpisodeEdits });
    });
    const edits = cut(base(60_000), 1_000, 2_000);
    await expect(saveEpisodeEdits("ep2", edits)).rejects.toThrow("the connection went away");
    expect(getSaveState("ep2").error).toBe("the connection went away");
    expect(getSaveState("ep2").saved).toBeNull();
    expect(isSaved("ep2", edits)).toBe(false);

    fail = false;
    const saved = await saveEpisodeEdits("ep2", edits);
    expect(writes).toHaveLength(1);
    expect(getSaveState("ep2").error).toBeNull();
    expect(isSaved("ep2", edits)).toBe(true);
    expect(saved.version).toBe(edits.version + 1);
  });

  it("never treats a broken read as an empty episode, and picks the work up again on a retry", async () => {
    const timeline = { words: [{ w: "hello", s: 0, e: 500 }], duration_ms: 60_000, silences: [], quiet: [], low_confidence: [] };
    const saved = cut(base(60_000), 1_000, 2_000);
    vi.mocked(engine.readJsonStrict).mockImplementation(async (path: string) => {
      if (path.endsWith("timeline.json")) return { ok: true as const, value: timeline };
      if (path.endsWith("episode-edits.json")) return { ok: false as const, missing: false, error: "read failed" };
      return { ok: false as const, missing: true, error: "" };
    });
    const failed = await loadStudio("ep3");
    expect(failed.failed).toBe(true);
    expect(failed.failedFiles).toEqual(["edits"]);
    expect(failed.files.edits).toMatchObject({ failed: true, missing: false });
    expect(failed.edits).toBeNull();
    expect(failed.error).toBe("read failed");
    expect(failed.durationMs).toBe(60_000);
    expect(failed.blank.operations).toEqual([]);

    vi.mocked(engine.readJsonStrict).mockImplementation(async (path: string) => {
      if (path.endsWith("timeline.json")) return { ok: true as const, value: timeline };
      if (path.endsWith("episode-edits.json")) return { ok: true as const, value: saved };
      return { ok: false as const, missing: true, error: "" };
    });
    const again = await loadStudio("ep3");
    expect(again.failed).toBe(false);
    expect(again.edits?.operations).toHaveLength(1);

    // a brand-new episode is missing, not failed: a blank record is fine here
    vi.mocked(engine.readJsonStrict).mockResolvedValue({ ok: false, missing: true, error: "" });
    const fresh = await loadStudio("ep4");
    expect(fresh.failed).toBe(false);
    expect(fresh.edits).toBeNull();
    expect(fresh.files.edits.missing).toBe(true);
  });

  it("opens a save point and brings it back as the next revision", async () => {
    const snapshot = snapshotVersion(cut(base(60_000), 1_000, 2_000), "first pass", NOW).edits;
    vi.mocked(engine.readJsonStrict).mockImplementation(async (path: string) =>
      path.endsWith("edits/versions/001.json") ? { ok: true as const, value: snapshot } : { ok: false as const, missing: true, error: "" }
    );
    expect((await loadVersion("ep5", 1))?.operations).toHaveLength(1);
    expect(await loadVersion("ep5", 9)).toBeNull();

    const writes: Write[] = [];
    setStudioWriter(async (path, value) => {
      writes.push({ path, value: value as EpisodeEdits });
    });
    const current = cut(cut(snapshot, 10_000, 11_000), 20_000, 21_000);
    const restored = await restoreEpisodeVersion("ep5", current, 1);
    expect(restored.operations).toHaveLength(1);
    expect(restored.version).toBe(current.version + 1);
    expect(writes.map((w) => w.path)).toEqual([`projects/ep5/edits/versions/002.json`, editsPath("ep5")]);
    // the save point that was restored from is never rewritten
    expect(writes.some((w) => w.path.endsWith("001.json"))).toBe(false);
  });
});
