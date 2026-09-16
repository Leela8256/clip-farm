/**
 * Prompt Director — pure logic (no SDK imports): the request spec the stock
 * LLM produces from a producer's sentence, its normalisation (the twin of
 * local_nodes/podcast_common/spec.py), the questions the pipelines are asked,
 * and how a conversational revision becomes a new edit version.
 *
 * Everything the pipelines need from the browser is a Question: the prompt
 * text lives in prompts/director.json (shared with tools/prompts.py) and the
 * dynamic parts are assembled here. The Question class itself comes from the
 * SDK, so the builders take a factory to stay testable.
 */

import prompts from "./prompts/director.json";
import { pyRound } from "./refine";
import { fmtStamp, type Candidate, type ClipEdit, type Sentence } from "./podcast";

export const DURATION_MODES = ["natural", "strict", "maximum"] as const;
export const FILLER_POLICIES = ["smart", "cut", "mute", "keep"] as const;
export const SILENCE_POLICIES = ["tighten", "keep"] as const;
export const ASPECT_RATIOS = ["9:16", "16:9", "1:1", "4:5"] as const;
export const CAPTION_PRESETS = ["classic", "yellow-bold", "white-outline", "minimal", "off"] as const;
export const EXCLUDABLE_CONTENT = ["profanity", "sponsor", "housekeeping", "names", "numbers"] as const;
export const RENDERABLE_ASPECTS: Record<string, string> = { "9:16": "vertical", "4:5": "vertical", "1:1": "vertical", "16:9": "wide" };

export type DurationMode = (typeof DURATION_MODES)[number];
export type FillerPolicy = (typeof FILLER_POLICIES)[number];
export type SilencePolicy = (typeof SILENCE_POLICIES)[number];
export type CaptionPreset = (typeof CAPTION_PRESETS)[number];

const DEFAULT_COUNT = 3;
const MAX_COUNT = 20;
const DEFAULT_TARGET_S = 45;
const DEFAULT_MIN_S = 15;
const NATURAL_TOLERANCE_S = 3;
const STRICT_TOLERANCE_S = 1;
// discovery windows as a share of the target (twin of spec.py): natural is
// generous and lets the score penalty pull towards the target; strict and
// maximum rely on the fit step trimming longer proposals
const NATURAL_WINDOW = [0.6, 1.5];
const STRICT_WINDOW = [0.85, 1.5];
const MAXIMUM_WINDOW = [0.5, 1.3];
export const RETRIEVAL_LIMIT = 16;
const CONTEXT_CHARS = 24_000;

export interface RequestSpec {
  spec_version: number;
  count: number;
  duration: { target_seconds: number; min_seconds: number | null; max_seconds: number | null; mode: DurationMode };
  speakers: string[];
  subjects: string[];
  exclude_subjects: string[];
  exclude_content: string[];
  tone: string | null;
  hook: string | null;
  ending: string | null;
  filler_policy: FillerPolicy;
  silence_policy: SilencePolicy;
  caption_preset: CaptionPreset;
  aspect_ratio: string;
  platform: string | null;
  warnings: string[];
}

export interface DurationWindow {
  mode: DurationMode;
  target_ms: number;
  min_ms: number;
  max_ms: number;
  tolerance_ms: number;
}

export interface Compliance {
  ok?: boolean;
  rejected_for?: string[];
  prompt_match?: number | null;
  duration_requested?: number | null;
  duration_planned?: number | null;
  duration_final?: number | null;
  duration_mode?: string;
  duration_met?: boolean | null;
  duration_ok?: boolean;
  speaker_match?: boolean | null;
  required_topic_found?: boolean | null;
  excluded_subject_found?: boolean;
  profanity_found?: boolean;
  profane_words?: string[];
  complete_ending?: boolean | null;
  cuts?: { planned: number; applied: number; muted: number; kept: number; restored: number; unsafe: number };
  fit?: { before_ms?: number; after_ms?: number; actions?: string[]; met?: boolean };
  visual?: { applied?: boolean; people?: number; speaker_visible_pct?: number | null; face_cut_violations?: number; face_checks?: number; smooth?: boolean; layout_changes?: number; layouts?: string[] };
  warnings?: string[];
}

export interface RequestCompliance {
  requested: number;
  delivered: number;
  proposed: number;
  rejected: number;
  rejection_reasons: Record<string, number>;
  /** what the request asked for, in seconds (the window the constraints enforced) */
  duration?: { mode: string; target_seconds: number; window_seconds: number[] };
  all_topic_found?: boolean;
  profanity_free?: boolean;
  /** anything the model wanted to say about the request itself */
  notes?: string[];
  warnings: string[];
}

export interface RejectedCandidate {
  title?: string;
  start_ms?: number;
  end_ms?: number;
  score?: number;
  speaker?: string | null;
  rejected_for?: string[];
}

export interface DirectorRequest {
  schema_version: number;
  request_id: string;
  prompt: string;
  raw?: Record<string, unknown>;
  spec: RequestSpec;
  search_query: string;
  summary?: string;
  status: "parsed" | "running" | "done" | "error";
  created: number;
  answered_at?: number;
  candidates?: Candidate[];
  rejected?: RejectedCandidate[];
  compliance?: RequestCompliance;
  window?: DurationWindow;
  seconds?: number;
  error?: string;
  mode?: "index" | "full";
}

export interface Cut {
  id: string;
  kind: "filler" | "silence";
  word: string;
  start_ms: number;
  end_ms: number;
  action: "cut" | "mute" | "keep";
  safe: boolean;
  reason: string | null;
  enabled: boolean;
  restored_for_fit?: boolean;
}

export interface ClipPlan {
  schema_version: number;
  clip_id: string;
  title?: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  rendered_duration_ms?: number;
  transcript?: string;
  cuts?: Cut[];
  mutes?: number[][];
  fit?: { mode: string; target_ms: number; tolerance_ms: number; before_ms: number; after_ms: number; met: boolean; actions: string[]; warnings: string[] };
  options?: Record<string, unknown>;
  version?: number | null;
  request_id?: string | null;
}

export interface EditVersion {
  n: number;
  created?: number;
  note?: string;
  source?: string;
  start_ms?: number;
  end_ms?: number;
  title?: string;
  filler_policy?: string;
  silence_policy?: string;
  caption_preset?: string;
  duration_seconds?: number;
  duration_mode?: string;
  disabled_cuts?: string[];
}

export interface Revision {
  action: "retime" | "retitle" | "options" | "new_request" | "compilation" | "none" | string;
  start?: string | number;
  end?: string | number;
  title?: string;
  options?: Record<string, unknown>;
  prompt?: string;
  clips?: string[];
  note?: string;
  explanation?: string;
  warnings?: string[];
}

// ---------------------------------------------------------------- coercion

function asList(value: unknown): string[] {
  if (value == null || value === false) return [];
  if (typeof value === "string") {
    return value
      .split(/[;,]\s*|\s+and\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === "string" && item.trim()) out.push(item.trim());
      else if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        const name = rec.name ?? rec.text ?? rec.value;
        if (typeof name === "string" && name.trim()) out.push(name.trim());
      }
    }
    return out;
  }
  const text = String(value).trim();
  return text ? [text] : [];
}

function asFloat(value: unknown): number | null {
  if (value == null || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const m = /(\d+(?:\.\d+)?)\s*(m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)?\b/i.exec(String(value).trim().toLowerCase());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return (m[2] ?? "").startsWith("m") ? n * 60 : n;
}

function asBool(value: unknown, fallback: boolean | null = null): boolean | null {
  if (typeof value === "boolean") return value;
  if (value == null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "remove", "cut"].includes(text)) return true;
  if (["0", "false", "no", "off", "keep"].includes(text)) return false;
  return fallback;
}

function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T, warnings: string[], label: string, aliases: Record<string, T> = {}): T {
  if (value == null || value === "") return fallback;
  let text = String(value).trim().toLowerCase();
  if (aliases[text]) text = aliases[text];
  if ((allowed as readonly string[]).includes(text)) return text as T;
  warnings.push(`Unknown ${label} '${String(value)}' — using '${fallback}'.`);
  return fallback;
}

// the same rounding the python spec twin uses (lib/refine.ts explains why it is not Math.round)
const round1 = (n: number) => pyRound(n, 1);

/** Coerce the LLM's JSON into the canonical spec; unusable values become defaults plus a warning. */
export function normalizeSpec(raw: unknown, defaults: { count?: number; target_seconds?: number } = {}): RequestSpec {
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const warnings: string[] = (Array.isArray(data.warnings) ? data.warnings : []).map(String).filter((w) => w.trim());

  const countRaw = asFloat(data.count);
  let count = defaults.count ?? DEFAULT_COUNT;
  if (countRaw != null) count = Math.max(1, Math.min(MAX_COUNT, Math.round(countRaw)));
  if (countRaw != null && countRaw !== count) warnings.push(`Clip count clamped to ${count} (1-${MAX_COUNT}).`);

  const dur = data.duration && typeof data.duration === "object" ? (data.duration as Record<string, unknown>) : {};
  let target = asFloat(data.target_duration_seconds ?? dur.target_seconds ?? dur.target);
  let minS = asFloat(data.min_duration_seconds ?? dur.min_seconds ?? dur.min);
  let maxS = asFloat(data.max_duration_seconds ?? dur.max_seconds ?? dur.max);
  const mode = choice(data.duration_mode ?? dur.mode, DURATION_MODES, "natural", warnings, "duration mode", {
    exact: "strict",
    exactly: "strict",
    precise: "strict",
    max: "maximum",
    "at most": "maximum",
    under: "maximum",
    "up to": "maximum",
    around: "natural",
    about: "natural",
    approx: "natural",
    approximately: "natural",
    flexible: "natural",
  });
  if (minS != null && maxS != null && minS > maxS) {
    warnings.push(`Minimum duration (${minS}s) was above the maximum (${maxS}s) — swapped.`);
    [minS, maxS] = [maxS, minS];
  }
  if (target == null) {
    if (minS != null && maxS != null) target = (minS + maxS) / 2;
    else if (maxS != null && mode === "maximum") target = maxS;
    else if (maxS != null) target = maxS * 0.8;
    else if (minS != null) target = minS * 1.3;
    else target = defaults.target_seconds ?? DEFAULT_TARGET_S;
  }
  if (target < 5) {
    warnings.push(`Target duration ${target}s is too short — using 5s.`);
    target = 5;
  }
  if (target > 600) {
    warnings.push(`Target duration ${target}s is too long for a clip — using 600s.`);
    target = 600;
  }
  if (minS != null && minS > target) {
    warnings.push(`Minimum duration (${minS}s) is above the target (${target}s) — dropped.`);
    minS = null;
  }
  if (maxS != null && maxS < target) {
    if (mode === "maximum") target = maxS;
    else {
      warnings.push(`Maximum duration (${maxS}s) is below the target (${target}s) — dropped.`);
      maxS = null;
    }
  }
  if (mode === "strict" && (minS != null || maxS != null)) warnings.push("Strict duration ignores min/max bounds — the clip is fitted to the target.");
  if (mode === "maximum" && maxS == null) maxS = target;

  let fillers = choice(data.filler_policy ?? data.fillers, FILLER_POLICIES, "smart", warnings, "filler policy", {
    remove: "smart",
    remove_fillers: "smart",
    auto: "smart",
    hard: "cut",
    "hard cut": "cut",
    silence: "mute",
    leave: "keep",
    none: "keep",
  });
  const remove = asBool(data.remove_fillers);
  if (remove === false) fillers = "keep";
  else if (remove === true && fillers === "keep") fillers = "smart";
  let silences = choice(data.silence_policy ?? data.silences ?? data.pauses, SILENCE_POLICIES, "tighten", warnings, "pause policy", {
    remove: "tighten",
    trim: "tighten",
    cut: "tighten",
    leave: "keep",
    preserve: "keep",
    natural: "keep",
  });
  if (asBool(data.tighten_pauses) === false) silences = "keep";

  const aspect = choice(data.aspect_ratio ?? data.aspect, ASPECT_RATIOS, "9:16", warnings, "aspect ratio", {
    vertical: "9:16",
    portrait: "9:16",
    reels: "9:16",
    shorts: "9:16",
    tiktok: "9:16",
    horizontal: "16:9",
    landscape: "16:9",
    wide: "16:9",
    youtube: "16:9",
    square: "1:1",
  });
  if (!RENDERABLE_ASPECTS[aspect]) warnings.push(`${aspect} isn't a shape we can render — using 9:16 for now.`);

  let captionRaw: unknown = data.caption_preset ?? data.captions;
  if (captionRaw && typeof captionRaw === "object") {
    const rec = captionRaw as Record<string, unknown>;
    captionRaw = rec.preset ?? rec.style ?? (rec.enabled === false ? "off" : null);
  }
  if (asBool(captionRaw) === false) captionRaw = "off";
  else if (asBool(captionRaw) === true) captionRaw = "classic";
  const captions = choice(captionRaw, CAPTION_PRESETS, "classic", warnings, "caption preset", {
    yellow: "yellow-bold",
    "bold yellow": "yellow-bold",
    "yellow bold": "yellow-bold",
    white: "white-outline",
    outline: "white-outline",
    default: "classic",
    none: "off",
    "no captions": "off",
    plain: "minimal",
  });

  const excludeContent: string[] = [];
  const extraExcludeSubjects: string[] = [];
  for (const item of asList(data.exclude_content ?? data.exclude)) {
    let key = item.toLowerCase().replace(/ /g, "_");
    if (["swearing", "cursing", "curse_words", "swear_words", "explicit", "bad_language"].includes(key)) key = "profanity";
    if (["ads", "ad_reads", "sponsors", "sponsor_reads", "advertising"].includes(key)) key = "sponsor";
    if (["intro", "outro", "greetings", "banter"].includes(key)) key = "housekeeping";
    if ((EXCLUDABLE_CONTENT as readonly string[]).includes(key)) {
      if (!excludeContent.includes(key)) excludeContent.push(key);
    } else {
      warnings.push(`Can't filter content of type '${item}' — treating it as an excluded subject.`);
      extraExcludeSubjects.push(item);
    }
  }

  const speakers = asList(data.speakers ?? data.speaker);
  const subjects = asList(data.subjects ?? data.subject ?? data.topic ?? data.topics);
  const excludeSubjects = [...asList(data.exclude_subjects), ...extraExcludeSubjects];
  if (speakers.length) warnings.push("Speaker constraints are matched from what is said (names, first person) until speaker tracking arrives in phase 2 — check the compliance flag.");

  const str = (v: unknown) => {
    const t = v == null ? "" : String(v).trim();
    return t || null;
  };

  return {
    spec_version: 1,
    count,
    duration: { target_seconds: round1(target), min_seconds: minS != null ? round1(minS) : null, max_seconds: maxS != null ? round1(maxS) : null, mode },
    speakers,
    subjects,
    exclude_subjects: excludeSubjects,
    exclude_content: excludeContent,
    tone: str(data.tone),
    hook: str(data.hook ?? data.hook_style),
    ending: str(data.ending ?? data.ending_requirement),
    filler_policy: fillers,
    silence_policy: silences,
    caption_preset: captions,
    aspect_ratio: aspect,
    platform: str(data.platform),
    warnings,
  };
}

/** The millisecond window discovery accepts and the tolerance the fit must land in (twin of spec.duration_window). */
export function durationWindow(spec: RequestSpec, minSecondsDefault = DEFAULT_MIN_S): DurationWindow {
  const { target_seconds: target, min_seconds: minS, max_seconds: maxS } = spec.duration;
  const mode = spec.duration.mode;
  let tolerance: number;
  let lo: number;
  let hi: number;
  if (mode === "natural") {
    tolerance = NATURAL_TOLERANCE_S;
    lo = minS ?? Math.max(minSecondsDefault, target * NATURAL_WINDOW[0]);
    hi = maxS ?? target * NATURAL_WINDOW[1];
  } else if (mode === "strict") {
    tolerance = STRICT_TOLERANCE_S;
    lo = Math.max(minSecondsDefault, target * STRICT_WINDOW[0]);
    hi = target * STRICT_WINDOW[1];
  } else {
    tolerance = 0;
    lo = minS ?? Math.max(minSecondsDefault, target * MAXIMUM_WINDOW[0]);
    hi = target * MAXIMUM_WINDOW[1];
  }
  lo = Math.max(3, Math.min(lo, target));
  hi = Math.max(hi, target);
  return { mode, target_ms: Math.round(target * 1000), min_ms: Math.round(lo * 1000), max_ms: Math.round(hi * 1000), tolerance_ms: tolerance * 1000 };
}

export function describeSpec(spec: RequestSpec): string {
  const parts = [`${spec.count} clip(s)`, `${spec.duration.target_seconds}s ${spec.duration.mode}`];
  if (spec.speakers.length) parts.push("speaker " + spec.speakers.join(", "));
  if (spec.subjects.length) parts.push("about " + spec.subjects.join("; "));
  if (spec.exclude_content.length) parts.push("no " + spec.exclude_content.join(", "));
  if (spec.hook) parts.push(`hook: ${spec.hook}`);
  if (spec.ending) parts.push(`ending: ${spec.ending}`);
  return parts.join(" · ");
}

export function describeRequest(spec: RequestSpec, window: DurationWindow): string {
  const ask = Math.min(8, Math.max(spec.count * 2, 3));
  const parts = [
    `Deliver up to ${ask} candidates so the best ${spec.count} can be kept.`,
    `Length: about ${spec.duration.target_seconds}s (${spec.duration.mode} mode; anything from ${window.min_ms / 1000} to ${window.max_ms / 1000}s is acceptable).`,
  ];
  if (spec.speakers.length) parts.push("Speaker who must be talking: " + spec.speakers.join(", ") + ".");
  if (spec.subjects.length) parts.push("Subject the clip must cover: " + spec.subjects.join("; ") + ".");
  if (spec.exclude_subjects.length) parts.push("Subjects to stay away from: " + spec.exclude_subjects.join("; ") + ".");
  if (spec.exclude_content.length) parts.push("Content to exclude: " + spec.exclude_content.join(", ") + ".");
  if (spec.tone) parts.push(`Tone: ${spec.tone}.`);
  if (spec.hook) parts.push(`The clip should open with ${spec.hook}.`);
  if (spec.ending) parts.push(`It should end with ${spec.ending}.`);
  if (spec.platform) parts.push(`Platform: ${spec.platform}.`);
  return parts.join(" ");
}

/** The search phrase the embedding node sees: the model's own, else the subjects, else the sentence. */
export function searchQueryOf(raw: unknown, spec: RequestSpec, prompt: string): string {
  const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const own = typeof rec.search_query === "string" ? rec.search_query.trim() : "";
  return (own || [...spec.speakers, ...spec.subjects].join(" ") || prompt).slice(0, 200);
}

// ------------------------------------------------------------- questions

/** The subset of the SDK Question class the builders use (keeps this module SDK-free and testable). */
export interface QuestionLike {
  role: string;
  expectJson: boolean;
  filter: { objectIds?: string[]; limit?: number };
  addInstruction(title: string, text: string): void;
  addExample(given: string, result: string | object | unknown[]): void;
  addContext(context: string): void;
  addGoal(goal: string): void;
  addQuestion(text: string): void;
}

type Block = { role: string; instructions: string[][] };

function apply(q: QuestionLike, block: Block) {
  q.role = block.role;
  q.expectJson = true;
  for (const [title, text] of block.instructions) q.addInstruction(title, text ?? "");
}

export function buildParseQuestion<Q extends QuestionLike>(q: Q, prompt: string): Q {
  apply(q, prompts.parse);
  for (const ex of prompts.parse.examples) q.addExample(ex.given, ex.result);
  q.addQuestion(prompt.trim());
  return q;
}

export function buildDirectQuestion<Q extends QuestionLike>(
  q: Q,
  input: { prompt: string; spec: RequestSpec; window: DurationWindow; projectRoot: string; requestId: string; episodeId: string; searchQuery: string; transcriptLines?: string | null }
): Q {
  apply(q, prompts.direct);
  q.addInstruction("Request", describeRequest(input.spec, input.window));
  q.addExample("Pick clips for a request from transcript passages", prompts.direct.example);
  q.addGoal(`Producer's request: ${input.prompt.trim()}`);
  q.addContext(`project: ${input.projectRoot}\nrequest: ${input.requestId}`);
  if (input.transcriptLines) {
    for (let i = 0; i < input.transcriptLines.length; i += CONTEXT_CHARS) {
      q.addContext("Transcript" + (i ? " (continued)" : "") + ":\n" + input.transcriptLines.slice(i, i + CONTEXT_CHARS));
    }
  }
  q.filter.objectIds = [input.episodeId];
  q.filter.limit = RETRIEVAL_LIMIT;
  q.addQuestion(input.searchQuery.trim() || input.prompt.trim());
  return q;
}

export function transcriptLines(sentences: Sentence[]): string {
  return sentences
    .filter((s) => s.text.trim())
    .map((s) => `[${fmtStamp(s.start_ms)} - ${fmtStamp(s.end_ms)}] ${s.text.trim()}`)
    .join("\n");
}

const cutLine = (c: Cut) =>
  `${c.id}: ${c.kind} ${c.word ? `“${c.word}”` : "pause"} at ${(c.start_ms / 1000).toFixed(1)}s — ${c.action}${c.enabled ? "" : " (restored)"}`;

export function buildReviseQuestion<Q extends QuestionLike>(
  q: Q,
  input: { instruction: string; projectRoot: string; clipId: string; plan: ClipPlan; sentences: Sentence[]; candidates: Candidate[]; padMs?: number }
): Q {
  apply(q, prompts.revise);
  for (const ex of prompts.revise.examples) q.addExample(ex.given, ex.result);
  const pad = input.padMs ?? 60_000;
  const { start_ms: start, end_ms: end } = input.plan;
  const lines = input.sentences
    .filter((s) => s.end_ms >= start - pad && s.start_ms <= end + pad)
    .map((s) => `${s.start_ms < end && s.end_ms > start ? ">" : " "} [${fmtStamp(s.start_ms)} - ${fmtStamp(s.end_ms)}] ${s.text}`);
  const o = input.plan.options ?? {};
  const shown = Object.fromEntries(["filler_policy", "silence_policy", "caption_preset", "duration_seconds", "duration_mode"].map((k) => [k, o[k] ?? null]));
  q.addContext(`project: ${input.projectRoot}\nclip: ${input.clipId}`);
  q.addContext(
    `Clip ${input.clipId} — “${input.plan.title ?? ""}” from ${fmtStamp(start)} to ${fmtStamp(end)} (${((end - start) / 1000).toFixed(1)}s, rendered ${(
      (input.plan.rendered_duration_ms ?? end - start) / 1000
    ).toFixed(1)}s). Options: ${JSON.stringify(shown)}.\nPlanned cuts:\n${(input.plan.cuts ?? []).map(cutLine).join("\n") || "none"}`
  );
  q.addContext("Transcript around the clip (lines marked > are inside it):\n" + lines.join("\n"));
  if (input.candidates.length) {
    q.addContext("Other candidates in this episode:\n" + input.candidates.map((c) => `${c.id}: [${fmtStamp(c.start_ms)} - ${fmtStamp(c.end_ms)}] ${c.title}`).join("\n"));
  }
  q.addQuestion(input.instruction.trim());
  return q;
}

// --------------------------------------------------------------- revisions

export function parseTs(value: unknown): number | null {
  if (value == null || typeof value === "boolean") return null;
  if (typeof value === "number") return Math.round(value);
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\s*$/.exec(String(value));
  if (!m) return null;
  const h = parseInt(m[1] ?? "0", 10);
  const frac = (m[4] ?? "").padEnd(3, "0");
  return ((h * 60 + parseInt(m[2], 10)) * 60 + parseInt(m[3], 10)) * 1000 + (frac ? parseInt(frac, 10) : 0);
}

/**
 * A revision becomes a new version on the clip's edit record; the candidate
 * itself is never changed. Returns null when the action needs the caller
 * (new_request / compilation / none) or changes nothing.
 */
export function applyRevision(revision: Revision, edit: ClipEdit, plan: { start_ms: number; end_ms: number }, now = Date.now()): EditVersion | null {
  const versions = edit.versions ?? [];
  const n = Math.max(0, ...versions.map((v) => v.n ?? 0)) + 1;
  const base: EditVersion = { n, created: now / 1000, note: String(revision.note ?? revision.action ?? "").slice(0, 120), source: "revision" };
  switch (revision.action) {
    case "retime": {
      const start = parseTs(revision.start);
      const end = parseTs(revision.end);
      if (start == null && end == null) return null;
      return { ...base, start_ms: start ?? plan.start_ms, end_ms: end ?? plan.end_ms };
    }
    case "retitle":
      return revision.title ? { ...base, title: String(revision.title).slice(0, 120) } : null;
    case "options": {
      const opts = revision.options ?? {};
      const version: EditVersion = { ...base };
      for (const key of ["filler_policy", "silence_policy", "caption_preset", "duration_seconds", "duration_mode"] as const) {
        const value = opts[key];
        if (value != null && value !== "") (version as unknown as Record<string, unknown>)[key] = value;
      }
      if (Array.isArray(opts.restore) && opts.restore.length) {
        version.disabled_cuts = Array.from(new Set([...(edit.disabled_cuts ?? []), ...opts.restore.map(String)])).sort();
      }
      return Object.keys(version).length > Object.keys(base).length ? version : null;
    }
    default:
      return null;
  }
}

/** The edit with a version overlaid (the same rule podcast_prepare_clip applies). */
export function resolveEdit(edit: ClipEdit | undefined, version?: number | null): ClipEdit {
  if (!edit) return {};
  const wanted = version ?? edit.active_version;
  const chosen = wanted != null ? (edit.versions ?? []).find((v) => v.n === wanted) : undefined;
  if (!chosen) return edit;
  const { n: _n, created: _c, note: _note, source: _s, ...fields } = chosen;
  void _n;
  void _c;
  void _note;
  void _s;
  return { ...edit, ...fields };
}

export function nextRequestId(existing: string[]): string {
  const numbers = existing.map((name) => /^r(\d+)\.json$/.exec(name)?.[1]).filter((n): n is string => !!n).map((n) => parseInt(n, 10));
  const next = numbers.length ? Math.max(...numbers) + 1 : 1;
  return `r${String(next).padStart(2, "0")}`;
}

export const requestIdOf = (clipId: string): string | null => /^(r\d+)c\d+$/.exec(clipId)?.[1] ?? null;

/** Human-readable verdicts for the compliance badges. */
export function complianceBadges(c: Compliance | null | undefined, spec?: RequestSpec | null): { label: string; tone: "ok" | "warn" | "bad" | "muted" }[] {
  if (!c) return [];
  const out: { label: string; tone: "ok" | "warn" | "bad" | "muted" }[] = [];
  const tri = (label: string, value: boolean | null | undefined, unknownLabel: string) =>
    out.push(value == null ? { label: unknownLabel, tone: "muted" } : value ? { label, tone: "ok" } : { label: `not ${label}`, tone: "bad" });
  if (c.prompt_match != null) out.push({ label: `prompt match ${Math.round(c.prompt_match * 100)}%`, tone: c.prompt_match >= 0.7 ? "ok" : "warn" });
  if (c.duration_requested) {
    const final = c.duration_final ?? c.duration_planned;
    const met = c.duration_met ?? c.duration_ok;
    out.push({ label: `${final ?? "?"}s of ${c.duration_requested}s ${c.duration_mode ?? ""}`.trim(), tone: met === false ? "warn" : "ok" });
  }
  if (spec?.speakers.length || c.speaker_match != null) tri("speaker verified", c.speaker_match, "speaker unverified");
  if (spec?.subjects.length || c.required_topic_found != null) tri("on topic", c.required_topic_found, "topic unchecked");
  if (c.profanity_found != null) out.push(c.profanity_found ? { label: "profanity", tone: spec?.exclude_content.includes("profanity") ? "bad" : "warn" } : { label: "clean", tone: "ok" });
  if (c.complete_ending != null) tri("complete ending", c.complete_ending, "ending unchecked");
  if (c.visual?.applied) {
    const v = c.visual;
    if (v.speaker_visible_pct != null) out.push({ label: `speaker visible ${v.speaker_visible_pct}%`, tone: v.speaker_visible_pct >= 90 ? "ok" : "warn" });
    if (v.face_checks) {
      const share = (v.face_cut_violations ?? 0) / v.face_checks;
      out.push(share <= 0.1 ? { label: "faces safe", tone: "ok" } : { label: `${v.face_cut_violations} face-edge frames`, tone: "warn" });
    }
    if (v.smooth != null) out.push(v.smooth ? { label: "smooth camera", tone: "ok" } : { label: "fast pans", tone: "warn" });
  }
  return out;
}
