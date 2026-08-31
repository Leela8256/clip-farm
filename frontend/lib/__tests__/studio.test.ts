import { describe, expect, it } from "vitest";
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
  type EpisodeEdits,
  type Suggestion,
  type StudioWord,
} from "../studio";

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
    expect(applyAll(rejected, suggestions, "tight").operations.map((o) => o.source)).toEqual(["suggestion:p002", "suggestion:q003"]);
  });

  it("applies everything for a level once and only once", () => {
    const once = applyAll(base(), suggestions, "balanced");
    expect(once.operations).toHaveLength(2);
    expect(once.suggestions.mode).toBe("balanced");
    const twice = applyAll(once, suggestions, "balanced");
    expect(twice.operations).toHaveLength(2);
    expect(twice.suggestions.accepted).toEqual(["f001", "p002"]);
  });

  it("skips a suggestion that lands on an instruction already there", () => {
    const edits = applyAll(cut(base(), 900, 2_000), suggestions, "natural");
    expect(edits.operations).toHaveLength(1);
    expect(suggestionState(edits, suggestions[0])).toBe("open");
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
