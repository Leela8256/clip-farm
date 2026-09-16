/**
 * Clip selection — hard constraints first, quality ranking second.
 *
 * This is the browser's half of what used to be the `podcast_refine` node: the
 * LLM's raw answers reach the page on the answers lane, and everything the
 * node did with them happens here instead — tolerant parsing, snapping to
 * sentence boundaries, the length and overlap rules, the hard constraints of a
 * Prompt Director request (speaker, subject, exclusions, duration window,
 * complete thoughts) and the two weighted rankings. The files it produces
 * (analysis/candidates.json, chapters.json, analysis/requests/<rNN>.json) keep
 * exactly the shape the nodes, the CLI and the pages already read.
 *
 * `local_nodes/podcast_common/constraints.py` + `clips.py` are the twin: same
 * weights, same penalty, same thresholds, same wording of every rejection —
 * `lib/__tests__/refine.test.ts` mirrors the python tests case for case. Change
 * one, change the other.
 *
 * No SDK imports (unit-tested), and no runtime imports at all: the spec
 * normalisation lives in lib/director.ts and reaches the directed pass as
 * arguments, so this module stays the single source of truth for the ranking
 * numbers without a cycle.
 */

import type { Chapter } from "./podcast";
import type { DurationWindow, RejectedCandidate, RequestCompliance, RequestSpec } from "./director";

// ------------------------------------------------------------------ numbers

/** Episode analysis ranking (clips.SCORE_WEIGHTS). */
export const SCORE_WEIGHTS: Record<string, number> = { hook: 0.4, standalone: 0.3, clarity: 0.3 };

/** What each analysis score means (the `scoring.axes` block of candidates.json). */
export const ANALYSIS_AXES: Record<string, string> = {
  hook: "Would the first three seconds stop a scroll?",
  clarity: "Is the point easy to follow with no visuals?",
  standalone: "Does it work with zero episode context?",
};

/** Prompt Director ranking (constraints.DIRECTOR_WEIGHTS). */
export const DIRECTOR_WEIGHTS: Record<string, number> = { prompt_match: 0.35, hook: 0.25, standalone: 0.2, clarity: 0.1, energy: 0.1 };

export const DIRECTOR_AXES: Record<string, string> = {
  prompt_match: "How well the moment answers the producer’s direction (subject, tone, hook, ending).",
  hook: "Would the first three seconds stop a scroll?",
  standalone: "Does it work with zero episode context?",
  clarity: "Is the point easy to follow with no visuals?",
  energy: "Vocal and visual energy: pace, emphasis, emotion.",
};

/** Score points lost per second outside the tolerance window (natural mode only). */
export const DURATION_PENALTY_PER_S = 0.15;
export const MAX_DURATION_PENALTY = 2.0;
/** A candidate overlapping a better one by more than this share of its own length is dropped. */
export const OVERLAP_LIMIT = 0.4;
/** Chapters proposed closer together than this are the same chapter seen twice. */
export const CHAPTER_MIN_GAP_MS = 60_000;

/**
 * The limits the podcast_refine node carried in its pipeline config. They are
 * the defaults the project's own settings override, and they must stay these
 * numbers: the request files already on disk were written with them.
 */
export const REFINE_DEFAULTS = { candidates: 10, min_seconds: 20, max_seconds: 90, target_seconds: 45 };

/**
 * The name every status.json line and progress event from this step carries.
 * It is the identity readers already know (the screens key their "analysed"
 * state off it), so it stays stable even though the node is gone.
 */
export const REFINE_NODE = "podcast_refine";

export const PROFANITY = new Set([
  "fuck", "fucking", "fucked", "fucker", "motherfucker", "shit", "shitty", "bullshit", "asshole", "bitch", "bastard",
  "damn", "goddamn", "crap", "dick", "cunt", "piss", "pissed", "wanker", "bollocks", "arsehole", "prick", "slut", "whore",
]);

// -------------------------------------------------------------------- shapes

export interface RefineSentence {
  id?: number;
  text?: string;
  start_ms: number;
  end_ms: number;
}

export interface CandidateCompliance {
  ok: boolean;
  rejected_for: string[];
  duration_requested: number;
  duration_planned: number;
  duration_ok: boolean;
  speaker_match: boolean | null;
  required_topic_found: boolean | null;
  excluded_subject_found: boolean;
  profanity_found: boolean;
  profane_words: string[];
  complete_ending: boolean;
  warnings: string[];
}

/** A candidate as it travels through selection and lands in the written file. */
export interface RefinedCandidate {
  start_ms: number;
  end_ms: number;
  title: string;
  hook: string;
  reason: string;
  quote: string;
  takeaway?: string;
  speaker?: string | null;
  speaker_evidence?: string;
  topic_found?: boolean | null;
  excluded_found?: boolean | null;
  complete_ending?: boolean | null;
  scores: Record<string, number>;
  score?: number;
  proposed?: { start_ms: number; end_ms: number };
  duration_ms?: number;
  text?: string;
  compliance?: CandidateCompliance;
  id?: string;
  rank?: number;
  request_id?: string;
  sentence_ids?: number[];
  rejected_for?: string[];
}

/** One file the caller must write, in the order the node wrote them. */
export interface RefineWrite {
  path: string;
  value: unknown;
}

/** The `update_status()` line this step used to push (status.json + the progress event). */
export interface RefineStatus {
  stage: string;
  data: Record<string, unknown>;
}

// ------------------------------------------------------------------ coercion

/**
 * python's `round(value, digits)`, which is what every score, duration and
 * spec number in the twin goes through. `Math.round(x * 100) / 100` is a
 * different function: scaling by 100 can carry a value across the boundary
 * (2.9249999… becomes exactly 292.5 and rounds up), and an exact tie goes to
 * the even digit in python and away from zero in JS. A cent of a score is
 * enough to reorder two clips, so this rounds the value's own decimal
 * expansion, half to even.
 */
export function pyRound(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;
  const decimals = value.toFixed(Math.min(20, digits + 18));
  const negative = decimals.startsWith("-");
  const [whole, fraction = ""] = (negative ? decimals.slice(1) : decimals).split(".");
  const keep = fraction.slice(0, digits).padEnd(digits, "0");
  const rest = fraction.slice(digits).replace(/0+$/, "");
  let up = false;
  if (rest) {
    if (rest[0] > "5") up = true;
    else if (rest[0] === "5") up = rest.length > 1 || Number(keep[digits - 1] ?? whole[whole.length - 1] ?? "0") % 2 === 1;
  }
  const scaled = Number(whole + keep) + (up ? 1 : 0);
  const out = scaled / 10 ** digits;
  return negative ? -out : out;
}

const round1 = (n: number) => pyRound(n, 1);
const round2 = (n: number) => pyRound(n, 2);

/** python's `%g` for the numbers that end up in a rejection sentence. */
const g = (n: number) => String(Number(n.toPrecision(6)));

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** `item.get(key, item.get(other))` — the alternative is used only when the key is absent. */
function pick(item: Record<string, unknown>, key: string, other: string): unknown {
  return key in item ? item[key] : item[other];
}

/** `str(value or '').strip()[:limit]` */
function text(value: unknown, limit: number): string {
  return (value ? String(value) : "").trim().slice(0, limit);
}

/** A tri-state flag as the model may have written it; anything unclear is "not asserted". */
export function asFlag(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value == null) return null;
  const t = String(value).trim().toLowerCase();
  if (t === "true" || t === "yes" || t === "1") return true;
  if (t === "false" || t === "no" || t === "0") return false;
  return null;
}

/** Milliseconds from an int/float/digit-string, or `mm:ss` / `h:mm:ss[.fff]`. */
export function parseTimestamp(value: unknown): number | null {
  if (value == null || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  const t = String(value).trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\s*$/.exec(t);
  if (!m) return null;
  const hours = parseInt(m[1] ?? "0", 10);
  const frac = m[4] ?? "";
  return ((hours * 60 + parseInt(m[2], 10)) * 60 + parseInt(m[3], 10)) * 1000 + (frac ? parseInt(frac.padEnd(3, "0"), 10) : 0);
}

/** The parsed JSON of one answer, or a tolerant parse of raw text (fenced or embedded). */
export function parseJsonPayload(answer: unknown): unknown {
  if (typeof answer !== "string") return answer;
  let body = answer.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(body);
  if (fence) body = fence[1].trim();
  try {
    return JSON.parse(body);
  } catch {
    const match = /(\{[\s\S]*\}|\[[\s\S]*\])/.exec(body);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }
}

/** `float(value)`, or the fallback where python's float() would have raised. */
function asNumber(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  const n = typeof value === "number" ? value : typeof value === "boolean" ? (value ? 1 : 0) : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** A model's score clamped to 0-10 with one decimal; anything unreadable scores 5. */
export function clampScore(value: unknown, fallback = 5): number {
  const n = asNumber(value, NaN);
  return Number.isFinite(n) ? Math.max(0, Math.min(10, round1(n))) : fallback;
}

/**
 * CPython's `sum()` over floats: Neumaier compensated summation, not a plain
 * accumulation. The difference is one ulp, which is exactly enough to move a
 * rounded score by a cent and reorder two clips — the twin's scores are the
 * ones already written into every request file on disk.
 */
function fsum(values: number[]): number {
  let sum = 0;
  let carry = 0;
  for (const x of values) {
    const t = sum + x;
    carry += Math.abs(sum) >= Math.abs(x) ? sum - t + x : x - t + sum;
    sum = t;
  }
  return sum + carry;
}

/** The weighted average behind a score, unrounded (missing components count as 5). */
function weighted(scores: unknown, weights: Record<string, number>): number {
  const rec = isRecord(scores) ? scores : {};
  const total = fsum(Object.values(weights)) || 1;
  return fsum(Object.entries(weights).map(([key, weight]) => asNumber(rec[key], 5) * weight)) / total;
}

/** The overall score for a set of component scores (clips.overall_score). */
export function weightedScore(scores: unknown, weights: Record<string, number> = SCORE_WEIGHTS): number {
  return round2(weighted(scores, weights));
}

// ------------------------------------------------------------- LLM answers

/** Distinct profane words in the text, in order of appearance. */
export function findProfanity(value: string): string[] {
  const found: string[] = [];
  for (const token of (value || "").toLowerCase().match(/[a-z']+/g) ?? []) {
    const clean = token.replace(/^'+|'+$/g, "");
    if (PROFANITY.has(clean) && !found.includes(clean)) found.push(clean);
  }
  return found;
}

function answerItems(payload: unknown): unknown[] {
  const data = parseJsonPayload(payload);
  const items = isRecord(data) ? data.candidates || data.clips || [] : data;
  return Array.isArray(items) ? items : [];
}

/** One episode-analysis answer → candidate dicts; malformed entries are dropped, not fatal. */
export function parseCandidateAnswer(payload: unknown): RefinedCandidate[] {
  const out: RefinedCandidate[] = [];
  for (const raw of answerItems(payload)) {
    if (!isRecord(raw)) continue;
    const start = parseTimestamp(pick(raw, "start_ms", "start"));
    const end = parseTimestamp(pick(raw, "end_ms", "end"));
    if (start == null || end == null || end <= start) continue;
    const rawScores = isRecord(raw.scores) ? raw.scores : {};
    const fallback = raw.score;
    const scores = {
      hook: clampScore("hook" in rawScores ? rawScores.hook : fallback),
      clarity: clampScore("clarity" in rawScores ? rawScores.clarity : fallback),
      standalone: clampScore("standalone" in rawScores ? rawScores.standalone : fallback),
    };
    out.push({
      start_ms: start,
      end_ms: end,
      title: text(raw.title, 120),
      hook: text(raw.hook, 200),
      reason: text(raw.reason || raw.why, 600),
      quote: text(raw.quote, 400),
      scores,
      score: weightedScore(scores, SCORE_WEIGHTS),
    });
  }
  return out;
}

/**
 * One directed answer → candidate dicts. The same tolerant parsing plus the
 * director-specific fields: prompt match / energy, the speaker the model
 * believes is talking (with its evidence) and the compliance flags it was
 * asked to assert.
 */
export function parseDirectorAnswer(payload: unknown): RefinedCandidate[] {
  const out: RefinedCandidate[] = [];
  for (const raw of answerItems(payload)) {
    if (!isRecord(raw)) continue;
    const start = parseTimestamp(pick(raw, "start_ms", "start"));
    const end = parseTimestamp(pick(raw, "end_ms", "end"));
    if (start == null || end == null || end <= start) continue;
    const rawScores = isRecord(raw.scores) ? raw.scores : {};
    const scores: Record<string, number> = {};
    for (const key of Object.keys(DIRECTOR_WEIGHTS)) scores[key] = clampScore(key in rawScores ? rawScores[key] : raw[key]);
    out.push({
      start_ms: start,
      end_ms: end,
      title: text(raw.title, 120),
      hook: text(raw.hook, 200),
      reason: text(raw.reason || raw.why, 600),
      quote: text(raw.quote, 400),
      takeaway: text(raw.takeaway || raw.ending, 300),
      speaker: text(raw.speaker, 60) || null,
      speaker_evidence: text(raw.speaker_evidence, 200),
      topic_found: asFlag(pick(raw, "topic_found", "required_topic_found")),
      excluded_found: asFlag(pick(raw, "excluded_found", "excluded_subject_found")),
      complete_ending: asFlag(raw.complete_ending),
      scores,
    });
  }
  return out;
}

export interface ParsedChapter {
  start_ms: number;
  title: string;
}

export function parseChapters(payload: unknown): ParsedChapter[] {
  const data = parseJsonPayload(payload);
  const items = isRecord(data) ? data.chapters : null;
  if (!Array.isArray(items)) return [];
  const out: ParsedChapter[] = [];
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const start = parseTimestamp(pick(raw, "start_ms", "start"));
    const title = text(raw.title, 120);
    if (start != null && title) out.push({ start_ms: start, title });
  }
  return out;
}

/** Dedupe chapters proposed by overlapping parts (first wins inside the gap) and add end times. */
export function mergeChapters(chapters: ParsedChapter[], durationMs: number, minGapMs = CHAPTER_MIN_GAP_MS): Chapter[] {
  const merged: { start_ms: number; title: string }[] = [];
  for (const ch of [...chapters].sort((a, b) => a.start_ms - b.start_ms)) {
    const last = merged[merged.length - 1];
    if (last && ch.start_ms - last.start_ms < minGapMs) continue;
    merged.push({ start_ms: ch.start_ms, title: ch.title });
  }
  return merged.map((ch, i) => ({
    ...ch,
    end_ms: i + 1 < merged.length ? merged[i + 1].start_ms : durationMs,
    id: `ch${String(i + 1).padStart(2, "0")}`,
  }));
}

// -------------------------------------------------------------- transcript

/** The transcript under a window, as one quote. */
export function quoteFor(sentences: RefineSentence[], startMs: number, endMs: number, maxChars = 320): string {
  const joined = sentences
    .filter((s) => s.start_ms < endMs && s.end_ms > startMs)
    .map((s) => (s.text ?? "").trim())
    .join(" ");
  return joined.slice(0, maxChars).replace(/\s+$/, "") + (joined.length > maxChars ? "…" : "");
}

/** Move a window onto the nearest sentence start / sentence end. */
export function snapToSentences(startMs: number, endMs: number, sentences: RefineSentence[]): [number, number] {
  if (!sentences.length) return [startMs, endMs];
  const ordered = [...sentences].sort((a, b) => a.start_ms - b.start_ms);
  let first = ordered[0];
  let last = ordered[0];
  for (const s of ordered) {
    if (Math.abs(s.start_ms - startMs) < Math.abs(first.start_ms - startMs)) first = s;
    if (Math.abs(s.end_ms - endMs) < Math.abs(last.end_ms - endMs)) last = s;
  }
  return [first.start_ms, Math.max(last.end_ms, first.end_ms)];
}

/** Sentence ids a clip covers. */
export function sentenceIds(sentences: RefineSentence[], startMs: number, endMs: number): number[] {
  return sentences.filter((s) => s.start_ms < endMs && s.end_ms > startMs).map((s) => s.id as number);
}

const overlapMs = (a: { start_ms: number; end_ms: number }, b: { start_ms: number; end_ms: number }) =>
  Math.max(0, Math.min(a.end_ms, b.end_ms) - Math.max(a.start_ms, b.start_ms));

/** The last sentence end inside `limit`, so a long clip is trimmed back and never cut mid-sentence. */
function sentenceEndWithin(sentences: RefineSentence[], startMs: number, limit: number): number | null {
  let best: number | null = null;
  for (const s of sentences) if (s.end_ms > startMs && s.end_ms <= limit && (best == null || s.end_ms > best)) best = s.end_ms;
  return best;
}

/**
 * Clamp to the episode, drop clips that are too short, trim ones that run too
 * long (back to a sentence end when the transcript is given), dedupe heavy
 * overlaps (highest score wins) and return the top N, best first.
 */
export function validateCandidates(
  candidates: RefinedCandidate[],
  totalDurationMs: number,
  minMs: number,
  maxMs: number,
  maxCount: number,
  sentences: RefineSentence[] = []
): RefinedCandidate[] {
  const cleaned: RefinedCandidate[] = [];
  for (const cand of candidates) {
    const start = Math.max(0, Math.trunc(cand.start_ms));
    let end = totalDurationMs ? Math.min(Math.trunc(totalDurationMs), Math.trunc(cand.end_ms)) : Math.trunc(cand.end_ms);
    if (end - start > maxMs) {
      const limit = start + maxMs;
      end = sentenceEndWithin(sentences, start, limit) ?? limit;
    }
    if (end - start < minMs) continue;
    cleaned.push({ ...cand, start_ms: start, end_ms: end, duration_ms: end - start });
  }

  cleaned.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.start_ms - b.start_ms);
  const kept: RefinedCandidate[] = [];
  for (const cand of cleaned) {
    const length = cand.end_ms - cand.start_ms;
    if (kept.some((k) => overlapMs(cand, k) > OVERLAP_LIMIT * length)) continue;
    kept.push(cand);
    if (kept.length >= maxCount) break;
  }
  return kept;
}

export function assignIds(candidates: RefinedCandidate[]): RefinedCandidate[] {
  candidates.forEach((cand, i) => {
    cand.id = `c${String(i + 1).padStart(2, "0")}`;
    cand.rank = i + 1;
  });
  return candidates;
}

// ------------------------------------------------------------ hard constraints

/** true / false / null — null is "could not be verified", never asserted as a pass. */
export function speakerMatches(wanted: string[], found: string | null | undefined): boolean | null {
  if (!wanted.length) return true;
  if (!found) return null;
  const f = found.toLowerCase();
  return wanted.some((w) => f.includes(w.toLowerCase()) || w.toLowerCase().includes(f));
}

/**
 * Hard-constraint verdict for one candidate: `ok` plus the per-constraint
 * flags and the warnings. `transcript` is the text of the candidate's final
 * boundaries. Nothing is fabricated — a constraint that cannot be verified is
 * reported as null with a warning saying why.
 */
export function checkConstraints(cand: RefinedCandidate, spec: RequestSpec, window: DurationWindow, transcript: string): CandidateCompliance {
  const warnings: string[] = [];
  const reasons: string[] = [];
  const durationMs = cand.end_ms - cand.start_ms;
  const durationOk = window.min_ms <= durationMs && durationMs <= window.max_ms;
  if (!durationOk) reasons.push(`${(durationMs / 1000).toFixed(1)}s is outside the ${g(window.min_ms / 1000)}-${g(window.max_ms / 1000)}s window`);

  const profane = findProfanity(transcript);
  const profanityFound = profane.length > 0;
  if (profanityFound && (spec.exclude_content ?? []).includes("profanity")) reasons.push("contains profanity (" + profane.slice(0, 3).join(", ") + ")");

  const speakers = spec.speakers ?? [];
  const speakerMatch = speakerMatches(speakers, cand.speaker);
  if (speakers.length) {
    if (speakerMatch === false) reasons.push(`speaker is ${cand.speaker}, not ${speakers.join(" / ")}`);
    else if (speakerMatch === null) warnings.push("Speaker could not be verified from the transcript (no diarization yet).");
  }

  let topicFound = cand.topic_found ?? null;
  if ((spec.subjects ?? []).length) {
    if (topicFound === false) reasons.push("required subject not covered");
    else if (topicFound === null) warnings.push("Subject coverage was not asserted by the model.");
  } else if (topicFound === null) {
    topicFound = true;
  }

  const excludedFound = cand.excluded_found ?? null;
  if ((spec.exclude_subjects ?? []).length && excludedFound) reasons.push("touches an excluded subject");

  let completeEnding = cand.complete_ending ?? null;
  if (completeEnding === false) {
    reasons.push("does not end on a complete thought");
  } else if (completeEnding === null) {
    completeEnding = /[.!?…]["”’)]*\s*$/.test(transcript || "");
    if (!completeEnding) warnings.push("The last sentence has no terminal punctuation — check the ending.");
  }

  return {
    ok: !reasons.length,
    rejected_for: reasons,
    duration_requested: round1(window.target_ms / 1000),
    duration_planned: round1(durationMs / 1000),
    duration_ok: durationOk,
    speaker_match: speakers.length ? speakerMatch : null,
    required_topic_found: topicFound,
    excluded_subject_found: (spec.exclude_subjects ?? []).length ? Boolean(excludedFound) : false,
    profanity_found: profanityFound,
    profane_words: profane,
    complete_ending: Boolean(completeEnding),
    warnings,
  };
}

/** Weighted component score minus a small penalty for missing the duration target (natural mode only). */
export function directorScore(cand: RefinedCandidate, window: DurationWindow): number {
  const base = weighted(cand.scores, DIRECTOR_WEIGHTS);
  let penalty = 0;
  if (window.mode === "natural") {
    const off = Math.abs(cand.end_ms - cand.start_ms - window.target_ms) - (window.tolerance_ms ?? 0);
    if (off > 0) penalty = Math.min(MAX_DURATION_PENALTY, (off / 1000) * DURATION_PENALTY_PER_S);
  }
  return round2(Math.max(0, base - penalty));
}

/**
 * Snap every proposal to sentence boundaries, apply the hard constraints, rank
 * the survivors and keep the best non-overlapping `count`. Rejected entries
 * carry `rejected_for`.
 */
export function selectCandidates(
  proposed: RefinedCandidate[],
  spec: RequestSpec,
  window: DurationWindow,
  sentences: RefineSentence[],
  durationMs: number
): { kept: RefinedCandidate[]; rejected: RefinedCandidate[] } {
  const want = Math.trunc(Number(spec.count) || 1);
  const checked: RefinedCandidate[] = [];
  for (const raw of proposed) {
    const cand: RefinedCandidate = { ...raw, proposed: { start_ms: raw.start_ms, end_ms: raw.end_ms } };
    const [snappedStart, snappedEnd] = snapToSentences(cand.start_ms, cand.end_ms, sentences);
    cand.start_ms = Math.max(0, snappedStart);
    cand.end_ms = durationMs ? Math.min(durationMs, snappedEnd) : snappedEnd;
    if (cand.end_ms - cand.start_ms > window.max_ms && sentences.length) {
      // trim back to the last sentence end inside the window (never mid-sentence)
      const end = sentenceEndWithin(sentences, cand.start_ms, cand.start_ms + window.max_ms);
      if (end != null) cand.end_ms = end;
    }
    cand.duration_ms = cand.end_ms - cand.start_ms;
    cand.text = quoteFor(sentences, cand.start_ms, cand.end_ms, 6000);
    cand.quote = cand.quote || quoteFor(sentences, cand.start_ms, cand.end_ms);
    cand.compliance = checkConstraints(cand, spec, window, cand.text);
    cand.score = directorScore(cand, window);
    checked.push(cand);
  }

  checked.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.start_ms - b.start_ms);
  const kept: RefinedCandidate[] = [];
  const rejected: RefinedCandidate[] = [];
  for (const cand of checked) {
    if (!cand.compliance?.ok) {
      cand.rejected_for = cand.compliance?.rejected_for ?? [];
      rejected.push(cand);
      continue;
    }
    const length = Math.max(1, cand.end_ms - cand.start_ms);
    const clash = kept.find((k) => overlapMs(cand, k) > OVERLAP_LIMIT * length);
    if (clash) {
      cand.rejected_for = [`overlaps a higher-ranked clip (${clash.title || clash.start_ms})`];
      rejected.push(cand);
      continue;
    }
    if (kept.length >= want) {
      cand.rejected_for = [`beyond the requested ${want} clip(s)`];
      rejected.push(cand);
      continue;
    }
    kept.push(cand);
  }
  return { kept, rejected };
}

/** Aggregate report for analysis/requests/<id>.json. */
export function requestCompliance(
  kept: RefinedCandidate[],
  rejected: RefinedCandidate[],
  spec: RequestSpec,
  window: DurationWindow
): RequestCompliance {
  const want = Math.trunc(Number(spec.count) || 1);
  const warnings: string[] = [...(spec.warnings ?? [])];
  if (kept.length < want) warnings.push(`Only ${kept.length} of the ${want} requested clip(s) met every constraint.`);
  const unverified = kept.filter((c) => c.compliance?.speaker_match == null && (spec.speakers ?? []).length);
  if (unverified.length) warnings.push(`${unverified.length} clip(s) could not have their speaker verified.`);
  const reasons: Record<string, number> = {};
  for (const cand of rejected) {
    for (const reason of cand.rejected_for ?? []) {
      const key = reason.split(" (")[0];
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
  }
  return {
    requested: want,
    delivered: kept.length,
    proposed: kept.length + rejected.length,
    rejected: rejected.length,
    rejection_reasons: reasons,
    duration: { mode: window.mode, target_seconds: window.target_ms / 1000, window_seconds: [window.min_ms / 1000, window.max_ms / 1000] },
    all_topic_found: kept.every((c) => c.compliance?.required_topic_found !== false),
    profanity_free: !kept.some((c) => c.compliance?.profanity_found),
    warnings,
  };
}

/** The short form of a rejected candidate the request file records. */
export function rejectedSummary(rejected: RefinedCandidate[]): RejectedCandidate[] {
  return rejected.map((c) => ({
    title: c.title,
    start_ms: c.start_ms,
    end_ms: c.end_ms,
    score: c.score,
    speaker: c.speaker ?? null,
    rejected_for: c.rejected_for,
  }));
}

// ------------------------------------------------------------------ analysis

export interface AnalysisRefineInput {
  root: string;
  episodeId: string;
  /** the producer's goal from project.json settings */
  goal: string;
  /** how many candidates to keep, and the length limits (project settings over REFINE_DEFAULTS) */
  want: number;
  minMs: number;
  maxMs: number;
  sentences: RefineSentence[];
  durationMs: number;
  /** the raw LLM answers, one per transcript part */
  payloads: unknown[];
  /** epoch seconds stamped into every file */
  now?: number;
  /** how long the run took, for the status line */
  seconds?: number;
}

export interface AnalysisRefinement {
  files: RefineWrite[];
  /** the `analysis` block project.json carries after a run */
  analysis: Record<string, unknown>;
  status: RefineStatus;
  manifest: Record<string, unknown>;
  candidates: RefinedCandidate[];
  chapters: Chapter[];
}

/**
 * Episode analysis: merge the per-part answers, snap every proposal to
 * sentence boundaries, enforce the length limits, remove overlaps, keep the
 * best N by the hook / clarity / standalone rubric and dedupe the chapters.
 */
export function refineAnalysis(input: AnalysisRefineInput): AnalysisRefinement {
  const now = input.now ?? Date.now() / 1000;
  const sentences = input.sentences;
  const proposed: RefinedCandidate[] = [];
  const chapters: ParsedChapter[] = [];
  let emptyParts = 0;
  for (const payload of input.payloads) {
    const found = parseCandidateAnswer(payload);
    const foundChapters = parseChapters(payload);
    if (!found.length && !foundChapters.length) emptyParts += 1;
    proposed.push(...found);
    chapters.push(...foundChapters);
  }

  for (const cand of proposed) {
    cand.proposed = { start_ms: cand.start_ms, end_ms: cand.end_ms };
    const [start, end] = snapToSentences(cand.start_ms, cand.end_ms, sentences);
    cand.start_ms = start;
    cand.end_ms = end;
  }

  const kept = validateCandidates(proposed, input.durationMs, input.minMs, input.maxMs, input.want, sentences);
  for (const cand of kept) {
    cand.quote = cand.quote || quoteFor(sentences, cand.start_ms, cand.end_ms);
    cand.text = quoteFor(sentences, cand.start_ms, cand.end_ms, 6000);
    cand.sentence_ids = sentenceIds(sentences, cand.start_ms, cand.end_ms);
  }
  assignIds(kept);
  const merged = mergeChapters(chapters, input.durationMs);

  const files: RefineWrite[] = [
    // the raw model answers next to the derived candidates (explainability + debugging)
    { path: `${input.root}/analysis/llm-answers.json`, value: { schema_version: 1, generated: now, answers: input.payloads } },
    {
      path: `${input.root}/analysis/candidates.json`,
      value: {
        schema_version: 1,
        episode_id: input.episodeId,
        goal: input.goal,
        generated: now,
        proposed: proposed.length,
        parts: input.payloads.length,
        empty_parts: emptyParts,
        limits: { min_ms: input.minMs, max_ms: input.maxMs, count: input.want },
        scoring: { weights: SCORE_WEIGHTS, axes: ANALYSIS_AXES },
        candidates: kept,
      },
    },
    { path: `${input.root}/analysis/chapters.json`, value: { schema_version: 1, chapters: merged } },
  ];

  const seconds = input.seconds ?? 0;
  return {
    files,
    analysis: {
      status: "analyzed",
      candidates: kept.length,
      proposed: proposed.length,
      chapters: merged.length,
      sentences: sentences.length,
      parts: input.payloads.length,
      analyzed_at: now,
    },
    status: { stage: "analyzed", data: { candidates: kept.length, proposed: proposed.length, chapters: merged.length, seconds } },
    manifest: {
      project: input.root,
      episode_id: input.episodeId,
      goal: input.goal,
      candidates: kept,
      chapters: merged,
      proposed: proposed.length,
      parts: input.payloads.length,
      empty_parts: emptyParts,
      seconds,
    },
    candidates: kept,
    chapters: merged,
  };
}

// ---------------------------------------------------------- Prompt Director

export interface DirectedRefineInput {
  root: string;
  episodeId: string;
  requestId: string;
  /** the request file as it stands (prompt, raw, spec, search_query, created) */
  request: Record<string, unknown>;
  /** the re-normalised spec, its duration window and its one-line summary */
  spec: RequestSpec;
  window: DurationWindow;
  summary: string;
  sentences: RefineSentence[];
  durationMs: number;
  payloads: unknown[];
  now?: number;
  seconds?: number;
}

export interface DirectedRefinement {
  files: RefineWrite[];
  /** the entry project.json keeps for this request */
  projectRequest: Record<string, unknown>;
  status: RefineStatus;
  manifest: Record<string, unknown>;
  candidates: RefinedCandidate[];
  rejected: RejectedCandidate[];
  compliance: RequestCompliance;
  notes: string[];
}

/**
 * Prompt Director: enforce the hard constraints, rank the survivors on prompt
 * match / hook / standalone / clarity / energy and write the request file with
 * its compliance report.
 */
export function refineDirected(input: DirectedRefineInput): DirectedRefinement {
  const now = input.now ?? Date.now() / 1000;
  if (!input.sentences.length) throw new Error(`No transcript for ${input.root} — run the episode analysis first.`);

  const proposed: RefinedCandidate[] = [];
  const errors: string[] = [];
  const notes: string[] = [];
  for (const payload of input.payloads) {
    const found = parseDirectorAnswer(payload);
    if (!found.length && typeof payload === "string" && payload.trimStart().startsWith("**LLM error**")) errors.push(payload.trim().slice(0, 300));
    if (isRecord(payload) && String(payload.notes ?? "").trim()) notes.push(String(payload.notes).trim().slice(0, 1000));
    proposed.push(...found);
  }
  if (errors.length && !proposed.length) throw new Error(errors.join("; "));

  const { kept, rejected } = selectCandidates(proposed, input.spec, input.window, input.sentences, input.durationMs);
  kept.forEach((cand, i) => {
    cand.id = `${input.requestId}c${String(i + 1).padStart(2, "0")}`;
    cand.rank = i + 1;
    cand.request_id = input.requestId;
    cand.sentence_ids = sentenceIds(input.sentences, cand.start_ms, cand.end_ms);
  });
  const compliance = requestCompliance(kept, rejected, input.spec, input.window);
  if (notes.length) compliance.notes = notes;
  const seconds = input.seconds ?? 0;
  const rejectedShort = rejectedSummary(rejected);

  const request = {
    ...input.request,
    schema_version: 1,
    request_id: input.requestId,
    status: "done",
    spec: input.spec,
    summary: input.summary,
    window: input.window,
    scoring: { weights: DIRECTOR_WEIGHTS, axes: DIRECTOR_AXES },
    candidates: kept,
    rejected: rejectedShort,
    compliance,
    llm_answers: input.payloads,
    answered_at: now,
    seconds,
  };

  return {
    files: [{ path: `${input.root}/analysis/requests/${input.requestId}.json`, value: request }],
    projectRequest: {
      prompt: input.request.prompt,
      summary: input.summary,
      delivered: kept.length,
      requested: compliance.requested,
      answered_at: now,
    },
    status: {
      stage: "directed",
      data: { request: input.requestId, candidates: kept.length, proposed: proposed.length, rejected: rejected.length, seconds },
    },
    manifest: {
      project: input.root,
      episode_id: input.episodeId,
      request_id: input.requestId,
      spec: input.spec,
      summary: input.summary,
      candidates: kept,
      rejected: rejectedShort,
      compliance,
      notes,
      proposed: proposed.length,
      seconds,
    },
    candidates: kept,
    rejected: rejectedShort,
    compliance,
    notes,
  };
}
