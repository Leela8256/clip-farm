"use client";

/**
 * Brand looks, as the episode editor uses them.
 *
 * The looks themselves — the list, the caption styles, the snapshot a render
 * carries — live in lib/brand.ts and are shared with every other screen. This
 * module does the one thing that is particular to a full episode: applying a
 * look FILLS IN what the producer has not set on this episode and leaves
 * everything they chose themselves exactly as it is, then says which was which.
 *
 * What it fills in lands in the episode's own edit record, which is what the
 * finished episode is made from — nothing here is decoration.
 */

import { listBrandTemplates, resolveBrand, type BrandTemplate, type CaptionStyle as BrandCaptionStyle } from "@/lib/brand";
import { DEFAULT_CAPTION_STYLE, type Assets, type CaptionStyle, type EpisodeEdits } from "@/lib/studio";

export { listBrandTemplates, resolveBrand };
export type { BrandTemplate };

const CORNERS = ["tl", "tr", "bl", "br"] as const;

const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** A look's captions in the words this editor's caption controls use. */
export function captionStyleFrom(raw: BrandCaptionStyle | string | null | undefined): Partial<CaptionStyle> {
  if (typeof raw === "string") return raw ? { preset: raw } : {};
  const m = rec(raw);
  if (!Object.keys(m).length) return {};
  const style: Partial<CaptionStyle> = {};
  const preset = str(m.preset);
  if (preset) style.preset = preset;
  const font = str(m.font);
  if (font) style.font = font;
  const size = num(m.size);
  if (size) style.size = size;
  const position = str(m.position);
  if (position === "top" || position === "middle" || position === "bottom") style.position = position;
  const color = str(m.color);
  if (color) style.color = color;
  if (typeof m.karaoke === "boolean") style.karaoke = m.karaoke;
  if (typeof m.speaker_colors === "boolean") style.per_speaker_colors = m.speaker_colors;
  return style;
}

export interface BrandApply {
  edits: EpisodeEdits;
  /** what the look filled in, in plain words */
  filled: string[];
  /** what it left alone because the producer had already chosen it */
  kept: string[];
  /** the exact look that was applied, for the record */
  brand: ReturnType<typeof resolveBrand>;
}

const untouched = (style: CaptionStyle, key: keyof CaptionStyle) => style[key] === DEFAULT_CAPTION_STYLE[key];

/**
 * Apply a look to this episode: fill in the blanks, never overwrite a choice.
 * The result is an ordinary edit — one Undo puts it back.
 */
export function applyBrand(edits: EpisodeEdits, template: BrandTemplate): BrandApply {
  const brand = resolveBrand(template);
  const snapshot = brand.resolved;
  const filled: string[] = [];
  const kept: string[] = [];
  const assets: Assets = { ...edits.assets };

  const fill = (label: string, has: boolean, put: () => void) => {
    if (has) kept.push(label);
    else {
      put();
      filled.push(label);
    }
  };

  const logo = rec(snapshot.logo);
  const logoPath = str(logo.path);
  if (logoPath) {
    const corner = CORNERS.find((c) => c === logo.corner) ?? "tr";
    fill("logo", !!assets.logo?.path, () => {
      assets.logo = { path: logoPath, corner, height: num(logo.height) ?? 0.1, opacity: num(logo.opacity) ?? 0.9 };
    });
  }
  const intro = str(rec(snapshot.intro).path);
  if (intro) fill("opening clip", !!assets.intro?.path, () => (assets.intro = { path: intro }));
  const outro = str(rec(snapshot.outro).path);
  if (outro) fill("closing clip", !!assets.outro?.path, () => (assets.outro = { path: outro }));
  const music = rec(snapshot.music);
  const musicPath = str(music.path);
  if (musicPath) {
    fill("music", !!assets.music?.path, () => {
      assets.music = {
        path: musicPath,
        gain_db: num(music.gain_db) ?? -22,
        duck_db: num(music.duck_db) ?? -12,
        fade_ms: num(music.fade_ms) ?? 1500,
      };
    });
  }
  const headline = str(rec(snapshot.headline).text);
  if (headline) {
    fill("opening card", !!assets.title_card?.text, () => {
      assets.title_card = { ...(assets.title_card ?? { seconds: 3 }), text: headline };
    });
  }
  const cta = str(rec(snapshot.cta).text);
  if (cta) {
    fill("closing card", !!assets.end_card?.text, () => {
      assets.end_card = { ...(assets.end_card ?? { seconds: 3 }), text: cta };
    });
  }

  const wanted = captionStyleFrom(snapshot.captions as BrandCaptionStyle | undefined);
  const style = { ...edits.visual.caption_style };
  const keys = (Object.keys(wanted) as (keyof CaptionStyle)[]).filter((key) => wanted[key] !== undefined);
  if (keys.length) {
    const changed = keys.filter((key) => untouched(style, key));
    if (changed.length) {
      for (const key of changed) Object.assign(style, { [key]: wanted[key] });
      filled.push("caption look");
    } else kept.push("caption look");
  }

  const extra = edits.extra_aspects ?? [];
  const aspect = str(rec(snapshot.layout).aspect);
  const wantsExtra = !!aspect && aspect !== "16:9" && !extra.includes(aspect);
  if (wantsExtra) filled.push(`${aspect} version`);

  return {
    edits: {
      ...edits,
      assets,
      extra_aspects: wantsExtra ? [...extra, aspect!] : extra,
      visual: { ...edits.visual, caption_style: style },
    },
    filled,
    kept,
    brand,
  };
}

/** What applying a look did, in one honest line. */
export function describeApply(result: BrandApply, name: string): string {
  if (!result.filled.length && !result.kept.length) return `${name} has nothing to add to this episode yet`;
  const bits: string[] = [];
  if (result.filled.length) bits.push(`${name} filled in ${result.filled.join(", ")}`);
  if (result.kept.length) bits.push(`your own ${result.kept.join(", ")} left as ${result.kept.length > 1 ? "they are" : "it is"}`);
  return bits.join(" · ");
}
