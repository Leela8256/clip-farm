/**
 * The clip-shaped part of styling, and preview freshness, for Create Clips.
 *
 * The caption gallery, the brand templates and their snapshots belong to
 * `lib/brand` — the same looks travel through the brand pages, the episode
 * editor and here. What lives here is what only a clip has: the shape its tall
 * version is made in, how a saved look is stamped onto one clip without
 * overwriting hand-made choices, and telling the producer honestly when the
 * preview they are watching was made before the changes they have since made.
 */

import { legacyPresetOf, resolveBrand, resolveCaptionStyle, stableJson, type BrandTemplate, type CaptionStyle, type ResolvedBrand } from "@/lib/brand";
import type { ClipEdit } from "@/lib/podcast";
import type { ClipPlan, RequestSpec } from "@/lib/director";

// ------------------------------------------------------------------- shapes

export const CLIP_ASPECTS: { value: string; label: string; hint: string }[] = [
  { value: "9:16", label: "9:16 tall", hint: "Reels, Shorts, TikTok" },
  { value: "4:5", label: "4:5 portrait", hint: "Instagram and LinkedIn feed" },
  { value: "1:1", label: "1:1 square", hint: "Feed posts that crop either way" },
];

// --------------------------------------------------------- the styled clip edit

/** The style fields a clip edit carries on top of its boundaries and cleanup. */
export interface ClipStyle {
  /** 9:16 | 4:5 | 1:1 — the shape the vertical render is made in */
  aspect?: string;
  caption_style?: CaptionStyle;
  brand?: ResolvedBrand;
}

export type StyledEdit = ClipEdit & ClipStyle;

export const styleOf = (edit: ClipEdit | null | undefined): ClipStyle => (edit ?? {}) as ClipStyle;

/**
 * Applying a brand template never overwrites a choice the producer made by
 * hand: only the fields they have not touched are filled in.
 */
export function applyTemplate(template: BrandTemplate, own: StyledEdit): StyledEdit {
  const brand = resolveBrand(template);
  const patch: StyledEdit = { brand };
  if (template.captions && own.caption_style === undefined) {
    const style = resolveCaptionStyle(template.captions);
    patch.caption_style = style;
    const legacy = legacyPresetOf(style.preset ?? "clean-karaoke");
    patch.caption_preset = legacy;
    patch.captions = legacy;
  }
  if (template.layout?.mode && own.layout_mode === undefined) patch.layout_mode = template.layout.mode;
  if (template.layout?.aspect && own.aspect === undefined) patch.aspect = template.layout.aspect;
  if (template.cleanup?.filler_policy && own.filler_policy === undefined) patch.filler_policy = template.cleanup.filler_policy;
  if (template.cleanup?.silence_policy && own.silence_policy === undefined) patch.silence_policy = template.cleanup.silence_policy;
  return patch;
}

// ------------------------------------------------------------ preview freshness

export interface EffectiveRender {
  start_ms: number;
  end_ms: number;
  version: number | null;
  options: Record<string, unknown>;
}

const RENDERABLE_LAYOUT: Record<string, string> = { "9:16": "vertical", "16:9": "wide" };

/**
 * Exactly what this clip would be rendered with right now — the same fallback
 * order the renderer itself uses (the clip's own edit, then the request it came
 * from, then the house default).
 */
export function effectiveRender(
  range: { start_ms: number; end_ms: number },
  edit: StyledEdit,
  spec: RequestSpec | null | undefined,
  version: number | null
): EffectiveRender {
  const captionPreset =
    typeof edit.caption_preset === "string" ? edit.caption_preset : typeof edit.captions === "string" ? edit.captions : edit.captions === false ? "off" : spec?.caption_preset ?? "classic";
  const fillers = edit.filler_policy ?? (edit.remove_fillers === false ? "keep" : spec?.filler_policy ?? "smart");
  const silences = edit.silence_policy ?? (edit.tighten_pauses === false ? "keep" : spec?.silence_policy ?? "tighten");
  const layouts = edit.layouts ?? (spec ? RENDERABLE_LAYOUT[spec.aspect_ratio] ?? "" : "");
  const target = edit.duration_seconds ?? spec?.duration.target_seconds ?? null;
  return {
    start_ms: range.start_ms,
    end_ms: range.end_ms,
    version,
    options: {
      caption_preset: captionPreset,
      filler_policy: fillers,
      silence_policy: silences,
      layouts,
      duration_seconds: target,
      duration_mode: target != null ? edit.duration_mode ?? spec?.duration.mode ?? "natural" : "natural",
      disabled_cuts: [...(edit.disabled_cuts ?? [])].sort(),
      layout_mode: edit.layout_mode ?? "auto",
      subject: edit.subject ?? null,
      aspect: edit.aspect ?? "9:16",
      // the look is named by its gallery id; the renderer may fill the rest of it in
      caption_style: edit.caption_style?.preset ?? null,
      brand: edit.brand?.hash ?? null,
    },
  };
}

/** A one-line fingerprint of the work a render would be made from. */
export const renderSignature = (effective: EffectiveRender): string => stableJson(effective);

type PlanWithRequest = ClipPlan & { requested?: { start_ms?: number; end_ms?: number }; prepared_at?: number };

/**
 * True when the preview on screen was made before the changes now on screen.
 *
 * Only the facts the plan actually reports are compared, so a renderer that
 * does not yet know about a setting can never leave the screen stuck on a
 * warning it can do nothing about. The plan's *requested* boundaries are the
 * ones to compare: the renderer snaps them onto whole words, and that snap is
 * not a change the producer made.
 */
export function previewBehindEdits(plan: ClipPlan | null | undefined, report: { rendered_at?: number } | null | undefined, current: EffectiveRender): boolean {
  if (!plan || !report) return false;
  const p = plan as PlanWithRequest;
  const start = p.requested?.start_ms ?? plan.start_ms;
  const end = p.requested?.end_ms ?? plan.end_ms;
  if (start !== current.start_ms || end !== current.end_ms) return true;
  if ((plan.version ?? null) !== (current.version ?? null)) return true;
  // prepared after it was rendered: the render never saw this plan
  if (p.prepared_at != null && report.rendered_at != null && report.rendered_at + 1 < p.prepared_at) return true;
  const planned = plan.options ?? {};
  for (const [key, value] of Object.entries(current.options)) {
    if (!(key in planned)) continue;
    // the plan keeps whole objects; what identifies them is the brand's
    // fingerprint and the caption look's name
    const raw = planned[key];
    const was =
      key === "brand" && raw && typeof raw === "object"
        ? (raw as ResolvedBrand).hash ?? null
        : key === "caption_style" && raw && typeof raw === "object"
          ? (raw as CaptionStyle).preset ?? null
          : raw;
    if (stableJson(was) !== stableJson(value)) return true;
  }
  return false;
}
