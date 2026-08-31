"use client";

/**
 * Shared, purely presentational helpers for the editing screens: turning the
 * word timings + transcript into editable lines, working out which words a
 * change covers, and the live progress of a background job.
 */

import { useCallback, useSyncExternalStore } from "react";
import { getRun, subscribeRun, type RunState } from "@/lib/engine";
import type { Sentence, StatusEvent } from "@/lib/podcast";
import { fmtDuration, type ApplyAllResult, type EpisodeEdits, type Operation, type StudioWord, type Suggestion } from "@/lib/studio";

export interface EditorWord {
  /** position in the flat word list — the unit of selection */
  i: number;
  /** place in the recording's own word list (-1 when the line had no word timings) */
  k: number;
  text: string;
  s: number;
  e: number;
}

export interface EditorRow {
  i: number;
  start_ms: number;
  end_ms: number;
  text: string;
  words: EditorWord[];
}

export interface Transcript {
  rows: EditorRow[];
  words: EditorWord[];
}

const clean = (w: string) => w.replace(/\s+/g, " ").trim();

/** Split a sentence with no word timings into evenly spaced pseudo-words. */
function spread(text: string, start: number, end: number, from: number): EditorWord[] {
  const parts = text.split(/\s+/).filter(Boolean);
  const span = Math.max(1, end - start);
  return parts.map((p, k) => ({
    i: from + k,
    k: -1,
    text: p,
    s: Math.round(start + (span * k) / parts.length),
    e: Math.round(start + (span * (k + 1)) / parts.length),
  }));
}

/**
 * The editable lines: one per transcript sentence, filled with the word timings
 * that fall inside it. Recordings without sentences fall back to fixed-size
 * lines; sentences without word timings get evenly spaced words so a selection
 * still points at real time.
 */
export function buildTranscript(words: StudioWord[], sentences: Sentence[]): Transcript {
  const flat: EditorWord[] = [];
  const rows: EditorRow[] = [];
  const src = words ?? [];

  if (sentences.length) {
    let p = 0;
    for (const sentence of sentences) {
      while (p < src.length && src[p].e <= sentence.start_ms) p++;
      const picked: EditorWord[] = [];
      let q = p;
      while (q < src.length && src[q].s < sentence.end_ms) {
        const w = clean(src[q].w);
        if (w) picked.push({ i: flat.length + picked.length, k: q, text: w, s: src[q].s, e: Math.max(src[q].e, src[q].s + 1) });
        q++;
      }
      p = q;
      const line = picked.length ? picked : spread(sentence.text, sentence.start_ms, sentence.end_ms, flat.length);
      if (!line.length) continue;
      flat.push(...line);
      rows.push({
        i: rows.length,
        start_ms: line[0].s,
        end_ms: line[line.length - 1].e,
        text: sentence.text || line.map((w) => w.text).join(" "),
        words: line,
      });
    }
    if (rows.length) return { rows, words: flat };
  }

  // no sentences (or none matched): group the words into readable lines
  let line: EditorWord[] = [];
  const flush = () => {
    if (!line.length) return;
    flat.push(...line);
    rows.push({ i: rows.length, start_ms: line[0].s, end_ms: line[line.length - 1].e, text: line.map((w) => w.text).join(" "), words: line });
    line = [];
  };
  for (let k = 0; k < src.length; k++) {
    const raw = src[k];
    const text = clean(raw.w);
    if (!text) continue;
    const prev = line[line.length - 1];
    if (prev && (raw.s - prev.e > 700 || line.length >= 22)) flush();
    line.push({ i: flat.length + line.length, k, text, s: raw.s, e: Math.max(raw.e, raw.s + 1) });
  }
  flush();
  return { rows, words: flat };
}

export interface WordMark {
  cut?: string;
  mute?: string;
  bleep?: string;
  tight?: string;
}

export interface Marks {
  /** word index → the change covering it */
  byWord: Map<number, WordMark>;
  /** word index → the change that starts there (the restore affordance sits before it) */
  starts: Map<number, Operation>;
}

const active = (op: Operation) => op.enabled !== false;

/** Which words each change covers, so the line can strike them through or underline them. */
export function markWords(words: EditorWord[], operations: Operation[]): Marks {
  const byWord = new Map<number, WordMark>();
  const starts = new Map<number, Operation>();
  if (!words.length) return { byWord, starts };
  const key = { cut: "cut", mute: "mute", bleep: "bleep", shorten_silence: "tight" } as const;
  for (const op of operations) {
    if (!active(op)) continue;
    let first = -1;
    // words are ordered, so a linear scan bounded by the range is cheap enough per change
    let lo = 0;
    let hi = words.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].e <= op.start_ms) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < words.length && words[i].s < op.end_ms; i++) {
      if (words[i].e <= op.start_ms) continue;
      const mark = byWord.get(i) ?? {};
      mark[key[op.type]] = op.id;
      byWord.set(i, mark);
      if (first < 0) first = i;
    }
    if (first >= 0 && !starts.has(first)) starts.set(first, op);
  }
  return { byWord, starts };
}

/** The line a time falls on (or the last one before it) — for highlight + scrolling. */
export function rowAt(rows: EditorRow[], ms: number): number {
  if (!rows.length) return -1;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid].start_ms <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Plain-language names for the kinds of change a suggestion asks for. */
export const ACTION_LABELS: Record<string, string> = {
  cut: "Remove",
  mute: "Silence",
  bleep: "Bleep",
  shorten_silence: "Shorten",
};

/** The change a suggestion created, if it was accepted. */
export function operationFor(edits: EpisodeEdits, suggestion: Suggestion): Operation | null {
  return edits.operations.find((op) => op.source === `suggestion:${suggestion.id}`) ?? null;
}

/* ---- live progress of a background job ------------------------------------ */

const snaps = new Map<string, { stamp: string; run: RunState }>();

function snapshot(key: string): RunState | undefined {
  const run = getRun(key);
  if (!run) return undefined;
  const stamp = `${run.events.length}|${run.done}|${run.error ?? ""}|${run.lost ?? false}|${run.started}`;
  const held = snaps.get(key);
  if (!held || held.stamp !== stamp) snaps.set(key, { stamp, run: { ...run } });
  return snaps.get(key)!.run;
}

const serverRun = () => undefined;

/** Follow a job started with startRun() without re-rendering on every tick. */
export function useJob(key: string): RunState | undefined {
  const subscribe = useCallback((fn: () => void) => subscribeRun(key, fn), [key]);
  const read = useCallback(() => snapshot(key), [key]);
  return useSyncExternalStore(subscribe, read, serverRun);
}

/* ---- plain-language progress ---------------------------------------------- */

const num = (evt: StatusEvent, key: string) => (typeof evt[key] === "number" ? (evt[key] as number) : undefined);

/** What a background job is doing, in words a producer would use. */
export function studioProgress(evt: StatusEvent | null | undefined): string {
  if (!evt) return "Getting started…";
  if (evt.stage === "error") return `It stopped: ${evt.message ?? "something went wrong"}`;
  switch (evt.stage) {
    case "studio_aligning": {
      const piece = num(evt, "piece");
      const pieces = num(evt, "pieces");
      return piece != null && pieces ? `Lining up the words · part ${piece} of ${pieces}` : "Lining up the words with the recording";
    }
    case "studio_suggesting":
      return "Looking for things worth tidying";
    case "studio_ready":
      return `Ready to edit · ${num(evt, "words") ?? 0} words`;
    case "preparing":
      return "Working out the edit";
    case "studio_prepared":
      return "Edit worked out";
    case "rendering": {
      const part = num(evt, "part");
      const parts = num(evt, "parts");
      return part != null && parts ? `Putting the episode together · part ${part} of ${parts}` : "Putting the episode together";
    }
    case "mastering":
      return "Finishing the sound";
    case "rendered":
      return `Done${num(evt, "seconds") ? ` in ${Math.round(num(evt, "seconds")!)}s` : ""}`;
    case "probing":
      return "Reading the recording";
    default:
      return typeof evt.message === "string" && evt.message ? evt.message : "Working…";
  }
}

export const INIT_STEPS: { stages: string[]; label: string }[] = [
  { stages: ["probing", "studio_aligning"], label: "Lining up the words" },
  { stages: ["studio_suggesting"], label: "Finding things to tidy" },
  { stages: ["studio_ready"], label: "Ready to edit" },
];

/** How far through the setup the job is (0-based; -1 before it starts). */
export function initStep(evt: StatusEvent | null | undefined): number {
  if (!evt) return 0;
  const i = INIT_STEPS.findIndex((s) => s.stages.includes(evt.stage));
  return i < 0 ? 0 : i;
}

/* ---- plain-language labels for the editing screens ------------------------ */

/** What "apply all" actually did, in a producer's words. */
export function applySummary(result: ApplyAllResult): string {
  const bits = [`${result.applied} applied`];
  if (result.skipped_conflict) bits.push(`${result.skipped_conflict} skipped (they overlap an edit)`);
  if (result.review_only) bits.push(`${result.review_only} need a listen`);
  if (result.already_accepted) bits.push(`${result.already_accepted} were already in`);
  if (result.saved_ms > 1000) bits.push(`${fmtDuration(result.saved_ms)} saved`);
  return bits.join(" · ");
}

/** Why a drafted change was suggested, grouped the way a producer thinks about it. */
export const CATEGORY_LABELS: Record<string, string> = {
  setup: "Getting started",
  retake: "Second takes",
  repetition: "Said twice",
  pause: "Long pauses",
  tangent: "Off the point",
  other: "Other",
};
